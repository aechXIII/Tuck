import array
import io
import os
import subprocess
import sys
import threading
from dataclasses import replace
from pathlib import Path

import pytest

from tuck.encoding.capabilities import can_tone_map_hdr
from tuck.encoding.command import build_base_cmd, nvenc_preset, scaler_to_ffmpeg_flag
from tuck.encoding.failures import DISK_FULL_MESSAGE
from tuck.encoding.filters import build_video_filters
from tuck.encoding.runner import describe_encoder_fallback
from tuck.engine import EncodeCancelled, EncodeError, FFmpegEngine, is_ffmpeg_available
from tuck.media_tools import find_ffmpeg, find_ffprobe
from tuck.models import (
    ENCODER_AUTO,
    ENCODER_AUTO_COMPRESSION,
    RC_EXPLICIT_BITRATE,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    WORKFLOW_COMPRESSION,
    WORKFLOW_UPSCALE,
    AudioClip,
    AudioTrack,
    CropRect,
    EncodePlan,
    EncodeProgress,
    EncodeStage,
    OutputGeometry,
    PlanRequest,
    Profile,
    Segment,
    SourceAudioTrack,
    VideoInfo,
    VideoTransform,
)
from tuck.planner import plan as make_plan
from tuck.probe import _run_ffprobe_json, probe


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
    def test_refinement_allocation_failure_keeps_previous_result(
        self, engine, tmp_path, monkeypatch
    ):
        import tempfile

        output = tmp_path / "output.mp4"
        plan = EncodePlan(
            source="source.mp4",
            output=str(output),
            video_bitrate=1_000_000,
            estimated_size=9_000,
            target_size=10_000,
            two_pass=False,
            rate_control_method=RCM_CBR,
        )
        allocate = tempfile.mkstemp
        calls = 0

        def allocate_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError("No space left on device")
            return allocate(*args, **kwargs)

        def encode_once(_ffmpeg, _plan, _source, destination, *_args, **_kwargs):
            destination.write_bytes(b"a" * 4_000)
            return destination

        monkeypatch.setattr("tuck.encoding.runner.tempfile.mkstemp", allocate_once)
        monkeypatch.setattr(engine, "_encode_single_pass", encode_once)
        monkeypatch.setattr(engine, "_left_bitrate_unused", lambda *_args: False)

        result = engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)

        assert result.read_bytes() == b"a" * 4_000
        assert plan.video_bitrate == 1_000_000
        assert plan.estimated_size == 9_000
        assert set(tmp_path.iterdir()) == {output}

    @pytest.mark.parametrize(
        "refinements, expected_byte, expected_size, expected_bitrate",
        [
            (["failure"], b"a", 4_000, 1_000_000),
            (["os_error"], b"a", 4_000, 1_000_000),
            (["missing", "missing"], b"a", 4_000, 1_000_000),
            (["empty", "empty"], b"a", 4_000, 1_000_000),
            ([12_000, 11_000], b"a", 4_000, 1_000_000),
            ([3_000], b"a", 4_000, 1_000_000),
            ([4_100], b"b", 4_100, 1_080_000),
            ([6_000, "failure"], b"b", 6_000, 1_080_000),
        ],
    )
    def test_refinement_publishes_best_under_target_result(
        self,
        engine,
        tmp_path,
        monkeypatch,
        refinements,
        expected_byte,
        expected_size,
        expected_bitrate,
    ):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        output = tmp_path / "output.mp4"
        plan = EncodePlan(
            source=str(source),
            output=str(output),
            video_bitrate=1_000_000,
            estimated_size=9_000,
            audio_bitrate=0,
            target_size=10_000,
            two_pass=False,
            rate_control_method=RCM_CBR,
        )
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
        )
        monkeypatch.setattr(engine, "_left_bitrate_unused", lambda *_args: False)
        outcomes = iter([4_000, *refinements])
        attempt_paths = []
        attempt_plans = []
        metadata = {}

        def encode_once(_ffmpeg, attempt_plan, _source, destination, *_args, **_kwargs):
            attempt_paths.append(destination)
            attempt_plans.append(attempt_plan)
            outcome = next(outcomes)
            if outcome == "failure":
                destination.write_bytes(b"partial")
                raise EncodeError("refinement failed")
            if outcome == "os_error":
                raise OSError(12, "Cannot allocate memory")
            if outcome == "missing":
                destination.unlink(missing_ok=True)
            elif outcome == "empty":
                destination.write_bytes(b"")
            else:
                marker = bytes([ord("a") + len(attempt_paths) - 1])
                destination.write_bytes(marker * outcome)
                metadata[marker] = (attempt_plan.video_bitrate, attempt_plan.estimated_size)
            return destination

        monkeypatch.setattr(engine, "_encode_single_pass", encode_once)
        result = engine.encode(plan)

        assert result == output
        assert result.read_bytes() == expected_byte * expected_size
        selected_plan = attempt_plans[-1]
        assert selected_plan.video_bitrate == expected_bitrate
        assert (selected_plan.video_bitrate, selected_plan.estimated_size) == metadata[
            expected_byte
        ]
        assert engine.resolved_encoder == "libx264"
        assert engine.encoder_fallback == ""
        assert len(set(attempt_paths)) == len(attempt_paths)
        assert all(path != source and path != output for path in attempt_paths)
        assert source.read_bytes() == b"source"
        assert set(tmp_path.iterdir()) == {source, output}

    @pytest.mark.parametrize("failure", ["cancel", "encode_error", "os_error"])
    def test_refinement_cancellation_discards_saved_candidate(
        self, engine, tmp_path, monkeypatch, failure
    ):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        output = tmp_path / "output.mp4"
        output.write_bytes(b"existing export")
        plan = EncodePlan(
            source=str(source),
            output=str(output),
            replace_existing=True,
            video_bitrate=1_000_000,
            target_size=10_000,
            two_pass=False,
            rate_control_method=RCM_CBR,
        )
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
        )
        monkeypatch.setattr(engine, "_left_bitrate_unused", lambda *_args: False)
        calls = 0

        def encode_once(_ffmpeg, _plan, _source, destination, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            destination.write_bytes(b"a" * 4_000)
            if calls == 2:
                engine.cancel()
                if failure == "cancel":
                    raise EncodeCancelled("Encoding cancelled by user")
                if failure == "os_error":
                    raise OSError(12, "Cannot allocate memory")
                raise EncodeError("process stopped after cancellation")
            return destination

        monkeypatch.setattr(engine, "_encode_single_pass", encode_once)
        with pytest.raises(EncodeCancelled):
            engine.encode(plan)

        assert output.read_bytes() == b"existing export"
        assert source.read_bytes() == b"source"
        assert set(tmp_path.iterdir()) == {source, output}

    def test_attempt_os_error_without_saved_candidate_propagates(
        self, engine, tmp_path, monkeypatch
    ):
        output = tmp_path / "output.mp4"
        plan = EncodePlan(source="source.mp4", output=str(output), two_pass=False)
        error = OSError(12, "Cannot allocate memory")

        def fail(*_args, **_kwargs):
            raise error

        monkeypatch.setattr(engine, "_encode_single_pass", fail)
        with pytest.raises(OSError) as caught:
            engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)

        assert caught.value is error
        assert not list(tmp_path.iterdir())

    def test_saved_candidate_replace_os_error_propagates(self, engine, tmp_path, monkeypatch):
        output = tmp_path / "output.mp4"
        output.mkdir()
        plan = EncodePlan(
            source="source.mp4",
            output=str(output),
            video_bitrate=1_000_000,
            target_size=10_000,
            two_pass=False,
        )

        def encode_once(_ffmpeg, _plan, _source, destination, *_args, **_kwargs):
            destination.write_bytes(b"a" * 4_000)
            return destination

        monkeypatch.setattr(engine, "_encode_single_pass", encode_once)
        monkeypatch.setattr(engine, "_left_bitrate_unused", lambda *_args: False)
        with pytest.raises(OSError):
            engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)

        assert set(tmp_path.iterdir()) == {output}
        assert output.is_dir()

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
        bitrates = []

        def encode_once(_ffmpeg, attempt_plan, _source, destination, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            bitrates.append(attempt_plan.video_bitrate)
            # a content-limited source: raising the bitrate does not add bytes
            destination.write_bytes(b"x" * 4_000_000)
            return destination

        engine._encode_single_pass = encode_once
        result = engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)
        assert result == output
        assert bitrates == [1_000_000, 1_080_000]
        assert plan.video_bitrate == 1_000_000, (
            "keep the metadata of the equally sized first output"
        )
        assert calls == 2, "stop after the retry that did not grow the output, not at the limit"

    def test_undershoot_is_accepted_when_the_video_left_its_bitrate_unused(
        self, engine, real_video_path, tmp_path
    ):
        output = tmp_path / "output.mp4"
        plan = EncodePlan(
            source=str(real_video_path),
            output=str(output),
            video_bitrate=5_000_000,
            audio_bitrate=0,
            two_pass=False,
            target_size=10_000_000,
            rate_control_method=RCM_CBR,
        )
        calls = 0

        def encode_once(_ffmpeg, _plan, _source, destination, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            # a small test pattern cannot use 5 Mbps, so more bitrate would change nothing
            destination.write_bytes(real_video_path.read_bytes())
            return destination

        engine._encode_single_pass = encode_once
        result = engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 3.0, None)
        assert result == output
        assert calls == 1
        assert plan.video_bitrate == 5_000_000

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

        def encode_once(_ffmpeg, _plan, _source, destination, *_args, **_kwargs):
            destination.write_bytes(b"x" * next(sizes))
            return destination

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

        def encode_once(_ffmpeg, attempt_plan, _source, destination, *_args, **_kwargs):
            seen.append(attempt_plan.transform.crop)
            destination.write_bytes(b"x" * 4_000_000)
            return destination

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
        assert cmd[cmd.index("-b:v") + 1] == "2000000"
        assert cmd[cmd.index("-maxrate") + 1] == "3000000"
        assert cmd[cmd.index("-bufsize") + 1] == "6000000"

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
        """AMF has no plain "vbr" rate control; its capped VBR is vbr_peak."""
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
        assert cmd[rc_idx + 1] == "vbr_peak"
        assert cmd[cmd.index("-b:v") + 1] == "2000000"
        assert cmd[cmd.index("-maxrate") + 1] == "3000000"
        assert cmd[cmd.index("-bufsize") + 1] == "6000000"

    def testnvenc_preset_mapping(self):
        """NVENC preset mapping converts x264 preset names to p1-p7."""
        assert nvenc_preset("medium") == "p5"
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


_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _ffmpeg_or_skip() -> str:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is unavailable")
    return ffmpeg


def _make_clip(ffmpeg: str, path: Path, *extra: str, audio_tracks: int = 1) -> None:
    cmd = [ffmpeg, "-y", "-v", "error", "-f", "lavfi"]
    cmd += ["-i", "testsrc2=duration=1:size=320x240:rate=25"]
    for index in range(audio_tracks):
        cmd += ["-f", "lavfi", "-i", f"sine=frequency={440 + index * 220}:duration=1"]
    cmd += ["-map", "0:v"]
    for index in range(audio_tracks):
        cmd += ["-map", f"{index + 1}:a"]
    cmd += [*extra, str(path)]
    result = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=_NO_WINDOW)
    if result.returncode != 0 or not path.is_file():
        pytest.skip(f"cannot create {path.name}")


def _small_info(path: Path, **overrides) -> VideoInfo:
    base = VideoInfo(
        path=str(path),
        duration=1.0,
        width=320,
        height=240,
        fps=25.0,
        video_codec="h264",
        audio_codec="aac",
        audio_channels=1,
        audio_sample_rate=44100,
        audio_bitrate=64_000,
        has_audio=True,
    )
    return replace(base, **overrides)


def _small_plan(source: Path, output: Path, **overrides) -> EncodePlan:
    base = EncodePlan(
        source=str(source),
        output=str(output),
        target_width=320,
        target_height=240,
        target_fps=25.0,
        video_bitrate=400_000,
        original_video_bitrate=400_000,
        audio_bitrate=64_000,
        two_pass=False,
        preset="ultrafast",
        video_encoder="libx264",
        rate_control_method=RCM_VBR,
        target_size=5 * 1024 * 1024,
        source_info=_small_info(source),
    )
    return replace(base, **overrides)


def _maps(cmd: list[str]) -> list[str]:
    return [cmd[index + 1] for index, arg in enumerate(cmd) if arg == "-map"]


def _probe_streams(path: Path, *entries: str) -> list[str]:
    return subprocess.run(
        [find_ffprobe() or "ffprobe", "-v", "error", *entries, "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=_NO_WINDOW,
    ).stdout.split()


class TestCancelBetweenRuns:
    def test_cancel_before_spawn_never_starts_ffmpeg(self, monkeypatch):
        engine = FFmpegEngine()
        engine.cancel()

        def no_spawn(*_args, **_kwargs):
            raise AssertionError("FFmpeg started after cancel")

        monkeypatch.setattr("tuck.encoding.runner.subprocess.Popen", no_spawn)
        with pytest.raises(EncodeCancelled):
            engine._run_pass(["ffmpeg"], 1.0, None, pass_num=2, total_passes=2)

    def test_cancel_between_candidates_stops_the_fallback(self, tmp_path, monkeypatch):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders",
            lambda: frozenset({"libx264", "h264_nvenc"}),
        )
        engine = FFmpegEngine()
        spawned: list[list[str]] = []

        class FailedNvenc:
            pid = 0
            returncode = 1

            def __init__(self) -> None:
                self.stderr = io.StringIO("[h264_nvenc @ 01] Cannot load nvcuda.dll\n")

            def poll(self) -> int:
                return 1

            def wait(self, timeout: float | None = None) -> int:
                return 1

        def popen(cmd, **_kwargs):
            spawned.append(cmd)
            return FailedNvenc()

        def cleanup_then_cancel(_output: Path) -> None:
            # the user cancels after the hardware attempt failed, before the next one starts
            engine._cancel_event.set()

        monkeypatch.setattr("tuck.encoding.runner.subprocess.Popen", popen)
        monkeypatch.setattr(engine, "_cleanup_output", cleanup_then_cancel)
        plan = _small_plan(source, tmp_path / "out.mp4", video_encoder=ENCODER_AUTO)
        with pytest.raises(EncodeCancelled):
            engine.encode(plan)
        assert len(spawned) == 1
        assert "h264_nvenc" in spawned[0]

    def test_early_stop_kills_ffmpeg_instead_of_waiting_for_it(self):
        engine = FFmpegEngine()
        # a stand-in for FFmpeg that reports progress and never exits by itself
        child = (
            "import sys, time\n"
            "while True:\n"
            "    sys.stderr.write('out_time_us=500000\\nprogress=continue\\n')\n"
            "    sys.stderr.flush()\n"
            "    time.sleep(0.02)\n"
        )
        outcome: list[BaseException] = []

        def on_progress(_progress):
            # stop reading the way a cancel does, without killing the process here
            engine._cancel_event.set()

        def run():
            try:
                engine._run_pass([sys.executable, "-c", child], 1.0, on_progress, pass_num=1)
            except BaseException as exc:
                outcome.append(exc)

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout=30)
        assert not worker.is_alive(), "the pass waited for an FFmpeg that was never stopped"
        assert len(outcome) == 1 and isinstance(outcome[0], EncodeCancelled)
        assert engine._process is None


class TestFailureOutput:
    def test_failure_is_explained_and_keeps_ffmpeg_output_without_progress(self):
        engine = FFmpegEngine()
        child = (
            "import sys\n"
            "for _ in range(300):\n"
            "    sys.stderr.write('out_time_us=100000\\nprogress=continue\\n')\n"
            "sys.stderr.write('[mp4 @ 01] Error writing trailer: No space left on device\\n')\n"
            "sys.exit(1)\n"
        )
        with pytest.raises(EncodeError) as caught:
            engine._run_pass([sys.executable, "-c", child], 1.0, None, pass_num=1)
        assert str(caught.value) == DISK_FULL_MESSAGE
        assert caught.value.returncode == 1
        assert "No space left on device" in caught.value.stderr
        assert "progress=" not in engine.last_stderr
        assert "No space left on device" in engine.last_stderr

    def test_kept_output_is_limited_by_characters(self):
        engine = FFmpegEngine()
        child = (
            "import sys\n"
            "for index in range(150):\n"
            "    sys.stderr.write(f'line {index} ' + 'x' * 100 + '\\n')\n"
            "sys.exit(1)\n"
        )
        with pytest.raises(EncodeError):
            engine._run_pass([sys.executable, "-c", child], 1.0, None, pass_num=1)
        assert len(engine.last_stderr) == 4000
        assert engine.last_stderr.endswith("x\n")


class TestEncoderFallbackNotice:
    @pytest.mark.parametrize(
        ("used", "failures", "notice"),
        [
            (
                "libx264",
                [("h264_nvenc", "device")],
                "Used software encoding because the NVIDIA encoder couldn't start",
            ),
            (
                "h264_amf",
                [("h264_nvenc", "settings")],
                "Used the AMD encoder because the NVIDIA encoder didn't accept these settings",
            ),
            (
                "libx264",
                [("h264_nvenc", "device"), ("h264_amf", "device")],
                "Used software encoding because the NVIDIA and AMD encoders couldn't start",
            ),
        ],
    )
    def test_wording(self, used, failures, notice):
        assert describe_encoder_fallback(used, failures) == notice

    def test_auto_fallback_is_recorded_in_plain_words(self, tmp_path, monkeypatch):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders",
            lambda: frozenset({"libx264", "h264_nvenc"}),
        )
        engine = FFmpegEngine()

        def encode_with_retry(_ffmpeg, attempt, _source, output, *_args):
            if attempt.video_encoder == "h264_nvenc":
                raise EncodeError("failed", stderr="Cannot load nvcuda.dll")
            output.write_bytes(b"encoded")
            return output

        monkeypatch.setattr(engine, "_encode_with_retry", encode_with_retry)
        engine.encode(_small_plan(source, tmp_path / "out.mp4", video_encoder=ENCODER_AUTO))
        assert engine.resolved_encoder == "libx264"
        assert (
            engine.encoder_fallback
            == "Used software encoding because the NVIDIA encoder couldn't start"
        )

    def test_explicit_encoder_records_no_fallback(self, tmp_path, monkeypatch):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"source")
        monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(
            "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
        )
        engine = FFmpegEngine()
        engine._encoder_fallback = "left over from an earlier export"

        def encode_with_retry(_ffmpeg, _attempt, _source, output, *_args):
            output.write_bytes(b"encoded")
            return output

        monkeypatch.setattr(engine, "_encode_with_retry", encode_with_retry)
        engine.encode(_small_plan(source, tmp_path / "out.mp4"))
        assert engine.resolved_encoder == "libx264"
        assert engine.encoder_fallback == ""


class TestRateControl:
    def test_two_pass_compression_uses_capped_vbr(self, tmp_path):
        plan = _small_plan(tmp_path / "in.mp4", tmp_path / "out.mp4", two_pass=True)
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source), include_audio=False)
        assert cmd[cmd.index("-b:v") + 1] == "400000"
        assert cmd[cmd.index("-maxrate") + 1] == "600000"
        assert cmd[cmd.index("-bufsize") + 1] == "1200000"
        assert "-minrate" not in cmd

    def test_explicit_cbr_stays_constant(self, tmp_path):
        plan = _small_plan(tmp_path / "in.mp4", tmp_path / "out.mp4", rate_control_method=RCM_CBR)
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert cmd[cmd.index("-minrate") + 1] == "400000"
        assert cmd[cmd.index("-maxrate") + 1] == "400000"

    def test_nvenc_compression_uses_capped_vbr(self, tmp_path):
        plan = _small_plan(
            tmp_path / "in.mp4",
            tmp_path / "out.mp4",
            video_encoder="h264_nvenc",
            preset="p5",
            workflow=WORKFLOW_COMPRESSION,
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert cmd[cmd.index("-rc") + 1] == "vbr"
        assert cmd[cmd.index("-maxrate") + 1] == "600000"
        assert cmd[cmd.index("-bufsize") + 1] == "1200000"


class TestStreamMapping:
    def test_filtered_path_uses_the_first_audio_track(self, tmp_path):
        plan = _small_plan(
            tmp_path / "in.mp4",
            tmp_path / "out.mp4",
            segments=[Segment(0.0, 0.4), Segment(0.6, 1.0)],
            source_audio_gain_db=-3.0,
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert "[0:a:0]" in graph
        assert "[0:a]" not in graph

    def test_added_audio_is_mixed_into_the_first_track_only(self, tmp_path):
        music = AudioTrack(
            "music",
            "Music",
            [AudioClip(str(tmp_path / "music.wav"), 0.0, 0.0, 1.0, 1.0)],
        )
        plan = _small_plan(
            tmp_path / "in.mkv",
            tmp_path / "out.mp4",
            source_audio_tracks=[SourceAudioTrack(0), SourceAudioTrack(1)],
            audio_tracks=[music],
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert _maps(cmd) == ["[vout]", "[aout]", "[aout1]"]
        parts = cmd[cmd.index("-filter_complex") + 1].split(";")
        first = next(part for part in parts if part.endswith("[aout]"))
        second = next(part for part in parts if part.endswith("[aout1]"))
        assert first.startswith("[mix0][mix1]amix=inputs=2")
        assert any(part.startswith("[1:a:0]") and part.endswith("[mix1]") for part in parts)
        assert second == "[t1mix0]anull[aout1]"
        assert any(part.startswith("[0:a:1]") and part.endswith("[t1sa0]") for part in parts)

    def test_each_source_track_gets_its_own_volume(self, tmp_path):
        plan = _small_plan(
            tmp_path / "in.mkv",
            tmp_path / "out.mp4",
            source_audio_muted=True,
            source_audio_gain_db=-12.0,
            source_audio_tracks=[SourceAudioTrack(1, 3.0), SourceAudioTrack(2)],
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert _maps(cmd) == ["[vout]", "[aout]", "[aout1]"]
        parts = cmd[cmd.index("-filter_complex") + 1].split(";")
        second = next(part for part in parts if part.startswith("[0:a:1]"))
        third = next(part for part in parts if part.startswith("[0:a:2]"))
        assert not any(part.startswith("[0:a:0]") for part in parts)
        assert any(part.startswith("[sa0]volume=3.00dB") for part in parts)
        assert second.endswith("[sa0]")
        assert third.endswith("[t1sa0]")
        assert "-12.00dB" not in cmd[cmd.index("-filter_complex") + 1]

    def test_subtitles_come_after_every_audio_track(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", subtitle_codecs=["subrip"])
        plan = _small_plan(
            tmp_path / "in.mkv",
            tmp_path / "out.mp4",
            source_info=info,
            source_audio_tracks=[SourceAudioTrack(0), SourceAudioTrack(1)],
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert _maps(cmd) == ["0:v:0", "0:a:0?", "0:a:1?", "0:s:0?"]

    def test_first_text_track_is_kept_as_mov_text(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", subtitle_codecs=["hdmv_pgs_subtitle", "subrip"])
        plan = _small_plan(tmp_path / "in.mkv", tmp_path / "out.mp4", source_info=info)
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert _maps(cmd) == ["0:v:0", "0:a:0?", "0:s:1?"]
        assert cmd[cmd.index("-c:s") + 1] == "mov_text"

    def test_picture_subtitles_are_not_mapped(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", subtitle_codecs=["hdmv_pgs_subtitle"])
        plan = _small_plan(tmp_path / "in.mkv", tmp_path / "out.mp4", source_info=info)
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert _maps(cmd) == ["0:v:0", "0:a:0?"]
        assert "-c:s" not in cmd

    def test_analysis_pass_carries_no_subtitles(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", subtitle_codecs=["subrip"])
        plan = _small_plan(
            tmp_path / "in.mkv", tmp_path / "out.mp4", source_info=info, two_pass=True
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source), include_audio=False)
        assert _maps(cmd) == ["0:v:0"]
        assert "-c:s" not in cmd

    def test_filtered_export_from_the_start_ends_subtitles_with_the_picture(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", duration=2.0, subtitle_codecs=["ass"])
        plan = _small_plan(
            tmp_path / "in.mkv",
            tmp_path / "out.mp4",
            source_info=info,
            segments=[Segment(0.0, 1.5)],
            source_audio_gain_db=-3.0,
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert _maps(cmd) == ["[vout]", "[aout]", "0:s:0?"]
        assert cmd[cmd.index("-t") + 1] == "1.500"

    def test_subtitle_input_comes_after_the_prepared_video(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", duration=2.0, subtitle_codecs=["subrip"])
        plan = _small_plan(
            tmp_path / "in.mkv",
            tmp_path / "out.mp4",
            source_info=info,
            segments=[Segment(0.5, 1.5)],
        )
        cmd = build_base_cmd(
            "ffmpeg", plan, Path(plan.source), prepared_video=tmp_path / "blend.nut"
        )
        assert "[1:v]" in cmd[cmd.index("-filter_complex") + 1]
        assert "2:s:0?" in _maps(cmd)

    def test_several_parts_drop_subtitles(self, tmp_path):
        info = _small_info(tmp_path / "in.mkv", duration=2.0, subtitle_codecs=["subrip"])
        plan = _small_plan(
            tmp_path / "in.mkv",
            tmp_path / "out.mp4",
            source_info=info,
            segments=[Segment(0.0, 0.5), Segment(1.0, 1.5)],
        )
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert not any(arg.endswith(":s:0?") for arg in cmd)
        assert "-c:s" not in cmd


class TestToneMapping:
    def test_sdr_plan_has_no_tone_mapping(self, tmp_path):
        plan = _small_plan(tmp_path / "in.mp4", tmp_path / "out.mp4")
        cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
        assert not any("zscale" in arg or "tonemap" in arg for arg in cmd)
        assert "-color_trc" not in cmd

    def test_blended_video_stays_sdr_after_tone_mapping(self, tmp_path):
        info = _small_info(
            tmp_path / "in.mp4",
            color_transfer="smpte2084",
            color_primaries="bt2020",
            color_space="bt2020nc",
        )
        plan = _small_plan(tmp_path / "in.mp4", tmp_path / "out.mp4", source_info=info)
        plan.tone_map_hdr = True
        cmd = build_base_cmd(
            "ffmpeg", plan, Path(plan.source), prepared_video=tmp_path / "blend.nut"
        )
        graph = cmd[cmd.index("-filter_complex") + 1]
        # nothing after the tone map converts to BT.601 or brings back the HDR colours
        tail = graph[graph.index("tonemap") :]
        assert "bt601" not in tail
        assert "smpte2084" not in tail
        assert cmd[cmd.index("-colorspace") + 1] == "bt709"

    def test_blended_sdr_video_keeps_its_own_colours(self, tmp_path):
        info = _small_info(
            tmp_path / "in.mp4", color_transfer="smpte170m", color_primaries="smpte170m"
        )
        plan = _small_plan(tmp_path / "in.mp4", tmp_path / "out.mp4", source_info=info)
        cmd = build_base_cmd(
            "ffmpeg", plan, Path(plan.source), prepared_video=tmp_path / "blend.nut"
        )
        graph = cmd[cmd.index("-filter_complex") + 1]
        assert "scale=out_color_matrix=bt601:out_range=tv" in graph
        assert "color_trc=smpte170m" in graph


class TestRealExports:
    def test_non_ascii_source_and_output_encode(self, tmp_path):
        ffmpeg = _ffmpeg_or_skip()
        source = tmp_path / "あいう 動画.mp4"
        _make_clip(ffmpeg, source, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac")
        info = probe(source)
        output = tmp_path / "出力 クリップ.mp4"
        result = FFmpegEngine().encode(
            _small_plan(source, output, source_info=info, target_fps=info.fps)
        )
        assert result.is_file() and result.stat().st_size > 0
        ffprobe = find_ffprobe()
        if ffprobe:
            # the ffprobe fallback must read the same UTF-8 file name back
            data = _run_ffprobe_json(ffprobe, source, "probing")
            assert data["format"]["filename"] == str(source)

    @pytest.mark.parametrize(
        ("segments", "gain", "source_audio_segments"),
        [
            # no edits, so the tracks are mapped straight through
            (None, 0.0, None),
            # cut, with the first track joined to the video concat
            ([Segment(0.0, 0.4), Segment(0.6, 1.0)], 0.0, None),
            # cut with a volume change, through the source audio chain
            ([Segment(0.0, 0.4), Segment(0.6, 1.0)], -3.0, None),
            # source audio split apart from the video
            ([Segment(0.0, 1.0)], 0.0, [Segment(0.0, 0.3), Segment(0.6, 1.0)]),
        ],
    )
    def test_every_audio_track_is_encoded(self, tmp_path, segments, gain, source_audio_segments):
        ffmpeg = _ffmpeg_or_skip()
        source = tmp_path / "tracks.mkv"
        _make_clip(
            ffmpeg,
            source,
            *("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac:a:1", "6"),
            audio_tracks=3,
        )
        info = probe(source)
        assert info.audio_stream_count == 3
        assert info.audio_codecs == ["aac", "aac", "aac"]
        output = FFmpegEngine().encode(
            _small_plan(
                source,
                tmp_path / "out.mp4",
                source_info=info,
                audio_channels=2,
                source_audio_tracks=[SourceAudioTrack(index, gain) for index in range(3)],
                segments=segments or [],
                source_audio_segments=source_audio_segments,
            )
        )
        durations = _probe_streams(
            output, "-select_streams", "a", "-show_entries", "stream=duration"
        )
        expected = sum(segment.duration for segment in segments) if segments else 1.0
        assert len(durations) == 3
        for duration in durations:
            assert float(duration) == pytest.approx(expected, abs=0.1)

    def test_copied_audio_tracks_keep_their_order(self, tmp_path):
        ffmpeg = _ffmpeg_or_skip()
        source = tmp_path / "tracks.mkv"
        _make_clip(
            ffmpeg,
            source,
            *("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac:a:1", "6"),
            audio_tracks=3,
        )
        info = probe(source)
        output = FFmpegEngine().encode(
            _small_plan(
                source,
                tmp_path / "out.mp4",
                source_info=info,
                copy_audio=True,
                source_audio_tracks=[SourceAudioTrack(index) for index in range(3)],
            )
        )
        channels = _probe_streams(
            output, "-select_streams", "a", "-show_entries", "stream=channels"
        )
        assert channels == ["1", "6", "1"]

    @pytest.mark.parametrize("copy_audio", [True, False])
    def test_muted_source_tracks_are_left_out(self, tmp_path, copy_audio):
        ffmpeg = _ffmpeg_or_skip()
        source = tmp_path / "tracks.mkv"
        _make_clip(
            ffmpeg,
            source,
            *("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac:a:1", "6"),
            audio_tracks=3,
        )
        info = probe(source)
        # the first track is muted; cutting and turning the third down sends both through filters
        overrides = (
            {"copy_audio": True, "source_audio_tracks": [SourceAudioTrack(1), SourceAudioTrack(2)]}
            if copy_audio
            else {
                "audio_channels": 2,
                "segments": [Segment(0.0, 0.4), Segment(0.6, 1.0)],
                "source_audio_tracks": [SourceAudioTrack(1), SourceAudioTrack(2, -6.0)],
            }
        )
        output = FFmpegEngine().encode(
            _small_plan(source, tmp_path / "out.mp4", source_info=info, **overrides)
        )
        channels = _probe_streams(
            output, "-select_streams", "a", "-show_entries", "stream=channels"
        )
        assert channels == (["6", "1"] if copy_audio else ["2", "2"])

    @pytest.mark.parametrize(
        ("container", "codec", "segments", "gain"),
        [
            ("mkv", "srt", None, 0.0),
            ("mp4", "mov_text", None, 0.0),
            # a trimmed start with edited audio goes through the filter graph
            ("mkv", "srt", [Segment(0.3, 1.0)], -3.0),
        ],
    )
    def test_text_subtitles_are_kept_in_time(self, tmp_path, container, codec, segments, gain):
        ffmpeg = _ffmpeg_or_skip()
        clip = tmp_path / "clip.mkv"
        _make_clip(ffmpeg, clip, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac")
        subtitles = tmp_path / "subtitles.srt"
        subtitles.write_text("1\n00:00:00,500 --> 00:00:00,900\nHello\n", encoding="utf-8")
        source = tmp_path / f"subtitled.{container}"
        muxed = subprocess.run(
            [
                *(ffmpeg, "-y", "-v", "error", "-i", str(clip), "-i", str(subtitles)),
                *("-map", "0", "-map", "1", "-c", "copy", "-c:s", codec, str(source)),
            ],
            capture_output=True,
            timeout=60,
            creationflags=_NO_WINDOW,
        )
        if muxed.returncode != 0:
            pytest.skip(f"cannot mux {codec} subtitles into {container}")
        info = probe(source)
        assert info.text_subtitle_track == 0
        request = PlanRequest(segments=segments, source_audio_gain_db=gain) if segments else None
        encode_plan = make_plan(
            source,
            Profile(name="Subtitles", two_pass=False, preset="ultrafast"),
            output=tmp_path / "out.mp4",
            request=request,
            source_info=info,
        )
        assert encode_plan.warnings == []
        result = FFmpegEngine().encode(encode_plan)
        report = _probe_streams(
            result, "-select_streams", "s", "-show_entries", "stream=codec_name:packet=pts_time"
        )
        assert "mov_text" in report
        start = 0.3 if segments else 0.0
        times = [float(value.strip(",")) for value in report if value != "mov_text"]
        assert any(abs(time - (0.5 - start)) < 0.05 for time in times), report

    @pytest.mark.parametrize(
        "tags",
        [
            {"color_trc": "arib-std-b67", "color_primaries": "bt2020", "colorspace": "bt2020nc"},
            # many PQ files tag only the transfer, which zscale can't place on its own
            {"color_trc": "smpte2084"},
        ],
        ids=["hlg", "pq-transfer-only"],
    )
    def test_hdr_source_is_tone_mapped_to_sdr(self, tmp_path, tags):
        ffmpeg = _ffmpeg_or_skip()
        if not can_tone_map_hdr():
            pytest.skip("this FFmpeg has no zscale and tonemap filters")
        source = tmp_path / "hdr.mkv"
        setparams = ":".join(f"{name}={value}" for name, value in tags.items())
        output_tags = [arg for name, value in tags.items() for arg in (f"-{name}", value)]
        _make_clip(
            ffmpeg,
            source,
            *("-vf", f"format=yuv420p10le,setparams={setparams}", "-c:v", "ffv1"),
            *output_tags,
            *("-c:a", "aac"),
        )
        info = probe(source)
        assert info.is_hdr
        encode_plan = make_plan(
            source,
            Profile(name="HDR", two_pass=False, preset="ultrafast"),
            output=tmp_path / "sdr.mp4",
            source_info=info,
        )
        assert encode_plan.tone_map_hdr
        output_info = probe(FFmpegEngine().encode(encode_plan))
        assert output_info.color_transfer == "bt709"
        assert not output_info.is_hdr
