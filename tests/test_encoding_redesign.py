from __future__ import annotations

from pathlib import Path

from tuck.encoding.command import build_base_cmd
from tuck.models import (
    RC_TARGET_SIZE,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    WORKFLOW_COMPRESSION,
    WORKFLOW_UPSCALE,
    EncodePlan,
    PlanRequest,
    Profile,
    VideoInfo,
)
from tuck.planner import plan


def _info() -> VideoInfo:
    return VideoInfo(
        path="input.mp4",
        duration=60.0,
        width=1920,
        height=1080,
        fps=30.0,
        video_codec="h264",
        audio_codec="aac",
        audio_channels=2,
        audio_sample_rate=48000,
        bitrate=4_000_000,
        file_size=30 * 1024 * 1024,
        has_audio=True,
    )


def _compression_profile(size_mb: int) -> Profile:
    return Profile(
        name=f"{size_mb} MB",
        profile_id=f"size-{size_mb}",
        target_size_bytes=size_mb * 1024 * 1024,
        workflow=WORKFLOW_COMPRESSION,
        rate_control=RC_TARGET_SIZE,
        rate_control_method=RCM_CBR,
        explicit_bitrate=0,
        video_encoder="libx264",
        preset="medium",
    )


def test_target_size_requests_produce_different_bitrates_and_effective_names(monkeypatch):
    monkeypatch.setattr("tuck.probe.probe", lambda _: _info())
    ten = _compression_profile(10)
    fifty = _compression_profile(50)
    ten_req = PlanRequest(source="input.mp4", target_size_bytes=10 * 1024 * 1024)
    fifty_req = PlanRequest(source="input.mp4", target_size_bytes=50 * 1024 * 1024)

    ten_plan = plan("input.mp4", ten, request=ten_req)
    fifty_plan = plan("input.mp4", fifty, request=fifty_req)

    assert ten_plan.rate_control == RC_TARGET_SIZE
    assert fifty_plan.rate_control == RC_TARGET_SIZE
    assert ten_plan.explicit_bitrate == 0
    assert fifty_plan.explicit_bitrate == 0
    assert ten_plan.video_bitrate < fifty_plan.video_bitrate
    assert "10MB" in ten_plan.output
    assert "50MB" in fifty_plan.output


def test_compression_profile_migration_discards_old_explicit_bitrate():
    profile = Profile.from_dict(
        {
            "name": "Old broken profile",
            "profile_id": "old-broken",
            "target_size_bytes": 50 * 1024 * 1024,
            "workflow": WORKFLOW_COMPRESSION,
            "rate_control": "explicit_bitrate",
            "explicit_bitrate": 2_000_000,
            "rate_control_method": "cbr",
            "video_encoder": "libx264",
            "preset": "medium",
            "schema_version": 3,
        }
    )

    assert profile.rate_control == RC_TARGET_SIZE
    assert profile.explicit_bitrate == 0
    assert profile.rate_control_method == RCM_CBR


def test_legacy_nvenc_cqp_upscale_preserves_cqp_and_qp():
    profile = Profile.from_dict(
        {
            "name": "Old NVENC",
            "profile_id": "old-nvenc",
            "target_size_bytes": 500 * 1024 * 1024,
            "workflow": WORKFLOW_UPSCALE,
            "rate_control": RC_TARGET_SIZE,
            "rate_control_method": "cqp",
            "video_encoder": "h264_nvenc",
            "qp": 23,
            "preset": "medium",
            "schema_version": 3,
        }
    )

    assert profile.rate_control_method == RCM_CQP
    assert profile.qp == 23
    assert profile.preset == "p6"


def test_legacy_nvenc_cqp_command_uses_constqp():
    plan_data = EncodePlan(
        source="input.mp4",
        output="output.mp4",
        workflow=WORKFLOW_UPSCALE,
        video_encoder="h264_nvenc",
        rate_control_method=RCM_CQP,
        rate_control=RC_TARGET_SIZE,
        preset="p5",
        qp=18,
    )

    cmd = build_base_cmd("ffmpeg", plan_data, Path(plan_data.source))

    assert cmd[cmd.index("-rc") : cmd.index("-rc") + 4] == ["-rc", "constqp", "-qp", "18"]
    assert "-cq" not in cmd


def test_nvenc_cq_command_uses_cq_not_constqp():
    plan_data = EncodePlan(
        source="input.mp4",
        output="output.mp4",
        workflow=WORKFLOW_UPSCALE,
        video_encoder="h264_nvenc",
        rate_control_method=RCM_CQ,
        rate_control=RC_TARGET_SIZE,
        preset="p5",
        cq=23,
    )

    cmd = build_base_cmd("ffmpeg", plan_data, Path(plan_data.source))

    assert cmd[cmd.index("-rc") : cmd.index("-rc") + 4] == ["-rc", "vbr", "-cq", "23"]
    assert "constqp" not in cmd


def test_software_upscale_crf_command_uses_crf():
    plan_data = EncodePlan(
        source="input.mp4",
        output="output.mp4",
        workflow=WORKFLOW_UPSCALE,
        video_encoder="libx265",
        rate_control_method=RCM_CRF,
        rate_control=RC_TARGET_SIZE,
        preset="medium",
        crf=20,
    )

    cmd = build_base_cmd("ffmpeg", plan_data, Path(plan_data.source))

    assert cmd[cmd.index("-crf") : cmd.index("-crf") + 2] == ["-crf", "20"]


def test_upscale_vbr_keeps_explicit_bitrate(monkeypatch):
    monkeypatch.setattr("tuck.probe.probe", lambda _: _info())
    profile = Profile(
        name="VBR",
        profile_id="up-vbr",
        workflow=WORKFLOW_UPSCALE,
        rate_control="explicit_bitrate",
        rate_control_method=RCM_VBR,
        explicit_bitrate=4_000_000,
        video_encoder="h264_nvenc",
        preset="p5",
        two_pass=False,
    )

    resolved = plan("input.mp4", profile)

    assert resolved.rate_control == "explicit_bitrate"
    assert resolved.video_bitrate == 4_000_000
