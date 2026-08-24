from __future__ import annotations

import json
import logging
import math
import os
import subprocess
from pathlib import Path
from typing import Any

from . import media_tools
from .models import AudioInfo, VideoInfo

logger = logging.getLogger(__name__)

_QUARTER_TURN = 90
_FULL_TURN = 360


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
            capture_output=True,
            text=True,
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
    data = _run_ffprobe_json(ffprobe_path, source, "probing")

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

    return VideoInfo(
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

    data = _run_ffprobe_json(ffprobe_path, source, "probing audio")

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
    values: list[Any] = []
    side_data = video_stream.get("side_data_list", [])
    if isinstance(side_data, list):
        values.extend(item.get("rotation") for item in side_data if isinstance(item, dict))
    tags = video_stream.get("tags", {})
    if isinstance(tags, dict):
        values.append(tags.get("rotate"))

    for value in values:
        if value is None:
            continue
        try:
            rotation = float(value)
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
