from __future__ import annotations

import logging
from dataclasses import replace
from pathlib import Path

from .formatting import format_size
from .models import (
    _AMF_ENCODERS,
    _NVENC_ENCODERS,
    ENCODER_AUTO,
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
    OutputGeometry,
    PlanRequest,
    Profile,
    VideoInfo,
    VideoTransform,
    calculate_transform_geometry,
    estimate_size_from_bitrate,
    oriented_dimensions,
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
    source_info: VideoInfo | None = None,
) -> EncodePlan:
    from .probe import probe

    source = Path(source)
    info = source_info if source_info is not None else probe(source)

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

    if info.duration <= 0:
        raise ValueError(f"Duration is zero or negative: {info.duration:.2f}s")

    trim_start = 0.0
    trim_end = float(info.duration)
    if request is not None:
        if request.trim_start is not None:
            trim_start = float(request.trim_start)
        if request.trim_end is not None:
            trim_end = float(request.trim_end)

    if trim_start < 0:
        raise ValueError(f"trim_start must be >= 0 (got {trim_start:.3f}s)")
    if trim_start >= info.duration:
        raise ValueError(
            f"trim_start ({trim_start:.3f}s) must be less than source duration "
            f"({info.duration:.3f}s)"
        )
    if trim_end <= trim_start:
        raise ValueError(
            f"trim_end ({trim_end:.3f}s) must be greater than trim_start ({trim_start:.3f}s)"
        )
    if trim_end > info.duration + 0.05:
        raise ValueError(
            f"trim_end ({trim_end:.3f}s) exceeds source duration ({info.duration:.3f}s)"
        )
    trim_end = min(trim_end, float(info.duration))

    transform = (
        request.transform
        if request is not None and request.transform is not None
        else VideoTransform()
    )
    transform.validate_for_source(info.width, info.height)

    effective_duration = trim_end - trim_start
    if effective_duration <= 0:
        raise ValueError(f"Trim window is zero or negative: {effective_duration:.3f}s")
    user_trim = request is not None and (
        request.trim_start is not None or request.trim_end is not None
    )
    if user_trim and effective_duration < 0.05:
        raise ValueError(
            f"Trim window is too short ({effective_duration:.3f}s). Select at least 0.05 seconds."
        )

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

    output = _resolve_output_collision(output, respect_reservation=False)

    oriented_width, oriented_height = oriented_dimensions(transform, info.width, info.height)

    if transform.output is not None:
        requested_output = transform.output
    elif res_mode == RES_MODE_SOURCE:
        source_width, source_height = _make_even(oriented_width, oriented_height)
        requested_output = OutputGeometry(source_width, source_height)
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
        requested_output = OutputGeometry(max(2, int(cw)), max(2, int(ch)))
    elif res_mode == RES_MODE_LIMIT:
        limit_width, limit_height = _scale_resolution(
            oriented_width, oriented_height, profile.max_width, profile.max_height
        )
        requested_output = OutputGeometry(limit_width, limit_height)
    else:
        raise ValueError(f"Unknown resolution_mode: {res_mode!r}")

    transform = replace(transform, output=requested_output)
    transform_geometry = calculate_transform_geometry(transform, info.width, info.height)
    target_w = transform_geometry.output_width
    target_h = transform_geometry.output_height
    apply_scale = transform_geometry.requires_scale

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
    elif keep_audio and info.audio_bitrate > 0:
        copy_audio = True
        audio_br = info.audio_bitrate
    elif keep_audio:
        audio_br = min(max(audio_br, 0), MAX_AUDIO_BITRATE)
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
                f"Estimated size ({format_size(estimated_total)}) exceeds the "
                f"hard profile limit ({format_size(target_size)}). "
                f"Lower the explicit bitrate or choose a larger profile."
            )
    else:
        from .encoding.target_size import calculate_target_size_bitrates

        hardware = video_encoder in _NVENC_ENCODERS | _AMF_ENCODERS
        if video_encoder == ENCODER_AUTO:
            hardware = True
        ts_plan = calculate_target_size_bitrates(
            target_size,
            effective_duration,
            audio_br,
            hardware_encoder=hardware,
            min_video_bitrate=MIN_VIDEO_BITRATE,
        )
        video_br = ts_plan.video_bitrate
        audio_br = ts_plan.audio_bitrate
        if copy_audio and info.audio_bitrate > audio_br:
            copy_audio = False
        estimated_total = ts_plan.estimated_size

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
        trim_start=trim_start,
        trim_end=trim_end,
        transform=transform,
    )

    logger.info(
        "Plan: %s -> %s | %dx%d@%.1ffps | trim=%.2f-%.2f (%.2fs) | mode=%s/%s/%s | "
        "video=%dkbps audio=%dkbps | est=%s | workflow=%s rc=%s",
        source.name,
        Path(enc_plan.output).name,
        target_w,
        target_h,
        target_fps,
        trim_start,
        trim_end,
        effective_duration,
        res_mode,
        fps_mode,
        rate_ctrl,
        video_br // 1000,
        audio_br // 1000,
        format_size(estimated_total),
        workflow,
        rc_method,
    )

    return enc_plan


def _reservation_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + ".reserved")


def _reservation_exists(output: Path) -> bool:
    return _reservation_path(output).exists()


def _path_is_taken(output: Path, *, respect_reservation: bool = True) -> bool:
    if output.exists():
        return True
    if not respect_reservation:
        return False
    return _reservation_exists(output)


def _resolve_output_collision(output: Path, *, respect_reservation: bool = True) -> Path:
    if not _path_is_taken(output, respect_reservation=respect_reservation):
        return output
    base = output.parent / output.stem
    suffix = output.suffix
    counter = 1
    while True:
        candidate = base.parent / f"{base.name}_{counter}{suffix}"
        if not _path_is_taken(candidate, respect_reservation=respect_reservation):
            logger.info("Output collision resolved: %s -> %s", output, candidate)
            return candidate
        counter += 1
        if counter > 100:
            raise ValueError(
                f"Too many output file collisions for {output}. Clean up existing files."
            )


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
