import os
import time
from pathlib import Path

import pytest

from tuck.models import (
    DEFAULT_PROFILES,
    FPS_MODE_CUSTOM,
    FPS_MODE_SOURCE,
    PROFILE_ID_4K_UPSCALE,
    PROFILE_ID_1440P_UPSCALE,
    PROFILE_ID_DISCORD_FREE,
    PROFILE_ID_DISCORD_NITRO,
    RC_EXPLICIT_BITRATE,
    RC_TARGET_SIZE,
    RES_MODE_CUSTOM,
    RES_MODE_LIMIT,
    RES_MODE_SOURCE,
    SCALER_BICUBIC,
    SCALER_LANCZOS,
    SCALER_NEIGHBOR,
    SIZING_MODE_FIT,
    WORKFLOW_COMPRESSION,
    WORKFLOW_UPSCALE,
    CropRect,
    PlanRequest,
    Profile,
    Segment,
    SourceAudioTrack,
    SourceTrackSetting,
    VideoInfo,
    VideoTransform,
    find_profile_by_id,
)
from tuck.output_paths import resolve_output_collision
from tuck.planner import HDR_NOT_CONVERTED_WARNING, _make_even, _scale_resolution, plan
from tuck.planner_options import resolve_plan_options


class TestScaleResolution:
    def test_no_scaling_when_within_limits(self):
        w, h = _scale_resolution(640, 480, 1920, 1080)
        assert w == 640
        assert h == 480

    def test_scale_down_width(self):
        w, h = _scale_resolution(3840, 2160, 1920, 1080)
        assert w == 1920
        assert h == 1080

    def test_scale_down_height(self):
        w, h = _scale_resolution(1080, 1920, 1920, 1080)
        assert w <= 1080
        assert h <= 1080

    def test_even_dimensions(self):
        w, h = _scale_resolution(1921, 1081, 1920, 1080)
        assert w % 2 == 0
        assert h % 2 == 0

    def test_square_input(self):
        w, h = _scale_resolution(4000, 4000, 1000, 1000)
        assert w == 1000
        assert h == 1000

    def test_make_even(self):
        w, h = _make_even(1919, 1079)
        assert w == 1918
        assert h == 1078
        w2, h2 = _make_even(1920, 1080)
        assert w2 == 1920
        assert h2 == 1080


def test_linux_rejects_saved_amf_profile_when_planning(monkeypatch) -> None:
    profile = Profile(name="Hardware", video_encoder="h264_amf", two_pass=False)
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")

    with pytest.raises(ValueError, match="not supported on Linux"):
        resolve_plan_options(profile, None)

    assert profile.video_encoder == "h264_amf"


class TestCropPlanning:
    def test_no_crop_preserves_source_resolution(
        self, skip_if_no_ffprobe, sample_video_path
    ) -> None:
        profile = Profile(name="No crop", resolution_mode=RES_MODE_SOURCE, two_pass=False)

        result = plan(str(sample_video_path), profile)

        assert result.transform.crop is None
        assert result.source_info is not None
        assert result.target_width == result.source_info.width
        assert result.target_height == result.source_info.height
        assert not result.apply_scale

    def test_crop_defines_source_resolution_before_scaling(
        self, skip_if_no_ffprobe, sample_video_path
    ) -> None:
        profile = Profile(name="Crop", resolution_mode=RES_MODE_SOURCE, two_pass=False)
        crop = CropRect(10, 12, 40, 30)
        request = PlanRequest(transform=VideoTransform(crop=crop, sizing_mode=SIZING_MODE_FIT))

        result = plan(str(sample_video_path), profile, request=request)

        assert result.transform.crop == crop
        assert (result.target_width, result.target_height) == (40, 30)
        assert not result.apply_scale

    def test_crop_then_custom_scale(self, skip_if_no_ffprobe, sample_video_path) -> None:
        profile = Profile(name="Crop scale", resolution_mode=RES_MODE_SOURCE, two_pass=False)
        request = PlanRequest(
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=32,
            custom_height=24,
            transform=VideoTransform(crop=CropRect(10, 12, 40, 30)),
        )

        result = plan(str(sample_video_path), profile, request=request)

        assert (result.target_width, result.target_height) == (32, 24)
        assert result.apply_scale

    def test_crop_outside_probed_source_is_rejected(
        self, skip_if_no_ffprobe, sample_video_path
    ) -> None:
        profile = Profile(name="Bad crop", two_pass=False)
        request = PlanRequest(transform=VideoTransform(crop=CropRect(40, 40, 40, 30)))

        with pytest.raises(ValueError, match="inside source"):
            plan(str(sample_video_path), profile, request=request)


class TestPlan:
    def test_plan_with_default_profile(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        p = plan(str(sample_video_path), profile)
        assert p.source == str(sample_video_path)
        assert "_tucked" in str(p.output) and p.output.endswith(".mp4")
        assert p.profile_id == PROFILE_ID_DISCORD_FREE
        assert p.target_width > 0
        assert p.target_height > 0
        assert p.video_bitrate > 0

    def test_plan_source_preserve_resolution(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-src",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
        )
        p = plan(str(sample_video_path), profile)
        if p.source_info:
            assert abs(p.target_width - p.source_info.width) <= 1
            assert abs(p.target_height - p.source_info.height) <= 1

            if p.target_width == p.source_info.width and p.target_height == p.source_info.height:
                assert p.apply_scale is False

    def test_plan_source_preserve_fps(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-src2",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
        )
        p = plan(str(sample_video_path), profile)
        if p.source_info:
            assert p.target_fps == p.source_info.fps
            assert p.apply_fps_filter is False

    def test_plan_limit_resolution(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-limit",
            resolution_mode=RES_MODE_LIMIT,
            max_width=320,
            max_height=240,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
        )
        p = plan(str(sample_video_path), profile)
        assert p.target_width <= 320
        assert p.target_height <= 240

    def test_plan_custom_resolution(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-cust",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=640,
            custom_height=360,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
        )
        p = plan(str(sample_video_path), profile)

        assert p.target_width == 640
        assert p.target_height == 360
        assert p.apply_scale is True

    def test_plan_custom_fps(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-cfps",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_CUSTOM,
            custom_fps=15.0,
            target_size_bytes=100 * 1024 * 1024,
        )
        p = plan(str(sample_video_path), profile)
        if p.source_info:
            assert p.target_fps <= p.source_info.fps

    def test_compression_explicit_bitrate_is_rejected(self, skip_if_no_ffprobe, sample_video_path):
        profile = Profile(
            name="test",
            profile_id="test-ebr",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            rate_control=RC_EXPLICIT_BITRATE,
            explicit_bitrate=2_000_000,
            target_size_bytes=100 * 1024 * 1024,
        )
        with pytest.raises(ValueError, match="requires rate_control 'target_size'"):
            plan(str(sample_video_path), profile)

    def test_plan_with_output_dir(self, skip_if_no_ffprobe, sample_video_path, tmp_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        out_dir = tmp_path / "output"
        out_dir.mkdir()
        p = plan(str(sample_video_path), profile, output_dir=str(out_dir))
        assert Path(p.output).parent == out_dir

    def test_plan_output_differs_from_source(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        p = plan(str(sample_video_path), profile)
        assert Path(p.output) != Path(p.source)

    def test_plan_target_size_respected(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_NITRO)
        p = plan(str(sample_video_path), profile)
        assert p.target_size == 500 * 1024 * 1024

    def test_plan_audio_bitrate_zero_when_no_audio(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        p = plan(str(sample_video_path), profile)
        if not p.source_info.has_audio:
            assert p.audio_bitrate == 0

    def test_plan_estimated_size_within_target(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        p = plan(str(sample_video_path), profile)
        assert p.estimated_size <= p.target_size * 1.1

    def test_target_size_reencodes_audio_when_copy_would_exceed_budget(self, tmp_path, monkeypatch):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        info = VideoInfo(
            path=str(source),
            duration=60.0,
            width=1280,
            height=720,
            fps=30.0,
            video_codec="h264",
            audio_codec="aac",
            audio_channels=2,
            audio_sample_rate=48_000,
            audio_bitrate=1_500_000,
            has_audio=True,
        )
        monkeypatch.setattr("tuck.probe.probe", lambda _: info)
        profile = Profile(
            name="test",
            profile_id="test-copy-audio-budget",
            target_size_bytes=10 * 1024 * 1024,
            keep_audio=True,
        )

        result = plan(source, profile)

        assert not result.copy_audio
        assert result.audio_bitrate < info.audio_bitrate
        assert result.estimated_size <= result.target_size

    def test_plan_output_collision(self, skip_if_no_ffprobe, sample_video_path, tmp_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        out_dir = tmp_path / "collision"
        out_dir.mkdir()
        colliding = out_dir / f"{Path(sample_video_path).stem}_tucked.mp4"
        colliding.write_text("placeholder")
        p = plan(
            str(sample_video_path),
            profile,
            output_dir=str(out_dir),
            compression_suffix="_tucked",
        )
        assert Path(p.output) != colliding
        assert "_1" in Path(p.output).stem

    def test_plan_explicit_output_path(self, skip_if_no_ffprobe, sample_video_path, tmp_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        out = tmp_path / "custom_output.mp4"
        p = plan(str(sample_video_path), profile, output=str(out))
        assert Path(p.output) == out

    def test_plan_resolution_never_upscaled(self, skip_if_no_ffprobe, sample_video_path):
        profile = Profile(
            name="test",
            profile_id="test-noup",
            max_width=3840,
            max_height=2160,
            target_size_bytes=10 * 1024 * 1024,
            resolution_mode=RES_MODE_LIMIT,
        )
        p = plan(str(sample_video_path), profile)
        if p.source_info:
            assert p.target_width <= p.source_info.width
            assert p.target_height <= p.source_info.height

    def test_plan_custom_resolution_allows_upscale(self, skip_if_no_ffprobe, sample_video_path):
        profile = Profile(
            name="test",
            profile_id="test-upscale",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=3840,
            custom_height=2160,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            scaler=SCALER_LANCZOS,
        )
        p = plan(str(sample_video_path), profile)
        assert p.target_width == 3840
        assert p.target_height == 2160
        assert p.apply_scale is True
        assert p.scaler == SCALER_LANCZOS

    def test_plan_scaler_is_smooth_or_sharp_pixels(self, skip_if_no_ffprobe, sample_video_path):
        expected = {
            "bilinear": "lanczos",
            "bicubic": "lanczos",
            "lanczos": "lanczos",
            "point": "neighbor",
            "nearest": "neighbor",
        }
        for scaler, planned in expected.items():
            profile = Profile(
                name="test",
                profile_id=f"test-scaler-{scaler}",
                resolution_mode=RES_MODE_CUSTOM,
                custom_width=640,
                custom_height=360,
                fps_mode=FPS_MODE_SOURCE,
                target_size_bytes=100 * 1024 * 1024,
                scaler=scaler,
            )
            p = plan(str(sample_video_path), profile)
            assert p.scaler == planned

    def test_plan_request_scaler_override(self, skip_if_no_ffprobe, sample_video_path):
        """Request scaler overrides profile scaler."""
        profile = Profile(
            name="test",
            profile_id="test-scaler-override",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=640,
            custom_height=360,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            scaler=SCALER_BICUBIC,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            scaler=SCALER_LANCZOS,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.scaler == SCALER_LANCZOS

    def test_plan_request_no_scaler_uses_profile(self, skip_if_no_ffprobe, sample_video_path):
        """When request has no scaler, profile scaler is used."""
        profile = Profile(
            name="test",
            profile_id="test-scaler-profile",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=640,
            custom_height=360,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            scaler=SCALER_NEIGHBOR,
        )
        req = PlanRequest(source=str(sample_video_path))
        p = plan(str(sample_video_path), profile, request=req)
        assert p.scaler == SCALER_NEIGHBOR

    def test_plan_original_video_bitrate_stored(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        p = plan(str(sample_video_path), profile)
        assert p.original_video_bitrate == p.video_bitrate

    def test_plan_request_overrides_profile(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-override",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            rate_control=RC_TARGET_SIZE,
            target_size_bytes=100 * 1024 * 1024,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            profile_id="test-override",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=320,
            custom_height=240,
            fps_mode=FPS_MODE_CUSTOM,
            custom_fps=15.0,
            rate_control=RC_TARGET_SIZE,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.resolution_mode == RES_MODE_CUSTOM
        assert p.fps_mode == FPS_MODE_CUSTOM
        assert p.rate_control == RC_TARGET_SIZE
        assert p.video_bitrate > 0

    def test_plan_request_none_fields_no_override(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-none-override",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=640,
            custom_height=360,
            fps_mode=FPS_MODE_CUSTOM,
            custom_fps=15.0,
            rate_control=RC_TARGET_SIZE,
            audio_bitrate=192_000,
            target_size_bytes=100 * 1024 * 1024,
        )

        req = PlanRequest(source=str(sample_video_path))
        p = plan(str(sample_video_path), profile, request=req)
        assert p.resolution_mode == RES_MODE_CUSTOM
        assert p.fps_mode == FPS_MODE_CUSTOM
        assert p.rate_control == RC_TARGET_SIZE
        assert p.video_bitrate > 0

        assert p.audio_bitrate == 0

    def test_plan_request_audio_bitrate_fallback(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-audio-fb",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            rate_control=RC_TARGET_SIZE,
            audio_bitrate=256_000,
            target_size_bytes=100 * 1024 * 1024,
        )

        req = PlanRequest(
            source=str(sample_video_path),
            resolution_mode=RES_MODE_SOURCE,
        )
        p = plan(str(sample_video_path), profile, request=req)

        assert p.audio_bitrate == 0

    def test_plan_request_audio_bitrate_override(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-audio-ov",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            rate_control=RC_TARGET_SIZE,
            audio_bitrate=128_000,
            target_size_bytes=100 * 1024 * 1024,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            audio_bitrate=320_000,
        )
        p = plan(str(sample_video_path), profile, request=req)

        assert p.audio_bitrate == 0

    def test_plan_request_target_size_override(self, skip_if_no_ffprobe, sample_video_path):

        profile = Profile(
            name="test",
            profile_id="test-ts-override",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            rate_control=RC_TARGET_SIZE,
            audio_bitrate=128_000,
            target_size_bytes=500 * 1024 * 1024,  # 500 MB profile
        )

        req = PlanRequest(
            source=str(sample_video_path),
            target_size_bytes=50 * 1024 * 1024,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.target_size == 50 * 1024 * 1024

    def test_plan_video_encoder_from_profile(self, skip_if_no_ffprobe, sample_video_path):
        """Profile video_encoder is used when request has no override."""
        profile = Profile(
            name="test",
            profile_id="test-ve-profile",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            video_encoder="libx265",
        )
        p = plan(str(sample_video_path), profile)
        assert p.video_encoder == "libx265"

    def test_plan_video_encoder_request_override(self, skip_if_no_ffprobe, sample_video_path):
        """Request video_encoder overrides profile video_encoder."""
        profile = Profile(
            name="test",
            profile_id="test-ve-override",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            video_encoder="libx264",
        )
        req = PlanRequest(
            source=str(sample_video_path),
            video_encoder="libx265",
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.video_encoder == "libx265"

    def test_plan_crf_from_profile(self, skip_if_no_ffprobe, sample_video_path):
        """Profile crf is used when request has no override."""
        profile = Profile(
            name="test",
            profile_id="test-crf-profile",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            crf=18,
        )
        p = plan(str(sample_video_path), profile)
        assert p.crf == 18

    def test_plan_crf_request_override(self, skip_if_no_ffprobe, sample_video_path):
        """Request crf overrides profile crf."""
        profile = Profile(
            name="test",
            profile_id="test-crf-override",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            crf=23,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            crf=30,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.crf == 30

    def test_plan_tune_from_profile(self, skip_if_no_ffprobe, sample_video_path):
        """Profile tune is used when request has no override."""
        profile = Profile(
            name="test",
            profile_id="test-tune-profile",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            tune="animation",
        )
        p = plan(str(sample_video_path), profile)
        assert p.tune == "animation"

    def test_plan_tune_request_override(self, skip_if_no_ffprobe, sample_video_path):
        """Request tune overrides profile tune."""
        profile = Profile(
            name="test",
            profile_id="test-tune-override",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            tune="film",
        )
        req = PlanRequest(
            source=str(sample_video_path),
            tune="grain",
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.tune == "grain"

    def test_plan_request_none_encoder_fields_no_override(
        self, skip_if_no_ffprobe, sample_video_path
    ):
        """When request has None for encoder fields, profile defaults are used."""
        profile = Profile(
            name="test",
            profile_id="test-enc-none",
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            video_encoder="libx265",
            crf=18,
            tune="animation",
        )
        req = PlanRequest(source=str(sample_video_path))
        p = plan(str(sample_video_path), profile, request=req)
        assert p.video_encoder == "libx265"
        assert p.crf == 18
        assert p.tune == "animation"


class TestOutputCollision:
    def test_no_collision_when_file_does_not_exist(self, tmp_path):
        output = tmp_path / "output.mp4"
        result = resolve_output_collision(output)
        assert result == output

    def test_collision_appends_counter(self, tmp_path):
        output = tmp_path / "output.mp4"
        output.write_text("existing")
        result = resolve_output_collision(output)
        assert result != output
        assert result.parent == output.parent
        assert "_1" in result.stem

    def test_multiple_collisions_increment(self, tmp_path):
        output = tmp_path / "output.mp4"
        output.write_text("existing")
        (tmp_path / "output_1.mp4").write_text("existing")
        (tmp_path / "output_2.mp4").write_text("existing")
        result = resolve_output_collision(output)
        assert result.name == "output_3.mp4"

    def test_duplicate_pending_plans_get_different_paths(self, tmp_path):
        output = tmp_path / "output.mp4"
        first = resolve_output_collision(output)
        assert first == output
        output.write_text("first encode done")
        second = resolve_output_collision(output)
        assert second != output
        assert second.name == "output_1.mp4"

    def test_preview_ignores_reservation_marker(self, tmp_path):
        output = tmp_path / "output.mp4"
        output.with_suffix(".mp4.reserved").write_text("interrupted encode")

        assert resolve_output_collision(output, respect_reservation=False) == output

    def test_execution_uses_a_new_path_for_reservation_marker(self, tmp_path):
        output = tmp_path / "output.mp4"
        marker = output.with_suffix(".mp4.reserved")
        marker.write_text("active encode")

        result = resolve_output_collision(output)

        assert result.name == "output_1.mp4"
        assert marker.exists()

    def test_execution_preserves_old_reservation_marker(self, tmp_path):
        output = tmp_path / "output.mp4"
        marker = output.with_suffix(".mp4.reserved")
        marker.write_text("active encode")
        old = time.time() - 86401
        os.utime(marker, (old, old))

        assert resolve_output_collision(output).name == "output_1.mp4"
        assert marker.exists()


class TestUpscaleWorkflow:
    def test_upscale_profile_plan_has_zero_bitrate(self, skip_if_no_ffprobe, sample_video_path):
        """Upscale workflow sets video_bitrate=0 and estimated_size=0."""
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_1440P_UPSCALE)
        p = plan(str(sample_video_path), profile)
        assert p.workflow == WORKFLOW_UPSCALE
        assert p.video_bitrate == 0
        assert p.estimated_size == 0
        # the sample is square, and 1440p sizes its short side
        assert p.target_width == 1440
        assert p.target_height == 1440

    def test_upscale_4k_profile_dimensions(self, skip_if_no_ffprobe, sample_video_path):
        """4K upscale makes the short side 2160."""
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_4K_UPSCALE)
        p = plan(str(sample_video_path), profile)
        assert p.workflow == WORKFLOW_UPSCALE
        assert p.target_width == 2160
        assert p.target_height == 2160
        assert p.video_bitrate == 0

    def test_upscale_profile_uses_crf_from_profile(self, skip_if_no_ffprobe, sample_video_path):
        """Upscale profile passes CRF value through to plan."""
        profile = Profile(
            name="test",
            profile_id="test-upscale-crf",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=1920,
            custom_height=1080,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=500 * 1024 * 1024,
            workflow=WORKFLOW_UPSCALE,
            crf=18,
            two_pass=False,
        )
        p = plan(str(sample_video_path), profile)
        assert p.crf == 18
        assert p.two_pass is False

    def test_upscale_request_override_workflow(self, skip_if_no_ffprobe, sample_video_path):
        """Request workflow override propagates to plan."""
        profile = Profile(
            name="test",
            profile_id="test-wf-override",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=1920,
            custom_height=1080,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=100 * 1024 * 1024,
            workflow=WORKFLOW_COMPRESSION,
            two_pass=False,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            workflow=WORKFLOW_UPSCALE,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.workflow == WORKFLOW_UPSCALE
        assert p.video_bitrate == 0

    def test_upscale_request_override_rate_control_method(
        self, skip_if_no_ffprobe, sample_video_path
    ):
        """Request rate_control_method override propagates to plan."""
        profile = Profile(
            name="test",
            profile_id="test-rcm-override",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=1920,
            custom_height=1080,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=500 * 1024 * 1024,
            workflow=WORKFLOW_UPSCALE,
            rate_control_method="crf",
            crf=18,
            two_pass=False,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            rate_control_method="cbr",
            rate_control="explicit_bitrate",
            explicit_bitrate=5_000_000,
            qp=20,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.rate_control_method == "cbr"
        assert p.qp == 20

    def test_upscale_request_override_qp(self, skip_if_no_ffprobe, sample_video_path):
        """Request qp override propagates to plan."""
        profile = Profile(
            name="test",
            profile_id="test-qp-override",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=1920,
            custom_height=1080,
            fps_mode=FPS_MODE_SOURCE,
            target_size_bytes=500 * 1024 * 1024,
            workflow=WORKFLOW_UPSCALE,
            rate_control_method="cqp",
            video_encoder="h264_nvenc",
            qp=23,
            two_pass=False,
        )
        req = PlanRequest(
            source=str(sample_video_path),
            qp=18,
        )
        p = plan(str(sample_video_path), profile, request=req)
        assert p.qp == 18

    def test_upscale_explicit_bitrate_reaches_the_encoder(
        self, skip_if_no_ffprobe, sample_video_path
    ):
        profile = Profile(
            name="test",
            profile_id="test-upscale-cbr",
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=1920,
            custom_height=1080,
            fps_mode=FPS_MODE_SOURCE,
            workflow=WORKFLOW_UPSCALE,
            rate_control=RC_EXPLICIT_BITRATE,
            rate_control_method="cbr",
            video_encoder="h264_nvenc",
            explicit_bitrate=5_000_000,
            two_pass=False,
        )

        p = plan(str(sample_video_path), profile)

        assert p.video_bitrate == 5_000_000
        assert p.explicit_bitrate == 5_000_000
        assert p.estimated_size == 0


class TestEncoderRateControlCompatibility:
    def test_cpu_encoders_accept_crf(self):
        """CPU encoders accept CRF rate control method."""
        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        validate_rc_method_for_encoder("crf", "libx264")
        validate_rc_method_for_encoder("crf", "libx265")

    def test_cpu_encoders_accept_cbr(self):
        """CPU encoders accept CBR rate control method."""
        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        validate_rc_method_for_encoder("cbr", "libx264")
        validate_rc_method_for_encoder("cbr", "libx265")

    def test_cpu_encoders_reject_cqp(self):
        """CPU encoders reject CQP rate control method."""
        import pytest

        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        with pytest.raises(ValueError, match="not supported for libx264"):
            validate_rc_method_for_encoder("cqp", "libx264")
        with pytest.raises(ValueError, match="not supported for libx265"):
            validate_rc_method_for_encoder("cqp", "libx265")

    def test_cpu_encoders_reject_vbr(self):
        """CPU encoders reject VBR rate control method."""
        import pytest

        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        with pytest.raises(ValueError, match="not supported for libx264"):
            validate_rc_method_for_encoder("vbr", "libx264")

    def test_nvenc_encoders_accept_cqp_cbr_vbr(self):
        """NVENC encoders accept CQP, CBR, VBR."""
        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        for enc in ("h264_nvenc", "hevc_nvenc"):
            validate_rc_method_for_encoder("cqp", enc)
            validate_rc_method_for_encoder("cbr", enc)
            validate_rc_method_for_encoder("vbr", enc)

    def test_nvenc_encoders_reject_crf(self):
        """NVENC encoders reject CRF."""
        import pytest

        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        with pytest.raises(ValueError, match="not supported for h264_nvenc"):
            validate_rc_method_for_encoder("crf", "h264_nvenc")

    def test_amf_encoders_accept_cqp_cbr_vbr(self):
        """AMF encoders accept CQP, CBR, VBR."""
        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        for enc in ("h264_amf", "hevc_amf"):
            validate_rc_method_for_encoder("cqp", enc)
            validate_rc_method_for_encoder("cbr", enc)
            validate_rc_method_for_encoder("vbr", enc)

    def test_amf_encoders_reject_crf(self):
        """AMF encoders reject CRF."""
        import pytest

        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        with pytest.raises(ValueError, match="not supported for h264_amf"):
            validate_rc_method_for_encoder("crf", "h264_amf")

    def test_all_eight_encoders_in_allowlist(self):
        from tuck.models.encoding_policy import VALID_VIDEO_ENCODERS

        expected = {
            "libx264",
            "libx265",
            "h264_nvenc",
            "hevc_nvenc",
            "h264_amf",
            "hevc_amf",
            "h264_vaapi",
            "hevc_vaapi",
        }
        assert expected == VALID_VIDEO_ENCODERS

    def test_invalid_encoder_rejected(self):
        """Unknown encoder is rejected."""
        import pytest

        from tuck.models.encoding_policy import validate_rc_method_for_encoder

        with pytest.raises(ValueError, match="rate_control_method"):
            validate_rc_method_for_encoder("crf", "bogus_encoder")


class TestPlanTrim:
    def test_plan_default_uses_full_duration(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        p = plan(str(sample_video_path), profile)
        assert p.trim_start == 0.0
        assert p.source_info is not None
        assert abs(p.trim_end - p.source_info.duration) < 0.05
        assert not p.has_trim
        assert abs(p.trim_duration - p.source_info.duration) < 0.05

    def test_plan_trim_shortens_duration_and_raises_bitrate(
        self, skip_if_no_ffprobe, sample_video_path
    ):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        full = plan(str(sample_video_path), profile)
        assert full.source_info is not None
        full_dur = full.source_info.duration
        if full_dur < 1.0:
            pytest.skip("sample too short for trim test")

        req = PlanRequest(
            source=str(sample_video_path),
            trim_start=0.25,
            trim_end=min(0.75, full_dur * 0.5),
        )
        trimmed = plan(str(sample_video_path), profile, request=req)
        assert trimmed.has_trim
        assert abs(trimmed.trim_start - 0.25) < 0.001
        assert trimmed.trim_duration < full_dur
        assert trimmed.video_bitrate > full.video_bitrate

    def test_plan_trim_rejects_inverted_range(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        req = PlanRequest(source=str(sample_video_path), trim_start=2.0, trim_end=1.0)
        with pytest.raises(ValueError, match="trim_end"):
            plan(str(sample_video_path), profile, request=req)

    def test_plan_trim_rejects_start_past_duration(self, skip_if_no_ffprobe, sample_video_path):
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        full = plan(str(sample_video_path), profile)
        assert full.source_info is not None
        req = PlanRequest(
            source=str(sample_video_path),
            trim_start=full.source_info.duration + 5,
        )
        with pytest.raises(ValueError, match="trim_start"):
            plan(str(sample_video_path), profile, request=req)


class TestPlanSegments:
    @staticmethod
    def _info(path: Path, *, has_audio: bool = True) -> VideoInfo:
        return VideoInfo(
            path=str(path),
            duration=10,
            width=1280,
            height=720,
            fps=30,
            video_codec="h264",
            audio_codec="aac" if has_audio else "",
            audio_bitrate=192_000 if has_audio else 0,
            audio_channels=2 if has_audio else 0,
            audio_sample_rate=48_000 if has_audio else 0,
            has_audio=has_audio,
        )

    def test_multi_segment_duration_drives_bitrate_and_audio_reencode(self, tmp_path):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        profile = Profile(name="Segments", keep_audio=True, two_pass=False)
        full = plan(source, profile, source_info=self._info(source))
        selected = plan(
            source,
            profile,
            request=PlanRequest(segments=[Segment(0, 1), Segment(4, 5)]),
            source_info=self._info(source),
        )

        assert selected.segments == [Segment(0, 1), Segment(4, 5)]
        assert selected.effective_duration == pytest.approx(2)
        assert selected.video_bitrate > full.video_bitrate
        assert not selected.copy_audio
        assert selected.audio_bitrate == 192_000
        assert selected.trim_start == 0
        assert selected.trim_end == 0

    def test_single_segment_keeps_legacy_trim_shape(self, tmp_path):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        result = plan(
            source,
            Profile(name="Single", two_pass=False),
            request=PlanRequest(segments=[Segment(2, 4)]),
            source_info=self._info(source, has_audio=False),
        )
        assert result.trim_start == 2
        assert result.trim_end == 4
        assert result.trim_duration == 2

    @pytest.mark.parametrize(
        ("segments", "message"),
        [
            ([Segment(0, 2), Segment(1, 3)], "overlap"),
            ([Segment(4, 5), Segment(1, 2)], "chronologically"),
            ([Segment(9, 11)], "source duration"),
        ],
    )
    def test_invalid_segments_are_rejected(self, tmp_path, segments, message):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        with pytest.raises(ValueError, match=message):
            plan(
                source,
                Profile(name="Invalid", two_pass=False),
                request=PlanRequest(segments=segments),
                source_info=self._info(source),
            )


class TestPlanStages:
    @staticmethod
    def _source(tmp_path: Path) -> Path:
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        return source

    @staticmethod
    def _info(path: Path, **overrides) -> VideoInfo:
        values = {
            "path": str(path),
            "duration": 10.0,
            "width": 1280,
            "height": 720,
            "fps": 30.0,
            "video_codec": "h264",
            "audio_codec": "aac",
            "audio_bitrate": 128_000,
            "audio_channels": 2,
            "audio_sample_rate": 48_000,
            "has_audio": True,
        }
        values.update(overrides)
        return VideoInfo(**values)

    @pytest.mark.parametrize("size", [0, -1])
    def test_zero_or_negative_target_size_is_rejected_not_replaced(self, tmp_path, size):
        source = self._source(tmp_path)
        profile = Profile(name="Broken", two_pass=False, target_size_bytes=size)
        with pytest.raises(ValueError, match="Target size must be greater than zero"):
            plan(source, profile, source_info=self._info(source))

    def test_hard_linked_output_is_treated_as_the_source(self, tmp_path):
        source = self._source(tmp_path)
        link = tmp_path / "linked.mp4"
        try:
            os.link(source, link)
        except OSError:
            pytest.skip("hard links are not supported here")
        with pytest.raises(ValueError, match="differ from source"):
            plan(
                source,
                Profile(name="Linked", two_pass=False),
                output=link,
                source_info=self._info(source),
                replace_existing=True,
            )

    def test_missing_output_passes_the_same_file_check(self, tmp_path):
        source = self._source(tmp_path)
        result = plan(
            source,
            Profile(name="New", two_pass=False),
            output=tmp_path / "new.mp4",
            source_info=self._info(source),
        )
        assert Path(result.output).name == "new.mp4"

    def test_variable_frame_rate_uses_average_rate_for_limits(self, tmp_path):
        source = self._source(tmp_path)
        # a phone clip whose nominal rate is far above the pictures it holds
        info = self._info(source, fps=120.0, average_fps=29.5, variable_frame_rate=True)
        result = plan(
            source,
            Profile(name="Limit", two_pass=False, fps_mode=FPS_MODE_CUSTOM, custom_fps=60.0),
            source_info=info,
        )
        assert result.target_fps == pytest.approx(29.5)
        assert result.apply_fps_filter is False

        lower = plan(
            source,
            Profile(name="Lower", two_pass=False, fps_mode=FPS_MODE_CUSTOM, custom_fps=24.0),
            source_info=info,
        )
        assert lower.target_fps == pytest.approx(24.0)
        assert lower.apply_fps_filter is True

    def test_constant_frame_rate_keeps_nominal_rate(self, tmp_path):
        source = self._source(tmp_path)
        info = self._info(source, fps=60.0, average_fps=59.94)
        result = plan(
            source,
            Profile(name="Limit", two_pass=False, fps_mode=FPS_MODE_CUSTOM, custom_fps=30.0),
            source_info=info,
        )
        assert result.target_fps == pytest.approx(30.0)
        assert result.apply_fps_filter is True

    def test_hdr_source_is_tone_mapped_when_ffmpeg_can(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.planner.can_tone_map_hdr", lambda: True)
        source = self._source(tmp_path)
        info = self._info(source, color_transfer="smpte2084", color_primaries="bt2020")
        result = plan(source, Profile(name="HDR", two_pass=False), source_info=info)
        assert result.tone_map_hdr is True
        assert result.warnings == []

    def test_hdr_source_warns_when_ffmpeg_cannot_tone_map(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.planner.can_tone_map_hdr", lambda: False)
        source = self._source(tmp_path)
        info = self._info(source, color_transfer="arib-std-b67", color_primaries="bt2020")
        result = plan(source, Profile(name="HDR", two_pass=False), source_info=info)
        assert result.tone_map_hdr is False
        assert result.warnings == [HDR_NOT_CONVERTED_WARNING]

    def test_sdr_source_never_asks_ffmpeg_about_tone_mapping(self, tmp_path, monkeypatch):
        def unexpected() -> bool:
            raise AssertionError("SDR plans should not look for tone-mapping filters")

        monkeypatch.setattr("tuck.planner.can_tone_map_hdr", unexpected)
        source = self._source(tmp_path)
        result = plan(
            source,
            Profile(name="SDR", two_pass=False),
            source_info=self._info(source, color_transfer="bt709"),
        )
        assert result.tone_map_hdr is False

    def test_every_audio_track_is_kept(self, tmp_path):
        source = self._source(tmp_path)
        info = self._info(source, audio_stream_count=3, audio_codecs=["aac"] * 3)
        result = plan(source, Profile(name="Tracks", two_pass=False), source_info=info)
        assert result.source_audio_tracks == [
            SourceAudioTrack(0),
            SourceAudioTrack(1),
            SourceAudioTrack(2),
        ]
        assert result.warnings == []

    def test_each_source_audio_track_keeps_its_own_mute_and_volume(self, tmp_path):
        source = self._source(tmp_path)
        info = self._info(source, audio_stream_count=3, audio_codecs=["aac"] * 3)
        request = PlanRequest(
            source_audio_muted=True,
            source_audio_extra_tracks=[SourceTrackSetting(gain_db=-6.0)],
        )
        result = plan(
            source, Profile(name="Tracks", two_pass=False), request=request, source_info=info
        )
        # the first is muted, the second turned down, and the third, which has no settings, kept
        assert result.source_audio_tracks == [SourceAudioTrack(1, -6.0), SourceAudioTrack(2)]
        assert result.total_audio_bitrate == 2 * result.audio_bitrate

        all_muted = plan(
            source,
            Profile(name="Tracks", two_pass=False),
            request=PlanRequest(
                source_audio_muted=True,
                source_audio_extra_tracks=[SourceTrackSetting(muted=True)] * 2,
            ),
            source_info=info,
        )
        assert all_muted.source_audio_tracks == []
        assert all_muted.audio_bitrate == 0

        off = plan(
            source,
            Profile(name="Tracks", two_pass=False),
            request=PlanRequest(audio_enabled=False),
            source_info=info,
        )
        assert off.source_audio_tracks == []

    def test_the_size_budget_pays_for_every_audio_track(self, tmp_path):
        source = self._source(tmp_path)
        profile = Profile(name="Size", two_pass=False, target_size_bytes=8 * 1024 * 1024)
        one = plan(source, profile, source_info=self._info(source))
        three = plan(
            source,
            profile,
            source_info=self._info(source, audio_stream_count=3, audio_codecs=["aac"] * 3),
        )
        assert three.audio_bitrate == one.audio_bitrate
        assert three.total_audio_bitrate == 3 * one.audio_bitrate
        assert three.video_bitrate < one.video_bitrate
        assert three.estimated_size <= profile.target_size_bytes

    @pytest.mark.parametrize(
        ("codecs", "copied"),
        [(["aac", "aac"], True), (["aac", "pcm_s16le"], False)],
    )
    def test_original_audio_is_copied_only_when_every_track_can_be(self, tmp_path, codecs, copied):
        source = self._source(tmp_path)
        result = plan(
            source,
            Profile(name="Keep", two_pass=False, keep_audio=True),
            source_info=self._info(source, audio_stream_count=2, audio_codecs=codecs),
        )
        assert result.copy_audio is copied
        assert result.audio_bitrate == 128_000
        assert len(result.source_audio_tracks or []) == 2

    def test_a_volume_change_on_another_track_reencodes_the_audio(self, tmp_path):
        source = self._source(tmp_path)
        result = plan(
            source,
            Profile(name="Keep", two_pass=False, keep_audio=True),
            request=PlanRequest(source_audio_extra_tracks=[SourceTrackSetting(gain_db=3.0)]),
            source_info=self._info(source, audio_stream_count=2, audio_codecs=["aac", "aac"]),
        )
        assert result.copy_audio is False

    def test_one_text_subtitle_track_is_kept_without_a_warning(self, tmp_path):
        source = self._source(tmp_path)
        result = plan(
            source,
            Profile(name="Subtitles", two_pass=False),
            source_info=self._info(source, subtitle_codecs=["subrip"]),
        )
        assert result.warnings == []

    @pytest.mark.parametrize(
        ("codecs", "segments", "warning"),
        [
            (
                ["hdmv_pgs_subtitle"],
                None,
                "Subtitles aren't kept, because they're stored as pictures, which MP4 can't hold.",
            ),
            (
                ["subrip"],
                [Segment(0, 1), Segment(4, 5)],
                "Subtitles aren't kept when the video is cut into several parts.",
            ),
            (
                ["dvd_subtitle", "ass", "subrip"],
                None,
                "This video has 3 subtitle tracks. Only the first text track is kept.",
            ),
        ],
    )
    def test_subtitles_that_are_left_out_are_reported(self, tmp_path, codecs, segments, warning):
        source = self._source(tmp_path)
        result = plan(
            source,
            Profile(name="Subtitles", two_pass=False),
            request=PlanRequest(segments=segments) if segments else None,
            source_info=self._info(source, subtitle_codecs=codecs),
        )
        assert result.warnings == [warning]

    @pytest.mark.parametrize("method", ["cbr", "vbr"])
    def test_compression_encodes_with_capped_vbr_whatever_the_saved_label(self, tmp_path, method):
        source = self._source(tmp_path)
        encoder = "libx264" if method == "cbr" else "h264_nvenc"
        profile = Profile(
            name="Size",
            video_encoder=encoder,
            preset="medium" if method == "cbr" else "p5",
            two_pass=method == "cbr",
        )
        result = plan(
            source,
            profile,
            request=PlanRequest(rate_control_method=method),
            source_info=self._info(source),
        )
        assert result.rate_control_method == "vbr"
