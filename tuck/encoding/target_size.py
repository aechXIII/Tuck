from __future__ import annotations

from dataclasses import dataclass

from ..formatting import format_size
from ..models import AUDIO_OVERHEAD_FACTOR

MIN_VIDEO_BITRATE = 50_000
MAX_AUDIO_BITRATE = 320_000
DEFAULT_MAX_RETRIES = 2
UNDERSHOOT_RATIO = 0.95
MAX_REFINEMENT_FACTOR = 2.0
SOFTWARE_TARGET_RATIO = 0.97
HARDWARE_TARGET_RATIO = 0.95
HARDWARE_SAFETY_EXTRA = 0.02
# growth below this between a retry and the one before it means more bitrate is
# not producing more bytes: the source is content-limited and further retries
# only cost a full re-encode each
CONTENT_LIMITED_GROWTH = 1.05


# an encoder that spent less than this share of its video bitrate was held back by the
# content, not the budget, so a little more bitrate encodes the same file again
UNUSED_BITRATE_SHARE = 0.9


def left_bitrate_unused(video_bytes: int, duration_s: float, video_bitrate: int) -> bool:
    """The encoded video used clearly less than the bitrate it was given."""

    if duration_s <= 0 or video_bitrate <= 0:
        return False
    return video_bytes * 8 / duration_s < video_bitrate * UNUSED_BITRATE_SHARE


def is_content_limited(
    previous_size: int,
    actual_size: int,
    target_size: int,
    *,
    growth_threshold: float = CONTENT_LIMITED_GROWTH,
) -> bool:
    """The last bitrate-raising retry barely grew an already-under-target output."""

    return actual_size <= target_size and actual_size <= previous_size * growth_threshold


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
    audio_tracks: int = 1,
) -> TargetSizePlan:
    """audio_bitrate, in and out, is per track; the audio budget covers all of them"""
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

    tracks = max(1, audio_tracks)
    audio_br = min(max(int(audio_bitrate), 0), MAX_AUDIO_BITRATE)
    audio_size = (audio_br * tracks / 8.0) * duration_s

    max_audio_budget = effective_target * 0.15
    if audio_br > 0 and audio_size > max_audio_budget:
        audio_br = max(8_000, int((max_audio_budget * 8.0) / duration_s / tracks))
        audio_size = (audio_br * tracks / 8.0) * duration_s

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
    non_video_size: int = 0,
) -> RetryDecision:
    if attempt >= max_attempts - 1:
        return RetryDecision(False, current_video_bitrate, "retry limit reached")
    if actual_size <= 0 or target_size <= 0 or current_video_bitrate <= 0:
        return RetryDecision(False, current_video_bitrate, "size or bitrate unavailable")
    oversized = actual_size > target_size
    if not oversized and actual_size >= target_size * UNDERSHOOT_RATIO:
        return RetryDecision(False, current_video_bitrate, "within acceptable range")

    # audio packets and container bytes stay fixed when only video bitrate changes
    fixed_size = non_video_size if 0 <= non_video_size < actual_size else 0
    target_ratio = HARDWARE_TARGET_RATIO if hardware_encoder else SOFTWARE_TARGET_RATIO
    video_budget = max(0, int(target_size * target_ratio) - fixed_size)
    measured_video_size = actual_size - fixed_size
    corrected = int(current_video_bitrate * video_budget / measured_video_size)
    if oversized:
        new_br = max(MIN_VIDEO_BITRATE, min(corrected, current_video_bitrate - 1))
        if new_br >= current_video_bitrate:
            return RetryDecision(False, current_video_bitrate, "minimum video bitrate reached")
        return RetryDecision(True, new_br, "output exceeded target size")

    # a short or unusually compressible first output must not cause an unbounded jump
    new_br = min(corrected, int(current_video_bitrate * MAX_REFINEMENT_FACTOR))
    if new_br > current_video_bitrate:
        return RetryDecision(True, new_br, "output substantially under target")
    return RetryDecision(False, current_video_bitrate, "no room to increase video bitrate")
