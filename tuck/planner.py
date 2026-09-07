from __future__ import annotations

import logging
import math
from dataclasses import replace
from pathlib import Path

from .desktop_platform import is_linux_desktop
from .encoding.target_size import (
    MAX_AUDIO_BITRATE,
    MIN_VIDEO_BITRATE,
    calculate_target_size_bitrates,
)
from .formatting import format_size
from .models import (
    ENCODER_AUTO,
    ENCODER_AUTO_FAST,
    FPS_MODE_CUSTOM,
    FPS_MODE_LIMIT,
    FPS_MODE_SOURCE,
    RC_EXPLICIT_BITRATE,
    RES_MODE_CUSTOM,
    RES_MODE_LIMIT,
    RES_MODE_SOURCE,
    SIZING_MODE_STRETCH,
    WORKFLOW_UPSCALE,
    EncodePlan,
    OutputGeometry,
    PlanRequest,
    Profile,
    Segment,
    VideoInfo,
    VideoTransform,
    audio_independent_from_pieces,
    calculate_transform_geometry,
    crop_for_aspect,
    estimate_size_from_bitrate,
    oriented_dimensions,
    source_audio_output_pieces,
    validate_audio_tracks,
    validate_segments,
)
from .models.encoding_policy import (
    AMF_ENCODERS,
    NVENC_ENCODERS,
)
from .output_paths import resolve_output_collision
from .planner_options import resolve_plan_options

logger = logging.getLogger(__name__)


def plan(
    source: str | Path,
    profile: Profile,
    output: str | Path | None = None,
    output_dir: str = "",
    request: PlanRequest | None = None,
    compression_suffix: str = "_tucked_{size}",
    upscale_suffix: str = "_upscaled_{width}x{height}",
    source_info: VideoInfo | None = None,
    audio_source_durations: dict[str, float] | None = None,
) -> EncodePlan:
    from .probe import probe

    source = Path(source)
    info = source_info if source_info is not None else probe(source)

    options = resolve_plan_options(profile, request)
    res_mode = options.resolution_mode
    fps_mode = options.fps_mode
    rate_ctrl = options.rate_control
    explicit_br = options.explicit_bitrate
    audio_br = options.audio_bitrate
    workflow = options.workflow
    rc_method = options.rate_control_method
    qp_val = options.qp
    cq_val = options.cq
    audio_enabled = options.audio_enabled
    source_audio_muted = options.source_audio_muted
    source_audio_gain_db = options.source_audio_gain_db
    source_audio_segments = options.source_audio_segments
    audio_tracks = options.audio_tracks
    keep_audio = options.keep_audio
    scaler = options.scaler
    video_encoder = options.video_encoder
    crf = options.crf
    tune = options.tune
    two_pass = options.two_pass
    preset = options.preset

    if not math.isfinite(info.duration) or info.duration <= 0:
        raise ValueError(f"Duration is zero or negative: {info.duration:.2f}s")

    if request is not None and request.segments is not None:
        segments = list(request.segments)
        validate_segments(segments, float(info.duration))
        user_selection = True
    else:
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
        segments = [Segment(trim_start, trim_end)]
        user_selection = request is not None and (
            request.trim_start is not None or request.trim_end is not None
        )

    if request is not None and request.transform is not None:
        transform = request.transform
    elif profile.transform_intent is not None:
        intent = profile.transform_intent
        profile_crop = (
            crop_for_aspect(
                info.width,
                info.height,
                intent.crop_aspect,
                rotation=intent.rotation,
            )
            if intent.crop_aspect != "free"
            else None
        )
        transform = VideoTransform(
            crop=profile_crop,
            crop_aspect=intent.crop_aspect,
            rotation=intent.rotation,
            sizing_mode=intent.sizing_mode,
        )
    else:
        transform = VideoTransform()
    transform.validate_for_source(info.width, info.height)

    effective_duration = sum(segment.duration for segment in segments)
    if effective_duration <= 0:
        raise ValueError(f"Selected duration is zero or negative: {effective_duration:.3f}s")
    if user_selection and effective_duration < 0.05 - 1e-9:
        raise ValueError(
            f"Selected duration is too short ({effective_duration:.3f}s). "
            "Select at least 0.05 seconds."
        )
    if source_audio_segments:
        validate_segments(source_audio_segments, float(info.duration))
    validate_audio_tracks(audio_tracks, float(info.duration), audio_source_durations)

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

    output = resolve_output_collision(output, respect_reservation=False)

    oriented_width, oriented_height = oriented_dimensions(transform, info.width, info.height)
    resolution_width, resolution_height = oriented_width, oriented_height
    if transform.sizing_mode == SIZING_MODE_STRETCH:
        resolution_width, resolution_height = oriented_dimensions(
            replace(transform, crop=None),
            info.width,
            info.height,
        )

    if transform.output is not None:
        requested_output = transform.output
    elif res_mode == RES_MODE_SOURCE:
        source_width, source_height = _make_even(resolution_width, resolution_height)
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
            resolution_width, resolution_height, profile.max_width, profile.max_height
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

    imported_audio = any(
        not track.muted and any(not clip.muted for clip in track.clips) for track in audio_tracks
    )
    source_audio_pieces = source_audio_output_pieces(segments, source_audio_segments)
    source_audio = (
        audio_enabled
        and info.has_audio
        and not source_audio_muted
        and (source_audio_segments is None or bool(source_audio_pieces))
    )
    imported_audio = audio_enabled and imported_audio
    audio_independent = source_audio_segments is not None and audio_independent_from_pieces(
        source_audio_pieces, segments
    )
    audio_filters_required = imported_audio or (
        source_audio
        and (len(segments) > 1 or abs(source_audio_gain_db) > 1e-9 or audio_independent)
    )

    copy_audio = False
    if not audio_enabled or (not source_audio and not imported_audio):
        audio_br = 0
        keep_audio = False
    elif audio_filters_required:
        if keep_audio and source_audio and not imported_audio and info.audio_bitrate > 0:
            audio_br = info.audio_bitrate
        else:
            audio_br = min(max(audio_br or info.audio_bitrate or 128_000, 8_000), MAX_AUDIO_BITRATE)
    elif keep_audio and info.audio_bitrate > 0:
        copy_audio = True
        audio_br = info.audio_bitrate
    elif keep_audio:
        audio_br = min(max(audio_br, 0), MAX_AUDIO_BITRATE)
    else:
        audio_br = min(audio_br, MAX_AUDIO_BITRATE)

    if audio_filters_required and copy_audio:
        # Filtered audio cannot be copied directly
        copy_audio = False
        audio_br = min(info.audio_bitrate or audio_br, MAX_AUDIO_BITRATE)

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
        hardware = video_encoder in NVENC_ENCODERS | AMF_ENCODERS
        if video_encoder in (ENCODER_AUTO, ENCODER_AUTO_FAST) and not is_linux_desktop():
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
        audio_enabled=audio_enabled,
        source_audio_muted=source_audio_muted,
        source_audio_gain_db=source_audio_gain_db,
        source_audio_segments=source_audio_segments,
        audio_tracks=audio_tracks,
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
        trim_start=float(segments[0].start) if len(segments) == 1 else 0.0,
        trim_end=float(segments[0].end) if len(segments) == 1 else 0.0,
        segments=segments,
        transform=transform,
    )

    logger.info(
        "Plan: %s -> %s | %dx%d@%.1ffps | segments=%s (%.2fs selected) | mode=%s/%s/%s | "
        "video=%dkbps audio=%dkbps | est=%s | workflow=%s rc=%s",
        source.name,
        Path(enc_plan.output).name,
        target_w,
        target_h,
        target_fps,
        [segment.to_dict() for segment in segments],
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
