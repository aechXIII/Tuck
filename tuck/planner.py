from __future__ import annotations

import logging
import math
from dataclasses import replace
from pathlib import Path

from .encoding.capabilities import can_tone_map_hdr
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
    PlanValidationError,
    Profile,
    Segment,
    SourceAudioTrack,
    SourceTrackSetting,
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
    VAAPI_ENCODERS,
)
from .output_paths import export_directory, resolve_output_collision
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
    output_subfolder: str = "",
    keep_file_dates: bool = False,
    replace_existing: bool = False,
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
    source_audio_extra_tracks = options.source_audio_extra_tracks
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

    target_size = resolve_target_size(profile, request)

    if output is None:
        stem = source.stem
        out_parent = export_directory(source, output_dir, output_subfolder)
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

    ensure_output_differs_from_source(output, source)

    # replacing keeps the chosen name; the old file is only swapped out once the export is done
    if not replace_existing:
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

    target_fps, apply_fps = resolve_frame_rate(fps_mode, info, profile, request)

    from .lut import snapshot_lut

    lut = request.lut if request and request.lut is not None else profile.lut
    try:
        lut_filter_path = snapshot_lut(lut, info)
    except (ValueError, OSError) as exc:
        raise PlanValidationError("lut", str(exc)) from exc

    blending = (
        request.frame_blending
        if request and request.frame_blending is not None
        else profile.frame_blending
    )
    if blending.enabled:
        from .encoding.frame_blending import validate_blending_source

        try:
            validate_blending_source(blending, info, target_fps)
        except (ValueError, OSError) as exc:
            raise PlanValidationError("frame_blending", str(exc)) from exc

    if target_fps <= 0:
        raise ValueError("Target FPS is zero")

    imported_audio = any(
        not track.muted and any(not clip.muted for clip in track.clips) for track in audio_tracks
    )
    source_audio_pieces = source_audio_output_pieces(segments, source_audio_segments)
    kept_tracks = kept_source_tracks(
        info, source_audio_muted, source_audio_gain_db, source_audio_extra_tracks
    )
    source_audio = (
        audio_enabled
        and bool(kept_tracks)
        and (source_audio_segments is None or bool(source_audio_pieces))
    )
    if not source_audio:
        kept_tracks = []
    imported_audio = audio_enabled and imported_audio
    audio_independent = source_audio_segments is not None and audio_independent_from_pieces(
        source_audio_pieces, segments
    )
    audio_filters_required = imported_audio or (
        source_audio
        and (
            len(segments) > 1
            or any(abs(track.gain_db) > 1e-9 for track in kept_tracks)
            or audio_independent
            or blending.enabled
        )
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
        copy_audio = audio_tracks_share_codec(info, kept_tracks)
        audio_br = info.audio_bitrate if copy_audio else min(info.audio_bitrate, MAX_AUDIO_BITRATE)
    elif keep_audio:
        audio_br = min(max(audio_br, 0), MAX_AUDIO_BITRATE)
    else:
        audio_br = min(audio_br, MAX_AUDIO_BITRATE)

    if audio_filters_required and copy_audio:
        # Filtered audio cannot be copied directly
        copy_audio = False
        audio_br = min(info.audio_bitrate or audio_br, MAX_AUDIO_BITRATE)

    # audio_br is per track, and every kept source track is exported at it
    source_audio_tracks = max(1, len(kept_tracks))

    tone_map_hdr, warnings = plan_colors(info)
    warnings += subtitle_warnings(info, len(segments))

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
        estimated_total = estimate_size_from_bitrate(
            effective_duration, video_br, audio_br * source_audio_tracks
        )

        if estimated_total > target_size:
            raise ValueError(
                f"Estimated size ({format_size(estimated_total)}) exceeds the "
                f"hard profile limit ({format_size(target_size)}). "
                f"Lower the explicit bitrate or choose a larger profile."
            )
    else:
        hardware = video_encoder in NVENC_ENCODERS | AMF_ENCODERS | VAAPI_ENCODERS
        if video_encoder in (ENCODER_AUTO, ENCODER_AUTO_FAST):
            hardware = True
        ts_plan = calculate_target_size_bitrates(
            target_size,
            effective_duration,
            audio_br,
            hardware_encoder=hardware,
            min_video_bitrate=MIN_VIDEO_BITRATE,
            audio_tracks=source_audio_tracks,
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
        lut=lut,
        lut_filter_path=lut_filter_path,
        frame_blending=blending,
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
        source_audio_tracks=kept_tracks,
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
        keep_file_dates=keep_file_dates,
        replace_existing=replace_existing,
        tone_map_hdr=tone_map_hdr,
        warnings=warnings,
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


def resolve_target_size(profile: Profile, request: PlanRequest | None) -> int:
    """The size budget in bytes. A missing or zero size is an error, never a hidden default."""
    target_size = profile.target_size_bytes
    if request is not None and request.target_size_bytes is not None:
        target_size = request.target_size_bytes
    if target_size <= 0:
        raise ValueError("Target size must be greater than zero. Set a size limit and try again.")
    return target_size


def ensure_output_differs_from_source(output: Path, source: Path) -> None:
    same = output.resolve() == source.resolve()
    if not same:
        # a hard link has its own path but the same bytes, so replacing it would replace the source
        try:
            same = output.exists() and output.samefile(source)
        except OSError:
            same = False
    if same:
        raise ValueError("Output path must differ from source path")


def resolve_frame_rate(
    fps_mode: str, info: VideoInfo, profile: Profile, request: PlanRequest | None
) -> tuple[float, bool]:
    """The output frame rate and whether an fps filter is needed to reach it."""
    # a variable-rate video is judged by its average rate, so a limit above it doesn't make
    # the fps filter duplicate frames up to the nominal rate
    source_fps = info.decision_fps
    if fps_mode == FPS_MODE_SOURCE:
        return source_fps, False
    if fps_mode == FPS_MODE_CUSTOM:
        cfps = (
            request.custom_fps
            if request and request.custom_fps is not None and request.custom_fps > 0
            else profile.custom_fps
        )
        target_fps = min(cfps, source_fps)
    elif fps_mode == FPS_MODE_LIMIT:
        target_fps = min(source_fps, profile.max_fps) if profile.max_fps > 0 else source_fps
    else:
        raise ValueError(f"Unknown fps_mode: {fps_mode!r}")
    return target_fps, target_fps < source_fps - 0.001


HDR_NOT_CONVERTED_WARNING = (
    "This video is HDR, and the FFmpeg Tuck is using can't convert HDR colours, "
    "so the export may look washed out."
)


def plan_colors(info: VideoInfo) -> tuple[bool, list[str]]:
    """Whether to tone-map HDR to SDR, and a warning when it can't be done."""
    if not info.is_hdr:
        return False, []
    # exports are 8-bit SDR, so HDR is converted whenever FFmpeg can; without the filters
    # the export still runs rather than failing on colours alone
    if can_tone_map_hdr():
        return True, []
    return False, [HDR_NOT_CONVERTED_WARNING]


def kept_source_tracks(
    info: VideoInfo,
    first_muted: bool,
    first_gain_db: float,
    extra: list[SourceTrackSetting],
) -> list[SourceAudioTrack]:
    """The source audio tracks an export keeps; a track nobody set is kept at full volume"""
    if not info.has_audio:
        return []
    kept = [] if first_muted else [SourceAudioTrack(0, first_gain_db)]
    for index in range(1, max(1, info.audio_stream_count)):
        setting = extra[index - 1] if index - 1 < len(extra) else SourceTrackSetting()
        if not setting.muted:
            kept.append(SourceAudioTrack(index, setting.gain_db))
    return kept


def audio_tracks_share_codec(info: VideoInfo, kept: list[SourceAudioTrack]) -> bool:
    """Copying is only safe when every kept track matches the probed first one"""
    return all(
        info.audio_codecs[track.index] == info.audio_codec
        for track in kept
        if track.index < len(info.audio_codecs)
    )


def subtitle_warnings(info: VideoInfo, segment_count: int) -> list[str]:
    """What happens to the source's subtitles; the command keeps one text track when it can."""
    if not info.subtitle_codecs:
        return []
    if info.text_subtitle_track is None:
        return ["Subtitles aren't kept, because they're stored as pictures, which MP4 can't hold."]
    if segment_count > 1:
        return ["Subtitles aren't kept when the video is cut into several parts."]
    if len(info.subtitle_codecs) > 1:
        return [
            f"This video has {len(info.subtitle_codecs)} subtitle tracks. "
            "Only the first text track is kept."
        ]
    return []


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
