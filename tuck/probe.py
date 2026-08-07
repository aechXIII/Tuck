from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path

from .models import VideoInfo

logger = logging.getLogger(__name__)


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

    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid resolution in: {source}")

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
        file_size=file_size,
        bitrate=bitrate,
        has_audio=has_audio,
    )


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
