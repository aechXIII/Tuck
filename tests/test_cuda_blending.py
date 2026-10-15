from __future__ import annotations

from dataclasses import replace
from fractions import Fraction
from pathlib import Path

import pytest

from tuck.encoding.command import build_base_cmd, can_hardware_decode_blend
from tuck.encoding.failures import is_hardware_decode_failure
from tuck.encoding.frame_blending import TmixBlend, TmixPiece
from tuck.encoding.hardware_decoding import HardwareDecode
from tuck.encoding.runner import EncodeCancelled, EncodeError, FFmpegEngine
from tuck.models import (
    RC_EXPLICIT_BITRATE,
    EncodePlan,
    FrameBlending,
    Segment,
    VideoInfo,
    VideoTransform,
)


def blending_plan(tmp_path: Path) -> EncodePlan:
    return EncodePlan(
        source=str(tmp_path / "source.mp4"),
        output=str(tmp_path / "output.mp4"),
        target_fps=60,
        source_info=VideoInfo(
            path=str(tmp_path / "source.mp4"),
            duration=2,
            width=1920,
            height=1080,
            fps=300,
            video_codec="av1",
            pixel_format="yuv420p",
            variable_frame_rate=False,
            color_space="bt709",
            color_range="pc",
        ),
        frame_blending=FrameBlending(enabled=True),
        two_pass=False,
    )


def blend_for(plan: EncodePlan) -> TmixBlend:
    return TmixBlend(
        Fraction(60),
        tuple(
            TmixPiece(
                Fraction(segment.start), Fraction(segment.end), (Fraction(1),) * 5, 4, 599, 5, 0, 0
            )
            for segment in plan.effective_segments
        ),
    )


def test_cuda_download_precedes_blending_without_changing_samples(tmp_path):
    plan = blending_plan(tmp_path)
    blend = blend_for(plan)
    assert blend is not None
    assert can_hardware_decode_blend(plan, blend)
    software = build_base_cmd("ffmpeg", plan, Path(plan.source), blend=blend)
    cuda = build_base_cmd(
        "ffmpeg", plan, Path(plan.source), blend=blend, hardware_decode=HardwareDecode("cuda")
    )
    index = cuda.index("-hwaccel")
    assert cuda[index : index + 4] == ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    assert index < cuda.index("-i")
    assert "-xerror" in cuda
    assert "-xerror" not in software
    graph = cuda[cuda.index("-filter_complex") + 1]
    assert graph.count("hwdownload,format=nv12,") == 1
    assert (
        graph.replace("hwdownload,format=nv12,", "")
        == software[software.index("-filter_complex") + 1]
    )
    assert cuda[cuda.index("-c:v") + 1] == "av1"
    assert cuda[cuda.index("-c:v", cuda.index("-i")) + 1] == "libx264"


@pytest.mark.parametrize(
    "changes",
    [
        {"video_codec": "h264"},
        {"pixel_format": "yuv420p10le"},
        {"display_rotation": 90},
        {"color_transfer": "smpte2084"},
        {"color_transfer": "arib-std-b67"},
    ],
)
def test_cuda_rejects_unqualified_source_formats(tmp_path, changes):
    plan = blending_plan(tmp_path)
    assert plan.source_info is not None
    plan.source_info = replace(plan.source_info, **changes)
    blend = blend_for(plan)
    assert not can_hardware_decode_blend(plan, blend)
    command = build_base_cmd(
        "ffmpeg", plan, Path(plan.source), blend=blend, hardware_decode=HardwareDecode("cuda")
    )
    assert "-hwaccel" not in command


def test_cuda_requires_single_untransformed_blending_piece(tmp_path):
    plan = blending_plan(tmp_path)
    assert not can_hardware_decode_blend(plan, None)
    plan.transform = VideoTransform(rotation=90)
    assert not can_hardware_decode_blend(plan, blend_for(plan))
    plan.transform = VideoTransform()
    plan.segments = [Segment(0, 0.5), Segment(1, 1.5)]
    assert not can_hardware_decode_blend(plan, blend_for(plan))


@pytest.mark.parametrize(
    "stderr",
    [
        "[av1 @ 01] Failed setup for format cuda: hwaccel initialisation returned error.",
        "[AVHWDeviceContext @ 01] Cannot load nvcuda.dll",
        "[AVHWDeviceContext @ 01] Cannot load libcuda.so.1",
        "[AVHWDeviceContext @ 01] Cannot load libcuda.so.1\n"
        "No device available for decoder: device type cuda needed for codec av1.\n"
        "Hardware device setup failed for decoder: Operation not permitted\n"
        "Error opening output files: Operation not permitted",
        "Unknown decoder 'av1'",
        "[av1 @ 01] Your platform doesn't support hardware accelerated AV1 decoding.\n"
        "[av1 @ 01] Failed to get pixel format.",
        "[av1 @ 01] Failed to get number of CUDA devices",
        "[av1 @ 01] Hardware is lacking required capabilities",
        "[Parsed_hwdownload_0 @ 01] Failed to download frame: -1",
        "No device available for decoder: device type cuda needed for codec av1.",
        "[AVHWDeviceContext @ 01] cuDeviceGetCount failed: CUDA_ERROR_NO_DEVICE",
        "Unrecognized hwaccel: cuda.",
        "No such filter: 'hwdownload'",
        "[av1 @ 01] Failed setup for format cuda\nError while decoding: Function not implemented",
        "[av1 @ 01] No decoder surfaces left",
        "[Parsed_hwdownload_0 @ 01] The input must have a hardware frame reference.",
        "[Parsed_hwdownload_0 @ 01] Input frame is not the in the configured hwframe context.",
        "Stream #0:0 (libdav1d) -> hwdownload:default\n"
        "Impossible to convert between the formats supported by the filter "
        "'graph 0 input from stream 0:0' and the filter 'auto_scale_0'",
    ],
)
def test_cuda_decoder_failures_can_retry(stderr):
    assert is_hardware_decode_failure(stderr)


@pytest.mark.parametrize(
    "stderr",
    [
        "No space left on device",
        "Permission denied",
        "[h264_nvenc @ 01] Error while opening encoder",
        "[av1 @ 01] Corrupt frame",
        "Invalid data found when processing input",
        "Unknown encoder 'libx264'",
        "Error while filtering",
        "[h264_nvenc @ 01] CUDA_ERROR_OUT_OF_MEMORY",
        "[av1 @ 01] Failed setup for format cuda\nNo space left on device",
        "[av1 @ 01] No decoder surfaces left\nCorrupt frame",
        "Impossible to convert between the formats supported by the filter "
        "'graph 0 input from stream 0:0' and the filter 'auto_scale_0'",
        "Stream #0:0 (libdav1d) -> hwdownload:default\n"
        "Impossible to convert between the formats supported by the filter "
        "'Parsed_mix_0' and the filter 'auto_scale_0'",
    ],
)
def test_other_export_failures_do_not_retry_decode(stderr):
    assert not is_hardware_decode_failure(stderr)


@pytest.mark.parametrize("two_pass,fail_pass", [(False, 1), (True, 1), (True, 2)])
@pytest.mark.parametrize("weighted", [False, True])
@pytest.mark.parametrize("backend", ["cuda", "d3d11va", "vaapi"])
def test_decoder_retry_keeps_encoder_and_restarts_passes(
    tmp_path, monkeypatch, caplog, two_pass, fail_pass, weighted, backend
):
    plan = blending_plan(tmp_path)
    plan.two_pass = two_pass
    engine = FFmpegEngine()
    engine._tmix = replace(blend_for(plan), weighted=weighted, color_range="pc")
    engine._hardware_decode = HardwareDecode(backend)
    commands = []
    progress = []

    def run(command, *_args, **_kwargs):
        commands.append(command)
        if len(commands) == fail_pass:
            Path(plan.output).write_bytes(b"partial")
            raise EncodeError(
                "Cannot decode",
                stderr=f"[av1 @ 01] Failed setup for format {backend}: hwaccel failed",
            )
        if len(commands) > fail_pass:
            assert not Path(plan.output).exists()

    monkeypatch.setattr(engine, "_run_pass", run)
    result = engine._run_one_attempt(
        "ffmpeg", plan, Path(plan.source), Path(plan.output), 2, progress.append, 0, 1
    )
    assert result == Path(plan.output)
    assert len(commands) == fail_pass + (2 if two_pass else 1)
    assert "-hwaccel" in commands[0]
    assert all("-hwaccel" not in command for command in commands[fail_pass:])
    assert all(
        command[command.index("-c:v", command.index("-i")) + 1] == "libx264" for command in commands
    )
    assert not engine._hardware_decode
    assert "software decoding" in caplog.text
    assert any("software decoding" in event.message for event in progress)


@pytest.mark.parametrize("backend", ["cuda", "d3d11va", "vaapi"])
def test_cancelled_hardware_failure_never_restarts(tmp_path, monkeypatch, backend):
    plan = blending_plan(tmp_path)
    engine = FFmpegEngine()
    engine._tmix = blend_for(plan)
    engine._hardware_decode = HardwareDecode(backend)
    commands = []

    def run(command, *_args, **_kwargs):
        commands.append(command)
        engine.cancel()
        raise EncodeError(
            "Cannot decode",
            stderr=f"[av1 @ 01] Failed setup for format {backend}: hwaccel failed",
        )

    monkeypatch.setattr(engine, "_run_pass", run)
    with pytest.raises(EncodeCancelled):
        engine._run_one_attempt("ffmpeg", plan, Path(plan.source), Path(plan.output), 2, None, 0, 1)
    assert len(commands) == 1


@pytest.mark.parametrize(
    "available,expected",
    [
        (frozenset({"libx264"}), False),
        (frozenset({"libx264", "h264_amf"}), False),
        (frozenset({"libx264", "h264_nvenc"}), True),
    ],
)
def test_export_enables_cuda_only_with_usable_nvidia_and_resets_state(
    tmp_path,
    monkeypatch,
    available,
    expected,
):
    plan = blending_plan(tmp_path)
    plan.rate_control = RC_EXPLICIT_BITRATE
    plan.target_size = 1000
    Path(plan.source).write_bytes(b"source")
    engine = FFmpegEngine()
    active = []
    monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr("tuck.encoding.hardware_decoding.is_linux_desktop", lambda: False)
    monkeypatch.setattr("tuck.encoding.hardware_decoding.device_available", lambda *_: False)
    monkeypatch.setattr("tuck.encoding.runner.get_available_encoders", lambda: available)
    monkeypatch.setattr("tuck.encoding.runner.tmix_blend", lambda _plan: blend_for(_plan))

    def encode(_ffmpeg, _plan, _source, output, *_args, **_kwargs):
        active.append(bool(engine._hardware_decode))
        output.write_bytes(b"result")
        return output

    monkeypatch.setattr(engine, "_run_one_attempt", encode)
    assert engine.encode(plan).read_bytes() == b"result"
    assert active == [expected]
    assert not engine._hardware_decode


@pytest.mark.parametrize("device", [False, True])
def test_linux_cuda_decoding_does_not_require_hardware_encoding(tmp_path, monkeypatch, device):
    plan = blending_plan(tmp_path)
    plan.rate_control = RC_EXPLICIT_BITRATE
    plan.target_size = 1000
    Path(plan.source).write_bytes(b"source")
    engine = FFmpegEngine()
    active = []
    monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr("tuck.encoding.hardware_decoding.is_linux_desktop", lambda: True)
    monkeypatch.setattr("tuck.encoding.hardware_decoding.render_devices", lambda: [])
    monkeypatch.setattr("tuck.encoding.hardware_decoding.device_available", lambda *_: device)
    monkeypatch.setattr(
        "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
    )
    monkeypatch.setattr("tuck.encoding.runner.tmix_blend", lambda _plan: blend_for(_plan))

    def encode(_ffmpeg, _plan, _source, output, *_args, **_kwargs):
        active.append(bool(engine._hardware_decode))
        output.write_bytes(b"result")
        return output

    monkeypatch.setattr(engine, "_run_one_attempt", encode)
    assert engine.encode(plan).read_bytes() == b"result"
    assert active == [device]


@pytest.mark.parametrize("backend", ["cuda", "d3d11va", "vaapi"])
def test_hardware_decode_failure_retries_only_once(tmp_path, monkeypatch, backend):
    plan = blending_plan(tmp_path)
    engine = FFmpegEngine()
    engine._tmix = blend_for(plan)
    engine._hardware_decode = HardwareDecode(backend)
    commands = []

    def run(command, *_args, **_kwargs):
        commands.append(command)
        raise EncodeError(
            "Cannot decode",
            stderr=f"[av1 @ 01] Failed setup for format {backend}: hwaccel failed",
        )

    monkeypatch.setattr(engine, "_run_pass", run)
    with pytest.raises(EncodeError):
        engine._run_one_attempt("ffmpeg", plan, Path(plan.source), Path(plan.output), 2, None, 0, 1)
    assert len(commands) == 2


@pytest.mark.parametrize(
    "stderr",
    [
        "No space left on device",
        "Permission denied",
        "Corrupt frame",
        "Error while opening encoder",
    ],
)
def test_unrelated_failure_does_not_restart_export(tmp_path, monkeypatch, stderr):
    plan = blending_plan(tmp_path)
    engine = FFmpegEngine()
    engine._tmix = blend_for(plan)
    engine._hardware_decode = HardwareDecode("cuda")
    commands = []

    def run(command, *_args, **_kwargs):
        commands.append(command)
        raise EncodeError("Export failed", stderr=stderr)

    monkeypatch.setattr(engine, "_run_pass", run)
    with pytest.raises(EncodeError):
        engine._run_one_attempt("ffmpeg", plan, Path(plan.source), Path(plan.output), 2, None, 0, 1)
    assert len(commands) == 1
