from __future__ import annotations

import math
import os
import threading
import time
from collections import deque
from collections.abc import Callable, Generator, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from av.error import FFmpegError
from av.video.stream import VideoStream
from numpy.typing import NDArray

from ..models import EncodePlan, Segment, VideoInfo
from ..models.frame_blending import FrameBlending, interval_weight, vegas_weights

PixelArray = NDArray[np.uint8]
FloatArray = NDArray[np.float32]
MAX_BUFFER_BYTES = 256 * 1024 * 1024
MAX_WINDOW_FRAMES = 256
MAX_PIXELS = 4096 * 2160
MAX_TEMP_BYTES = 16 * 1024**3
# decoding up to this many seconds is cheaper than seeking past them
SEEK_THRESHOLD = 2.0
_WEIGHT_BITS = 16
_WEIGHT_ONE = 1 << _WEIGHT_BITS
# decoded pictures held ready for blending; enough to hide decoding without much memory
_READ_AHEAD_FRAMES = 4
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
# planar YUV that tmix blends in place, as the source is decoded
TMIX_FORMATS = frozenset(
    {"yuv420p", "yuv422p", "yuv444p", "yuvj420p", "yuvj422p", "yuvj444p", "gray"}
)


def validate_blending_source(settings: FrameBlending, info: VideoInfo, fps: float) -> None:
    if not settings.enabled:
        return
    if math.isfinite(fps) and fps > 240:
        raise ValueError("Frame blending supports up to 240 FPS. Choose a lower output frame rate.")
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
    start: float = 0.0,
) -> Generator[tuple[float, PixelArray], None, None]:
    """Source frames from the last keyframe at or before `start` onward."""
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        # use the same container origin as FFmpeg so delayed video stays aligned with audio
        origin = (container.start_time or 0) / av.time_base
        if start > 0 and stream.time_base is not None:
            container.seek(int((start + origin) / stream.time_base), stream=stream, backward=True)
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
                # display matrix angles are counterclockwise, matching FFmpeg autorotation
                pixels = np.ascontiguousarray(np.rot90(pixels, info.display_rotation // 90))
            if pixels.shape[:2] != (info.height, info.width):
                raise ValueError("Frame blending does not support changing video dimensions")
            previous = timestamp
            yield timestamp, pixels


class _ReadAhead:
    """Runs a source frame reader on its own thread, a few frames ahead of blending.

    Decoding and colour conversion then overlap with the blending that uses them. The reader
    is closed on its own thread, and its errors, cancellation included, surface on the next read.
    """

    def __init__(self, frames: Generator[tuple[float, PixelArray], None, None]) -> None:
        self._items: deque[tuple[float, PixelArray]] = deque()
        self._condition = threading.Condition()
        self._finished = False
        self._closed = False
        self._error: BaseException | None = None
        self._thread = threading.Thread(
            target=self._run, args=(frames,), name="blend-read", daemon=True
        )
        self._thread.start()

    def _run(self, frames: Generator[tuple[float, PixelArray], None, None]) -> None:
        error: BaseException | None = None
        try:
            for item in frames:
                with self._condition:
                    self._condition.wait_for(
                        lambda: self._closed or len(self._items) < _READ_AHEAD_FRAMES
                    )
                    if self._closed:
                        return
                    self._items.append(item)
                    self._condition.notify_all()
        except BaseException as exc:
            error = exc
        finally:
            frames.close()
            with self._condition:
                self._finished, self._error = True, error
                self._condition.notify_all()

    def __iter__(self) -> _ReadAhead:
        return self

    def __next__(self) -> tuple[float, PixelArray]:
        with self._condition:
            self._condition.wait_for(lambda: bool(self._items) or self._finished)
            if self._items:
                item = self._items.popleft()
                self._condition.notify_all()
                return item
            if self._error is not None:
                raise self._error
            raise StopIteration

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()
        self._thread.join()


def _integer_weights(weights: list[float]) -> list[int]:
    """Weights in 1/65536 steps that add up exactly, so white stays white."""
    total = sum(weights)
    scaled = [w / total * _WEIGHT_ONE for w in weights]
    whole = [math.floor(value) for value in scaled]
    by_remainder = sorted(range(len(scaled)), key=lambda i: whole[i] - scaled[i])
    for i in by_remainder[: _WEIGHT_ONE - sum(whole)]:
        whole[i] += 1
    return whole


def _blend(
    weighted: list[tuple[PixelArray, float]], linear: FloatArray | None, transfer: str
) -> PixelArray:
    """One output picture from its weighted source pictures."""
    if linear is not None:
        total = sum(weight for _, weight in weighted)
        result = np.zeros(weighted[0][0].shape, dtype=np.float32)
        for pixels, weight in weighted:
            result += linear[pixels] * np.float32(weight / total)
        result = from_linear(np.clip(result, 0, 1), transfer)
        return np.rint(np.clip(result, 0, 1) * 255).astype(np.uint8)
    # fixed point in place: far less memory traffic than a float copy of every picture
    weights = _integer_weights([weight for _, weight in weighted])
    total, scratch = _sums(weighted[0][0].shape)
    total.fill(0)
    for (pixels, _), weight in zip(weighted, weights, strict=True):
        if weight:
            np.multiply(pixels, np.uint32(weight), out=scratch, dtype=np.uint32)
            total += scratch
    total += _WEIGHT_ONE // 2
    total >>= _WEIGHT_BITS
    return total.astype(np.uint8)


_buffers = threading.local()


def _sums(shape: tuple[int, ...]) -> tuple[NDArray[np.uint32], NDArray[np.uint32]]:
    """This thread's running-sum buffers, kept between pictures instead of reallocated."""
    kept = getattr(_buffers, "sums", None)
    if kept is None or kept[0].shape != shape:
        kept = (np.empty(shape, dtype=np.uint32), np.empty(shape, dtype=np.uint32))
        _buffers.sums = kept
    return kept


def _workers() -> int:
    # blending is memory bound; a few threads fill the memory bandwidth
    return max(1, min(6, os.cpu_count() or 1))


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
    frames: _ReadAhead | None = None
    current: tuple[float, PixelArray] | None = None
    following: tuple[float, PixelArray] | None = None
    first_timestamp: float | None = None

    def open_at(time: float) -> None:
        """Read frames from the one shown at `time`, seeking when that skips enough video."""
        nonlocal frames, current, following, first_timestamp
        if frames is not None:
            frames.close()
        seek = time if time > SEEK_THRESHOLD else 0.0
        frames = _ReadAhead(_source_frames(Path(plan.source), info, check_cancel, seek))
        current = next(frames, None)
        following = next(frames, None)
        if current is None:
            raise ValueError("No video frames were decoded for frame blending")
        if seek and current[0] > time:
            # without a usable index a seek can land late; read from the start instead
            open_at(0.0)
            return
        # the first frame of the file covers any gap before it
        first_timestamp = None if seek else current[0]

    linear = (
        to_linear(np.arange(256, dtype=np.float32) / np.float32(255), info.color_transfer)
        if settings.linear_light
        else None
    )
    pending: deque[Future[PixelArray]] = deque()
    pool = ThreadPoolExecutor(max_workers=_workers(), thread_name_prefix="blend")
    try:
        buffer: deque[tuple[float, float, PixelArray]] = deque()
        segment_index = 0
        output_start = 0.0
        count = max(1, math.ceil(plan.effective_duration * fps - 1e-8))
        for index in range(count):
            check_cancel()
            # one global output grid prevents rounding error accumulating at each cut
            midpoint = min(
                float((Fraction(index) + Fraction(1, 2)) / fps),
                math.nextafter(plan.effective_duration, 0),
            )
            switched = index == 0
            while (
                midpoint >= output_start + segments[segment_index].duration
                and segment_index < len(segments) - 1
            ):
                output_start += segments[segment_index].duration
                segment_index += 1
                buffer.clear()
                switched = True
            segment = segments[segment_index]
            # a later part can start earlier in the source, or far past where reading stopped
            if switched and (
                current is None
                or current[0] > segment.start
                or segment.start - current[0] > SEEK_THRESHOLD
            ):
                open_at(segment.start)
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
                following = next(frames, None) if current is not None and frames else None
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
            if weighted:
                pending.append(pool.submit(_blend, weighted, linear, info.color_transfer))
            else:
                # zero custom density after boundary clipping falls back to the held frame
                held = next((p for start, end, p in buffer if start <= center < end), None)
                if held is None:
                    raise ValueError("No source frame covers this timeline interval")
                done: Future[PixelArray] = Future()
                done.set_result(held)
                pending.append(done)
            # blend a few pictures at once, but hand them out in order
            while len(pending) > _workers():
                yield pending.popleft().result()
        while pending:
            check_cancel()
            yield pending.popleft().result()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        if frames is not None:
            frames.close()


@dataclass(frozen=True)
class TmixPiece:
    """One segment blended by FFmpeg's tmix filter instead of the frame-by-frame path."""

    # trim points halfway between source frames, on FFmpeg's input clock
    start: Fraction
    end: Fraction
    weights: tuple[Fraction, ...]  # oldest source frame first
    # indices in the trimmed segment of the blended pictures kept, every `step` pictures
    first: int
    last: int
    step: int
    # output frames the blur window cannot fill at the cut edges repeat the nearest picture
    lead: int
    trail: int


@dataclass(frozen=True)
class TmixBlend:
    rate: Fraction
    pieces: tuple[TmixPiece, ...]


def _frame_grid(
    source: Path, segments: list[Segment], margin: Fraction
) -> tuple[Fraction, Fraction] | None:
    """(one frame time, frame step) when every frame near the segments sits on one even grid."""
    times: set[Fraction] = set()
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        if stream.time_base is None:
            return None
        base = Fraction(stream.time_base)
        origin = Fraction(container.start_time or 0, 1_000_000)
        for segment in segments:
            first = Fraction(segment.start) - margin
            last = Fraction(segment.end) + margin
            container.seek(max(0, int((first + origin) / base)), stream=stream, backward=True)
            for packet in container.demux(stream):
                if packet.pts is None:
                    if packet.size:
                        return None
                    continue
                moment = packet.pts * base - origin
                if first <= moment <= last:
                    times.add(moment)
                # decode order runs slightly behind display order; a second covers reordering
                if packet.dts is not None and packet.dts * base - origin > last + 1:
                    break
    ordered = sorted(times)
    if len(ordered) < 2:
        return None
    step = ordered[1] - ordered[0]
    if step <= 0 or any((later - ordered[0]) % step for later in ordered[2:]):
        return None
    # a missing frame inside a segment breaks the even grid tmix relies on
    for segment in segments:
        inside = [t for t in ordered if Fraction(segment.start) <= t < Fraction(segment.end)]
        if inside and (inside[-1] - inside[0]) / step + 1 != len(inside):
            return None
    return ordered[0], step


def _output_indices(
    segments: list[Segment], fps: Fraction, total: float
) -> list[tuple[int, int, float]]:
    """(first output frame, frame count, output start) per segment, as blended_frames assigns."""
    count = max(1, math.ceil(total * fps - 1e-8))
    ranges: list[list[int]] = [[] for _ in segments]
    starts = [0.0] * len(segments)
    segment_index = 0
    output_start = 0.0
    for index in range(count):
        midpoint = min(float((Fraction(index) + Fraction(1, 2)) / fps), math.nextafter(total, 0))
        while (
            midpoint >= output_start + segments[segment_index].duration
            and segment_index < len(segments) - 1
        ):
            output_start += segments[segment_index].duration
            segment_index += 1
            starts[segment_index] = output_start
        ranges[segment_index].append(index)
    return [(r[0] if r else 0, len(r), starts[i]) for i, r in enumerate(ranges)]


def tmix_blend(plan: EncodePlan) -> TmixBlend | None:
    """FFmpeg's tmix filter for blends it can reproduce, or None to blend frame by frame.

    It covers equal weights on constant-rate video whose frame rate is a whole multiple of the
    output rate, like 180 to 60 FPS. Pictures match the frame-by-frame path except where the
    blur window reaches past a cut, which is only the first and last frames of each segment.
    """
    info = plan.source_info
    settings = plan.frame_blending
    if info is None or not settings.enabled:
        return None
    validate_blending_source(settings, info, plan.target_fps)
    if (
        settings.curve != "equal"
        or settings.custom_weights
        or settings.linear_light
        or settings.amount <= 0
        or info.pixel_format not in TMIX_FORMATS
    ):
        return None
    segments = plan.effective_segments
    if not segments:
        return None
    fps = Fraction(plan.target_fps).limit_denominator(100_000)
    exposure = Fraction(settings.amount) / fps
    try:
        grid = _frame_grid(Path(plan.source), segments, exposure + 1 / fps)
    except FFmpegError:
        # the frame-by-frame path reads the file again and reports a real problem clearly
        return None
    if grid is None:
        return None
    reference, step = grid
    ratio = 1 / (step * fps)
    if ratio.denominator != 1:
        return None
    length = exposure / step  # blur window in source frames
    pieces = []
    for segment, (first_index, count, output_start) in zip(
        segments, _output_indices(segments, fps, plan.effective_duration), strict=True
    ):
        if not count:
            continue
        start, end = Fraction(segment.start), Fraction(segment.end)
        # the window of the segment's first output frame, in source frames from `reference`
        center = start + (first_index + Fraction(1, 2)) / fps - Fraction(output_start)
        opening = (center - exposure / 2 - reference) / step
        oldest = math.floor(opening)
        offset = opening - oldest
        weights = []
        position = 0
        while position < offset + length:
            weights.append(min(position + 1, offset + length) - max(position, offset))
            position += 1
        while weights and not weights[-1]:
            weights.pop()
        if not weights or len(weights) > MAX_WINDOW_FRAMES:
            return None
        head = math.ceil((start - reference) / step)
        tail = math.ceil((end - reference) / step)
        if tail <= head:
            return None
        # blended picture n of the trimmed segment ends at source frame head + n
        wanted = [oldest + len(weights) - 1 - head + k * ratio.numerator for k in range(count)]
        kept = [n for n in wanted if 0 <= n < tail - head]
        if not kept:
            return None
        pieces.append(
            TmixPiece(
                reference + (head - Fraction(1, 2)) * step,
                reference + (tail - Fraction(1, 2)) * step,
                tuple(weights),
                kept[0],
                kept[-1],
                ratio.numerator,
                wanted.index(kept[0]),
                count - 1 - wanted.index(kept[-1]),
            )
        )
    return TmixBlend(fps, tuple(pieces)) if pieces else None


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
        # FFV1 encodes slices in parallel; one thread per slice keeps up with blending
        stream.codec_context.thread_count = 0
        stream.codec_context.options = {"slices": "24"}
        last_progress = time.monotonic()

        def write(index: int, pixels: PixelArray) -> None:
            frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
            frame.pts, frame.time_base = index, 1 / fps
            for packet in stream.encode(frame):
                output.mux(packet)

        def written(index: int, done: Future[None]) -> None:
            nonlocal last_progress
            done.result()
            if destination.stat().st_size > MAX_TEMP_BYTES:
                raise ValueError(
                    "Frame blending temporary video exceeds 16 GiB; export a shorter selection"
                )
            now = time.monotonic()
            fraction = float((index + 1) / fps) / plan.effective_duration
            if fraction < 1 and (index == 0 or now - last_progress >= 0.25):
                progress(fraction)
                last_progress = now

        # one thread encodes, in order, while the next pictures are decoded and blended;
        # only that thread touches the output until it has stopped
        writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="blend-write")
        writing: deque[tuple[int, Future[None]]] = deque()
        try:
            for index, pixels in enumerate(blended_frames(plan, check_cancel)):
                writing.append((index, writer.submit(write, index, pixels)))
                while len(writing) > 2:
                    written(*writing.popleft())
            while writing:
                written(*writing.popleft())
        finally:
            writer.shutdown(wait=True, cancel_futures=True)
        for packet in stream.encode():
            output.mux(packet)
    if destination.stat().st_size > MAX_TEMP_BYTES:
        raise ValueError(
            "Frame blending temporary video exceeds 16 GiB; export a shorter selection"
        )
    progress(1.0)
