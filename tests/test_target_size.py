import pytest

from tuck.encoding.target_size import (
    MIN_VIDEO_BITRATE,
    TargetSizeTooSmall,
    calculate_target_size_bitrates,
    decide_retry,
    is_content_limited,
    left_bitrate_unused,
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

    def test_audio_budget_covers_every_track(self):
        target = 30 * 1024 * 1024
        one = calculate_target_size_bitrates(target, 60.0, 128_000)
        three = calculate_target_size_bitrates(target, 60.0, 128_000, audio_tracks=3)
        assert three.audio_bitrate == 128_000
        assert three.video_bitrate < one.video_bitrate
        assert three.estimated_size <= target

    def test_shared_audio_cap_is_split_between_tracks(self):
        target = 5 * 1024 * 1024
        plan = calculate_target_size_bitrates(target, 60.0, 320_000, audio_tracks=4)
        audio_bytes = plan.audio_bitrate * 4 / 8 * 60.0
        assert audio_bytes <= plan.effective_target * 0.15
        assert plan.audio_bitrate >= 8_000

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
        d = decide_retry(9_700_000, 10_000_000, 2_000_000, attempt=0, max_attempts=3)
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

    def test_video_that_used_far_less_than_its_bitrate_left_it_unused(self):
        # 10 s at 1 Mbps would be 1_250_000 bytes
        assert left_bitrate_unused(800_000, 10.0, 1_000_000)

    def test_video_that_used_its_bitrate_did_not_leave_it_unused(self):
        assert not left_bitrate_unused(1_200_000, 10.0, 1_000_000)

    def test_unknown_length_or_bitrate_never_counts_as_unused(self):
        assert not left_bitrate_unused(100, 0.0, 1_000_000)
        assert not left_bitrate_unused(100, 10.0, 0)


class TestMeasuredRetryPolicy:
    def test_large_overshoot_is_corrected_from_measured_size(self):
        decision = decide_retry(20_000_000, 10_000_000, 2_000_000, 0, 3)
        assert decision.should_retry
        assert decision.new_video_bitrate == 970_000

    def test_audio_and_container_bytes_do_not_scale_with_video_bitrate(self):
        decision = decide_retry(12_000_000, 10_000_000, 2_000_000, 0, 3, non_video_size=3_000_000)
        assert decision.should_retry
        assert decision.new_video_bitrate == 1_488_888

    def test_moderate_underfill_is_refined_toward_the_limit(self):
        decision = decide_retry(8_500_000, 10_000_000, 2_000_000, 0, 3)
        assert decision.should_retry
        assert decision.new_video_bitrate == 2_282_352

    def test_refinement_growth_is_bounded(self):
        decision = decide_retry(1_000_000, 10_000_000, 2_000_000, 0, 3)
        assert decision.new_video_bitrate == 4_000_000

    def test_hardware_correction_leaves_more_room_for_rate_control_variation(self):
        decision = decide_retry(
            12_000_000,
            10_000_000,
            2_000_000,
            0,
            3,
            non_video_size=3_000_000,
            hardware_encoder=True,
        )
        assert decision.new_video_bitrate == 1_444_444

    def test_underfill_at_the_minimum_bitrate_can_still_improve(self):
        decision = decide_retry(5_000_000, 10_000_000, MIN_VIDEO_BITRATE, 0, 3)
        assert decision.should_retry
        assert decision.new_video_bitrate > MIN_VIDEO_BITRATE

    def test_overshoot_at_the_minimum_bitrate_does_not_repeat_the_same_encode(self):
        decision = decide_retry(12_000_000, 10_000_000, MIN_VIDEO_BITRATE, 0, 3)
        assert not decision.should_retry

    @pytest.mark.parametrize("fixed", [-1, 12_000_000, 13_000_000])
    def test_invalid_non_video_measurement_uses_whole_file_correction(self, fixed):
        decision = decide_retry(12_000_000, 10_000_000, 2_000_000, 0, 3, non_video_size=fixed)
        assert decision.new_video_bitrate == 1_616_666

    @pytest.mark.parametrize("size", [9_500_000, 9_700_000, 10_000_000])
    def test_near_limit_results_do_not_spend_another_encode(self, size):
        assert not decide_retry(size, 10_000_000, 2_000_000, 0, 3).should_retry

    def test_fixed_bytes_that_exhaust_the_budget_stop_at_the_minimum(self):
        decision = decide_retry(12_000_000, 10_000_000, 2_000_000, 0, 3, non_video_size=10_000_000)
        assert decision.new_video_bitrate == MIN_VIDEO_BITRATE

    @pytest.mark.parametrize(
        "actual, target, bitrate", [(0, 10, 50_000), (10, 0, 50_000), (10, 20, 0)]
    )
    def test_missing_size_or_bitrate_does_not_request_an_encode(self, actual, target, bitrate):
        assert not decide_retry(actual, target, bitrate, 0, 3).should_retry


MB = 1024 * 1024


class TestATargetThatCannotWork:
    def test_says_the_size_the_length_and_a_size_that_works(self):
        with pytest.raises(TargetSizeTooSmall) as error:
            calculate_target_size_bitrates(20 * MB, 3600.0, 128_000)
        assert str(error.value) == (
            "20\u00a0MB is too small for 1:00:00 of video. Try at least 30\u00a0MB, or trim it."
        )
        assert error.value.field == "target_size"
        assert error.value.suggested_size == 30 * MB

    @pytest.mark.parametrize(
        ("target", "duration", "audio", "tracks", "hardware"),
        [
            (20 * MB, 3600.0, 128_000, 1, False),
            (20 * MB, 3600.0, 128_000, 1, True),
            (2 * MB, 3600.0, 320_000, 3, False),
            (MB, 155.0, 0, 1, False),
            (8 * MB, 2 * 3600.0, 96_000, 2, True),
            (500, 10.0, 128_000, 1, False),
        ],
    )
    def test_the_suggested_size_works_and_one_step_less_does_not(
        self, target, duration, audio, tracks, hardware
    ):
        def plan(size):
            return calculate_target_size_bitrates(
                size, duration, audio, hardware_encoder=hardware, audio_tracks=tracks
            )

        with pytest.raises(TargetSizeTooSmall) as error:
            plan(target)
        suggested = error.value.suggested_size
        assert suggested > target
        assert plan(suggested).video_bitrate >= MIN_VIDEO_BITRATE
        # the suggestion is a round number people would type, with no room to spare below it
        mb = suggested // MB
        assert suggested % MB == 0
        step = 1 if mb <= 10 else 5 if mb <= 100 else 10
        with pytest.raises(TargetSizeTooSmall):
            plan(suggested - step * MB)

    @pytest.mark.parametrize(
        ("target", "duration", "text"),
        [
            (MB, 155.0, "1 MB is too small for 2:35 of video. Try at least 2 MB, or trim it."),
            (
                int(7.5 * MB),
                5400.0,
                "7.5 MB is too small for 1:30:00 of video. Try at least 45 MB, or trim it.",
            ),
            (500, 10.0, "1 KB is too small for 0:10 of video. Try at least 1 MB, or trim it."),
        ],
    )
    def test_sizes_and_lengths_read_the_way_the_editor_shows_them(self, target, duration, text):
        with pytest.raises(TargetSizeTooSmall) as error:
            calculate_target_size_bitrates(target, duration, 128_000)
        # sizes keep their unit on the same line
        assert str(error.value).replace("\u00a0", " ") == text


def test_the_size_problem_reaches_the_page_as_a_target_size_error(tmp_path, monkeypatch):
    from tuck.bridge import BridgeAPI
    from tuck.models import VideoInfo
    from tuck.settings import configure_storage_root
    from tuck.sidecar.handlers import dispatch
    from tuck.sidecar.protocol import Request

    monkeypatch.setattr("tuck.settings._settings_manager", None)
    monkeypatch.setattr("tuck.settings._storage_root", None)
    configure_storage_root(tmp_path / "storage")
    try:
        source = tmp_path / "match.mp4"
        source.write_bytes(b"source")
        api = BridgeAPI()
        info = VideoInfo(
            path=str(source),
            duration=3600,
            width=1280,
            height=720,
            fps=30,
            video_codec="h264",
            pixel_format="yuv420p",
            has_audio=True,
            audio_bitrate=128_000,
        )
        monkeypatch.setattr(api, "_probe_once", lambda path: info)
        raw = {"source": str(source), "target_size_mb": 20}
        response = dispatch(api, Request("plan", "create_plan", {"request": raw}))
    finally:
        monkeypatch.setattr("tuck.settings._settings_manager", None)
        configure_storage_root(None)

    assert not response.ok
    assert response.error is not None
    assert response.error.details["field"] == "target_size"
    assert response.error.message.startswith("20\u00a0MB is too small for 1:00:00 of video.")
