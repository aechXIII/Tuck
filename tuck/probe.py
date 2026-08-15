from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .models import AudioInfo, VideoInfo

logger = logging.getLogger(__name__)

_QUARTER_TURN = 90
_FULL_TURN = 360


def _find_ffprobe() -> str | None:
    from .settings import get_settings_manager

    mgr = get_settings_manager()
    custom = mgr.get_setting("ffprobe_path", "")
    if custom and Path(custom).is_file():
        return custom

    found = shutil.which("ffprobe")
    if found:
        return found

    candidates = [
        r"C:\ffmpeg\bin\ffprobe.exe",
        r"C:\Program Files\ffmpeg\bin\ffprobe.exe",
        r"C:\Program Files (x86)\ffmpeg\bin\ffprobe.exe",
    ]
    for c in candidates:
        if Path(c).is_file():
            return c

    return None


def probe(source: str | Path) -> VideoInfo:
    ffprobe_path = _find_ffprobe()
    if not ffprobe_path:
        raise FileNotFoundError(
            "ffprobe not found. Install FFmpeg and ensure ffprobe is on PATH "
            "or set the path in settings."
        )

    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(f"Source file not found: {source}")

    file_size = source.stat().st_size

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
        raise RuntimeError(f"ffprobe timed out probing: {source}") from None

    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            cmd,
            output=result.stdout,
            stderr=result.stderr,
        )

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse ffprobe output: {e}") from e

    streams = data.get("streams", [])
    video_stream = None
    audio_stream = None
    for s in streams:
        if s.get("codec_type") == "video" and video_stream is None:
            video_stream = s
        elif s.get("codec_type") == "audio" and audio_stream is None:
            audio_stream = s

    if not video_stream:
        raise ValueError(f"No video stream found in: {source}")

    duration = 0.0
    fmt = data.get("format", {})
    dur_str = fmt.get("duration") or video_stream.get("duration")
    if dur_str:
        try:
            duration = float(dur_str)
        except (ValueError, TypeError):
            logger.warning("Could not parse duration from ffprobe: %r", dur_str)

    if duration <= 0 and "tags" in video_stream:
        dur_tag = video_stream["tags"].get("DURATION")
        if dur_tag:
            duration = _parse_duration_str(dur_tag)

    if duration <= 0:
        raise ValueError(f"Cannot determine duration for: {source}")

    coded_width = int(video_stream.get("width", 0))
    coded_height = int(video_stream.get("height", 0))
    if coded_width <= 0 or coded_height <= 0:
        raise ValueError(f"Invalid resolution in: {source}")
    display_rotation = _parse_display_rotation(video_stream)
    if display_rotation in (90, 270):
        width, height = coded_height, coded_width
    else:
        width, height = coded_width, coded_height

    fps = _parse_fps(video_stream)

    video_codec = video_stream.get("codec_name", "unknown")

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


def probe_audio(source: str | Path) -> AudioInfo:
    ffprobe_path = _find_ffprobe()
    if not ffprobe_path:
        raise FileNotFoundError(
            "ffprobe not found. Install FFmpeg and ensure ffprobe is on PATH "
            "or set the path in settings."
        )

    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(f"Audio source file not found: {source}")

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
        raise RuntimeError(f"ffprobe timed out probing audio: {source}") from None
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            cmd,
            output=result.stdout,
            stderr=result.stderr,
        )

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Failed to parse ffprobe output: {exc}") from exc

    audio_stream = next(
        (stream for stream in data.get("streams", []) if stream.get("codec_type") == "audio"),
        None,
    )
    if audio_stream is None:
        raise ValueError(f"No audio stream found in: {source}")

    fmt = data.get("format", {})
    duration = 0.0
    duration_value = fmt.get("duration") or audio_stream.get("duration")
    if duration_value:
        try:
            duration = float(duration_value)
        except (TypeError, ValueError):
            logger.warning("Could not parse audio duration from ffprobe: %r", duration_value)
    if duration <= 0:
        tags = audio_stream.get("tags", {})
        if isinstance(tags, dict) and tags.get("DURATION"):
            duration = _parse_duration_str(str(tags["DURATION"]))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Cannot determine audio duration for: {source}")

    def _stream_int(name: str) -> int:
        try:
            return int(audio_stream.get(name, 0) or 0)
        except (TypeError, ValueError):
            logger.warning("Could not parse audio %s from ffprobe", name)
            return 0

    return AudioInfo(
        path=str(source),
        duration=duration,
        codec=str(audio_stream.get("codec_name", "") or ""),
        channels=_stream_int("channels"),
        sample_rate=_stream_int("sample_rate"),
        bitrate=_stream_int("bit_rate"),
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


def _parse_fps(video_stream: dict) -> float:
    for key in ("r_frame_rate", "avg_frame_rate"):
        val = video_stream.get(key)
        if val and "/" in str(val):
            parts = str(val).split("/")
            try:
                num = float(parts[0])
                den = float(parts[1])
                if den > 0:
                    fps = num / den
                    if fps > 0:
                        return fps
            except (ValueError, ZeroDivisionError):
                continue

    for key in ("r_frame_rate", "avg_frame_rate"):
        val = video_stream.get(key)
        if val:
            try:
                fps = float(val)
                if fps > 0:
                    return fps
            except (ValueError, TypeError):
                pass

    return 0.0


def _parse_duration_str(dur: str) -> float:
    import re

    m = re.match(r"(\d+):(\d+):(\d+(?:\.\d+)?)", dur)
    if m:
        h, mn, s = m.groups()
        return int(h) * 3600 + int(mn) * 60 + float(s)
    return 0.0


def is_ffprobe_available() -> bool:
    return _find_ffprobe() is not None
