from __future__ import annotations

from dataclasses import dataclass

from ..formatting import format_size
from ..models import AUDIO_OVERHEAD_FACTOR

MIN_VIDEO_BITRATE = 50_000
MAX_AUDIO_BITRATE = 320_000
DEFAULT_MAX_RETRIES = 2
OVERSHOOT_RETRY_FACTOR = 0.90
UNDERSHOOT_RATIO = 0.75
UNDERSHOOT_BOOST_FACTOR = 1.08
HARDWARE_SAFETY_EXTRA = 0.02


@dataclass(frozen=True)
class TargetSizePlan:
    video_bitrate: int
    audio_bitrate: int
    estimated_size: int
    effective_duration: float
    effective_target: int
    safety_margin: float


@dataclass(frozen=True)
class RetryDecision:
    should_retry: bool
    new_video_bitrate: int
    reason: str


def calculate_target_size_bitrates(
    target_size: int,
    duration_s: float,
    audio_bitrate: int,
    *,
    hardware_encoder: bool = False,
    min_video_bitrate: int = MIN_VIDEO_BITRATE,
    overhead_factor: float = AUDIO_OVERHEAD_FACTOR,
) -> TargetSizePlan:
    if duration_s <= 0:
        raise ValueError(f"Invalid encode duration for target size: {duration_s:.3f}s")
    if target_size < 1024:
        raise ValueError(f"Target size too small: {target_size} bytes")

    safety = overhead_factor + (HARDWARE_SAFETY_EXTRA if hardware_encoder else 0.0)
    safety = min(max(safety, 0.02), 0.25)
    effective_target = int(target_size * (1.0 - safety))
    if effective_target < 1024:
        raise ValueError(
            f"Target size ({format_size(target_size)}) is too small after applying a safety margin."
        )

    audio_br = min(max(int(audio_bitrate), 0), MAX_AUDIO_BITRATE)
    audio_size = (audio_br / 8.0) * duration_s

    max_audio_budget = effective_target * 0.15
    if audio_br > 0 and audio_size > max_audio_budget:
        audio_size = max_audio_budget
        audio_br = max(8_000, int((audio_size * 8.0) / duration_s))
        audio_size = (audio_br / 8.0) * duration_s

    video_size_budget = effective_target - audio_size
    if video_size_budget <= 0:
        raise ValueError(
            f"Target size ({format_size(target_size)}) too small for "
            f"{duration_s:.1f}s video with audio. "
            f"Try a larger target or lower audio bitrate."
        )

    video_br = int((video_size_budget * 8.0) / duration_s)
    if video_br < min_video_bitrate:
        min_total = int((min_video_bitrate / 8.0) * duration_s + audio_size + target_size * safety)
        if min_total > target_size:
            raise ValueError(
                f"Target size ({format_size(target_size)}) is not realistic for "
                f"{duration_s:.1f}s of video. "
                f"Required video bitrate would be below "
                f"{min_video_bitrate // 1000} kbps. "
                f"Try a larger target or a shorter trim."
            )
        video_br = min_video_bitrate

    estimated = int((video_br / 8.0) * duration_s + audio_size + target_size * safety)
    return TargetSizePlan(
        video_bitrate=video_br,
        audio_bitrate=audio_br,
        estimated_size=estimated,
        effective_duration=duration_s,
        effective_target=effective_target,
        safety_margin=safety,
    )


def decide_retry(
    actual_size: int,
    target_size: int,
    current_video_bitrate: int,
    attempt: int,
    max_attempts: int,
    *,
    hardware_encoder: bool = False,
) -> RetryDecision:
    if attempt >= max_attempts - 1:
        return RetryDecision(False, current_video_bitrate, "retry limit reached")

    if actual_size > target_size:
        factor = OVERSHOOT_RETRY_FACTOR
        if hardware_encoder:
            factor = 0.88
        overshoot_ratio = actual_size / max(target_size, 1)
        if overshoot_ratio > 1.25:
            factor = min(factor, 0.82)
        new_br = max(MIN_VIDEO_BITRATE, int(current_video_bitrate * factor))
        if new_br >= current_video_bitrate:
            new_br = max(
                MIN_VIDEO_BITRATE, current_video_bitrate - max(1000, current_video_bitrate // 20)
            )
        return RetryDecision(True, new_br, "output exceeded target size")

    if actual_size < target_size * UNDERSHOOT_RATIO and current_video_bitrate > MIN_VIDEO_BITRATE:
        room = target_size / max(actual_size, 1)
        boost = min(UNDERSHOOT_BOOST_FACTOR, 1.0 + (room - 1.0) * 0.25)
        new_br = int(current_video_bitrate * boost)
        if new_br > current_video_bitrate:
            return RetryDecision(True, new_br, "output substantially under target")

    return RetryDecision(False, current_video_bitrate, "within acceptable range")
