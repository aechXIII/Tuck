from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

from .models import (
    SCALER_LANCZOS,
    AppSettings,
    AudioTrack,
    MuteRange,
    PlanRequest,
    Profile,
    Segment,
    SourceTrackSetting,
)
from .models.encoding_policy import (
    native_preset_for_encoder,
    normalize_legacy_rc_matrix,
    normalize_scaler,
    size_target_rate_control_method,
    validate_encoder_supported_on_desktop,
    validate_rate_control_matrix,
    validate_rc_method_for_encoder,
    validate_tune_for_encoder,
)
from .models.export_preferences import NAME_TAKEN_REPLACE, output_targets


class OutputOptions(TypedDict):
    output_dir: str
    output_subfolder: str
    compression_suffix: str
    upscale_suffix: str
    keep_file_dates: bool
    replace_existing: bool


class CutOutputOptions(TypedDict):
    name_suffix: str
    output_folder: str
    output_subfolder: str


def output_options(settings: AppSettings) -> OutputOptions:
    """Where and how exports are written, read the same way by the editor, CLI, and Send To."""
    # a hand-edited settings file can hold any JSON type, so text values are read as text
    folder, subfolder = output_targets(
        str(settings.output_location),
        str(settings.output_dir or ""),
        str(settings.output_subfolder or ""),
    )
    return {
        "output_dir": folder,
        "output_subfolder": subfolder,
        "compression_suffix": str(settings.compression_suffix or "_tucked_{size}"),
        "upscale_suffix": str(settings.upscale_suffix or "_upscaled_{width}x{height}"),
        "keep_file_dates": settings.keep_file_dates is True,
        "replace_existing": settings.name_taken == NAME_TAKEN_REPLACE,
    }


@dataclass(frozen=True)
class PlanOptions:
    resolution_mode: str
    fps_mode: str
    rate_control: str
    explicit_bitrate: int
    audio_bitrate: int
    workflow: str
    rate_control_method: str
    qp: int
    cq: int
    audio_enabled: bool
    source_audio_muted: bool
    source_audio_gain_db: float
    source_audio_segments: list[Segment] | None
    source_audio_extra_tracks: list[SourceTrackSetting]
    source_audio_mute_ranges: tuple[MuteRange, ...]
    audio_tracks: list[AudioTrack]
    mix_audio_tracks: bool
    even_out_loudness: bool
    keep_audio: bool
    scaler: str
    video_encoder: str
    crf: int
    tune: str
    two_pass: bool
    preset: str


def resolve_plan_options(profile: Profile, request: PlanRequest | None) -> PlanOptions:
    resolution_mode = profile.resolution_mode
    fps_mode = profile.fps_mode
    rate_control = profile.rate_control
    explicit_bitrate = profile.explicit_bitrate
    audio_bitrate = profile.audio_bitrate
    workflow = profile.workflow
    rate_control_method = profile.rate_control_method
    qp = profile.qp
    cq = profile.cq
    audio_enabled = True
    source_audio_muted = False
    source_audio_gain_db = 0.0
    source_audio_segments: list[Segment] | None = None
    source_audio_extra_tracks: list[SourceTrackSetting] = []
    source_audio_mute_ranges: tuple[MuteRange, ...] = ()
    audio_tracks: list[AudioTrack] = []
    # players, phones and chat apps mostly play only the first track, so sharing mixes them
    mix_audio_tracks = True
    even_out_loudness = False
    keep_audio = bool(profile.keep_audio)
    scaler = profile.scaler or SCALER_LANCZOS
    video_encoder = profile.video_encoder
    crf = profile.crf
    tune = profile.tune
    two_pass = profile.two_pass
    preset = profile.preset

    if request is not None:
        request.validate()
        if request.resolution_mode is not None:
            resolution_mode = request.resolution_mode
        if request.fps_mode is not None:
            fps_mode = request.fps_mode
        if request.rate_control is not None:
            rate_control = request.rate_control
        if request.explicit_bitrate is not None:
            explicit_bitrate = request.explicit_bitrate
        if request.audio_bitrate is not None:
            audio_bitrate = request.audio_bitrate
        if request.audio_enabled is not None:
            audio_enabled = request.audio_enabled
        if request.source_audio_muted is not None:
            source_audio_muted = request.source_audio_muted
        if request.source_audio_gain_db is not None:
            source_audio_gain_db = float(request.source_audio_gain_db)
        if request.source_audio_segments is not None:
            source_audio_segments = list(request.source_audio_segments)
        if request.source_audio_extra_tracks is not None:
            source_audio_extra_tracks = list(request.source_audio_extra_tracks)
        if request.source_audio_mute_ranges is not None:
            source_audio_mute_ranges = tuple(request.source_audio_mute_ranges)
        if request.audio_tracks is not None:
            audio_tracks = list(request.audio_tracks)
        if request.mix_audio_tracks is not None:
            mix_audio_tracks = request.mix_audio_tracks
        if request.even_out_loudness is not None:
            even_out_loudness = request.even_out_loudness
        if request.keep_audio is not None:
            keep_audio = bool(request.keep_audio)
        if request.scaler is not None:
            scaler = request.scaler
        if request.video_encoder is not None:
            video_encoder = request.video_encoder
        if request.crf is not None:
            crf = request.crf
        if request.tune is not None:
            tune = request.tune
        if request.two_pass is not None:
            two_pass = request.two_pass
        if request.preset is not None:
            preset = request.preset
        if request.workflow is not None:
            workflow = request.workflow
        if request.rate_control_method is not None:
            rate_control_method = request.rate_control_method
        if request.cq is not None:
            cq = request.cq
        if request.qp is not None:
            qp = request.qp

    validate_encoder_supported_on_desktop(video_encoder)
    scaler = normalize_scaler(scaler)
    preset = native_preset_for_encoder(preset, video_encoder)
    validate_tune_for_encoder(tune, video_encoder)
    validate_rc_method_for_encoder(rate_control_method, video_encoder)
    if request is None or request.rate_control_method is None:
        rate_control_method, two_pass = normalize_legacy_rc_matrix(
            workflow,
            rate_control,
            rate_control_method,
            video_encoder,
            two_pass,
        )
    validate_rate_control_matrix(
        workflow,
        rate_control,
        rate_control_method,
        video_encoder,
        two_pass,
    )
    rate_control_method = size_target_rate_control_method(workflow, rate_control_method)

    return PlanOptions(
        resolution_mode=resolution_mode,
        fps_mode=fps_mode,
        rate_control=rate_control,
        explicit_bitrate=explicit_bitrate,
        audio_bitrate=audio_bitrate,
        workflow=workflow,
        rate_control_method=rate_control_method,
        qp=qp,
        cq=cq,
        audio_enabled=audio_enabled,
        source_audio_muted=source_audio_muted,
        source_audio_gain_db=source_audio_gain_db,
        source_audio_segments=source_audio_segments,
        source_audio_extra_tracks=source_audio_extra_tracks,
        source_audio_mute_ranges=source_audio_mute_ranges,
        audio_tracks=audio_tracks,
        mix_audio_tracks=mix_audio_tracks,
        even_out_loudness=even_out_loudness,
        keep_audio=keep_audio,
        scaler=scaler,
        video_encoder=video_encoder,
        crf=crf,
        tune=tune,
        two_pass=two_pass,
        preset=preset,
    )
