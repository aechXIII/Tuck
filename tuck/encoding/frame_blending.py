from __future__ import annotations

import math
from collections import deque
from collections.abc import Callable, Generator, Iterator
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from av.video.stream import VideoStream
from numpy.typing import NDArray

from ..models import EncodePlan, VideoInfo
from ..models.frame_blending import FrameBlending, interval_weight, vegas_weights

PixelArray = NDArray[np.uint8]
FloatArray = NDArray[np.float32]
MAX_BUFFER_BYTES = 256 * 1024 * 1024
MAX_WINDOW_FRAMES = 256
MAX_PIXELS = 4096 * 2160
MAX_TEMP_BYTES = 16 * 1024**3
SUPPORTED_FORMATS = frozenset(
    {
        "yuv420p",
        "yuv422p",
        "yuv444p",
        "yuvj420p",
        "yuvj422p",
        "yuvj444p",
        "nv12",
        "rgb24",
        "bgr24",
        "bgr0",
        "rgb0",
        "gbrp",
        "gray",
    }
)
SUPPORTED_TRANSFERS = frozenset(
    {"bt709", "smpte170m", "iec61966-2-1", "linear", "gamma22", "gamma28"}
)


def validate_blending_source(settings: FrameBlending, info: VideoInfo, fps: float) -> None:
    if not settings.enabled:
        return
    if not math.isfinite(fps) or not 0.1 <= fps <= 240:
        raise ValueError("Frame blending requires an output frame rate between 0.1 and 240 FPS")
    if settings.curve == "vegas" and not settings.custom_weights:
        vegas_weights(info.fps, fps, settings.amount)
    if info.display_rotation not in {0, 90, 180, 270}:
        raise ValueError("Frame blending supports quarter-turn display rotation only")
    if info.width * info.height > MAX_PIXELS:
        raise ValueError("Frame blending supports up to 4096 x 2160 pixels; use a smaller source")
    if info.pixel_format not in SUPPORTED_FORMATS:
        raise ValueError(
            "Frame blending supports 8-bit SDR video without alpha; convert this source first"
        )
    if info.color_transfer not in SUPPORTED_TRANSFERS | {"unknown", "unspecified", ""}:
        raise ValueError(
            "Frame blending supports SDR transfer functions only; convert this source to SDR first"
        )
    if info.color_space not in {
        "bt709",
        "bt470bg",
        "smpte170m",
        "gbr",
        "unknown",
        "unspecified",
        "",
    }:
        raise ValueError(
            "Frame blending does not support this color matrix; convert the source to SDR BT.709"
        )
    if info.color_primaries not in {"bt709", "bt470bg", "smpte170m", "unknown", "unspecified", ""}:
        raise ValueError(
            "Frame blending does not support these color primaries; "
            "convert the source to SDR BT.709"
        )
    if settings.linear_light and info.color_transfer not in SUPPORTED_TRANSFERS:
        raise ValueError(
            'This video is missing color information. Turn off "Blend in linear light" to continue.'
        )


def to_linear(values: FloatArray, transfer: str) -> FloatArray:
    if transfer == "linear":
        return values
    if transfer == "iec61966-2-1":
        return np.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4)
    if transfer in {"gamma22", "gamma28"}:
        return values ** (2.2 if transfer == "gamma22" else 2.8)
    return np.where(values < 0.081, values / 4.5, ((values + 0.099) / 1.099) ** (1 / 0.45))


def from_linear(values: FloatArray, transfer: str) -> FloatArray:
    if transfer == "linear":
        return values
    if transfer == "iec61966-2-1":
        return np.where(values <= 0.0031308, values * 12.92, 1.055 * values ** (1 / 2.4) - 0.055)
    if transfer in {"gamma22", "gamma28"}:
        return values ** (1 / (2.2 if transfer == "gamma22" else 2.8))
    return np.where(values < 0.018, values * 4.5, 1.099 * values**0.45 - 0.099)


def _source_frames(
    source: Path,
    info: VideoInfo,
    check_cancel: Callable[[], None],
) -> Generator[tuple[float, PixelArray], None, None]:
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        stream.codec_context.thread_count = 2
        # use the same container origin as FFmpeg so delayed video stays aligned with audio
        origin = (container.start_time or 0) / av.time_base
        previous = -math.inf
        matrix = "ITU709" if info.color_space == "bt709" else "ITU601"
        if info.color_space in {"unknown", "unspecified", ""} and info.height >= 720:
            matrix = "ITU709"
        for frame in container.decode(stream):
            check_cancel()
            if frame.pts is None or frame.time_base is None:
                raise ValueError("Frame blending needs source presentation timestamps")
            timestamp = float(frame.pts * frame.time_base) - origin
            if timestamp <= previous:
                raise ValueError("Frame blending needs strictly increasing source timestamps")
            if frame.interlaced_frame:
                raise ValueError(
                    "Frame blending requires progressive video; deinterlace the source first"
                )
            if frame.format.name not in SUPPORTED_FORMATS:
                raise ValueError("The source changed to an unsupported frame blending pixel format")
            if frame.width * frame.height > MAX_PIXELS:
                raise ValueError("Source dimensions exceed the frame blending limit")
            if frame.format.is_rgb:
                pixels = np.asarray(frame.to_ndarray(format="rgb24"), dtype=np.uint8)
            else:
                full_range = (
                    frame.color_range == 2
                    or frame.format.name.startswith("yuvj")
                    or frame.format.name == "gray"
                )
                # PyAV 16 skips swscale coefficient setup when both matrix names match.
                # RGB has no destination YUV matrix; a distinct name forces source setup.
                pixels = np.asarray(
                    frame.to_ndarray(
                        format="rgb24",
                        src_colorspace=matrix,
                        dst_colorspace="ITU601" if matrix == "ITU709" else "ITU709",
                        src_color_range="JPEG" if full_range else "MPEG",
                        dst_color_range="JPEG",
                    ),
                    dtype=np.uint8,
                )
            if info.display_rotation:
                pixels = np.ascontiguousarray(np.rot90(pixels, -(info.display_rotation // 90)))
            if pixels.shape[:2] != (info.height, info.width):
                raise ValueError("Frame blending does not support changing video dimensions")
            previous = timestamp
            yield timestamp, pixels


def blended_frames(
    plan: EncodePlan,
    check_cancel: Callable[[], None],
) -> Iterator[PixelArray]:
    info = plan.source_info
    if info is None:
        raise ValueError("Frame blending requires source metadata")
    settings = plan.frame_blending
    validate_blending_source(settings, info, plan.target_fps)
    fps = Fraction(plan.target_fps).limit_denominator(100_000)
    exposure = settings.amount / float(fps)
    vegas = (
        vegas_weights(info.fps, float(fps), settings.amount)
        if settings.curve == "vegas" and not settings.custom_weights
        else ()
    )
    segments = plan.effective_segments
    if not segments:
        raise ValueError("Frame blending requires a nonempty timeline")
    frames = _source_frames(Path(plan.source), info, check_cancel)
    try:
        current = next(frames, None)
        following = next(frames, None)
        if current is None:
            raise ValueError("No video frames were decoded for frame blending")
        first_timestamp = current[0]
        buffer: deque[tuple[float, float, PixelArray]] = deque()
        segment_index = 0
        output_start = 0.0
        count = max(1, math.ceil(plan.effective_duration * fps - 1e-8))
        lookup = to_linear(np.arange(256, dtype=np.float32) / np.float32(255), info.color_transfer)
        for index in range(count):
            check_cancel()
            # one global output grid prevents rounding error accumulating at each cut
            midpoint = min(
                float((Fraction(index) + Fraction(1, 2)) / fps),
                math.nextafter(plan.effective_duration, 0),
            )
            while (
                midpoint >= output_start + segments[segment_index].duration
                and segment_index < len(segments) - 1
            ):
                output_start += segments[segment_index].duration
                segment_index += 1
                buffer.clear()
            segment = segments[segment_index]
            center = segment.start + midpoint - output_start
            left = max(segment.start, center - exposure / 2)
            right = min(segment.end, center + exposure / 2)
            while buffer and buffer[0][1] <= left:
                buffer.popleft()
            while current is not None:
                timestamp, pixels = current
                timestamp = min(0.0, timestamp) if timestamp == first_timestamp else timestamp
                end = following[0] if following is not None else info.duration
                if timestamp >= right and exposure > 0:
                    break
                if timestamp > center and exposure == 0:
                    break
                if end > left and timestamp < segment.end:
                    clipped_start = max(timestamp, segment.start)
                    if not buffer or buffer[-1][0] != clipped_start:
                        buffer.append((clipped_start, min(end, segment.end), pixels))
                    if (
                        len(buffer) > MAX_WINDOW_FRAMES
                        or sum(item[2].nbytes for item in buffer) > MAX_BUFFER_BYTES
                    ):
                        raise ValueError(
                            "Frame blending window exceeds its memory limit; "
                            "lower blur amount or increase output FPS"
                        )
                if end >= right and (exposure > 0 or end > center):
                    break
                current = following
                following = next(frames, None) if current is not None else None
            weighted: list[tuple[PixelArray, float]] = []
            for start, end, pixels in buffer:
                if exposure == 0:
                    weight = 1.0 if start <= center < end else 0.0
                else:
                    window_start = center - exposure / 2
                    weight = interval_weight(
                        settings,
                        (max(start, left) - window_start) / exposure,
                        (min(end, right) - window_start) / exposure,
                        vegas=vegas,
                    )
                if weight > 0:
                    weighted.append((pixels, weight))
            if not weighted:
                # zero custom density after boundary clipping falls back to the held frame
                held = next((p for start, end, p in buffer if start <= center < end), None)
                if held is None:
                    raise ValueError("No source frame covers this timeline interval")
                yield held
                continue
            total = sum(weight for _, weight in weighted)
            result = np.zeros(weighted[0][0].shape, dtype=np.float32)
            for pixels, weight in weighted:
                check_cancel()
                values = (
                    lookup[pixels] if settings.linear_light else pixels.astype(np.float32) / 255
                )
                result += values * (weight / total)
            if settings.linear_light:
                result = from_linear(np.clip(result, 0, 1), info.color_transfer)
            yield np.rint(np.clip(result, 0, 1) * 255).astype(np.uint8)
    finally:
        frames.close()


def prepare_blended_video(
    plan: EncodePlan,
    destination: Path,
    check_cancel: Callable[[], None],
    progress: Callable[[float], None],
) -> None:
    info = plan.source_info
    if info is None:
        raise ValueError("Frame blending requires source metadata")
    fps = Fraction(plan.target_fps).limit_denominator(100_000)
    with av.open(str(destination), "w", format="nut") as output:
        stream = output.add_stream("ffv1", rate=fps)
        if not isinstance(stream, VideoStream):
            raise RuntimeError("FFV1 video encoder is unavailable")
        stream.width, stream.height = info.width, info.height
        stream.pix_fmt = "bgr0"
        stream.time_base = 1 / fps
        stream.codec_context.thread_count = 2
        for index, pixels in enumerate(blended_frames(plan, check_cancel)):
            frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
            frame.pts, frame.time_base = index, 1 / fps
            for packet in stream.encode(frame):
                output.mux(packet)
            if destination.stat().st_size > MAX_TEMP_BYTES:
                raise ValueError(
                    "Frame blending temporary video exceeds 16 GiB; export a shorter selection"
                )
            if index % max(1, round(float(fps))) == 0:
                progress(min(1, float(index / fps) / plan.effective_duration))
        for packet in stream.encode():
            output.mux(packet)
    if destination.stat().st_size > MAX_TEMP_BYTES:
        raise ValueError(
            "Frame blending temporary video exceeds 16 GiB; export a shorter selection"
        )
