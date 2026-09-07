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
    VideoInfo,
    VideoTransform,
    find_profile_by_id,
)
from tuck.output_paths import resolve_output_collision
from tuck.planner import _make_even, _scale_resolution, plan
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


def test_linux_rejects_saved_hardware_profile_when_planning(monkeypatch) -> None:
    profile = Profile(name="Hardware", video_encoder="h264_nvenc", two_pass=False)
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")

    with pytest.raises(ValueError, match="not supported on Linux"):
        resolve_plan_options(profile, None)

    assert profile.video_encoder == "h264_nvenc"


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

    def test_plan_scaler_passed_through(self, skip_if_no_ffprobe, sample_video_path):
        for scaler in ["bilinear", "bicubic", "lanczos", "nearest"]:
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
            assert p.scaler == scaler

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
        assert p.target_width == 2560
        assert p.target_height == 1440

    def test_upscale_4k_profile_dimensions(self, skip_if_no_ffprobe, sample_video_path):
        """4K upscale profile targets 3840x2160."""
        profile = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_4K_UPSCALE)
        p = plan(str(sample_video_path), profile)
        assert p.workflow == WORKFLOW_UPSCALE
        assert p.target_width == 3840
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

    def test_all_six_encoders_in_allowlist(self):
        """All six encoders are in the valid set."""
        from tuck.models.encoding_policy import VALID_VIDEO_ENCODERS

        expected = {"libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_amf", "hevc_amf"}
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
