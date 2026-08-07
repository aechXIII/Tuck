from __future__ import annotations

import logging
from pathlib import Path

from .models import (
    AUDIO_OVERHEAD_FACTOR,
    FPS_MODE_CUSTOM,
    FPS_MODE_LIMIT,
    FPS_MODE_SOURCE,
    RC_EXPLICIT_BITRATE,
    RCM_CBR,
    RES_MODE_CUSTOM,
    RES_MODE_LIMIT,
    RES_MODE_SOURCE,
    WORKFLOW_UPSCALE,
    EncodePlan,
    PlanRequest,
    Profile,
    estimate_size_from_bitrate,
    validate_rate_control_matrix,
)

logger = logging.getLogger(__name__)

MIN_VIDEO_BITRATE = 50_000
MAX_AUDIO_BITRATE = 320_000


def plan(
    source: str | Path,
    profile: Profile,
    output: str | Path | None = None,
    output_dir: str = "",
    request: PlanRequest | None = None,
    compression_suffix: str = "_tucked_{size}",
    upscale_suffix: str = "_upscaled_{width}x{height}",
) -> EncodePlan:
    from .probe import probe

    source = Path(source)
    info = probe(source)

    res_mode = profile.resolution_mode
    fps_mode = profile.fps_mode
    rate_ctrl = profile.rate_control
    explicit_br = profile.explicit_bitrate
    audio_br = profile.audio_bitrate
    workflow = getattr(profile, "workflow", "compression")
    rc_method = getattr(profile, "rate_control_method", RCM_CBR)
    qp_val = getattr(profile, "qp", 23)
    cq_val = getattr(profile, "cq", qp_val)

    if request is not None:
        request.validate()
        if request.target_size_bytes is not None:
            pass
        if request.resolution_mode is not None:
            res_mode = request.resolution_mode
        if request.fps_mode is not None:
            fps_mode = request.fps_mode
        if request.rate_control is not None:
            rate_ctrl = request.rate_control
        if request.explicit_bitrate is not None:
            explicit_br = request.explicit_bitrate
        if request.audio_bitrate is not None:
            audio_br = request.audio_bitrate
        if request.workflow is not None:
            workflow = request.workflow
        if request.rate_control_method is not None:
            rc_method = request.rate_control_method
        if request.cq is not None:
            cq_val = request.cq
        if request.qp is not None:
            qp_val = request.qp

    if request is not None and request.keep_audio is not None:
        keep_audio = bool(request.keep_audio)
    else:
        keep_audio = bool(getattr(profile, "keep_audio", False))

    scaler = getattr(profile, "scaler", None) or "neighbor"
    if request is not None and request.scaler is not None:
        scaler = request.scaler

    video_encoder = getattr(profile, "video_encoder", "libx264")
    crf = getattr(profile, "crf", 23)
    tune = getattr(profile, "tune", "")

    if request is not None:
        if request.video_encoder is not None:
            video_encoder = request.video_encoder
        if request.crf is not None:
            crf = request.crf
        if request.tune is not None:
            tune = request.tune

    two_pass = profile.two_pass
    preset = profile.preset
    if request is not None:
        if request.two_pass is not None:
            two_pass = request.two_pass
        if request.preset is not None:
            preset = request.preset

    from .models import (
        _native_preset_for_encoder,
        _normalize_legacy_rc_matrix,
        _validate_rc_method_for_encoder,
        _validate_tune_for_encoder,
    )

    preset = _native_preset_for_encoder(preset, video_encoder)
    _validate_tune_for_encoder(tune, video_encoder)
    _validate_rc_method_for_encoder(rc_method, video_encoder)
    if request is None or request.rate_control_method is None:
        rc_method, two_pass = _normalize_legacy_rc_matrix(
            workflow, rate_ctrl, rc_method, video_encoder, two_pass
        )
    validate_rate_control_matrix(workflow, rate_ctrl, rc_method, video_encoder, two_pass)

    effective_duration = info.duration

    if effective_duration <= 0:
        raise ValueError(f"Duration is zero or negative: {effective_duration:.2f}s")

    target_size = profile.target_size_bytes
    if request is not None and request.target_size_bytes is not None:
        target_size = request.target_size_bytes
    if target_size <= 0:
        target_size = 100 * 1024 * 1024

    if output is None:
        stem = source.stem
        out_parent = Path(output_dir) if output_dir else source.parent
        suffix_template = upscale_suffix if workflow == WORKFLOW_UPSCALE else compression_suffix
        target_w_for_name, target_h_for_name = _make_even(info.width, info.height)
        if res_mode == RES_MODE_CUSTOM:
            cw = (
                request.custom_width
                if request and request.custom_width is not None and request.custom_width > 0
                else profile.custom_width
            )
            ch = (
                request.custom_height
                if request and request.custom_height is not None and request.custom_height > 0
                else profile.custom_height
            )
            if cw is not None and cw > 0 and ch is not None and ch > 0:
                target_w_for_name, target_h_for_name = _make_even(cw, ch)
        size_mb = int(target_size / (1024 * 1024))
        size_str = f"{size_mb}MB" if size_mb else ""
        name_suffix = (
            suffix_template.replace("{size}", size_str)
            .replace("{width}", str(target_w_for_name))
            .replace("{height}", str(target_h_for_name))
        )
        output = out_parent / f"{stem}{name_suffix}.mp4"
    else:
        output = Path(output)

    if output.resolve() == source.resolve():
        raise ValueError("Output path must differ from source path")

    output = _resolve_output_collision(output)

    if res_mode == RES_MODE_SOURCE:
        target_w, target_h = _make_even(info.width, info.height)
        apply_scale = info.width != target_w or info.height != target_h
    elif res_mode == RES_MODE_CUSTOM:
        cw = (
            request.custom_width
            if request and request.custom_width is not None and request.custom_width > 0
            else profile.custom_width
        )
        ch = (
            request.custom_height
            if request and request.custom_height is not None and request.custom_height > 0
            else profile.custom_height
        )
        target_w, target_h = _make_even(max(2, int(cw)), max(2, int(ch)))
        apply_scale = True
    elif res_mode == RES_MODE_LIMIT:
        target_w, target_h = _scale_resolution(
            info.width, info.height, profile.max_width, profile.max_height
        )
        apply_scale = target_w != info.width or target_h != info.height
    else:
        raise ValueError(f"Unknown resolution_mode: {res_mode!r}")

    if target_w <= 0 or target_h <= 0:
        raise ValueError("Resolution scaling resulted in zero dimension")

    if fps_mode == FPS_MODE_SOURCE:
        target_fps = info.fps
        apply_fps = False
    elif fps_mode == FPS_MODE_CUSTOM:
        cfps = (
            request.custom_fps
            if request and request.custom_fps is not None and request.custom_fps > 0
            else profile.custom_fps
        )
        target_fps = min(cfps, info.fps)
        apply_fps = target_fps < info.fps - 0.001
    elif fps_mode == FPS_MODE_LIMIT:
        target_fps = min(info.fps, profile.max_fps) if profile.max_fps > 0 else info.fps
        apply_fps = target_fps < info.fps - 0.001
    else:
        raise ValueError(f"Unknown fps_mode: {fps_mode!r}")

    if target_fps <= 0:
        raise ValueError("Target FPS is zero")

    copy_audio = False
    if not info.has_audio:
        audio_br = 0
        keep_audio = False
    elif keep_audio:
        copy_audio = True
        if audio_br <= 0:
            audio_br = 128_000
        audio_br = min(max(audio_br, 96_000), MAX_AUDIO_BITRATE)
    else:
        audio_br = min(audio_br, MAX_AUDIO_BITRATE)

    is_upscale = workflow == WORKFLOW_UPSCALE

    if is_upscale:
        if rate_ctrl == RC_EXPLICIT_BITRATE:
            if explicit_br < MIN_VIDEO_BITRATE:
                raise ValueError(
                    f"Explicit bitrate ({explicit_br // 1000} kbps) is below the "
                    f"minimum ({MIN_VIDEO_BITRATE // 1000} kbps)"
                )
            video_br = explicit_br
        else:
            video_br = 0
        estimated_total = 0
    elif rate_ctrl == RC_EXPLICIT_BITRATE:
        if explicit_br < MIN_VIDEO_BITRATE:
            raise ValueError(
                f"Explicit bitrate ({explicit_br // 1000} kbps) is below the "
                f"minimum ({MIN_VIDEO_BITRATE // 1000} kbps)"
            )
        video_br = explicit_br
        estimated_total = estimate_size_from_bitrate(effective_duration, video_br, audio_br)

        if estimated_total > target_size:
            raise ValueError(
                f"Estimated size ({_fmt_size(estimated_total)}) exceeds the "
                f"hard profile limit ({_fmt_size(target_size)}). "
                f"Lower the explicit bitrate or choose a larger profile."
            )
    else:
        effective_target = target_size * (1.0 - AUDIO_OVERHEAD_FACTOR)
        audio_size = (audio_br / 8) * effective_duration
        if audio_size > effective_target * 0.15:
            audio_size = effective_target * 0.15
            audio_br = int((audio_size * 8) / effective_duration)
        video_size_budget = effective_target - audio_size
        if video_size_budget <= 0:
            raise ValueError(
                f"Target size ({_fmt_size(target_size)}) too small for "
                f"{effective_duration:.1f}s video. Minimum needed: "
                f"~{_fmt_size(int(audio_size + target_size * AUDIO_OVERHEAD_FACTOR + 1024))}"
            )
        video_br = int((video_size_budget * 8) / effective_duration)
        video_br = max(video_br, MIN_VIDEO_BITRATE)
        estimated_video = (video_br / 8) * effective_duration
        estimated_total = int(estimated_video + audio_size + target_size * AUDIO_OVERHEAD_FACTOR)

    enc_plan = EncodePlan(
        source=str(source),
        output=str(output),
        target_width=target_w,
        target_height=target_h,
        target_fps=target_fps,
        video_bitrate=video_br,
        original_video_bitrate=video_br,
        resolution_mode=res_mode,
        fps_mode=fps_mode,
        rate_control=rate_ctrl,
        apply_scale=apply_scale,
        apply_fps_filter=apply_fps,
        scaler=scaler,
        audio_bitrate=audio_br,
        audio_channels=profile.audio_channels if not copy_audio else (info.audio_channels or 2),
        audio_sample_rate=profile.audio_sample_rate
        if not copy_audio
        else (info.audio_sample_rate or 44100),
        copy_audio=copy_audio,
        two_pass=two_pass,
        preset=preset,
        crf=crf,
        video_encoder=video_encoder,
        tune=tune,
        estimated_size=estimated_total,
        target_size=target_size,
        explicit_bitrate=explicit_br if rate_ctrl == RC_EXPLICIT_BITRATE else 0,
        source_info=info,
        profile_id=profile.profile_id or "",
        workflow=workflow,
        rate_control_method=rc_method,
        cq=cq_val,
        qp=qp_val,
    )

    logger.info(
        "Plan: %s -> %s | %dx%d@%.1ffps | mode=%s/%s/%s | "
        "video=%dkbps audio=%dkbps | est=%s | workflow=%s rc=%s",
        source.name,
        Path(enc_plan.output).name,
        target_w,
        target_h,
        target_fps,
        res_mode,
        fps_mode,
        rate_ctrl,
        video_br // 1000,
        audio_br // 1000,
        _fmt_size(estimated_total),
        workflow,
        rc_method,
    )

    return enc_plan


def _resolve_output_collision(output: Path) -> Path:
    if not output.exists() and not _reservation_exists(output):
        return output
    base = output.parent / output.stem
    suffix = output.suffix
    counter = 1
    while True:
        candidate = base.parent / f"{base.name}_{counter}{suffix}"
        if not candidate.exists() and not _reservation_exists(candidate):
            logger.info("Output collision resolved: %s -> %s", output, candidate)
            return candidate
        counter += 1
        if counter > 100:
            raise ValueError(
                f"Too many output file collisions for {output}. Clean up existing files."
            )


def _reservation_exists(output: Path) -> bool:
    return output.with_suffix(output.suffix + ".reserved").exists()


def _scale_resolution(
    src_w: int,
    src_h: int,
    max_w: int,
    max_h: int,
) -> tuple[int, int]:
    if src_w <= max_w and src_h <= max_h:
        return _make_even(src_w, src_h)

    ratio = min(max_w / src_w, max_h / src_h)
    new_w = int(src_w * ratio)
    new_h = int(src_h * ratio)
    return _make_even(new_w, new_h)


def _make_even(w: int, h: int) -> tuple[int, int]:
    return (w // 2 * 2, h // 2 * 2)


def _fmt_size(bytes_val: int | float) -> str:
    b = float(bytes_val)
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"
