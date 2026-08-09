from __future__ import annotations

from .capabilities import _find_ffmpeg as _find_ffmpeg
from .capabilities import (
    clear_encoder_cache,
    get_available_encoders,
    get_encoder_capabilities,
    resolve_encoder,
    select_auto_encoder,
)
from .command import build_base_cmd, nvenc_preset, scaler_to_ffmpeg_flag
from .progress import ProgressTracker, parse_ffmpeg_speed, parse_ffmpeg_time
from .runner import (
    EncodeCancelled,
    EncodeError,
    FFmpegEngine,
    cleanup_cache,
    is_ffmpeg_available,
)
from .target_size import (
    DEFAULT_MAX_RETRIES,
    MIN_VIDEO_BITRATE,
    TargetSizePlan,
    calculate_target_size_bitrates,
    decide_retry,
)

__all__ = [
    "DEFAULT_MAX_RETRIES",
    "MIN_VIDEO_BITRATE",
    "EncodeCancelled",
    "EncodeError",
    "FFmpegEngine",
    "ProgressTracker",
    "TargetSizePlan",
    "build_base_cmd",
    "calculate_target_size_bitrates",
    "cleanup_cache",
    "clear_encoder_cache",
    "decide_retry",
    "get_available_encoders",
    "get_encoder_capabilities",
    "is_ffmpeg_available",
    "nvenc_preset",
    "parse_ffmpeg_speed",
    "parse_ffmpeg_time",
    "resolve_encoder",
    "scaler_to_ffmpeg_flag",
    "select_auto_encoder",
]
