from __future__ import annotations

from pathlib import Path

import pytest

from tuck.bridge_validation import parse_plan_request
from tuck.encoding import capabilities, runner
from tuck.encoding.command import build_base_cmd
from tuck.models import EncodePlan, PlanRequest, Profile, Segment, VideoInfo
from tuck.models.encoding_policy import validate_encoder_supported_on_desktop
from tuck.planner_options import resolve_plan_options


@pytest.mark.parametrize("encoder", ["h264_nvenc", "hevc_nvenc"])
def test_linux_accepts_nvenc_profile_request_and_bridge(monkeypatch, encoder):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    validate_encoder_supported_on_desktop(encoder)
    request = PlanRequest(source="source.mp4", video_encoder=encoder, preset="p4", two_pass=False)
    request.validate()
    profile = Profile(name="NVIDIA", video_encoder=encoder, preset="p4", two_pass=False)
    assert resolve_plan_options(profile, request).video_encoder == encoder
    parsed = parse_plan_request(
        {"source": "source.mp4", "video_encoder": encoder}, lambda path: path
    )
    assert parsed.video_encoder == encoder


def test_linux_nvenc_discovery_requires_actual_encode(monkeypatch):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(
        capabilities,
        "_detect_available_encoders",
        lambda _: frozenset({"libx264", "h264_nvenc", "hevc_nvenc", "h264_amf", "h264_vaapi"}),
    )
    probes = []

    def probe(_ffmpeg, encoder):
        probes.append(encoder)
        return encoder == "h264_nvenc"

    monkeypatch.setattr(capabilities, "_hardware_encoder_works", probe)
    monkeypatch.setattr(capabilities, "choose_encode_device", lambda *_: None)
    assert capabilities._detect_usable_encoders("ffmpeg") == frozenset({"libx264", "h264_nvenc"})
    assert set(probes) == {"h264_nvenc", "hevc_nvenc"}


def test_linux_nvenc_without_driver_is_not_available(monkeypatch):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(
        capabilities,
        "_detect_available_encoders",
        lambda _: frozenset({"libx264", "h264_nvenc", "hevc_nvenc"}),
    )
    probes = []

    def run(cmd, **kwargs):
        probes.append(cmd)
        assert kwargs["stdin"] == capabilities.subprocess.DEVNULL
        return capabilities.subprocess.CompletedProcess(cmd, 1, "", "Cannot load libcuda.so.1")

    monkeypatch.setattr(capabilities.subprocess, "run", run)
    assert capabilities._detect_usable_encoders("ffmpeg") == frozenset({"libx264"})
    assert len(probes) == 2
    assert all("color=c=black:s=1280x720:d=0.1" in cmd and "-frames:v" in cmd for cmd in probes)


def test_linux_auto_fast_prefers_nvenc_then_vaapi_and_best_compression_cpu(monkeypatch):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    available = frozenset(
        {"libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_vaapi", "h264_amf"}
    )
    assert capabilities.auto_encoder_candidates(available=available)[:3] == (
        "h264_nvenc",
        "h264_vaapi",
        "libx264",
    )
    assert capabilities.auto_encoder_candidates("hevc", available)[0] == "hevc_nvenc"
    assert capabilities.auto_encoder_candidates(available=available, fastest=False)[:2] == (
        "libx264",
        "libx265",
    )
    caps = capabilities.get_encoder_capabilities(available).to_dict()
    assert caps["has_nvidia"] is True
    assert "h264_amf" not in caps["available"]


def _plan(**kwargs) -> EncodePlan:
    from dataclasses import replace

    info = VideoInfo(
        path="source.mp4",
        duration=10,
        width=1280,
        height=720,
        fps=30,
        video_codec="h264",
        audio_codec="aac",
        audio_channels=2,
        audio_sample_rate=48000,
        bitrate=4_000_000,
        file_size=5_000_000,
        has_audio=True,
        pixel_format="yuv420p",
    )
    return replace(
        EncodePlan(
            source="source.mp4",
            output="output.mp4",
            source_info=info,
            video_encoder="h264_nvenc",
            preset="p4",
            two_pass=False,
            video_bitrate=2_000_000,
            audio_bitrate=128_000,
            target_size=7,
        ),
        **kwargs,
    )


@pytest.mark.parametrize("vaapi_works", [False, True])
def test_linux_auto_fallback_records_nvenc_driver_failure(monkeypatch, tmp_path, vaapi_works):
    from tuck.encoding.vaapi import VaapiEncodeDevice

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        runner, "get_available_encoders", lambda: frozenset({"h264_nvenc", "h264_vaapi", "libx264"})
    )
    monkeypatch.setattr(
        runner, "choose_encode_device", lambda *_: VaapiEncodeDevice("/dev/dri/renderD128")
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "output.mp4"
    engine = runner.FFmpegEngine()
    attempted = []

    def run_pass(cmd, *_args, **_kwargs):
        encoder = cmd[cmd.index("-c:v") + 1]
        attempted.append(encoder)
        if encoder == "h264_nvenc":
            raise runner.EncodeError(
                "NVIDIA driver unavailable", stderr="Cannot load libnvidia-encode.so.1"
            )
        if encoder == "h264_vaapi" and not vaapi_works:
            raise runner.EncodeError("VAAPI unavailable", stderr="No VA display found")
        Path(cmd[-1]).write_bytes(b"encoded")

    monkeypatch.setattr(engine, "_run_pass", run_pass)
    result = engine.encode(_plan(source=str(source), output=str(output), video_encoder="auto_fast"))
    assert result.read_bytes() == b"encoded"
    assert attempted == (
        ["h264_nvenc", "h264_vaapi"] if vaapi_works else ["h264_nvenc", "h264_vaapi", "libx264"]
    )
    assert engine.resolved_encoder == ("h264_vaapi" if vaapi_works else "libx264")
    assert "NVIDIA" in engine.encoder_fallback and "couldn't start" in engine.encoder_fallback


def test_linux_explicit_nvenc_failure_preserves_existing_output(monkeypatch, tmp_path):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        runner, "get_available_encoders", lambda: frozenset({"h264_nvenc", "libx264"})
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "output.mp4"
    output.write_bytes(b"previous export")
    engine = runner.FFmpegEngine()

    def run_pass(*_args, **_kwargs):
        raise runner.EncodeError("NVIDIA driver unavailable", stderr="Cannot load libcuda.so.1")

    monkeypatch.setattr(engine, "_run_pass", run_pass)
    with pytest.raises(runner.EncodeError, match="NVIDIA driver unavailable"):
        engine.encode(_plan(source=str(source), output=str(output), replace_existing=True))
    assert output.read_bytes() == b"previous export"
    assert engine.encoder_fallback == ""
    assert set(tmp_path.iterdir()) == {source, output}


def test_linux_explicit_nvenc_unavailable_error_mentions_driver(monkeypatch, tmp_path):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(runner, "get_available_encoders", lambda: frozenset({"libx264"}))
    output = tmp_path / "output.mp4"
    output.write_bytes(b"previous export")
    with pytest.raises(runner.EncodeError, match="graphics driver"):
        runner.FFmpegEngine().encode(_plan(output=str(output), replace_existing=True))
    assert output.read_bytes() == b"previous export"


@pytest.mark.parametrize(
    "error",
    [
        "Cannot load libcuda.so.1",
        "Cannot load libnvidia-encode.so.1",
        "No CUDA-capable device is detected",
    ],
)
def test_linux_nvenc_driver_errors_are_device_failures(error):
    assert capabilities.hardware_failure_kind(error) == capabilities.HW_FAILURE_DEVICE


@pytest.mark.parametrize(
    "change",
    [
        "install",
        "replace",
        "visible",
        "unset_visible",
        "module",
        "ffmpeg",
        "wsl_driver",
        "wsl_device",
        "unreadable_directory",
    ],
)
def test_linux_nvenc_cache_reprobes_after_runtime_change(monkeypatch, tmp_path, change):
    from types import SimpleNamespace

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setenv("LD_LIBRARY_PATH", str(tmp_path))
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "-1")
    if change == "unset_visible":
        monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "")
    ffmpeg = tmp_path / "ffmpeg"
    ffmpeg.write_bytes(b"original")
    driver = tmp_path / "libnvidia-encode.so.1"
    if change in {"replace", "wsl_driver", "unreadable_directory"}:
        driver.write_bytes(b"original")
    device = tmp_path / "dxg"
    device.write_bytes(b"original")
    original_glob = Path.glob
    original_stat = Path.stat

    def glob(path, pattern, *args, **kwargs):
        if change == "unreadable_directory" and path == Path("/dev"):
            raise PermissionError("device directory cannot be listed")
        if path == Path("/usr/lib/wsl/lib"):
            return original_glob(tmp_path, pattern, *args, **kwargs)
        return original_glob(path, pattern, *args, **kwargs)

    def stat(path, *args, **kwargs):
        if path == Path("/dev/dxg"):
            return original_stat(device, *args, **kwargs)
        return original_stat(path, *args, **kwargs)

    if change.startswith("wsl_"):
        monkeypatch.setenv("LD_LIBRARY_PATH", "")
        monkeypatch.setattr(Path, "glob", glob)
        monkeypatch.setattr(Path, "stat", stat)
    elif change == "unreadable_directory":
        monkeypatch.setattr(Path, "glob", glob)
    driver_version = ["original"]
    original_read = Path.read_text

    def read_text(path, *args, **kwargs):
        if path == Path("/sys/module/nvidia/version"):
            return driver_version[0]
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    monkeypatch.setattr(capabilities, "find_ffmpeg", lambda: str(ffmpeg))
    monkeypatch.setattr(capabilities, "_encoder_cache", None)
    monkeypatch.setattr(capabilities, "_encoder_cache_fingerprint", None)
    monkeypatch.setattr(
        "tuck.settings.get_settings_manager", lambda: SimpleNamespace(get_setting=lambda *_: 0)
    )
    monkeypatch.setattr(
        capabilities, "_detect_available_encoders", lambda _: frozenset({"libx264", "h264_nvenc"})
    )
    works = [False]
    probes = []

    def probe(_ffmpeg, encoder):
        probes.append(encoder)
        return works[0]

    monkeypatch.setattr(capabilities, "_hardware_encoder_works", probe)
    assert capabilities.get_available_encoders() == frozenset({"libx264"})
    assert capabilities.get_available_encoders() == frozenset({"libx264"})
    assert len(probes) == 1
    works[0] = True
    if change in {"install", "replace", "wsl_driver", "unreadable_directory"}:
        driver.write_bytes(b"a newer NVIDIA driver library")
    elif change == "wsl_device":
        device.write_bytes(b"a changed WSL graphics device")
    elif change == "visible":
        monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    elif change == "unset_visible":
        monkeypatch.delenv("CUDA_VISIBLE_DEVICES")
    elif change == "module":
        driver_version[0] = "new loaded driver"
    else:
        ffmpeg.write_bytes(b"a replacement FFmpeg executable")
    assert capabilities.get_available_encoders() == frozenset({"libx264", "h264_nvenc"})
    assert len(probes) == 2


@pytest.mark.parametrize("encoder", ["h264_nvenc", "hevc_nvenc"])
@pytest.mark.parametrize("method", ["cq", "cqp", "cbr", "vbr"])
def test_linux_nvenc_commands_keep_existing_rate_control_and_preset(monkeypatch, encoder, method):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    plan = _plan(video_encoder=encoder, rate_control_method=method, cq=19, qp=17)
    cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
    assert cmd[cmd.index("-c:v") + 1] == encoder
    assert cmd[cmd.index("-preset") + 1] == "p4"
    assert "-init_hw_device" not in cmd
    if method == "cq":
        assert cmd[cmd.index("-cq") + 1] == "19"
    elif method == "cqp":
        assert cmd[cmd.index("-qp") + 1] == "17"
    else:
        assert cmd[cmd.index("-rc") + 1] == method
        assert cmd[cmd.index("-b:v") + 1] == "2000000"


@pytest.mark.parametrize("branch", ["concat", "prepared", "streamed"])
def test_linux_nvenc_software_filter_graphs_preserve_audio(monkeypatch, branch):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    plan = _plan()
    kwargs = {}
    if branch == "concat":
        plan.segments = [Segment(1, 2), Segment(4, 6)]
    elif branch == "prepared":
        kwargs["prepared_video"] = Path("prepared.mkv")
    else:
        kwargs["streamed_video"] = True
        plan.target_fps = 30
    cmd = build_base_cmd("ffmpeg", plan, Path(plan.source), **kwargs)
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "[vout]" in cmd and "[aout]" in cmd
    assert "hwupload" not in graph
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    if branch == "concat":
        assert "concat=n=2:v=1:a=1[vout][aout]" in graph
