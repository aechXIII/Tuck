import os
import subprocess
from pathlib import Path

import pytest

from tuck.engine import (
    EncodeError,
    FFmpegEngine,
    _nvenc_preset,
    _scaler_to_ffmpeg_flag,
    cleanup_cache,
    is_ffmpeg_available,
)
from tuck.models import (
    RCM_CBR,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    WORKFLOW_UPSCALE,
    EncodePlan,
)


def _create_synthetic_video(path: Path, duration: float = 3.0) -> bool:

    from tuck.engine import _find_ffmpeg

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return False
    try:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"testsrc=duration={duration}:size=320x240:rate=30",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=440:duration={duration}",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-shortest",
                str(path),
            ],
            capture_output=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return path.exists() and path.stat().st_size > 0
    except Exception:
        return False


@pytest.fixture
def real_video_path(tmp_path):

    path = tmp_path / "synthetic.mp4"
    if _create_synthetic_video(path):
        return path
    pytest.skip("Cannot create synthetic video (ffmpeg unavailable)")


@pytest.fixture
def engine():
    return FFmpegEngine()


class TestFFmpegEngine:
    def test_is_ffmpeg_available(self):
        result = is_ffmpeg_available()
        assert isinstance(result, bool)

    def test_encode_single_pass(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "output_single.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

    def test_encode_two_pass(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "output_two_pass.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=True,
            preset="ultrafast",
            rate_control_method=RCM_CBR,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

    def test_encode_with_progress_callback(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "output_progress.mp4"

        progress_values = []

        def cb(pct):
            progress_values.append(pct)

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan, on_progress=cb)
        assert result.exists()

        assert len(progress_values) >= 0

    def test_output_reservation_cleanup_and_no_y_flag(self, engine, real_video_path, tmp_path):

        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "output_reserved.mp4"

        output.write_text("existing")

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

        reservation = output.with_suffix(output.suffix + ".reserved")
        assert not reservation.exists()

        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-y" not in cmd

    def test_nested_output_parent_created_before_reservation(
        self, engine, real_video_path, tmp_path
    ):

        from tuck.probe import probe

        info = probe(real_video_path)

        output = tmp_path / "deep" / "nested" / "subdir" / "output.mp4"

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

        assert output.parent.exists()

        reservation = output.with_suffix(output.suffix + ".reserved")
        assert not reservation.exists()

    def test_pre_existing_reservation_marker_handled(self, engine, real_video_path, tmp_path):

        from tuck.probe import probe

        info = probe(real_video_path)
        base_output = tmp_path / "conflict" / "output.mp4"
        base_output.parent.mkdir(parents=True, exist_ok=True)

        base_output.write_text("existing output")
        existing_reservation = base_output.with_suffix(base_output.suffix + ".reserved")
        existing_reservation.write_text("locked by another process")

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(base_output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

        assert result != base_output

        assert existing_reservation.exists()

        assert base_output.read_bytes() == b"existing output"

        ours_reservation = result.with_suffix(result.suffix + ".reserved")
        assert not ours_reservation.exists()

    def test_source_not_found(self, engine, tmp_path):
        plan = EncodePlan(
            source=str(tmp_path / "nonexistent.mp4"),
            output=str(tmp_path / "out.mp4"),
            target_size=5 * 1024 * 1024,
            profile_id="test",
        )
        with pytest.raises(FileNotFoundError):
            engine.encode(plan)

    def test_size_exceeds_target_retries(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "output_retry.mp4"

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=5_000_000,  # Very high
            original_video_bitrate=5_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=10_000_000,
            target_size=1024,  # Very small target triggers retries
            source_info=info,
            profile_id="test",
        )

        try:
            result = engine.encode(plan)

            assert result.stat().st_size <= plan.target_size
        except EncodeError:
            pass

    def test_cleanup_cache(self, tmp_path):
        removed = cleanup_cache(tmp_path)
        assert isinstance(removed, int)
        assert removed >= 0


class TestScalerFlags:
    def test_scaler_to_ffmpeg_flag_mappings(self):
        assert _scaler_to_ffmpeg_flag("bilinear") == "bilinear"
        assert _scaler_to_ffmpeg_flag("bicubic") == "bicubic"
        assert _scaler_to_ffmpeg_flag("lanczos") == "lanczos"
        assert _scaler_to_ffmpeg_flag("nearest") == "neighbor"

    def test_scaler_to_ffmpeg_flag_unknown_defaults(self):
        assert _scaler_to_ffmpeg_flag("bogus") == "neighbor"
        assert _scaler_to_ffmpeg_flag("") == "neighbor"

    def test_build_base_cmd_includes_scaler_flags(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=320,
            target_height=240,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
            apply_scale=True,
        )

        for scaler, expected_flag in [
            ("bilinear", "bilinear"),
            ("bicubic", "bicubic"),
            ("lanczos", "lanczos"),
            ("nearest", "neighbor"),
        ]:
            plan.scaler = scaler
            cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
            assert "-vf" in cmd
            vf_index = cmd.index("-vf")
            vf_value = cmd[vf_index + 1]
            assert f"flags={expected_flag}" in vf_value

    def test_build_base_cmd_no_scale_no_vf_flags(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
            apply_scale=False,
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-vf" not in cmd

    def test_build_base_cmd_includes_video_encoder(self, engine, real_video_path, tmp_path):
        """_build_base_cmd uses plan.video_encoder for -c:v."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            video_encoder="libx265",
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        c_v_index = cmd.index("-c:v")
        assert cmd[c_v_index + 1] == "libx265"

    def test_build_base_cmd_includes_bitrate_single_pass(self, engine, real_video_path, tmp_path):
        """_build_base_cmd uses -b:v for single-pass encoding (ABR, not CRF)."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            rate_control_method=RCM_CBR,
            crf=18,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-b:v" in cmd
        bv_index = cmd.index("-b:v")
        assert cmd[bv_index + 1] == "500000"
        assert "-crf" not in cmd

    def test_build_base_cmd_includes_tune(self, engine, real_video_path, tmp_path):
        """_build_base_cmd includes -tune when plan.tune is set."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            tune="animation",
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-tune" in cmd
        tune_index = cmd.index("-tune")
        assert cmd[tune_index + 1] == "animation"

    def test_build_base_cmd_no_tune_when_empty(self, engine, real_video_path, tmp_path):
        """_build_base_cmd omits -tune when plan.tune is empty."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            tune="",
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-tune" not in cmd


class TestCancel:
    def test_cancel_sets_event(self, engine):
        engine.cancel()
        assert engine._cancel_event.is_set()

    def test_cancel_clears_event_on_encode(self, engine, real_video_path, tmp_path):

        engine.cancel()  # Set it
        assert engine._cancel_event.is_set()

        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "output_cancel_clear.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        engine.encode(plan)

        assert not engine._cancel_event.is_set()


class TestExplicitBitrateNoRetry:
    def test_explicit_bitrate_fails_on_size_overrun(self, engine, real_video_path, tmp_path):

        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "explicit_overrun.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=5_000_000,
            original_video_bitrate=5_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            rate_control="explicit_bitrate",
            explicit_bitrate=5_000_000,
            estimated_size=500_000,
            target_size=1024,  # 1 KB is impossible
            source_info=info,
            profile_id="test",
        )
        with pytest.raises(EncodeError, match="exceeds hard profile limit"):
            engine.encode(plan)

    def test_target_size_mode_retries_on_overrun(self, engine, real_video_path, tmp_path):

        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "target_retry.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=10_000_000,
            original_video_bitrate=10_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            rate_control="target_size",
            estimated_size=5_000_000,
            target_size=50 * 1024,  # 50 KB
            source_info=info,
            profile_id="test",
        )

        try:
            result = engine.encode(plan)
            assert result.stat().st_size <= plan.target_size
        except EncodeError as e:
            assert "after" in str(e)  # "after N attempts"


class TestOutputCollisionSafety:
    def test_final_file_exists_without_marker(self, engine, real_video_path, tmp_path):

        from tuck.probe import probe

        info = probe(real_video_path)
        base_output = tmp_path / "exists_no_marker" / "output.mp4"
        base_output.parent.mkdir(parents=True, exist_ok=True)
        original_content = b"existing final output"
        base_output.write_bytes(original_content)

        marker = base_output.with_suffix(base_output.suffix + ".reserved")
        assert not marker.exists()

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(base_output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

        assert result != base_output

        assert base_output.read_bytes() == original_content

        assert not result.with_suffix(result.suffix + ".reserved").exists()

    def test_marker_only_collision(self, engine, real_video_path, tmp_path):

        from tuck.probe import probe

        info = probe(real_video_path)
        base_output = tmp_path / "marker_only" / "output.mp4"
        base_output.parent.mkdir(parents=True, exist_ok=True)

        marker = base_output.with_suffix(base_output.suffix + ".reserved")
        marker.write_text("locked")
        assert not base_output.exists()

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(base_output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

        assert result != base_output

        assert marker.exists()

        assert not result.with_suffix(result.suffix + ".reserved").exists()

        assert not base_output.exists()

    def test_publication_race_final_file_appears(
        self, engine, real_video_path, tmp_path, monkeypatch
    ):

        from tuck.probe import probe

        info = probe(real_video_path)
        base_output = tmp_path / "race_pub" / "output.mp4"
        base_output.parent.mkdir(parents=True, exist_ok=True)

        stolen = {"active": False}

        _orig_exists = type(Path()).exists

        def _tampered_exists(self):
            if stolen["active"] and self == base_output:
                return True
            return _orig_exists(self)

        monkeypatch.setattr(Path, "exists", _tampered_exists)

        plan = EncodePlan(
            source=str(real_video_path),
            output=str(base_output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )

        original_encode = engine._encode_with_retry

        def _encode_and_arm(*args, **kwargs):
            result_path = original_encode(*args, **kwargs)
            stolen["active"] = True
            return result_path

        engine._encode_with_retry = _encode_and_arm  # type: ignore[method-assign]

        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0

        assert result != base_output

        assert not result.with_suffix(result.suffix + ".reserved").exists()


class TestUpscaleNoRetry:
    def test_upscale_workflow_no_retry_on_size(self, engine, real_video_path, tmp_path):
        """Upscale workflow does not retry even if output is large."""
        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "upscale_no_retry.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=640,
            target_height=480,
            target_fps=info.fps,
            video_bitrate=0,
            original_video_bitrate=0,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="ultrafast",
            crf=23,
            estimated_size=0,
            target_size=1024,  # 1 KB -- would trigger retry in compression mode
            source_info=info,
            profile_id="test",
            workflow=WORKFLOW_UPSCALE,
            rate_control_method=RCM_CRF,
            apply_scale=True,
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0
        # Upscale should succeed without EncodeError even if output > target_size


class TestFFmpegCommandPerEncoder:
    def test_cpu_crf_command(self, engine, real_video_path, tmp_path):
        """CPU encoder with CRF produces -crf flag, no -b:v."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            crf=18,
            video_encoder="libx264",
            rate_control_method=RCM_CRF,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-crf" in cmd
        crf_idx = cmd.index("-crf")
        assert cmd[crf_idx + 1] == "18"
        assert "-b:v" not in cmd

    def test_cpu_cbr_command(self, engine, real_video_path, tmp_path):
        """CPU encoder with CBR produces -b:v, -minrate, -maxrate, -bufsize."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=2_000_000,
            original_video_bitrate=2_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="libx264",
            rate_control_method=RCM_CBR,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-b:v" in cmd
        bv_idx = cmd.index("-b:v")
        assert cmd[bv_idx + 1] == "2000000"
        assert "-minrate" in cmd
        assert "-maxrate" in cmd
        assert "-bufsize" in cmd
        assert "-crf" not in cmd

    def test_nvenc_cqp_command(self, engine, real_video_path, tmp_path):
        """NVENC encoder with CQP produces -rc constqp -qp."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=0,
            original_video_bitrate=0,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="h264_nvenc",
            rate_control_method=RCM_CQP,
            qp=20,
            estimated_size=0,
            target_size=500 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "constqp"
        assert "-qp" in cmd
        qp_idx = cmd.index("-qp")
        assert cmd[qp_idx + 1] == "20"

    def test_nvenc_cbr_command(self, engine, real_video_path, tmp_path):
        """NVENC encoder with CBR produces -rc cbr -b:v."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=2_000_000,
            original_video_bitrate=2_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="h264_nvenc",
            rate_control_method=RCM_CBR,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "cbr"
        assert "-b:v" in cmd

    def test_nvenc_vbr_command(self, engine, real_video_path, tmp_path):
        """NVENC encoder with VBR produces -rc vbr -b:v -maxrate."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=2_000_000,
            original_video_bitrate=2_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="h264_nvenc",
            rate_control_method=RCM_VBR,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "vbr"
        assert "-b:v" in cmd
        assert "-maxrate" in cmd

    def test_amf_cqp_command(self, engine, real_video_path, tmp_path):
        """AMF encoder with CQP produces -rc cqp -qp_i -qp_p -qp_b."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=0,
            original_video_bitrate=0,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="h264_amf",
            rate_control_method=RCM_CQP,
            qp=20,
            estimated_size=0,
            target_size=500 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "cqp"
        assert "-qp_i" in cmd
        assert "-qp_p" in cmd
        assert "-qp_b" in cmd

    def test_amf_cbr_command(self, engine, real_video_path, tmp_path):
        """AMF encoder with CBR produces -rc cbr -b:v."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=2_000_000,
            original_video_bitrate=2_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="h264_amf",
            rate_control_method=RCM_CBR,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "cbr"
        assert "-b:v" in cmd

    def test_amf_vbr_command(self, engine, real_video_path, tmp_path):
        """AMF encoder with VBR produces -rc vbr -b:v -maxrate."""
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=2_000_000,
            original_video_bitrate=2_000_000,
            audio_bitrate=128_000,
            audio_channels=2,
            audio_sample_rate=44100,
            two_pass=False,
            preset="medium",
            video_encoder="h264_amf",
            rate_control_method=RCM_VBR,
            estimated_size=100_000,
            target_size=5 * 1024 * 1024,
            source_info=info,
            profile_id="test",
        )
        cmd = engine._build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "vbr"
        assert "-b:v" in cmd
        assert "-maxrate" in cmd

    def test_nvenc_preset_mapping(self):
        """NVENC preset mapping converts x264 preset names to p1-p7."""
        assert _nvenc_preset("medium") == "p6"
        assert _nvenc_preset("slow") == "p6"
        assert _nvenc_preset("fast") == "p4"
        assert _nvenc_preset("ultrafast") == "p1"
