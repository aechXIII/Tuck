from __future__ import annotations

import json
import logging
import math
import os
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import av
from av.container import InputContainer
from av.error import FFmpegError
from av.video.frame import VideoFrame
from av.video.stream import VideoStream

from . import media_tools
from .models import AudioInfo, VideoInfo

logger = logging.getLogger(__name__)

_QUARTER_TURN = 90
_FULL_TURN = 360
_PROBE_TIMEOUT = 60  # seconds
_PROBE_MAX_PACKETS = 1000

# ffprobe's names for FFmpeg's color values (libavutil/pixdesc.c), so both readers agree
_COLOR_RANGES = {0: "unknown", 1: "tv", 2: "pc"}
_COLOR_PRIMARIES = {
    0: "reserved", 1: "bt709", 2: "unknown", 3: "reserved", 4: "bt470m", 5: "bt470bg",
    6: "smpte170m", 7: "smpte240m", 8: "film", 9: "bt2020", 10: "smpte428", 11: "smpte431",
    12: "smpte432", 22: "ebu3213",
}  # fmt: skip
_COLOR_TRANSFERS = {
    0: "reserved", 1: "bt709", 2: "unknown", 3: "reserved", 4: "bt470m", 5: "bt470bg",
    6: "smpte170m", 7: "smpte240m", 8: "linear", 9: "log100", 10: "log316",
    11: "iec61966-2-4", 12: "bt1361e", 13: "iec61966-2-1", 14: "bt2020-10", 15: "bt2020-12",
    16: "smpte2084", 17: "smpte428", 18: "arib-std-b67",
}  # fmt: skip
_COLOR_SPACES = {
    0: "gbr", 1: "bt709", 2: "unknown", 3: "reserved", 4: "fcc", 5: "bt470bg",
    6: "smpte170m", 7: "smpte240m", 8: "ycgco", 9: "bt2020nc", 10: "bt2020c",
    11: "smpte2085", 12: "chroma-derived-nc", 13: "chroma-derived-c", 14: "ictcp",
    15: "ipt-c2", 16: "ycgco-re", 17: "ycgco-ro",
}  # fmt: skip


def first_video_frame(
    container: InputContainer, stream: VideoStream, max_packets: int
) -> VideoFrame | None:
    """Decode the first picture from the container's current position.

    `max_packets` stops a file that never yields a picture from being read to the end.
    """
    for count, packet in enumerate(container.demux(stream)):
        if count >= max_packets:
            return None
        for frame in packet.decode():
            if isinstance(frame, VideoFrame):
                return frame
    return None


def _ratio(value: Fraction | None) -> str:
    return f"{value.numerator}/{value.denominator}" if value else "0/0"


def _read_with_pyav(source: Path) -> dict:
    """Read the same fields `ffprobe -show_format -show_streams` prints, in its JSON shape.

    Opening the file in-process avoids starting ffprobe, which takes far longer than the read.
    Both readers then go through the same parsing, so a video is described the same way
    whichever one read it.
    """
    with av.open(str(source), timeout=_PROBE_TIMEOUT) as container:
        streams: list[dict] = []
        for stream in container.streams:
            context = stream.codec_context
            entry: dict[str, Any] = {"codec_type": stream.type}
            if context is not None:
                entry["codec_name"] = context.codec.canonical_name
                if context.bit_rate:
                    entry["bit_rate"] = str(context.bit_rate)
            if stream.metadata:
                entry["tags"] = dict(stream.metadata)
            if isinstance(stream, VideoStream):
                # only the first video stream is described, as _select_streams picks it
                first = not any(s["codec_type"] == "video" for s in streams)
                _read_video_stream(container, stream, entry, read_rotation=first)
            elif isinstance(stream, av.AudioStream):
                entry["channels"] = stream.codec_context.channels
                entry["sample_rate"] = stream.codec_context.sample_rate
            streams.append(entry)
        fmt: dict[str, str] = {}
        if container.duration:
            fmt["duration"] = f"{container.duration / 1_000_000:.6f}"
        if container.bit_rate:
            fmt["bit_rate"] = str(container.bit_rate)
        return {"streams": streams, "format": fmt}


def _read_video_stream(
    container: InputContainer, stream: VideoStream, entry: dict, read_rotation: bool
) -> None:
    context = stream.codec_context
    entry["width"] = context.width
    entry["height"] = context.height
    if context.pix_fmt:
        entry["pix_fmt"] = context.pix_fmt
    entry["r_frame_rate"] = _ratio(stream.base_rate)
    entry["avg_frame_rate"] = _ratio(stream.average_rate)
    aspect = stream.sample_aspect_ratio or context.sample_aspect_ratio
    if aspect:
        entry["sample_aspect_ratio"] = f"{aspect.numerator}:{aspect.denominator}"
    entry["color_range"] = _COLOR_RANGES.get(context.color_range, "unknown")
    entry["color_space"] = _COLOR_SPACES.get(context.colorspace, "unknown")
    entry["color_transfer"] = _COLOR_TRANSFERS.get(context.color_trc, "unknown")
    entry["color_primaries"] = _COLOR_PRIMARIES.get(context.color_primaries, "unknown")
    if not read_rotation:
        return
    # PyAV only exposes the display rotation on decoded pictures, so read the first one
    frame = first_video_frame(container, stream, _PROBE_MAX_PACKETS)
    if frame is None:
        raise ValueError("no picture could be decoded")
    if frame.rotation:
        entry["side_data_list"] = [{"rotation": frame.rotation}]


def _run_ffprobe_json(ffprobe_path: str, source: Path, context: str) -> dict:
    cmd = [
        ffprobe_path,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(source),
    ]

    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            # ffprobe writes UTF-8 JSON whatever the Windows code page is
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffprobe timed out {context}: {source}") from None

    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            cmd,
            output=result.stdout,
            stderr=result.stderr,
        )

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse ffprobe output: {e}") from e


def _select_streams(streams: list) -> tuple[dict | None, dict | None]:
    video_stream = None
    audio_stream = None
    for s in streams:
        if s.get("codec_type") == "video" and video_stream is None:
            video_stream = s
        elif s.get("codec_type") == "audio" and audio_stream is None:
            audio_stream = s
    return video_stream, audio_stream


def _parse_stream_duration(fmt: dict, stream: dict, label: str) -> float:
    duration = 0.0
    duration_value = fmt.get("duration") or stream.get("duration")
    if duration_value:
        try:
            duration = float(duration_value)
        except (ValueError, TypeError):
            logger.warning("Could not parse %s duration from ffprobe: %r", label, duration_value)

    if duration <= 0:
        tags = stream.get("tags", {})
        if isinstance(tags, dict) and tags.get("DURATION"):
            duration = _parse_duration_str(str(tags["DURATION"]))
    return duration


def _video_duration(fmt: dict, video_stream: dict, source: Path) -> float:
    duration = _parse_stream_duration(fmt, video_stream, "video")
    if duration <= 0:
        raise ValueError(f"Cannot determine duration for: {source}")
    return duration


def _video_dimensions(video_stream: dict, source: Path) -> tuple[int, int, int, int, int]:
    coded_width = int(video_stream.get("width", 0))
    coded_height = int(video_stream.get("height", 0))
    if coded_width <= 0 or coded_height <= 0:
        raise ValueError(f"Invalid resolution in: {source}")
    display_rotation = _parse_display_rotation(video_stream)
    if display_rotation in (90, 270):
        width, height = coded_height, coded_width
    else:
        width, height = coded_width, coded_height
    return coded_width, coded_height, width, height, display_rotation


def _video_bitrate(video_stream: dict, fmt: dict) -> int:
    bitrate = 0
    vbr = video_stream.get("bit_rate")
    if vbr:
        try:
            bitrate = int(vbr)
        except (ValueError, TypeError):
            logger.warning("Could not parse video bitrate from ffprobe: %r", vbr)
    if bitrate <= 0:
        fbr = fmt.get("bit_rate")
        if fbr:
            try:
                bitrate = int(fbr)
            except (ValueError, TypeError):
                logger.warning("Could not parse format bitrate from ffprobe: %r", fbr)
    return bitrate


def _audio_fields(audio_stream: dict | None) -> tuple[bool, str, int, int, int]:
    has_audio = audio_stream is not None
    audio_codec = ""
    audio_channels = 0
    audio_sample_rate = 0
    audio_bitrate = 0
    if audio_stream:
        audio_codec = audio_stream.get("codec_name", "")
        try:
            audio_channels = int(audio_stream.get("channels", 0))
        except (ValueError, TypeError):
            logger.warning("Could not parse audio channels from ffprobe")
        try:
            audio_sample_rate = int(audio_stream.get("sample_rate", 0))
        except (ValueError, TypeError):
            logger.warning("Could not parse audio sample rate from ffprobe")
        try:
            audio_bitrate = int(audio_stream.get("bit_rate", 0))
        except (ValueError, TypeError):
            logger.warning("Could not parse audio bitrate from ffprobe")
    return has_audio, audio_codec, audio_channels, audio_sample_rate, audio_bitrate


def probe(source: str | Path) -> VideoInfo:
    ffprobe_path = media_tools.find_ffprobe()
    if not ffprobe_path:
        raise FileNotFoundError(
            "ffprobe not found. Install FFmpeg and ensure ffprobe is on PATH "
            "or set the path in settings."
        )

    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(f"Source file not found: {source}")

    file_size = source.stat().st_size
    try:
        return _video_info(source, file_size, _read_with_pyav(source))
    except (FFmpegError, OSError, ValueError) as e:
        # ffprobe stays the reference for anything PyAV cannot read, and its errors are
        # the ones people see
        logger.debug("PyAV could not probe %s, using ffprobe: %s", source.name, e)
    return _video_info(source, file_size, _run_ffprobe_json(ffprobe_path, source, "probing"))


def _video_info(source: Path, file_size: int, data: dict) -> VideoInfo:
    video_stream, audio_stream = _select_streams(data.get("streams", []))
    if not video_stream:
        raise ValueError(f"No video stream found in: {source}")

    fmt = data.get("format", {})
    duration = _video_duration(fmt, video_stream, source)
    coded_width, coded_height, width, height, display_rotation = _video_dimensions(
        video_stream, source
    )
    fps = _parse_fps(video_stream)
    video_codec = video_stream.get("codec_name", "unknown")
    bitrate = _video_bitrate(video_stream, fmt)
    has_audio, audio_codec, audio_channels, audio_sample_rate, audio_bitrate = _audio_fields(
        audio_stream
    )

    nominal_fps = _fps_from_ratio(str(video_stream.get("r_frame_rate", "")))
    average_fps = _fps_from_ratio(str(video_stream.get("avg_frame_rate", "")))
    variable_frame_rate = (
        True if nominal_fps and average_fps and abs(nominal_fps - average_fps) > 0.001 else None
    )
    audio_stream_count = sum(
        1 for stream in data.get("streams", []) if stream.get("codec_type") == "audio"
    )
    subtitle_codecs = [
        str(stream.get("codec_name", ""))
        for stream in data.get("streams", [])
        if stream.get("codec_type") == "subtitle"
    ]

    return VideoInfo(
        variable_frame_rate=variable_frame_rate,
        average_fps=average_fps or 0.0,
        audio_stream_count=audio_stream_count,
        subtitle_codecs=subtitle_codecs,
        sample_aspect_ratio=video_stream.get("sample_aspect_ratio", "1:1"),
        pixel_format=video_stream.get("pix_fmt", ""),
        color_transfer=video_stream.get("color_transfer", "unknown"),
        color_space=video_stream.get("color_space", "unknown"),
        color_primaries=video_stream.get("color_primaries", "unknown"),
        color_range=video_stream.get("color_range", "unknown"),
        path=str(source),
        duration=duration,
        width=width,
        height=height,
        fps=fps,
        video_codec=video_codec,
        audio_codec=audio_codec,
        audio_channels=audio_channels,
        audio_sample_rate=audio_sample_rate,
        audio_bitrate=audio_bitrate,
        file_size=file_size,
        bitrate=bitrate,
        has_audio=has_audio,
        coded_width=coded_width,
        coded_height=coded_height,
        display_rotation=display_rotation,
    )


def _audio_duration(fmt: dict, audio_stream: dict, source: Path) -> float:
    duration = _parse_stream_duration(fmt, audio_stream, "audio")
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Cannot determine audio duration for: {source}")
    return duration


def _stream_int(stream: dict, name: str) -> int:
    try:
        return int(stream.get(name, 0) or 0)
    except (TypeError, ValueError):
        logger.warning("Could not parse audio %s from ffprobe", name)
        return 0


def probe_audio(source: str | Path) -> AudioInfo:
    ffprobe_path = media_tools.find_ffprobe()
    if not ffprobe_path:
        raise FileNotFoundError(
            "ffprobe not found. Install FFmpeg and ensure ffprobe is on PATH "
            "or set the path in settings."
        )

    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(f"Audio source file not found: {source}")

    try:
        return _audio_info(source, _read_with_pyav(source))
    except (FFmpegError, OSError, ValueError) as e:
        logger.debug("PyAV could not probe %s, using ffprobe: %s", source.name, e)
    return _audio_info(source, _run_ffprobe_json(ffprobe_path, source, "probing audio"))


def _audio_info(source: Path, data: dict) -> AudioInfo:
    audio_stream = next(
        (stream for stream in data.get("streams", []) if stream.get("codec_type") == "audio"),
        None,
    )
    if audio_stream is None:
        raise ValueError(f"No audio stream found in: {source}")

    fmt = data.get("format", {})
    duration = _audio_duration(fmt, audio_stream, source)

    return AudioInfo(
        path=str(source),
        duration=duration,
        codec=str(audio_stream.get("codec_name", "") or ""),
        channels=_stream_int(audio_stream, "channels"),
        sample_rate=_stream_int(audio_stream, "sample_rate"),
        bitrate=_stream_int(audio_stream, "bit_rate"),
        file_size=source.stat().st_size,
    )


def _parse_display_rotation(video_stream: dict) -> int:
    values: list[tuple[Any, int]] = []
    side_data = video_stream.get("side_data_list", [])
    if isinstance(side_data, list):
        values.extend((item.get("rotation"), 1) for item in side_data if isinstance(item, dict))
    tags = video_stream.get("tags", {})
    if isinstance(tags, dict):
        # legacy rotate tags use the opposite sign to display matrix angles
        values.append((tags.get("rotate"), -1))

    for value, direction in values:
        if value is None:
            continue
        try:
            rotation = float(value) * direction
        except (TypeError, ValueError):
            logger.warning("Could not parse display rotation from ffprobe: %r", value)
            continue
        if not math.isfinite(rotation):
            logger.warning("Ignoring non-finite display rotation from ffprobe: %r", value)
            continue
        nearest = round(rotation / _QUARTER_TURN) * _QUARTER_TURN
        if math.isclose(rotation, nearest, rel_tol=0.0, abs_tol=0.01):
            return nearest % _FULL_TURN
        logger.warning("Using non-quarter display rotation from ffprobe: %g", rotation)
        return round(rotation) % _FULL_TURN
    return 0


def _fps_from_ratio(val: str) -> float | None:
    if "/" not in val:
        return None
    parts = val.split("/")
    try:
        num = float(parts[0])
        den = float(parts[1])
        if den > 0:
            fps = num / den
            if fps > 0:
                return fps
    except (ValueError, ZeroDivisionError):
        logger.debug("Could not parse fps ratio from ffprobe: %r", val)
    return None


def _fps_from_float(val: str) -> float | None:
    try:
        fps = float(val)
        if fps > 0:
            return fps
    except (ValueError, TypeError):
        logger.debug("Could not parse fps value from ffprobe: %r", val)
    return None


def _parse_fps(video_stream: dict) -> float:
    for key in ("r_frame_rate", "avg_frame_rate"):
        val = video_stream.get(key)
        if val:
            fps = _fps_from_ratio(str(val))
            if fps is not None:
                return fps

    for key in ("r_frame_rate", "avg_frame_rate"):
        val = video_stream.get(key)
        if val:
            fps = _fps_from_float(str(val))
            if fps is not None:
                return fps

    return 0.0


def _parse_duration_str(dur: str) -> float:
    import re

    m = re.match(r"(\d+):(\d+):(\d+(?:\.\d+)?)", dur)
    if m:
        h, mn, s = m.groups()
        return int(h) * 3600 + int(mn) * 60 + float(s)
    return 0.0


def is_ffprobe_available() -> bool:
    return media_tools.find_ffprobe() is not None
