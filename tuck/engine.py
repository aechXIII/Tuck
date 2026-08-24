from __future__ import annotations

from . import media_tools
from .encoding import (
    EncodeCancelled,
    EncodeError,
    FFmpegEngine,
    cleanup_cache,
    get_available_encoders,
)


def is_ffmpeg_available() -> bool:
    return media_tools.find_ffmpeg() is not None


__all__ = [
    "EncodeCancelled",
    "EncodeError",
    "FFmpegEngine",
    "cleanup_cache",
    "get_available_encoders",
    "is_ffmpeg_available",
]
