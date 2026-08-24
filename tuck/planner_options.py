from __future__ import annotations

from dataclasses import dataclass

from .models import AudioTrack, PlanRequest, Profile, Segment
from .models.encoding_policy import (
    RCM_CBR,
    native_preset_for_encoder,
    normalize_legacy_rc_matrix,
    validate_rate_control_matrix,
    validate_rc_method_for_encoder,
    validate_tune_for_encoder,
)


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
    audio_tracks: list[AudioTrack]
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
    workflow = getattr(profile, "workflow", "compression")
    rate_control_method = getattr(profile, "rate_control_method", RCM_CBR)
    qp = getattr(profile, "qp", 23)
    cq = getattr(profile, "cq", qp)
    audio_enabled = True
    source_audio_muted = False
    source_audio_gain_db = 0.0
    source_audio_segments: list[Segment] | None = None
    audio_tracks: list[AudioTrack] = []
    keep_audio = bool(getattr(profile, "keep_audio", False))
    scaler = getattr(profile, "scaler", None) or "neighbor"
    video_encoder = getattr(profile, "video_encoder", "libx264")
    crf = getattr(profile, "crf", 23)
    tune = getattr(profile, "tune", "")
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
        if request.audio_tracks is not None:
            audio_tracks = list(request.audio_tracks)
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
        audio_tracks=audio_tracks,
        keep_audio=keep_audio,
        scaler=scaler,
        video_encoder=video_encoder,
        crf=crf,
        tune=tune,
        two_pass=two_pass,
        preset=preset,
    )
