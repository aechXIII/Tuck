"""Max bitrate, 10-bit color and keyframe spacing, from the profile to FFmpeg's arguments."""

from __future__ import annotations

import json
import subprocess
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from tuck.bridge_serialization import profile_ui_dict
from tuck.bridge_validation import normalize_profile_ui_payload, parse_plan_request
from tuck.encoding import capabilities
from tuck.encoding.command import build_base_cmd, keyframe_interval
from tuck.encoding.vaapi import VaapiEncodeDevice
from tuck.models import (
    RC_EXPLICIT_BITRATE,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    WORKFLOW_UPSCALE,
    EncodePlan,
    PlanRequest,
    Profile,
    VideoInfo,
)
from tuck.planner_options import resolve_plan_options


def _info(**kwargs) -> VideoInfo:
    return replace(
        VideoInfo(
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
            has_audio=False,
            pixel_format="yuv420p",
        ),
        **kwargs,
    )


def _plan(**kwargs) -> EncodePlan:
    return replace(
        EncodePlan(
            source="source.mp4",
            output="output.mp4",
            target_width=1280,
            target_height=720,
            target_fps=60,
            video_encoder="libx264",
            rate_control_method=RCM_CRF,
            crf=23,
            two_pass=False,
            audio_enabled=False,
            source_info=_info(),
        ),
        **kwargs,
    )


def _value(cmd: list[str], flag: str) -> str | None:
    return cmd[cmd.index(flag) + 1] if flag in cmd else None


def _cmd(plan: EncodePlan, **kwargs) -> list[str]:
    return build_base_cmd("ffmpeg", plan, Path(plan.source), **kwargs)


# profiles


def test_profile_round_trip_writes_the_settings_only_when_set():
    plain = Profile(name="Plain", profile_id="plain")
    data = plain.to_dict()
    # Tuck 0.7.1 refuses fields it doesn't know, so an unused setting isn't written at all
    assert not {"max_bitrate", "ten_bit", "keyframe_seconds"} & set(data)

    capped = Profile(
        name="Capped",
        profile_id="capped",
        max_bitrate=8_000_000,
        ten_bit=True,
        keyframe_seconds=2,
    )
    loaded = Profile.from_dict(json.loads(json.dumps(capped.to_dict())))
    assert (loaded.max_bitrate, loaded.ten_bit, loaded.keyframe_seconds) == (8_000_000, True, 2.0)
    assert Profile.from_dict(data).max_bitrate == 0


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("max_bitrate", 50_000),
        ("max_bitrate", 2_000_000_000),
        ("max_bitrate", True),
        ("ten_bit", "yes"),
        ("keyframe_seconds", -1),
        ("keyframe_seconds", 61),
    ],
)
def test_profile_refuses_values_out_of_range(field, value):
    with pytest.raises(ValueError, match=field):
        Profile.from_dict(
            {"name": "Bad", "profile_id": "bad", "target_size_bytes": 10 << 20, field: value}
        )


def test_ui_payload_takes_the_cap_in_mbps_and_gives_it_back():
    data = normalize_profile_ui_payload(
        {"name": "Cap", "max_bitrate_mbps": 2.5, "ten_bit": True, "keyframe_seconds": 5}
    )
    assert data["max_bitrate"] == 2_500_000
    profile = Profile.from_dict(
        {**data, "profile_id": "cap", "target_size_bytes": 10 << 20, "video_encoder": "libx265"}
    )
    ui = profile_ui_dict(profile)
    assert (ui["max_bitrate_mbps"], ui["ten_bit"], ui["keyframe_seconds"]) == (2.5, True, 5.0)
    with pytest.raises(ValueError, match="max_bitrate_mbps"):
        normalize_profile_ui_payload({"name": "Cap", "max_bitrate_mbps": "8"})


def test_plan_request_carries_the_settings(tmp_path):
    request = parse_plan_request(
        {
            "source": str(tmp_path / "clip.mp4"),
            "max_bitrate": 8_000_000,
            "ten_bit": True,
            "keyframe_seconds": 2,
        },
        lambda path: path,
    )
    assert (request.max_bitrate, request.ten_bit, request.keyframe_seconds) == (8_000_000, True, 2)
    with pytest.raises(ValueError, match="max_bitrate"):
        parse_plan_request({"source": "clip.mp4", "max_bitrate": 10}, lambda path: path)


# what the planner allows


def _quality_profile(encoder: str, **kwargs) -> Profile:
    method = RCM_CRF if encoder.startswith("lib") else RCM_CQ
    return Profile(
        name="Quality",
        profile_id="quality",
        video_encoder=encoder,
        rate_control_method=method,
        two_pass=False,
        preset="medium"
        if encoder.startswith("lib")
        else "p4"
        if "nvenc" in encoder
        else "balanced",
        **kwargs,
    )


def test_the_cap_reaches_quality_levels_only():
    quality = resolve_plan_options(_quality_profile("libx264", max_bitrate=8_000_000), None)
    assert quality.bitrate_cap == 8_000_000
    # a size goal sets its own bitrate, so a cap kept in the profile doesn't reach it
    size = Profile(
        name="Size", profile_id="size", rate_control_method=RCM_CBR, max_bitrate=8_000_000
    )
    assert resolve_plan_options(size, None).bitrate_cap == 0
    upscale = Profile(
        name="Up",
        profile_id="up",
        workflow=WORKFLOW_UPSCALE,
        rate_control=RC_EXPLICIT_BITRATE,
        rate_control_method=RCM_CBR,
        explicit_bitrate=8_000_000,
        two_pass=False,
        max_bitrate=4_000_000,
    )
    assert resolve_plan_options(upscale, None).bitrate_cap == 0


@pytest.mark.parametrize("encoder", ["hevc_amf", "h264_vaapi"])
def test_encoders_that_cant_cap_a_quality_level_are_refused(monkeypatch, encoder):
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux" if "vaapi" in encoder else "windows")
    profile = _quality_profile(encoder, max_bitrate=8_000_000)
    with pytest.raises(ValueError, match="software and NVIDIA"):
        resolve_plan_options(profile, None)
    # without a cap the same profile plans
    resolve_plan_options(replace(profile, max_bitrate=0), None)


@pytest.mark.parametrize("encoder", ["libx264", "h264_nvenc", "auto"])
def test_ten_bit_needs_an_hevc_encoder(encoder):
    profile = _quality_profile("libx265")
    request = PlanRequest(source="clip.mp4", video_encoder=encoder, ten_bit=True)
    if encoder == "h264_nvenc":
        request = replace(request, rate_control_method=RCM_CQ, preset="p4")
    if encoder == "auto":
        request = replace(request, rate_control_method=RCM_CRF)
    with pytest.raises(ValueError, match=r"10-bit color needs an H\.265 encoder"):
        resolve_plan_options(profile, request)
    assert resolve_plan_options(profile, PlanRequest(source="clip.mp4", ten_bit=True)).ten_bit


def test_auto_moves_past_encoders_that_cant_cap(monkeypatch):
    from tuck.encoding import runner as runner_module

    monkeypatch.setattr(
        runner_module,
        "get_available_encoders",
        lambda: frozenset({"h264_amf", "h264_nvenc", "libx264"}),
    )
    engine = runner_module.FFmpegEngine.__new__(runner_module.FFmpegEngine)
    plan = _plan(video_encoder="auto", bitrate_cap=8_000_000)
    _, candidates = engine._select_encoder_candidates(plan)
    assert "h264_amf" not in candidates
    assert candidates[0] == "h264_nvenc"
    _, uncapped = engine._select_encoder_candidates(replace(plan, bitrate_cap=0))
    assert "h264_amf" in uncapped


# FFmpeg arguments


def test_software_quality_keeps_its_level_under_the_cap():
    cmd = _cmd(_plan(bitrate_cap=8_000_000))
    assert _value(cmd, "-crf") == "23"
    # a buffer as large as the cap keeps each second near it
    assert (_value(cmd, "-maxrate"), _value(cmd, "-bufsize")) == ("8000000", "8000000")
    assert "-maxrate" not in _cmd(_plan())


def test_nvidia_caps_its_quality_level():
    cq = _cmd(
        _plan(
            video_encoder="hevc_nvenc",
            rate_control_method=RCM_CQ,
            cq=28,
            preset="p4",
            bitrate_cap=8_000_000,
        )
    )
    assert (_value(cq, "-rc"), _value(cq, "-cq"), _value(cq, "-maxrate")) == (
        "vbr",
        "28",
        "8000000",
    )
    # constant QP has no peak, so a capped one keeps the level in NVENC's quality-targeted VBR
    qp = _cmd(
        _plan(
            video_encoder="h264_nvenc",
            rate_control_method=RCM_CQP,
            qp=24,
            preset="p4",
            bitrate_cap=8_000_000,
        )
    )
    assert (_value(qp, "-rc"), _value(qp, "-cq"), _value(qp, "-maxrate")) == (
        "vbr",
        "24",
        "8000000",
    )
    plain = _cmd(_plan(video_encoder="h264_nvenc", rate_control_method=RCM_CQP, qp=24, preset="p4"))
    assert _value(plain, "-rc") == "constqp"


@pytest.mark.parametrize(
    ("encoder", "pixel_format", "profile"),
    [
        ("libx265", "yuv420p10le", None),
        ("hevc_nvenc", "p010le", "main10"),
        ("hevc_amf", "p010le", "main10"),
    ],
)
def test_ten_bit_pixel_formats(encoder, pixel_format, profile):
    method = RCM_CRF if encoder == "libx265" else RCM_CQ
    cmd = _cmd(_plan(video_encoder=encoder, rate_control_method=method, ten_bit=True))
    assert _value(cmd, "-pix_fmt") == pixel_format
    assert _value(cmd, "-profile:v") == profile
    assert (
        _value(_cmd(_plan(video_encoder=encoder, rate_control_method=method)), "-pix_fmt")
        == "yuv420p"
    )


@pytest.mark.parametrize("segments", ["one", "several"])
def test_vaapi_uploads_ten_bit_pictures(monkeypatch, segments):
    from tuck.models import Segment

    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    plan = _plan(
        video_encoder="hevc_vaapi",
        rate_control_method=RCM_CQ,
        preset="balanced",
        ten_bit=True,
        segments=[Segment(1, 2), Segment(4, 6)] if segments == "several" else [],
    )
    cmd = _cmd(plan, vaapi_device=VaapiEncodeDevice("/dev/dri/renderD128"))
    graph = " ".join(cmd)
    assert "format=p010" in graph and "format=nv12" not in graph
    assert _value(cmd, "-profile:v") == "main10"
    assert "-pix_fmt" not in cmd


def test_ten_bit_on_h264_never_reaches_ffmpeg():
    with pytest.raises(ValueError, match="10-bit"):
        _cmd(_plan(ten_bit=True))


def test_keyframes_follow_the_export_frame_rate():
    assert keyframe_interval(_plan(keyframe_seconds=2, target_fps=60)) == 120
    assert keyframe_interval(_plan(keyframe_seconds=2, target_fps=29.97)) == 60
    assert keyframe_interval(_plan(keyframe_seconds=1, target_fps=0)) == 60
    assert keyframe_interval(_plan(keyframe_seconds=0)) == 0
    assert _value(_cmd(_plan(keyframe_seconds=5, target_fps=30)), "-g") == "150"
    assert "-g" not in _cmd(_plan())


# asking an encoder for 10-bit


def test_ten_bit_check_reads_what_the_encoder_really_made(monkeypatch):
    monkeypatch.setattr(capabilities, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(capabilities, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(capabilities, "_ten_bit_cache", {})
    made = {"pix_fmt": "yuv420p"}
    calls = []

    def run(command, **_kwargs):
        calls.append(command)
        if command[0] == "ffprobe":
            return SimpleNamespace(returncode=0, stdout=made["pix_fmt"] + "\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(capabilities.subprocess, "run", run)
    # an 8-bit x265 quietly makes 8-bit and still succeeds
    assert capabilities.encoder_makes_ten_bit("libx265") is False
    made["pix_fmt"] = "yuv420p10le"
    assert capabilities.encoder_makes_ten_bit("hevc_nvenc") is True
    # asked once per encoder, then remembered
    count = len(calls)
    assert capabilities.encoder_makes_ten_bit("hevc_nvenc") is True
    assert len(calls) == count
    assert capabilities.encoder_makes_ten_bit("libx264") is False


def test_bridge_refuses_to_ask_an_h264_encoder():
    from tuck.bridge import BridgeAPI

    api = BridgeAPI.__new__(BridgeAPI)
    assert api.check_ten_bit("libx264") == {
        "ok": False,
        "error": "10-bit color needs an H.265 encoder.",
    }


def test_sidecar_runs_the_check_on_a_media_worker():
    from tuck.sidecar import handlers
    from tuck.sidecar.server import MEDIA_METHODS

    assert "check_ten_bit" in handlers._HANDLERS
    assert "check_ten_bit" in MEDIA_METHODS


# real encodes


def _frames(ffprobe: str, path: Path) -> list[dict]:
    result = subprocess.run(
        [
            *(ffprobe, "-v", "error", "-select_streams", "v:0"),
            *("-show_entries", "packet=pts_time,size,flags", "-of", "json", str(path)),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)["packets"]


@pytest.fixture
def busy_source(tmp_path, skip_if_no_ffmpeg):
    from tuck.media_tools import find_ffmpeg

    source = tmp_path / "busy.mp4"
    subprocess.run(
        [
            *(find_ffmpeg() or "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi"),
            *("-i", "testsrc2=duration=4:size=640x360:rate=30,noise=alls=40:allf=t"),
            *("-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", str(source)),
        ],
        check=True,
    )
    return source


def _encode(plan: EncodePlan, output: Path) -> None:
    from tuck.media_tools import find_ffmpeg

    cmd = build_base_cmd(find_ffmpeg() or "ffmpeg", plan, Path(plan.source))
    subprocess.run([*cmd, "-y", str(output)], capture_output=True, check=True)


def test_real_encode_keeps_keyframe_spacing_and_the_cap(busy_source, tmp_path):
    from tuck.media_tools import find_ffprobe
    from tuck.probe import probe

    info = probe(busy_source)
    plan = _plan(
        source=str(busy_source),
        target_width=info.width,
        target_height=info.height,
        target_fps=30,
        source_info=info,
        crf=18,
        preset="ultrafast",
        keyframe_seconds=1,
        bitrate_cap=1_000_000,
    )
    output = tmp_path / "capped.mp4"
    _encode(plan, output)
    packets = _frames(find_ffprobe() or "ffprobe", output)
    keyframes = [round(float(p["pts_time"]), 2) for p in packets if "K" in p["flags"]]
    assert keyframes[:4] == [0.0, 1.0, 2.0, 3.0]
    per_second: dict[int, int] = {}
    for packet in packets:
        second = int(float(packet["pts_time"]))
        per_second[second] = per_second.get(second, 0) + int(packet["size"]) * 8
    # noise at CRF 18 wants far more than 1 Mbps. x264 starts with its buffer full, so the first
    # second may spend it too; after that each second stays near the cap
    assert per_second[0] < 2_000_000
    assert max(per_second[second] for second in (1, 2, 3)) < 1_150_000


def test_real_encode_makes_ten_bit_where_the_encoder_can(busy_source, tmp_path):
    from tuck.media_tools import find_ffprobe
    from tuck.probe import probe

    if not capabilities.encoder_makes_ten_bit("libx265"):
        pytest.skip("this FFmpeg's x265 is 8-bit only")
    info = probe(busy_source)
    plan = _plan(
        source=str(busy_source),
        target_width=info.width,
        target_height=info.height,
        target_fps=30,
        source_info=info,
        video_encoder="libx265",
        preset="ultrafast",
        ten_bit=True,
    )
    output = tmp_path / "ten.mp4"
    _encode(plan, output)
    result = subprocess.run(
        [
            *(find_ffprobe() or "ffprobe", "-v", "error", "-select_streams", "v:0"),
            *("-show_entries", "stream=pix_fmt,profile", "-of", "csv=p=0", str(output)),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "Main 10,yuv420p10le"
