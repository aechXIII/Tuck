import array
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tuck.encoding.command import build_base_cmd, nvenc_preset, scaler_to_ffmpeg_flag
from tuck.encoding.filters import build_video_filters
from tuck.engine import EncodeError, FFmpegEngine, is_ffmpeg_available
from tuck.models import (
    ENCODER_AUTO,
    ENCODER_AUTO_COMPRESSION,
    RC_EXPLICIT_BITRATE,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    WORKFLOW_UPSCALE,
    CropRect,
    EncodePlan,
    EncodeProgress,
    EncodeStage,
    OutputGeometry,
    Segment,
    VideoTransform,
)


def _create_synthetic_video(path: Path, duration: float = 3.0) -> bool:

    from tuck.media_tools import find_ffmpeg

    ffmpeg = find_ffmpeg()
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


def _audio_peak_at(ffmpeg: str, source: Path, start: float) -> int:
    decoded = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-ss",
            str(start),
            "-i",
            str(source),
            "-t",
            "0.5",
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "pipe:1",
        ],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert decoded.returncode == 0
    samples = array.array("h")
    samples.frombytes(decoded.stdout)
    return max((abs(sample) for sample in samples), default=0)


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

    @pytest.mark.ffmpeg
    def test_encode_source_audio_segments_restores_audio_after_muted_gap(self, engine, tmp_path):
        from tuck.media_tools import find_ffmpeg
        from tuck.probe import probe

        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            pytest.skip("ffmpeg unavailable")
        source = tmp_path / "source-audio-segments.mp4"
        if not _create_synthetic_video(source, duration=9.0):
            pytest.skip("Cannot create synthetic video")
        info = probe(source)
        output = tmp_path / "source-audio-segments-output.mp4"
        plan = EncodePlan(
            source=str(source),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=96_000,
            audio_channels=2,
            audio_sample_rate=44_100,
            two_pass=False,
            preset="ultrafast",
            target_size=10 * 1024 * 1024,
            rate_control=RC_EXPLICIT_BITRATE,
            source_info=info,
            segments=[Segment(0, 8.8)],
            source_audio_segments=[Segment(0, 3), Segment(6, 8.8)],
        )

        result = engine.encode(plan)

        assert _audio_peak_at(ffmpeg, result, 1.0) > 500
        assert _audio_peak_at(ffmpeg, result, 4.0) < 50
        assert _audio_peak_at(ffmpeg, result, 7.0) > 500

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

        assert progress_values
        assert all(isinstance(value, EncodeProgress) for value in progress_values)
        assert progress_values[0].stage == EncodeStage.PREPARING
        assert progress_values[-1].stage == EncodeStage.COMPLETED
        assert progress_values[-1].percent == 100.0

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

        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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


def test_video_filter_builder_preserves_existing_filter_order() -> None:
    assert build_video_filters(
        crop=CropRect(10, 20, 800, 600),
        scale_width=320,
        scale_height=240,
        scaler="lanczos",
        frame_rate=24,
    ) == ["crop=800:600:10:20:exact=1", "scale=320:240:flags=lanczos", "fps=24"]
    assert build_video_filters() == []


def test_consume_stderr_preserves_partial_output_on_exception() -> None:
    class _RaisingLines:
        def __iter__(self):
            yield "line one\n"
            yield "line two\n"
            raise ValueError("boom")

    class _FakeProc:
        stderr = _RaisingLines()

    class _NoopTracker:
        def update_from_line(self, line: str) -> None:
            return None

    engine = FFmpegEngine()
    stderr_lines: list[str] = []

    with pytest.raises(ValueError):
        engine._consume_stderr(_FakeProc(), _NoopTracker(), None, stderr_lines)

    assert stderr_lines == ["line one\n", "line two\n"]


def test_build_base_cmd_applies_crop_without_scaling(engine, real_video_path, tmp_path) -> None:
    from tuck.probe import probe

    info = probe(real_video_path)
    plan = EncodePlan(
        source=str(real_video_path),
        output=str(tmp_path / "crop.mp4"),
        source_info=info,
        transform=VideoTransform(crop=CropRect(10, 20, 200, 100)),
    )

    cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))

    assert cmd[cmd.index("-vf") + 1] == "crop=200:100:10:20:exact=1"


def test_cpu_encode_outputs_selected_crop_dimensions(engine, real_video_path, tmp_path) -> None:
    from tuck.probe import probe

    info = probe(real_video_path)
    output = tmp_path / "cropped-output.mp4"
    crop = CropRect(60, 40, 160, 120)
    plan = EncodePlan(
        source=str(real_video_path),
        output=str(output),
        target_width=crop.width,
        target_height=crop.height,
        target_fps=info.fps,
        video_bitrate=500_000,
        original_video_bitrate=500_000,
        audio_bitrate=0,
        two_pass=False,
        preset="ultrafast",
        target_size=10 * 1024 * 1024,
        rate_control=RC_EXPLICIT_BITRATE,
        rate_control_method=RCM_CBR,
        source_info=info,
        transform=VideoTransform(crop=crop),
    )

    result = engine.encode(plan)
    result_info = probe(result)

    assert (result_info.width, result_info.height) == (crop.width, crop.height)


def test_cpu_encode_crops_display_rotated_source_coordinates(engine, tmp_path) -> None:
    from tuck.media_tools import find_ffmpeg
    from tuck.probe import probe

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("ffmpeg unavailable")

    base = tmp_path / "base.mp4"
    source = tmp_path / "rotated.mp4"
    create = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=1:duration=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(base),
        ],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if create.returncode != 0:
        pytest.skip("cannot create orientation fixture")
    rotate = subprocess.run(
        [ffmpeg, "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", str(source)],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if rotate.returncode != 0:
        pytest.skip("ffmpeg does not support display_rotation")

    info = probe(source)
    crop = CropRect(20, 10, 200, 300)
    output = tmp_path / "rotated-crop.mp4"
    plan = EncodePlan(
        source=str(source),
        output=str(output),
        target_width=crop.width,
        target_height=crop.height,
        target_fps=info.fps,
        video_bitrate=500_000,
        original_video_bitrate=500_000,
        audio_bitrate=0,
        two_pass=False,
        preset="ultrafast",
        target_size=10 * 1024 * 1024,
        rate_control=RC_EXPLICIT_BITRATE,
        rate_control_method=RCM_CBR,
        source_info=info,
        transform=VideoTransform(crop=crop),
    )

    result = engine.encode(plan)
    result_info = probe(result)

    assert (info.width, info.height) == (240, 320)
    assert (result_info.width, result_info.height) == (200, 300)


@pytest.mark.parametrize(
    ("transform", "expected"),
    [
        (VideoTransform(rotation=90, sizing_mode="fit"), (240, 320)),
        (VideoTransform(flip_horizontal=True, flip_vertical=True), (320, 240)),
        (
            VideoTransform(sizing_mode="fit", output=OutputGeometry(200, 200)),
            (200, 150),
        ),
        (
            VideoTransform(sizing_mode="fill", output=OutputGeometry(200, 200)),
            (200, 200),
        ),
        (
            VideoTransform(sizing_mode="stretch", output=OutputGeometry(200, 200)),
            (200, 200),
        ),
    ],
)
def test_cpu_encode_applies_complete_transform_geometry(
    transform, expected, engine, real_video_path, tmp_path
) -> None:
    from tuck.probe import probe

    info = probe(real_video_path)
    output = tmp_path / f"transform-{expected[0]}x{expected[1]}-{transform.sizing_mode}.mp4"
    plan = EncodePlan(
        source=str(real_video_path),
        output=str(output),
        target_width=expected[0],
        target_height=expected[1],
        target_fps=info.fps,
        video_bitrate=500_000,
        original_video_bitrate=500_000,
        audio_bitrate=0,
        two_pass=False,
        preset="ultrafast",
        target_size=10 * 1024 * 1024,
        rate_control=RC_EXPLICIT_BITRATE,
        rate_control_method=RCM_CBR,
        source_info=info,
        transform=transform,
    )

    result = engine.encode(plan)
    result_info = probe(result)

    assert (result_info.width, result_info.height) == expected


def test_cpu_encode_outputs_selected_crop_content(engine, tmp_path) -> None:
    from tuck.media_tools import find_ffmpeg
    from tuck.probe import probe

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("ffmpeg unavailable")

    source = tmp_path / "split-colors.mp4"
    create = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:size=320x240:rate=1:duration=1",
            "-vf",
            "drawbox=x=160:y=0:w=160:h=240:color=blue:t=fill",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            str(source),
        ],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if create.returncode != 0:
        pytest.skip("cannot create split-color fixture")

    info = probe(source)
    crop = CropRect(160, 0, 160, 240)
    output = tmp_path / "blue-half.mp4"
    plan = EncodePlan(
        source=str(source),
        output=str(output),
        target_width=crop.width,
        target_height=crop.height,
        target_fps=info.fps,
        video_bitrate=500_000,
        original_video_bitrate=500_000,
        audio_bitrate=0,
        two_pass=False,
        preset="ultrafast",
        target_size=10 * 1024 * 1024,
        rate_control=RC_EXPLICIT_BITRATE,
        rate_control_method=RCM_CBR,
        source_info=info,
        transform=VideoTransform(crop=crop),
    )

    result = engine.encode(plan)
    decoded = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(result),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert decoded.returncode == 0
    center = ((crop.height // 2) * crop.width + crop.width // 2) * 3
    red, green, blue = decoded.stdout[center : center + 3]
    assert blue > 180
    assert red < 70
    assert green < 70


@pytest.mark.parametrize("encoder", ["libx264", "h264_nvenc", "h264_amf"])
def test_crop_filter_is_shared_by_all_encoder_commands(
    encoder, engine, real_video_path, tmp_path
) -> None:
    from tuck.probe import probe

    info = probe(real_video_path)
    plan = EncodePlan(
        source=str(real_video_path),
        output=str(tmp_path / "crop.mp4"),
        source_info=info,
        video_encoder=encoder,
        rate_control_method=RCM_CBR,
        transform=VideoTransform(crop=CropRect(10, 20, 200, 100)),
    )

    cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))

    assert cmd[cmd.index("-vf") + 1] == "crop=200:100:10:20:exact=1"


class TestScalerFlags:
    def testscaler_to_ffmpeg_flag_mappings(self):
        assert scaler_to_ffmpeg_flag("bilinear") == "bilinear"
        assert scaler_to_ffmpeg_flag("bicubic") == "bicubic"
        assert scaler_to_ffmpeg_flag("lanczos") == "lanczos"
        assert scaler_to_ffmpeg_flag("nearest") == "neighbor"

    def testscaler_to_ffmpeg_flag_unknown_defaults(self):
        assert scaler_to_ffmpeg_flag("bogus") == "neighbor"
        assert scaler_to_ffmpeg_flag("") == "neighbor"

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
            cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
            assert "-vf" in cmd
            vf_index = cmd.index("-vf")
            vf_value = cmd[vf_index + 1]
            assert f"flags={expected_flag}" in vf_value

    def test_build_base_cmd_unknown_scaler_uses_neighbor(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            target_width=320,
            target_height=240,
            target_fps=info.fps,
            video_bitrate=500_000,
            audio_bitrate=128_000,
            two_pass=False,
            source_info=info,
            apply_scale=True,
            scaler="bogus",
        )

        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert cmd[cmd.index("-vf") + 1] == "scale=320:240:flags=neighbor,setsar=1"

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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-vf" not in cmd

    def test_build_base_cmd_includes_video_encoder(self, engine, real_video_path, tmp_path):
        """The public command builder uses plan.video_encoder for -c:v."""
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        c_v_index = cmd.index("-c:v")
        assert cmd[c_v_index + 1] == "libx265"

    def test_build_base_cmd_includes_bitrate_single_pass(self, engine, real_video_path, tmp_path):
        """The public command builder uses -b:v for single-pass encoding (ABR, not CRF)."""
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-b:v" in cmd
        bv_index = cmd.index("-b:v")
        assert cmd[bv_index + 1] == "500000"
        assert "-crf" not in cmd

    def test_build_base_cmd_includes_tune(self, engine, real_video_path, tmp_path):
        """The public command builder includes -tune when plan.tune is set."""
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-tune" in cmd
        tune_index = cmd.index("-tune")
        assert cmd[tune_index + 1] == "animation"

    def test_build_base_cmd_no_tune_when_empty(self, engine, real_video_path, tmp_path):
        """The public command builder omits -tune when plan.tune is empty."""
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        engine.reset_cancel()
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


class TestHardwareFallback:
    def test_auto_tries_amd_after_nvenc_initialization_failure(
        self, engine, real_video_path, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders",
            lambda: frozenset({"libx264", "h264_nvenc", "h264_amf"}),
        )
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            video_encoder=ENCODER_AUTO,
            rate_control_method=RCM_CBR,
            target_size=1024 * 1024,
        )
        attempted: list[str] = []

        def encode_with_retry(_ffmpeg, attempt, _source, output, *_args):
            attempted.append(attempt.video_encoder)
            if attempt.video_encoder == "h264_nvenc":
                raise EncodeError("hardware failed", stderr="No NVENC capable devices found")
            output.write_bytes(b"encoded")
            return output

        engine._encode_with_retry = encode_with_retry
        result = engine.encode(plan)
        assert result.exists()
        assert attempted == ["h264_nvenc", "h264_amf"]
        assert plan.video_encoder == ENCODER_AUTO

    def test_explicit_hardware_failure_does_not_fallback(
        self, engine, real_video_path, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders",
            lambda: frozenset({"libx264", "h264_nvenc"}),
        )
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            video_encoder="h264_nvenc",
            rate_control_method=RCM_CBR,
            target_size=1024 * 1024,
        )

        def fail(*_args, **_kwargs):
            raise EncodeError("hardware failed", stderr="No NVENC capable devices found")

        engine._encode_with_retry = fail
        with pytest.raises(EncodeError, match="hardware failed"):
            engine.encode(plan)
        assert plan.video_encoder == "h264_nvenc"

    def test_auto_best_compression_keeps_two_pass_for_cpu(
        self, engine, real_video_path, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
        )
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            video_encoder=ENCODER_AUTO_COMPRESSION,
            rate_control_method=RCM_CBR,
            two_pass=False,
            preset="medium",
        )

        def encode_with_retry(*args, **_kwargs):
            attempt = args[1]
            output = args[3]
            assert attempt.video_encoder == "libx264"
            assert attempt.two_pass is True
            assert attempt.preset == "veryslow"
            output.write_bytes(b"encoded")
            return output

        engine._encode_with_retry = encode_with_retry

        assert engine.encode(plan).exists()

    def test_auto_cpu_fallback_normalizes_hardware_rate_control(
        self, engine, real_video_path, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
        )
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(tmp_path / "out.mp4"),
            video_encoder=ENCODER_AUTO,
            workflow=WORKFLOW_UPSCALE,
            rate_control_method=RCM_CQ,
            cq=19,
        )

        def encode_with_retry(*args, **kwargs):
            normalized_plan = args[1]
            output = args[3]
            assert normalized_plan.video_encoder == "libx264"
            assert normalized_plan.rate_control_method == RCM_CRF
            output.write_bytes(b"encoded")
            return output

        engine._encode_with_retry = encode_with_retry

        result = engine.encode(plan)

        assert result.exists()
        assert plan.video_encoder == ENCODER_AUTO
        assert plan.rate_control_method == RCM_CQ


class TestTargetSizeRetries:
    def test_undershoot_retries_then_stops_when_the_output_stops_growing(self, engine, tmp_path):
        output = tmp_path / "output.mp4"
        plan = EncodePlan(
            source="source.mp4",
            output=str(output),
            video_bitrate=1_000_000,
            audio_bitrate=0,
            two_pass=False,
            target_size=10_000_000,
            rate_control_method=RCM_CBR,
        )
        calls = 0

        def encode_once(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            # a content-limited source: raising the bitrate does not add bytes
            output.write_bytes(b"x" * 4_000_000)
            return output

        engine._encode_single_pass = encode_once
        result = engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)
        assert result == output
        assert plan.video_bitrate > 1_000_000, "the first undershoot must raise the bitrate"
        assert calls == 2, "stop after the retry that did not grow the output, not at the limit"

    def test_undershoot_uses_every_retry_while_the_output_keeps_growing(self, engine, tmp_path):
        output = tmp_path / "output.mp4"
        plan = EncodePlan(
            source="source.mp4",
            output=str(output),
            video_bitrate=1_000_000,
            audio_bitrate=0,
            two_pass=False,
            target_size=10_000_000,
            rate_control_method=RCM_CBR,
        )
        sizes = iter([2_000_000, 4_000_000, 7_000_000])

        def encode_once(*_args, **_kwargs):
            output.write_bytes(b"x" * next(sizes))
            return output

        engine._encode_single_pass = encode_once
        engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)
        with pytest.raises(StopIteration):
            next(sizes)  # all three attempts were used

    def test_target_size_retry_preserves_crop(self, engine, tmp_path):
        output = tmp_path / "output.mp4"
        crop = CropRect(11, 13, 200, 100)
        plan = EncodePlan(
            source="source.mp4",
            output=str(output),
            video_bitrate=1_000_000,
            audio_bitrate=0,
            two_pass=False,
            target_size=10_000_000,
            rate_control_method=RCM_CBR,
            transform=VideoTransform(crop=crop),
        )
        seen = []

        def encode_once(_ffmpeg, attempt_plan, *_args, **_kwargs):
            seen.append(attempt_plan.transform.crop)
            output.write_bytes(b"x" * 4_000_000)
            return output

        engine._encode_single_pass = encode_once

        engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)

        assert seen == [crop, crop], "the crop must survive the retry"


def test_two_pass_uses_identical_crop_filter_in_both_passes(
    engine, real_video_path, tmp_path, monkeypatch
) -> None:
    from tuck.probe import probe

    info = probe(real_video_path)
    plan = EncodePlan(
        source=str(real_video_path),
        output=str(tmp_path / "output.mp4"),
        source_info=info,
        two_pass=True,
        transform=VideoTransform(crop=CropRect(11, 13, 200, 100)),
    )
    commands = []
    monkeypatch.setattr(
        engine, "_run_pass", lambda command, *_args, **_kwargs: commands.append(command)
    )

    engine._encode_two_pass(
        "ffmpeg", plan, Path(plan.source), Path(plan.output), info.duration, None
    )

    assert len(commands) == 2
    assert commands[0][commands[0].index("-vf") + 1] == "crop=200:100:11:13:exact=1"
    assert commands[1][commands[1].index("-vf") + 1] == "crop=200:100:11:13:exact=1"


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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
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
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-rc" in cmd
        rc_idx = cmd.index("-rc")
        assert cmd[rc_idx + 1] == "vbr"
        assert "-b:v" in cmd
        assert "-maxrate" in cmd

    def testnvenc_preset_mapping(self):
        """NVENC preset mapping converts x264 preset names to p1-p7."""
        assert nvenc_preset("medium") == "p6"
        assert nvenc_preset("slow") == "p6"
        assert nvenc_preset("fast") == "p4"
        assert nvenc_preset("ultrafast") == "p1"


class TestTrimFlags:
    def test_build_cmd_without_trim_omits_seek(self, engine, real_video_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output="out.mp4",
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            audio_bitrate=128_000,
            two_pass=False,
            preset="ultrafast",
            source_info=info,
            trim_start=0.0,
            trim_end=info.duration,
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-ss" not in cmd
        assert "-t" not in cmd

    def test_build_cmd_with_trim_includes_ss_and_t(self, engine, real_video_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        if info.duration < 1.0:
            pytest.skip("sample too short")
        plan = EncodePlan(
            source=str(real_video_path),
            output="out.mp4",
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            audio_bitrate=128_000,
            two_pass=False,
            preset="ultrafast",
            source_info=info,
            trim_start=0.5,
            trim_end=min(info.duration, 1.5),
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert "-ss" in cmd
        ss_idx = cmd.index("-ss")
        assert float(cmd[ss_idx + 1]) == pytest.approx(0.5, abs=0.01)
        assert "-t" in cmd
        t_idx = cmd.index("-t")
        assert float(cmd[t_idx + 1]) == pytest.approx(plan.trim_duration, abs=0.01)
        assert ss_idx < cmd.index("-i")

    def test_encode_trimmed_clip(self, engine, real_video_path, tmp_path):
        from tuck.probe import probe

        info = probe(real_video_path)
        if info.duration < 1.5:
            pytest.skip("sample too short")
        output = tmp_path / "trimmed.mp4"
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
            trim_start=0.2,
            trim_end=0.9,
        )
        result = engine.encode(plan)
        assert result.exists()
        assert result.stat().st_size > 0
        out_info = probe(result)
        assert out_info.duration == pytest.approx(0.7, abs=0.35)

    def test_build_cmd_multi_segment_uses_concat_graph_and_filtered_audio(
        self, engine, real_video_path
    ):
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output="out.mp4",
            target_width=info.height,
            target_height=info.width,
            target_fps=15,
            video_bitrate=500_000,
            audio_bitrate=96_000,
            copy_audio=True,
            two_pass=False,
            source_info=info,
            segments=[Segment(0.2, 0.8), Segment(1.4, 2.1)],
            transform=VideoTransform(rotation=90),
            apply_fps_filter=True,
        )

        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        graph = cmd[cmd.index("-filter_complex") + 1]

        assert "trim=start=0.200:end=0.800,setpts=PTS-STARTPTS[v0]" in graph
        assert "atrim=start=1.400:end=2.100,asetpts=PTS-STARTPTS[a1]" in graph
        assert "concat=n=2:v=1:a=1[vcat][aout]" in graph
        assert graph.index("concat=n=2") < graph.index("transpose=clock")
        assert graph.index("transpose=clock") < graph.index("fps=15")
        assert cmd.count("-map") == 2
        assert "[vout]" in cmd and "[aout]" in cmd
        assert "-ss" not in cmd and "-t" not in cmd
        assert cmd[cmd.index("-c:a") + 1] == "aac"

    def test_multi_segment_pass_one_graph_has_no_audio_output(self, real_video_path):
        from tuck.encoding.command import build_base_cmd
        from tuck.probe import probe

        info = probe(real_video_path)
        plan = EncodePlan(
            source=str(real_video_path),
            output="out.mp4",
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            audio_bitrate=96_000,
            source_info=info,
            segments=[Segment(0.2, 0.8), Segment(1.4, 2.1)],
        )

        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source), include_audio=False)
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert "[0:a]" not in graph
        assert "[aout]" not in graph
        assert "concat=n=2:v=1:a=0[vout]" in graph
        assert "-an" in cmd

    def test_multi_segment_source_without_audio_builds_video_only_concat(
        self, engine, real_video_path
    ):
        from tuck.probe import probe

        info = probe(real_video_path)
        info.has_audio = False
        info.audio_bitrate = 0
        plan = EncodePlan(
            source=str(real_video_path),
            output="out.mp4",
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            audio_bitrate=0,
            source_info=info,
            segments=[Segment(0.2, 0.8), Segment(1.4, 2.1)],
        )

        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert "[0:a]" not in graph
        assert "concat=n=2:v=1:a=0[vout]" in graph
        assert "-an" in cmd

    @pytest.mark.ffmpeg
    def test_encode_multi_segment_two_pass_with_audio_and_summed_progress(
        self, engine, real_video_path, tmp_path
    ):
        from tuck.probe import probe

        info = probe(real_video_path)
        output = tmp_path / "segments.mp4"
        selected = [Segment(0.2, 0.8), Segment(1.4, 2.1)]
        progress = []
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            target_width=info.width,
            target_height=info.height,
            target_fps=info.fps,
            video_bitrate=500_000,
            original_video_bitrate=500_000,
            audio_bitrate=96_000,
            audio_channels=2,
            audio_sample_rate=44_100,
            two_pass=True,
            preset="ultrafast",
            estimated_size=200_000,
            target_size=5 * 1024 * 1024,
            rate_control=RC_EXPLICIT_BITRATE,
            source_info=info,
            segments=selected,
        )

        result = engine.encode(plan, on_progress=progress.append)
        output_info = probe(result)

        assert result.exists() and result.stat().st_size > 0
        assert output_info.duration == pytest.approx(1.3, abs=0.2)
        assert output_info.has_audio
        assert any(getattr(item, "duration", 0) == pytest.approx(1.3) for item in progress)


def test_encode_reports_progress_before_ffmpeg_exits(engine, real_video_path, tmp_path):
    from tuck.media_tools import find_ffmpeg

    ffmpeg = find_ffmpeg()
    assert ffmpeg is not None
    plan = EncodePlan(
        source=str(real_video_path),
        output=str(tmp_path / "live-progress.mp4"),
        preset="ultrafast",
        two_pass=False,
    )
    cmd = build_base_cmd(ffmpeg, plan, real_video_path)
    cmd.insert(cmd.index("-i"), "-re")
    updates = []

    def collect(progress):
        if 0 < progress.percent < 100:
            assert engine._process is not None
            assert engine._process.poll() is None
            updates.append(progress)

    engine._run_pass([*cmd, plan.output], 3, collect, pass_num=1)
    assert len(updates) >= 2
    assert updates[-1].percent > updates[0].percent
    assert all(progress.eta_seconds is not None for progress in updates)


def test_encoder_process_does_not_read_sidecar_requests():
    script = """
import sys
from tuck.encoding.runner import FFmpegEngine
engine = FFmpegEngine()
child = engine._spawn_ffmpeg(
    [sys.executable, "-c", "import sys; sys.stderr.write(repr(sys.stdin.read()))"], 0
)
_, child_input = child.communicate(timeout=10)
print(child_input)
print(repr(sys.stdin.read()))
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        input="sidecar request\n",
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    assert result.stdout.splitlines() == ["''", "'sidecar request\\n'"]
