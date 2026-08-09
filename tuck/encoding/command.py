from __future__ import annotations

from pathlib import Path

from ..models import (
    _AMF_ENCODERS,
    _CPU_ENCODERS,
    _NVENC_ENCODERS,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    EncodePlan,
)


def fmt_ffmpeg_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    return f"{seconds:.3f}"


_SCALER_TO_FFMPEG: dict[str, str] = {
    "bilinear": "bilinear",
    "bicubic": "bicubic",
    "lanczos": "lanczos",
    "nearest": "neighbor",
    "point": "neighbor",
}


def scaler_to_ffmpeg_flag(scaler: str) -> str:
    return _SCALER_TO_FFMPEG.get(scaler, "neighbor")


_NVENC_PRESET_MAP: dict[str, str] = {
    "ultrafast": "p1",
    "superfast": "p2",
    "veryfast": "p3",
    "faster": "p3",
    "fast": "p4",
    "medium": "p6",
    "slow": "p6",
    "slower": "p7",
    "veryslow": "p7",
}


def nvenc_preset(preset: str) -> str:
    return (
        preset
        if preset in {"p1", "p2", "p3", "p4", "p5", "p6", "p7"}
        else _NVENC_PRESET_MAP.get(preset, "p5")
    )


def build_base_cmd(
    ffmpeg: str,
    plan: EncodePlan,
    source: Path,
) -> list[str]:
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-stats"]

    trim_start = float(getattr(plan, "trim_start", 0.0) or 0.0)
    trim_end = float(getattr(plan, "trim_end", 0.0) or 0.0)
    trim_duration = plan.trim_duration if trim_end > trim_start else 0.0

    if trim_start > 0.001:
        cmd += ["-ss", fmt_ffmpeg_time(trim_start)]
    cmd += ["-i", str(source)]
    if trim_duration > 0.001 and (
        trim_start > 0.001
        or (
            plan.source_info is not None
            and trim_end > 0
            and trim_end < float(plan.source_info.duration) - 0.001
        )
    ):
        cmd += ["-t", fmt_ffmpeg_time(trim_duration)]

    vf_parts = []
    if plan.apply_scale and plan.target_width > 0 and plan.target_height > 0:
        scaler_flag = scaler_to_ffmpeg_flag(getattr(plan, "scaler", "neighbor"))
        vf_parts.append(f"scale={plan.target_width}:{plan.target_height}:flags={scaler_flag}")
    if plan.apply_fps_filter and plan.target_fps > 0:
        vf_parts.append(f"fps={plan.target_fps}")

    if vf_parts:
        cmd += ["-vf", ",".join(vf_parts)]

    encoder = getattr(plan, "video_encoder", "libx264")
    rc_method = getattr(plan, "rate_control_method", RCM_CRF)
    qp_val = getattr(plan, "qp", 23)
    cq_val = getattr(plan, "cq", qp_val)
    crf_val = getattr(plan, "crf", 23)

    cmd += ["-c:v", encoder]

    if encoder in _CPU_ENCODERS:
        cmd += ["-preset", plan.preset]
        tune = getattr(plan, "tune", "")
        if tune:
            cmd += ["-tune", tune]
        if rc_method == RCM_CRF:
            cmd += ["-crf", str(crf_val)]
        elif rc_method == RCM_CBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-b:v", str(bitrate)]
            cmd += ["-minrate", str(bitrate)]
            cmd += ["-maxrate", str(bitrate)]
            cmd += ["-bufsize", str(bitrate)]
    elif encoder in _NVENC_ENCODERS:
        cmd += ["-preset", nvenc_preset(plan.preset)]
        if rc_method == RCM_CQ:
            bitrate = plan.video_bitrate
            cmd += ["-rc", "vbr", "-cq", str(cq_val)]
            if bitrate > 0:
                cmd += ["-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]
        elif rc_method == RCM_CQP:
            cmd += ["-rc", "constqp", "-qp", str(qp_val)]
        elif rc_method == RCM_CBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "cbr", "-b:v", str(bitrate)]
        elif rc_method == RCM_VBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "vbr", "-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]
    elif encoder in _AMF_ENCODERS:
        cmd += ["-usage", "transcoding"]
        if rc_method in (RCM_CQ, RCM_CQP):
            cmd += [
                "-rc",
                "cqp",
                "-qp_i",
                str(cq_val),
                "-qp_p",
                str(cq_val),
                "-qp_b",
                str(cq_val),
            ]
        elif rc_method == RCM_CBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "cbr", "-b:v", str(bitrate)]
        elif rc_method == RCM_VBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "vbr", "-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]

    cmd += ["-pix_fmt", "yuv420p"]

    if getattr(plan, "copy_audio", False):
        cmd += ["-c:a", "copy"]
    elif plan.audio_bitrate > 0:
        cmd += ["-c:a", "aac", "-b:a", str(plan.audio_bitrate)]
        cmd += ["-ac", str(plan.audio_channels)]
        cmd += ["-ar", str(plan.audio_sample_rate)]
    else:
        cmd += ["-an"]

    cmd += ["-movflags", "+faststart"]
    return cmd
