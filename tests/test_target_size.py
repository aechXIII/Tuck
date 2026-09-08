import pytest

from tuck.encoding.target_size import (
    MIN_VIDEO_BITRATE,
    calculate_target_size_bitrates,
    decide_retry,
    is_content_limited,
)


class TestTargetSizePlanning:
    def test_standard_calculation(self):
        plan = calculate_target_size_bitrates(10 * 1024 * 1024, 60.0, 128_000)
        assert plan.video_bitrate >= MIN_VIDEO_BITRATE
        assert plan.effective_duration == 60.0
        assert plan.estimated_size > 0

    def test_uses_trimmed_duration(self):
        full = calculate_target_size_bitrates(10 * 1024 * 1024, 120.0, 128_000)
        trimmed = calculate_target_size_bitrates(10 * 1024 * 1024, 30.0, 128_000)
        assert trimmed.video_bitrate > full.video_bitrate

    def test_safety_margin(self):
        plan = calculate_target_size_bitrates(10 * 1024 * 1024, 30.0, 96_000)
        assert plan.effective_target < 10 * 1024 * 1024
        assert plan.safety_margin > 0

    def test_hardware_extra_margin(self):
        soft = calculate_target_size_bitrates(
            10 * 1024 * 1024, 30.0, 96_000, hardware_encoder=False
        )
        hard = calculate_target_size_bitrates(10 * 1024 * 1024, 30.0, 96_000, hardware_encoder=True)
        assert hard.safety_margin > soft.safety_margin

    def test_very_small_target_raises(self):
        with pytest.raises(ValueError):
            calculate_target_size_bitrates(500, 10.0, 128_000)

    def test_zero_duration_raises(self):
        with pytest.raises(ValueError, match="duration"):
            calculate_target_size_bitrates(10 * 1024 * 1024, 0.0, 128_000)

    def test_impossible_long_video(self):
        with pytest.raises(ValueError):
            calculate_target_size_bitrates(2 * 1024 * 1024, 3600.0, 320_000)

    def test_minimum_video_bitrate_cannot_exceed_target(self):
        with pytest.raises(ValueError):
            calculate_target_size_bitrates(1024 * 1024, 155.0, 0)

    def test_audio_budget_capped(self):
        plan = calculate_target_size_bitrates(5 * 1024 * 1024, 20.0, 320_000)
        assert plan.audio_bitrate <= 320_000
        assert plan.video_bitrate >= MIN_VIDEO_BITRATE

    def test_copied_audio_is_reserved(self):
        target = 10 * 1024 * 1024
        no_audio = calculate_target_size_bitrates(target, 60.0, 0)
        copied_audio = calculate_target_size_bitrates(target, 60.0, 128_000)
        assert copied_audio.video_bitrate < no_audio.video_bitrate
        assert copied_audio.estimated_size <= target


class TestRetryPolicy:
    def test_overshoot_retries(self):
        d = decide_retry(12_000_000, 10_000_000, 2_000_000, attempt=0, max_attempts=3)
        assert d.should_retry
        assert d.new_video_bitrate < 2_000_000

    def test_within_target_no_retry(self):
        d = decide_retry(9_000_000, 10_000_000, 2_000_000, attempt=0, max_attempts=3)
        assert not d.should_retry

    def test_retry_limit(self):
        d = decide_retry(12_000_000, 10_000_000, 2_000_000, attempt=2, max_attempts=3)
        assert not d.should_retry

    def test_undershoot_may_retry(self):
        d = decide_retry(4_000_000, 10_000_000, 1_000_000, attempt=0, max_attempts=3)
        assert d.should_retry
        assert d.new_video_bitrate > 1_000_000

    def test_undershoot_stays_within_hard_limit_on_next_attempt(self):
        d = decide_retry(4_000_000, 10_000_000, 1_000_000, attempt=0, max_attempts=3)
        assert d.should_retry
        final = decide_retry(10_000_001, 10_000_000, d.new_video_bitrate, attempt=1, max_attempts=3)
        assert final.should_retry
        assert final.new_video_bitrate < d.new_video_bitrate


class TestContentLimited:
    def test_barely_grown_under_target_output_is_content_limited(self):
        # a synthetic clip: raising the bitrate moved the output 200_000 -> 205_000
        assert is_content_limited(200_000, 205_000, target_size=2_000_000)

    def test_output_that_grew_with_more_bitrate_is_not_content_limited(self):
        assert not is_content_limited(1_000_000, 1_400_000, target_size=2_000_000)

    def test_output_at_or_over_target_is_never_content_limited(self):
        # over target must keep going through the overshoot retry path
        assert not is_content_limited(2_000_000, 2_100_000, target_size=2_000_000)
        assert not is_content_limited(1_900_000, 2_000_001, target_size=2_000_000)
