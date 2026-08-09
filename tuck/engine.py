from __future__ import annotations

from .encoding import (
    EncodeCancelled,
    EncodeError,
    FFmpegEngine,
    cleanup_cache,
    get_available_encoders,
)
from .encoding.capabilities import _find_ffmpeg
from .encoding.command import nvenc_preset as _nvenc_preset
from .encoding.command import scaler_to_ffmpeg_flag as _scaler_to_ffmpeg_flag


def is_ffmpeg_available() -> bool:
    return _find_ffmpeg() is not None


__all__ = [
    "EncodeCancelled",
    "EncodeError",
    "FFmpegEngine",
    "_find_ffmpeg",
    "_nvenc_preset",
    "_scaler_to_ffmpeg_flag",
    "cleanup_cache",
    "get_available_encoders",
    "is_ffmpeg_available",
]
