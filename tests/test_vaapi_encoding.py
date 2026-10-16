from __future__ import annotations

from dataclasses import replace
from fractions import Fraction
from pathlib import Path

import pytest

from tuck.encoding.capabilities import auto_encoder_candidates, get_encoder_capabilities
from tuck.encoding.command import build_base_cmd
from tuck.encoding.frame_blending import TmixBlend, TmixPiece
from tuck.models import (
    AudioClip,
    AudioTrack,
    EncodePlan,
    PlanRequest,
    Profile,
    Segment,
    SourceAudioTrack,
    VideoInfo,
)
from tuck.models.encoding_policy import validate_encoder_supported_on_desktop


@pytest.mark.parametrize("encoder", ["h264_vaapi", "hevc_vaapi"])
def test_linux_accepts_vaapi_requests_and_profiles(monkeypatch, encoder):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    request = PlanRequest(source="source.mp4", video_encoder=encoder)
    request.validate()
    profile = Profile.from_dict(
        {
            "name": "VAAPI",
            "profile_id": "vaapi",
            "target_size_bytes": 10 * 1024 * 1024,
            "video_encoder": encoder,
            "preset": "balanced",
            "two_pass": False,
        }
    )
    assert request.video_encoder == profile.video_encoder == encoder


def test_windows_rejects_vaapi(monkeypatch):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "windows")
    with pytest.raises(ValueError, match="only supported on Linux"):
        validate_encoder_supported_on_desktop("h264_vaapi")


def test_linux_auto_fast_uses_vaapi_and_best_compression_uses_cpu(monkeypatch):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    available = frozenset({"libx264", "libx265", "h264_vaapi", "hevc_vaapi", "h264_amf"})
    assert auto_encoder_candidates(available=available)[0] == "h264_vaapi"
    assert auto_encoder_candidates("hevc", available)[0] == "hevc_vaapi"
    assert auto_encoder_candidates(available=available, fastest=False)[0] == "libx264"
    caps = get_encoder_capabilities(available).to_dict()
    assert caps["has_vaapi"] is True
    assert "h264_amf" not in caps["available"]


def _plan(**kwargs) -> EncodePlan:
    info = VideoInfo(
        path="source.mp4",
        duration=10,
        width=1280,
        height=720,
        fps=60,
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
            video_encoder="h264_vaapi",
            preset="balanced",
            two_pass=False,
            video_bitrate=2_000_000,
            target_size=10 * 1024 * 1024,
            audio_bitrate=128_000,
            source_info=info,
            source_audio_tracks=[SourceAudioTrack(0), SourceAudioTrack(1)],
        ),
        **kwargs,
    )


@pytest.mark.parametrize(
    "path",
    ["simple", "concat", "imported", "independent", "prepared", "streamed", "blend", "weighted"],
)
def test_vaapi_upload_follows_every_software_video_branch(path):
    from tuck.encoding.vaapi import VaapiEncodeDevice

    plan = _plan(apply_scale=True, target_width=640, target_height=360)
    kwargs = {}
    if path == "concat":
        plan.segments = [Segment(1, 2), Segment(4, 6)]
    elif path == "imported":
        plan.audio_tracks = [AudioTrack("music", "Music", [AudioClip("music.wav", 0, 0, 10, 10)])]
    elif path == "independent":
        plan.source_audio_segments = [Segment(2, 4), Segment(5, 6)]
    elif path == "prepared":
        kwargs["prepared_video"] = Path("prepared.mkv")
    elif path == "streamed":
        kwargs["streamed_video"] = True
        plan.target_fps = 30
    elif path in {"blend", "weighted"}:
        kwargs["blend"] = TmixBlend(
            rate=Fraction(30),
            pieces=(
                TmixPiece(
                    start=Fraction(0),
                    end=Fraction(10),
                    first=1,
                    last=599,
                    step=2,
                    weights=(Fraction(1), Fraction(2))
                    if path == "weighted"
                    else (Fraction(1, 3), Fraction(2, 3)),
                    lead=0,
                    trail=0,
                ),
            ),
            weighted=path == "weighted",
        )
    cmd = build_base_cmd(
        "ffmpeg",
        plan,
        Path(plan.source),
        vaapi_device=VaapiEncodeDevice("/dev/dri/renderD129"),
        **kwargs,
    )
    assert cmd[cmd.index("-init_hw_device") + 1] == "vaapi=tuck_encode:/dev/dri/renderD129"
    assert cmd[cmd.index("-filter_hw_device") + 1] == "tuck_encode"
    assert "-pix_fmt" not in cmd
    graph = (
        cmd[cmd.index("-filter_complex") + 1]
        if "-filter_complex" in cmd
        else cmd[cmd.index("-vf") + 1]
    )
    assert graph.count("hwupload") == 1
    assert "scale=" in graph[: graph.index("hwupload")]
    assert "format=yuv420p" not in graph[graph.index("hwupload") :]
    assert "format=nv12,hwupload" in graph
    assert "[aout1]" in cmd if path != "simple" else "0:a:1?" in cmd


@pytest.mark.parametrize(
    "method,value,rc", [("cq", 19, "CQP"), ("cqp", 17, "CQP"), ("cbr", 0, "CBR"), ("vbr", 0, "VBR")]
)
def test_vaapi_rate_control_uses_supported_options(method, value, rc):
    from tuck.encoding.vaapi import VaapiEncodeDevice

    plan = _plan(rate_control_method=method, cq=19, qp=17)
    cmd = build_base_cmd(
        "ffmpeg", plan, Path(plan.source), vaapi_device=VaapiEncodeDevice("/dev/dri/renderD128")
    )
    assert cmd[cmd.index("-rc_mode") + 1] == rc
    assert cmd[cmd.index("-compression_level") + 1] == "4"
    assert "-preset" not in cmd and "-bf" not in cmd
    if value:
        assert cmd[cmd.index("-qp") + 1] == str(value)
    else:
        assert cmd[cmd.index("-b:v") + 1] == "2000000"
        assert cmd[cmd.index("-maxrate") + 1] == str(2_000_000 if rc == "CBR" else 3_000_000)


def test_vaapi_commands_require_execution_owned_device():
    with pytest.raises(ValueError, match=r"VAAPI.*device"):
        build_base_cmd("ffmpeg", _plan(), Path("source.mp4"))


def test_vaapi_unfiltered_concat_keeps_combined_audio_output():
    from tuck.encoding.vaapi import VaapiEncodeDevice

    plan = _plan(segments=[Segment(1, 2), Segment(4, 6)])
    cmd = build_base_cmd(
        "ffmpeg", plan, Path(plan.source), vaapi_device=VaapiEncodeDevice("/dev/dri/renderD128")
    )
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "concat=n=2:v=1:a=1[vsoftware][aout]" in graph
    assert graph.count("[vout]") == 1
    assert "[vsoftware]format=nv12,hwupload[vout]" in graph
    assert "[aout]" in cmd and "[aout1]" in cmd


def test_linux_discovery_requires_encode_and_remembers_successful_device(monkeypatch):
    from tuck.encoding import capabilities, vaapi
    from tuck.encoding.vaapi import VaapiEncodeDevice

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(
        capabilities,
        "_detect_available_encoders",
        lambda _: frozenset({"libx264", "h264_vaapi", "hevc_vaapi"}),
    )
    monkeypatch.setattr(
        vaapi,
        "render_devices",
        lambda: (
            VaapiEncodeDevice("/dev/dri/renderD128"),
            VaapiEncodeDevice("/dev/dri/renderD129"),
        ),
    )
    monkeypatch.setattr(vaapi, "environment_fingerprint", lambda _: "test-devices")
    commands = []

    def run(cmd, **kwargs):
        commands.append(cmd)
        assert kwargs["stdin"] == vaapi.subprocess.DEVNULL
        good = "h264_vaapi" in cmd and "vaapi=tuck_encode:/dev/dri/renderD129" in cmd
        return vaapi.subprocess.CompletedProcess(cmd, 0 if good else 1, "", "driver unavailable")

    monkeypatch.setattr(vaapi.subprocess, "run", run)
    vaapi.clear_probe_cache()
    assert capabilities._detect_usable_encoders("ffmpeg") == frozenset({"libx264", "h264_vaapi"})
    device = vaapi.choose_encode_device("ffmpeg", "h264_vaapi")
    assert device == VaapiEncodeDevice("/dev/dri/renderD129")
    assert len(commands) == 4
    assert all("format=nv12,hwupload" in cmd for cmd in commands)


@pytest.mark.parametrize(
    "device",
    [
        "/tmp/file",
        "/dev/dri/card0",
        "/dev/dri/renderD128,driver=x",
        "/dev/dri/renderD128:foo",
        "../renderD128",
    ],
)
def test_vaapi_device_rejects_ffmpeg_device_syntax(device):
    from tuck.encoding.vaapi import VaapiEncodeDevice

    with pytest.raises(ValueError, match="render device"):
        VaapiEncodeDevice(device)


def test_runner_passes_probed_vaapi_device_and_retries_to_cpu(monkeypatch, tmp_path):
    from tuck.encoding import runner
    from tuck.encoding.vaapi import VaapiEncodeDevice

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        runner, "get_available_encoders", lambda: frozenset({"h264_vaapi", "libx264"})
    )
    monkeypatch.setattr(
        runner,
        "choose_encode_device",
        lambda *_: VaapiEncodeDevice("/dev/dri/renderD129"),
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "output.mp4"
    engine = runner.FFmpegEngine()
    commands = []

    def run_pass(cmd, *_args, **_kwargs):
        commands.append(cmd)
        if "h264_vaapi" in cmd:
            raise runner.EncodeError(
                "driver refused settings", stderr="No usable encoding profile found"
            )
        Path(cmd[-1]).write_bytes(b"encoded")

    monkeypatch.setattr(engine, "_run_pass", run_pass)
    plan = _plan(source=str(source), output=str(output), video_encoder="auto_fast", target_size=7)
    assert engine.encode(plan) == output
    assert output.read_bytes() == b"encoded"
    assert len(commands) == 2
    assert "vaapi=tuck_encode:/dev/dri/renderD129" in commands[0]
    assert "-init_hw_device" not in commands[1]
    assert engine.resolved_encoder == "libx264"
    assert (
        engine.encoder_fallback
        == "Used software encoding because the VAAPI encoder didn't accept these settings"
    )


def test_explicit_vaapi_failure_keeps_existing_output(monkeypatch, tmp_path):
    from tuck.encoding import runner
    from tuck.encoding.vaapi import VaapiEncodeDevice

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        runner, "get_available_encoders", lambda: frozenset({"h264_vaapi", "libx264"})
    )
    monkeypatch.setattr(
        runner,
        "choose_encode_device",
        lambda *_: VaapiEncodeDevice("/dev/dri/renderD128"),
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "output.mp4"
    output.write_bytes(b"previous export")
    engine = runner.FFmpegEngine()

    def run_pass(*_args, **_kwargs):
        raise runner.EncodeError("VAAPI failed", stderr="Failed to create a VAAPI device")

    monkeypatch.setattr(engine, "_run_pass", run_pass)
    with pytest.raises(runner.EncodeError, match="VAAPI failed"):
        engine.encode(_plan(source=str(source), output=str(output), replace_existing=True))
    assert output.read_bytes() == b"previous export"
    assert engine.encoder_fallback == ""


def test_vaapi_probe_cache_invalidates_after_driver_change(monkeypatch):
    from tuck.encoding import vaapi

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    device = vaapi.VaapiEncodeDevice("/dev/dri/renderD128")
    monkeypatch.setattr(vaapi, "render_devices", lambda: (device,))
    fingerprint = ["driver-one"]
    monkeypatch.setattr(vaapi, "environment_fingerprint", lambda _: fingerprint[0])
    probes = []

    def run(cmd, **_kwargs):
        probes.append(cmd)
        return vaapi.subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(vaapi.subprocess, "run", run)
    vaapi.clear_probe_cache()
    assert vaapi.choose_encode_device("ffmpeg", "h264_vaapi") == device
    assert vaapi.choose_encode_device("ffmpeg", "h264_vaapi") == device
    assert len(probes) == 1
    fingerprint[0] = "driver-two"
    assert vaapi.choose_encode_device("ffmpeg", "h264_vaapi") == device
    assert len(probes) == 2


def test_linux_encoder_cache_ignores_saved_hardware_and_reprobes_changed_driver(monkeypatch):
    from tuck.encoding import capabilities
    from tuck.settings import get_settings_manager

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(capabilities, "find_ffmpeg", lambda: "ffmpeg")
    fingerprint = ["driver-one"]
    monkeypatch.setattr(capabilities, "environment_fingerprint", lambda _: fingerprint[0])
    monkeypatch.setattr(capabilities, "_encoder_cache", None)
    monkeypatch.setattr(capabilities, "_encoder_cache_fingerprint", None)
    monkeypatch.setattr(get_settings_manager(), "get_setting", lambda *_: 0)

    def stale_cache(*_args):
        pytest.fail("Linux trusted a persisted hardware encoder list")

    monkeypatch.setattr(capabilities, "_load_cached_encoders", stale_cache)
    calls = []

    def detect(_ffmpeg):
        calls.append(fingerprint[0])
        return frozenset({"libx264", "h264_vaapi"}) if len(calls) == 1 else frozenset({"libx264"})

    monkeypatch.setattr(capabilities, "_detect_usable_encoders", detect)
    assert "h264_vaapi" in capabilities.get_available_encoders()
    assert "h264_vaapi" in capabilities.get_available_encoders()
    assert calls == ["driver-one"]
    fingerprint[0] = "driver-two"
    assert capabilities.get_available_encoders() == frozenset({"libx264"})
    assert calls == ["driver-one", "driver-two"]


def test_vaapi_fingerprint_tracks_replaced_ffmpeg_and_driver_selection(monkeypatch, tmp_path):
    from tuck.encoding import vaapi

    monkeypatch.setattr(vaapi, "render_devices", lambda: ())
    ffmpeg = tmp_path / "ffmpeg"
    ffmpeg.write_bytes(b"original")
    before = vaapi.environment_fingerprint(str(ffmpeg))
    ffmpeg.write_bytes(b"replacement with a different size")
    replaced = vaapi.environment_fingerprint(str(ffmpeg))
    assert replaced != before
    monkeypatch.setenv("LIBVA_DRIVER_NAME", "another-driver")
    assert vaapi.environment_fingerprint(str(ffmpeg)) != replaced


def test_bridge_accepts_linux_vaapi_and_cannot_choose_its_device(monkeypatch):
    from tuck.bridge_validation import parse_plan_request

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    request = parse_plan_request(
        {
            "source": "source.mp4",
            "video_encoder": "hevc_vaapi",
            "vaapi_device": "/tmp/untrusted",
            "preset": "quality",
        },
        lambda path: path,
    )
    assert request.video_encoder == "hevc_vaapi"
    assert "vaapi_device" not in vars(request)
    data = _plan().to_dict()
    data["vaapi_device"] = "/tmp/untrusted"
    restored = EncodePlan.from_dict(data)
    assert "vaapi_device" not in restored.to_dict()


def test_vaapi_crop_rotate_hdr_and_lut_finish_before_upload():
    from tuck.encoding.vaapi import VaapiEncodeDevice
    from tuck.models import CropRect, LutSettings, OutputGeometry, VideoTransform

    plan = _plan(
        transform=VideoTransform(
            crop=CropRect(0, 0, 640, 360), rotation=90, output=OutputGeometry(360, 640)
        ),
        tone_map_hdr=True,
        lut=LutSettings(enabled=True, path="grade.cube"),
        lut_filter_path="grade.cube",
    )
    assert plan.source_info is not None
    plan.source_info.color_transfer = "smpte2084"
    cmd = build_base_cmd(
        "ffmpeg", plan, Path(plan.source), vaapi_device=VaapiEncodeDevice("/dev/dri/renderD128")
    )
    graph = cmd[cmd.index("-vf") + 1]
    assert graph.index("crop=") < graph.index("transpose=")
    assert graph.index("tonemap=") < graph.index("lut3d=") < graph.index("hwupload")
    assert graph.endswith("format=nv12,hwupload")


@pytest.mark.parametrize("cancel", [False, True])
def test_vaapi_size_retry_and_cancel_preserve_output(monkeypatch, tmp_path, cancel):
    from tuck.encoding import runner
    from tuck.encoding.vaapi import VaapiEncodeDevice

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(runner, "get_available_encoders", lambda: frozenset({"h264_vaapi"}))
    monkeypatch.setattr(
        runner, "choose_encode_device", lambda *_: VaapiEncodeDevice("/dev/dri/renderD128")
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "output.mp4"
    output.write_bytes(b"previous export")
    engine = runner.FFmpegEngine()
    monkeypatch.setattr(engine, "_measure_video_size", lambda _: None)
    bitrates = []
    sizes = iter([12_000, 9_700])

    def run_pass(cmd, *_args, **_kwargs):
        bitrates.append(int(cmd[cmd.index("-b:v") + 1]))
        assert "vaapi=tuck_encode:/dev/dri/renderD128" in cmd
        Path(cmd[-1]).write_bytes(b"x" * next(sizes))
        if cancel:
            engine.cancel()

    monkeypatch.setattr(engine, "_run_pass", run_pass)
    plan = _plan(
        source=str(source),
        output=str(output),
        target_size=10_000,
        replace_existing=True,
        video_bitrate=1_000_000,
    )
    if cancel:
        with pytest.raises(runner.EncodeCancelled):
            engine.encode(plan)
        assert output.read_bytes() == b"previous export"
        assert len(bitrates) == 1
    else:
        assert engine.encode(plan) == output
        assert output.stat().st_size == 9_700
        assert len(bitrates) == 2 and bitrates[1] < bitrates[0]
    assert set(tmp_path.iterdir()) == {source, output}


@pytest.mark.parametrize("method", ["crf", "unknown"])
def test_vaapi_rejects_unsupported_rate_control(method):
    from tuck.models.encoding_policy import validate_rc_method_for_encoder

    with pytest.raises(ValueError, match="rate_control_method"):
        validate_rc_method_for_encoder(method, "h264_vaapi")


def test_vaapi_rejects_two_pass():
    from tuck.models.encoding_policy import validate_rate_control_matrix

    with pytest.raises(ValueError, match="Two-pass encoding is only available for CPU"):
        validate_rate_control_matrix("compression", "target_size", "cbr", "h264_vaapi", True)
