from __future__ import annotations

import contextlib
import json
import math
import re
import uuid
from dataclasses import dataclass, field, fields
from enum import Enum
from pathlib import Path
from typing import Any, ClassVar

from .progress import EncodeProgress as EncodeProgress
from .progress import EncodeStage as EncodeStage
from .transforms import (
    CROP_ASPECT_1_1 as CROP_ASPECT_1_1,
)
from .transforms import (
    CROP_ASPECT_4_3 as CROP_ASPECT_4_3,
)
from .transforms import (
    CROP_ASPECT_9_16 as CROP_ASPECT_9_16,
)
from .transforms import (
    CROP_ASPECT_16_9 as CROP_ASPECT_16_9,
)
from .transforms import (
    CROP_ASPECT_FREE as CROP_ASPECT_FREE,
)
from .transforms import (
    CROP_ASPECT_RATIOS as CROP_ASPECT_RATIOS,
)
from .transforms import (
    SIZING_MODE_FILL as SIZING_MODE_FILL,
)
from .transforms import (
    SIZING_MODE_FIT as SIZING_MODE_FIT,
)
from .transforms import (
    SIZING_MODE_STRETCH as SIZING_MODE_STRETCH,
)
from .transforms import (
    CropRect as CropRect,
)
from .transforms import (
    OutputGeometry as OutputGeometry,
)
from .transforms import (
    ProfileTransformIntent as ProfileTransformIntent,
)
from .transforms import (
    TransformGeometry as TransformGeometry,
)
from .transforms import (
    VideoTransform as VideoTransform,
)
from .transforms import (
    calculate_transform_geometry as calculate_transform_geometry,
)
from .transforms import (
    crop_for_aspect as crop_for_aspect,
)
from .transforms import (
    fill_crop_dimensions as fill_crop_dimensions,
)
from .transforms import (
    fit_output_dimensions as fit_output_dimensions,
)
from .transforms import (
    oriented_dimensions as oriented_dimensions,
)

# Keep the old ID so saved settings, CLI commands, and Send To shortcuts still work
PROFILE_ID_DISCORD_FREE = "discord-10mb"
PROFILE_ID_DISCORD_NITRO_BASIC = "discord-50mb"
PROFILE_ID_DISCORD_NITRO = "discord-500mb"
PROFILE_ID_1440P_UPSCALE = "1440p-upscale"
PROFILE_ID_4K_UPSCALE = "4k-upscale"

BUILTIN_PROFILE_IDS: frozenset[str] = frozenset(
    {
        PROFILE_ID_DISCORD_FREE,
        PROFILE_ID_DISCORD_NITRO_BASIC,
        PROFILE_ID_DISCORD_NITRO,
        PROFILE_ID_1440P_UPSCALE,
        PROFILE_ID_4K_UPSCALE,
    }
)

DISCORD_FREE_LIMIT = 20 * 1024 * 1024
DISCORD_NITRO_BASIC_LIMIT = 50 * 1024 * 1024
DISCORD_NITRO_LIMIT = 500 * 1024 * 1024
MIN_TARGET_SIZE_BYTES = 2 * 1024 * 1024
MIN_SEGMENT_DURATION = 0.05

PROFILE_SCHEMA_VERSION = 6


class QueueState(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


RES_MODE_SOURCE = "source"
RES_MODE_LIMIT = "limit"
RES_MODE_CUSTOM = "custom"
FPS_MODE_SOURCE = "source"
FPS_MODE_LIMIT = "limit"
FPS_MODE_CUSTOM = "custom"
RC_TARGET_SIZE = "target_size"
RC_EXPLICIT_BITRATE = "explicit_bitrate"
WORKFLOW_COMPRESSION = "compression"
WORKFLOW_UPSCALE = "upscale"
RCM_CRF = "crf"
RCM_CQP = "cqp"
RCM_CQ = "cq"
RCM_CBR = "cbr"
RCM_VBR = "vbr"

SCALER_BILINEAR = "bilinear"
SCALER_BICUBIC = "bicubic"
SCALER_LANCZOS = "lanczos"
SCALER_NEIGHBOR = "neighbor"
SCALER_POINT = "point"

_VALID_RES_MODES = frozenset({RES_MODE_SOURCE, RES_MODE_LIMIT, RES_MODE_CUSTOM})
_VALID_FPS_MODES = frozenset({FPS_MODE_SOURCE, FPS_MODE_LIMIT, FPS_MODE_CUSTOM})
_VALID_RC_MODES = frozenset({RC_TARGET_SIZE, RC_EXPLICIT_BITRATE})
_VALID_WORKFLOWS = frozenset({WORKFLOW_COMPRESSION, WORKFLOW_UPSCALE})
_VALID_RC_METHODS = frozenset({RCM_CRF, RCM_CQP, RCM_CQ, RCM_CBR, RCM_VBR})
_VALID_SCALERS = frozenset(
    {SCALER_BILINEAR, SCALER_BICUBIC, SCALER_LANCZOS, SCALER_NEIGHBOR, SCALER_POINT}
)
ENCODER_AUTO = "auto"
ENCODER_AUTO_COMPRESSION = "auto_compression"
ENCODER_AUTO_FAST = "auto_fast"
_AUTO_ENCODERS: frozenset[str] = frozenset(
    {ENCODER_AUTO, ENCODER_AUTO_COMPRESSION, ENCODER_AUTO_FAST}
)

_VALID_VIDEO_ENCODERS: frozenset[str] = frozenset(
    {"libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_amf", "hevc_amf"}
)
_VALID_VIDEO_ENCODER_CHOICES: frozenset[str] = _VALID_VIDEO_ENCODERS | _AUTO_ENCODERS

_CPU_ENCODERS: frozenset[str] = frozenset({"libx264", "libx265"})
_NVENC_ENCODERS: frozenset[str] = frozenset({"h264_nvenc", "hevc_nvenc"})
_AMF_ENCODERS: frozenset[str] = frozenset({"h264_amf", "hevc_amf"})

X264_TUNES: frozenset[str] = frozenset(
    {"", "film", "animation", "grain", "stillimage", "psnr", "ssim", "fastdecode", "zerolatency"}
)
X265_TUNES: frozenset[str] = frozenset(
    {"", "psnr", "ssim", "grain", "zerolatency", "fastdecode", "animation"}
)
_ALL_TUNES: frozenset[str] = X264_TUNES | X265_TUNES


def _validate_tune_for_encoder(tune: str, video_encoder: str | None) -> None:
    if tune not in _ALL_TUNES:
        raise ValueError(f"tune must be one of {sorted(_ALL_TUNES)}")
    if not tune:
        return
    if video_encoder == "libx265" and tune not in X265_TUNES:
        raise ValueError(f"tune '{tune}' is not compatible with libx265")
    if video_encoder == "libx264" and tune not in X264_TUNES:
        raise ValueError(f"tune '{tune}' is not compatible with libx264")


def _validate_rc_method_for_encoder(rc_method: str, video_encoder: str) -> None:
    if rc_method not in _VALID_RC_METHODS:
        raise ValueError(f"rate_control_method must be one of {sorted(_VALID_RC_METHODS)}")
    if video_encoder in _AUTO_ENCODERS:
        return
    if video_encoder not in _VALID_VIDEO_ENCODERS:
        raise ValueError(
            f"rate_control_method: unknown video_encoder '{video_encoder}'; "
            f"must be one of {sorted(_VALID_VIDEO_ENCODER_CHOICES)}"
        )
    if video_encoder in _CPU_ENCODERS:
        if rc_method not in (RCM_CRF, RCM_CBR):
            raise ValueError(
                f"rate_control_method '{rc_method}' not supported for {video_encoder}; "
                f"use crf or cbr"
            )
    elif (video_encoder in _NVENC_ENCODERS or video_encoder in _AMF_ENCODERS) and rc_method not in (
        RCM_CQ,
        RCM_CQP,
        RCM_CBR,
        RCM_VBR,
    ):
        raise ValueError(
            f"rate_control_method '{rc_method}' not supported for {video_encoder}; "
            f"use cq, cbr, or vbr"
        )


_QUALITY_RC_METHODS: frozenset[str] = frozenset({RCM_CRF, RCM_CQ, RCM_CQP})
_BITRATE_RC_METHODS: frozenset[str] = frozenset({RCM_CBR, RCM_VBR})


def validate_rate_control_matrix(
    workflow: str,
    rate_control: str,
    rate_control_method: str,
    video_encoder: str,
    two_pass: bool,
) -> None:
    is_compression = workflow == WORKFLOW_COMPRESSION
    is_upscale = workflow == WORKFLOW_UPSCALE
    is_quality_method = rate_control_method in _QUALITY_RC_METHODS
    is_bitrate_method = rate_control_method in _BITRATE_RC_METHODS
    is_auto = video_encoder in _AUTO_ENCODERS
    is_cpu = video_encoder in _CPU_ENCODERS or is_auto

    if is_compression:
        if rate_control != RC_TARGET_SIZE:
            raise ValueError("Compression workflow requires rate_control 'target_size'.")
        if is_quality_method:
            raise ValueError(
                "Compression requires a bitrate-driven method; quality method is not supported."
            )

    if is_upscale:
        if is_bitrate_method and rate_control != RC_EXPLICIT_BITRATE:
            raise ValueError(
                "Upscale workflow with CBR/VBR requires rate_control 'explicit_bitrate'."
            )
        if is_quality_method and rate_control != RC_TARGET_SIZE:
            raise ValueError("Upscale CRF or constant quality requires rate_control 'target_size'.")
        if (
            video_encoder in _CPU_ENCODERS
            and rate_control_method != RCM_CRF
            and not is_bitrate_method
        ):
            raise ValueError("Software Upscale requires CRF or an explicit bitrate method.")
        if (
            not is_auto
            and video_encoder in _NVENC_ENCODERS | _AMF_ENCODERS
            and rate_control_method == RCM_CRF
        ):
            raise ValueError(
                "Hardware Upscale requires constant quality or an explicit bitrate method."
            )

    if two_pass:
        if not is_compression:
            raise ValueError("Two-pass encoding is only available for Compression workflow.")
        if not is_cpu or video_encoder in (ENCODER_AUTO, ENCODER_AUTO_FAST):
            raise ValueError(
                f"Two-pass encoding is only available for CPU encoders "
                f"(libx264/libx265), not '{video_encoder}'."
            )
        if not is_bitrate_method:
            raise ValueError(
                f"Two-pass encoding requires a bitrate-driven rate-control method "
                f"(CBR for CPU), not '{rate_control_method}'."
            )


def _normalize_legacy_rc_matrix(
    workflow: str,
    rate_control: str,
    rate_control_method: str,
    video_encoder: str,
    two_pass: bool,
) -> tuple[str, bool]:
    is_compression = workflow == WORKFLOW_COMPRESSION
    is_upscale = workflow == WORKFLOW_UPSCALE
    is_quality_method = rate_control_method in _QUALITY_RC_METHODS
    is_cpu = video_encoder in _CPU_ENCODERS

    new_rcm = rate_control_method
    new_two_pass = two_pass

    if is_compression:
        new_rcm = RCM_CBR
        new_two_pass = new_two_pass and is_cpu

    if is_upscale and not is_quality_method and rate_control == RC_TARGET_SIZE:
        new_rcm = RCM_CRF if is_cpu else RCM_CQ

    if new_two_pass and (
        workflow != WORKFLOW_COMPRESSION or not is_cpu or new_rcm not in _BITRATE_RC_METHODS
    ):
        new_two_pass = False

    return new_rcm, new_two_pass


@dataclass
class VideoInfo:
    path: str
    duration: float
    width: int
    height: int
    fps: float
    video_codec: str
    audio_codec: str = ""
    audio_channels: int = 0
    audio_sample_rate: int = 0
    audio_bitrate: int = 0
    file_size: int = 0
    bitrate: int = 0
    has_audio: bool = False
    coded_width: int = 0
    coded_height: int = 0
    display_rotation: int = 0

    @property
    def resolution_str(self) -> str:
        return f"{self.width}x{self.height}"

    @property
    def duration_str(self) -> str:
        m, s = divmod(int(self.duration), 60)
        h, m = divmod(m, 60)
        if h:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"


@dataclass(frozen=True)
class Segment:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return float(self.end - self.start)

    def validate(self, source_duration: float | None = None) -> None:
        if isinstance(self.start, bool) or not isinstance(self.start, (int, float)):
            raise ValueError("segment start must be a number")
        if isinstance(self.end, bool) or not isinstance(self.end, (int, float)):
            raise ValueError("segment end must be a number")
        if not math.isfinite(float(self.start)):
            raise ValueError("segment start must be finite")
        if not math.isfinite(float(self.end)):
            raise ValueError("segment end must be finite")
        if self.start < 0:
            raise ValueError("segment start must be >= 0")
        if self.end <= self.start:
            raise ValueError("segment end must be greater than segment start")
        if self.duration < MIN_SEGMENT_DURATION - 1e-9:
            raise ValueError(
                f"segment is too short ({self.duration:.3f}s). "
                f"Select at least {MIN_SEGMENT_DURATION:.2f} seconds."
            )
        if source_duration is not None:
            if not math.isfinite(source_duration) or source_duration <= 0:
                raise ValueError(f"source duration must be positive and finite ({source_duration})")
            if self.start >= source_duration:
                raise ValueError(
                    f"segment start ({self.start:.3f}s) must be less than source duration "
                    f"({source_duration:.3f}s)"
                )
            if self.end > source_duration + 1e-6:
                raise ValueError(
                    f"segment end ({self.end:.3f}s) exceeds source duration "
                    f"({source_duration:.3f}s)"
                )

    def to_dict(self) -> dict[str, float]:
        return {"start": float(self.start), "end": float(self.end)}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Segment:
        if not isinstance(data, dict):
            raise ValueError("segment must be an object")
        if set(data) != {"start", "end"}:
            raise ValueError("segment must contain exactly start and end")
        start = data["start"]
        end = data["end"]
        segment = cls(start=start, end=end)
        segment.validate()
        return segment


def validate_segments(
    segments: list[Segment],
    source_duration: float | None = None,
) -> None:
    if not segments:
        raise ValueError("segments must contain at least one segment")
    previous: Segment | None = None
    for index, segment in enumerate(segments):
        if not isinstance(segment, Segment):
            raise ValueError(f"segments[{index}] must be a Segment")
        segment.validate(source_duration)
        if previous is not None:
            if segment.start < previous.start:
                raise ValueError("segments must be ordered chronologically")
            if segment.start < previous.end - 1e-6:
                raise ValueError(
                    f"segments must not overlap (segment {index} starts at "
                    f"{segment.start:.3f}s before the previous segment ends at "
                    f"{previous.end:.3f}s)"
                )
        previous = segment


@dataclass
class PlanRequest:
    source: str = ""
    profile_id: str = ""

    target_size_bytes: int | None = None

    resolution_mode: str | None = None
    custom_width: int | None = None
    custom_height: int | None = None

    fps_mode: str | None = None
    custom_fps: float | None = None

    rate_control: str | None = None
    explicit_bitrate: int | None = None

    audio_bitrate: int | None = None
    keep_audio: bool | None = None

    scaler: str | None = None

    video_encoder: str | None = None
    crf: int | None = None
    cq: int | None = None
    tune: str | None = None

    two_pass: bool | None = None
    preset: str | None = None

    workflow: str | None = None
    rate_control_method: str | None = None
    qp: int | None = None

    trim_start: float | None = None
    trim_end: float | None = None
    segments: list[Segment] | None = None
    transform: VideoTransform | None = None

    def validate(self) -> None:
        if self.resolution_mode is not None and self.resolution_mode not in _VALID_RES_MODES:
            raise ValueError(f"Invalid resolution_mode: {self.resolution_mode!r}")
        if self.fps_mode is not None and self.fps_mode not in _VALID_FPS_MODES:
            raise ValueError(f"Invalid fps_mode: {self.fps_mode!r}")
        if self.rate_control is not None and self.rate_control not in _VALID_RC_MODES:
            raise ValueError(f"Invalid rate_control: {self.rate_control!r}")
        if self.workflow is not None and self.workflow not in _VALID_WORKFLOWS:
            raise ValueError(f"Invalid workflow: {self.workflow!r}")
        if (
            self.rate_control_method is not None
            and self.rate_control_method not in _VALID_RC_METHODS
        ):
            raise ValueError(f"Invalid rate_control_method: {self.rate_control_method!r}")
        if self.rate_control_method == RCM_CQP:
            raise ValueError("CQP is a legacy profile setting; use CQ instead.")

        if self.resolution_mode == RES_MODE_CUSTOM:
            if self.custom_width is not None and self.custom_width < 2:
                raise ValueError("custom_width must be >= 2")
            if self.custom_height is not None and self.custom_height < 2:
                raise ValueError("custom_height must be >= 2")
        if (
            self.fps_mode == FPS_MODE_CUSTOM
            and self.custom_fps is not None
            and self.custom_fps <= 0
        ):
            raise ValueError("custom_fps must be > 0")

        if (
            self.rate_control == RC_EXPLICIT_BITRATE
            and self.explicit_bitrate is not None
            and self.explicit_bitrate < 1000
        ):
            raise ValueError("explicit_bitrate must be >= 1000 bps")

        if self.target_size_bytes is not None and self.target_size_bytes < MIN_TARGET_SIZE_BYTES:
            raise ValueError("target_size_bytes must be at least 2 MB")

        if self.scaler is not None and self.scaler not in _VALID_SCALERS:
            if self.scaler == "nearest":
                self.scaler = SCALER_NEIGHBOR
            else:
                raise ValueError(f"Invalid scaler: {self.scaler!r}")

        if (
            self.video_encoder is not None
            and self.video_encoder not in _VALID_VIDEO_ENCODER_CHOICES
        ):
            raise ValueError(f"video_encoder must be one of {sorted(_VALID_VIDEO_ENCODER_CHOICES)}")

        if self.crf is not None and (self.crf < 0 or self.crf > 51):
            raise ValueError("crf must be between 0 and 51")

        if self.cq is not None and (self.cq < 0 or self.cq > 51):
            raise ValueError("cq must be between 0 and 51")

        if self.qp is not None and (self.qp < 0 or self.qp > 51):
            raise ValueError("qp must be between 0 and 51")

        if self.tune is not None:
            _validate_tune_for_encoder(self.tune, self.video_encoder)

        if self.two_pass is not None and not isinstance(self.two_pass, bool):
            raise ValueError("two_pass must be a boolean")

        if self.preset is not None and self.preset not in _VALID_PRESETS:
            raise ValueError(f"preset must be one of {sorted(_VALID_PRESETS)}")

        if self.transform is not None and not isinstance(self.transform, VideoTransform):
            raise ValueError("transform must be a VideoTransform or None")

        if self.segments is not None and (self.trim_start is not None or self.trim_end is not None):
            raise ValueError("segments cannot be combined with trim_start or trim_end")
        if self.segments is not None:
            validate_segments(self.segments)

        if self.trim_start is not None:
            if isinstance(self.trim_start, bool) or not isinstance(self.trim_start, (int, float)):
                raise ValueError("trim_start must be a number")
            if not math.isfinite(float(self.trim_start)):
                raise ValueError("trim_start must be finite")
            if self.trim_start < 0:
                raise ValueError("trim_start must be >= 0")
        if self.trim_end is not None:
            if isinstance(self.trim_end, bool) or not isinstance(self.trim_end, (int, float)):
                raise ValueError("trim_end must be a number")
            if not math.isfinite(float(self.trim_end)):
                raise ValueError("trim_end must be finite")
            if self.trim_end <= 0:
                raise ValueError("trim_end must be > 0")
        if (
            self.trim_start is not None
            and self.trim_end is not None
            and self.trim_end <= self.trim_start
        ):
            raise ValueError("trim_end must be greater than trim_start")

        if (
            self.workflow is not None
            and self.rate_control is not None
            and self.rate_control_method is not None
            and self.video_encoder is not None
            and self.two_pass is not None
        ):
            validate_rate_control_matrix(
                self.workflow,
                self.rate_control,
                self.rate_control_method,
                self.video_encoder,
                self.two_pass,
            )


@dataclass
class EncodePlan:
    source: str
    output: str
    target_width: int = 0
    target_height: int = 0
    target_fps: float = 0.0
    video_bitrate: int = 0
    original_video_bitrate: int = 0
    resolution_mode: str = RES_MODE_SOURCE
    fps_mode: str = FPS_MODE_SOURCE
    rate_control: str = RC_TARGET_SIZE
    apply_scale: bool = False
    apply_fps_filter: bool = False
    scaler: str = SCALER_NEIGHBOR
    audio_bitrate: int = 0
    audio_channels: int = 2
    audio_sample_rate: int = 44100
    copy_audio: bool = False
    two_pass: bool = True
    preset: str = "medium"
    crf: int = 23
    video_encoder: str = "libx264"
    tune: str = ""
    estimated_size: int = 0
    target_size: int = 0
    explicit_bitrate: int = 0
    source_info: VideoInfo | None = None
    profile_id: str = ""
    workflow: str = WORKFLOW_COMPRESSION
    rate_control_method: str = RCM_CBR
    cq: int = 23
    qp: int = 23
    trim_start: float = 0.0
    trim_end: float = 0.0
    segments: list[Segment] = field(default_factory=list)
    transform: VideoTransform = field(default_factory=VideoTransform)

    @property
    def effective_segments(self) -> list[Segment]:
        if self.segments:
            return list(self.segments)
        if self.trim_end > self.trim_start:
            return [Segment(float(self.trim_start), float(self.trim_end))]
        if self.source_info is not None and self.source_info.duration > 0:
            return [Segment(0.0, float(self.source_info.duration))]
        return []

    @property
    def effective_duration(self) -> float:
        return float(sum(segment.duration for segment in self.effective_segments))

    @property
    def trim_duration(self) -> float:
        """Legacy name for the selected duration"""

        return self.effective_duration

    @property
    def segment_count(self) -> int:
        return len(self.effective_segments)

    @property
    def has_trim(self) -> bool:
        segments = self.effective_segments
        if len(segments) != 1:
            return bool(segments)
        segment = segments[0]
        if segment.start > 0.001:
            return True
        full = float(self.source_info.duration) if self.source_info is not None else 0.0
        return bool(full > 0 and segment.end < full - 0.001)

    def to_dict(self) -> dict[str, Any]:
        import dataclasses

        d = dataclasses.asdict(self)
        if self.source_info is not None:
            d["source_info"] = dataclasses.asdict(self.source_info)
        else:
            d["source_info"] = None
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EncodePlan:
        data = dict(data)
        info = data.pop("source_info", None)
        transform_data = data.pop("transform", None)
        segments_data = data.pop("segments", None)
        for field_name, default in [
            ("resolution_mode", RES_MODE_SOURCE),
            ("fps_mode", FPS_MODE_SOURCE),
            ("rate_control", RC_TARGET_SIZE),
            ("apply_scale", False),
            ("apply_fps_filter", False),
            ("explicit_bitrate", 0),
            ("copy_audio", False),
            ("scaler", SCALER_NEIGHBOR),
            ("workflow", WORKFLOW_COMPRESSION),
            ("rate_control_method", RCM_CBR),
            ("cq", 23),
            ("qp", 23),
            ("trim_start", 0.0),
            ("trim_end", 0.0),
        ]:
            if field_name not in data:
                data[field_name] = default
        plan = cls(**{k: v for k, v in data.items() if k in _fields_for(cls)})
        if transform_data is not None:
            if not isinstance(transform_data, dict):
                raise ValueError("transform must be an object or null")
            plan.transform = VideoTransform.from_dict(transform_data)
        if info and isinstance(info, dict):
            plan.source_info = VideoInfo(
                **{k: v for k, v in info.items() if k in _fields_for(VideoInfo)}
            )
        if segments_data is not None:
            if not isinstance(segments_data, list):
                raise ValueError("segments must be an array")
            plan.segments = [Segment.from_dict(item) for item in segments_data]
            if plan.segments:
                validate_segments(
                    plan.segments,
                    float(plan.source_info.duration) if plan.source_info is not None else None,
                )
            if len(plan.segments) == 1:
                plan.trim_start = float(plan.segments[0].start)
                plan.trim_end = float(plan.segments[0].end)
            elif len(plan.segments) > 1:
                plan.trim_start = 0.0
                plan.trim_end = 0.0
            elif plan.source_info is not None:
                legacy_start = float(plan.trim_start or 0.0)
                legacy_end = float(plan.trim_end or plan.source_info.duration)
                plan.segments = [Segment(legacy_start, legacy_end)]
                validate_segments(plan.segments, float(plan.source_info.duration))
        elif plan.source_info is not None:
            # Load legacy trim fields as one segment
            legacy_start = float(plan.trim_start or 0.0)
            legacy_end = float(plan.trim_end or plan.source_info.duration)
            plan.segments = [Segment(legacy_start, legacy_end)]
            validate_segments(plan.segments, float(plan.source_info.duration))
        return plan


@dataclass
class Profile:
    name: str
    target_size_bytes: int = DISCORD_NITRO_BASIC_LIMIT

    resolution_mode: str = RES_MODE_SOURCE
    max_width: int = 1920
    max_height: int = 1080
    custom_width: int = 1920
    custom_height: int = 1080

    fps_mode: str = FPS_MODE_SOURCE
    max_fps: float = 30.0
    custom_fps: float = 30.0

    rate_control: str = RC_TARGET_SIZE
    explicit_bitrate: int = 0

    scaler: str = SCALER_NEIGHBOR

    audio_bitrate: int = 128_000
    audio_channels: int = 2
    audio_sample_rate: int = 44100
    keep_audio: bool = False

    preset: str = "medium"
    two_pass: bool = True

    video_encoder: str = "libx264"
    crf: int = 23
    tune: str = ""

    workflow: str = WORKFLOW_COMPRESSION
    rate_control_method: str = RCM_CBR
    cq: int = 23
    qp: int = 23

    transform_intent: ProfileTransformIntent | None = None

    profile_id: str | None = None
    schema_version: int = PROFILE_SCHEMA_VERSION

    _ID_RE: ClassVar = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

    def __post_init__(self) -> None:
        if self.profile_id is None:
            self.profile_id = uuid.uuid4().hex[:12]
        elif not self.profile_id:
            raise ValueError("profile_id must be non-empty string, or None to auto-generate")
        if not self._ID_RE.match(self.profile_id):
            msg = f"Invalid profile_id {self.profile_id!r}: must match {self._ID_RE.pattern}"
            raise ValueError(msg)
        if self.schema_version < 1:
            self.schema_version = PROFILE_SCHEMA_VERSION
        if self.transform_intent is not None and not isinstance(
            self.transform_intent, ProfileTransformIntent
        ):
            raise ValueError("transform_intent must be a ProfileTransformIntent or None")

    def to_dict(self) -> dict[str, Any]:
        data = {
            "profile_id": self.profile_id,
            "name": self.name,
            "target_size_bytes": self.target_size_bytes,
            "resolution_mode": self.resolution_mode,
            "max_width": self.max_width,
            "max_height": self.max_height,
            "custom_width": self.custom_width,
            "custom_height": self.custom_height,
            "fps_mode": self.fps_mode,
            "max_fps": self.max_fps,
            "custom_fps": self.custom_fps,
            "rate_control": self.rate_control,
            "explicit_bitrate": self.explicit_bitrate,
            "scaler": self.scaler,
            "audio_bitrate": self.audio_bitrate,
            "audio_channels": self.audio_channels,
            "audio_sample_rate": self.audio_sample_rate,
            "keep_audio": self.keep_audio,
            "preset": self.preset,
            "two_pass": self.two_pass,
            "video_encoder": self.video_encoder,
            "crf": self.crf,
            "tune": self.tune,
            "workflow": self.workflow,
            "rate_control_method": self.rate_control_method,
            "cq": self.cq,
            "qp": self.qp,
            "schema_version": self.schema_version,
        }
        if self.transform_intent is not None:
            data["transform_intent"] = self.transform_intent.to_dict()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Profile:
        defaults_v3: dict[str, Any] = {
            "resolution_mode": RES_MODE_LIMIT,
            "custom_width": data.get("max_width", 1920),
            "custom_height": data.get("max_height", 1080),
            "fps_mode": FPS_MODE_LIMIT,
            "custom_fps": data.get("max_fps", 30.0),
            "keep_audio": False,
            "rate_control": RC_TARGET_SIZE,
            "explicit_bitrate": 0,
            "workflow": WORKFLOW_COMPRESSION,
            "rate_control_method": RCM_CBR,
            "cq": data.get("qp", 23),
            "qp": data.get("qp", 23),
        }
        merged = {**defaults_v3, **data}
        if (
            data.get("profile_id") in (PROFILE_ID_1440P_UPSCALE, PROFILE_ID_4K_UPSCALE)
            and data.get("schema_version", 1) < 3
        ):
            merged["workflow"] = WORKFLOW_UPSCALE
            merged["rate_control_method"] = RCM_CRF
            merged["crf"] = 18
            merged["two_pass"] = False
        source_schema_version = merged.get("schema_version", 1)
        if source_schema_version < 4 or (
            merged.get("workflow", WORKFLOW_COMPRESSION) == WORKFLOW_COMPRESSION
            and merged.get("rate_control") == RC_EXPLICIT_BITRATE
        ):
            merged = _migrate_profile_data(merged)
        if source_schema_version < PROFILE_SCHEMA_VERSION:
            merged = _migrate_builtin_profile_defaults(merged)
            merged["schema_version"] = PROFILE_SCHEMA_VERSION
        _validate_profile_dict(merged)
        transform_data = merged.get("transform_intent")
        return cls(
            name=merged["name"],
            target_size_bytes=merged.get("target_size_bytes", DISCORD_NITRO_BASIC_LIMIT),
            resolution_mode=merged.get("resolution_mode", RES_MODE_SOURCE),
            max_width=merged.get("max_width", 1920),
            max_height=merged.get("max_height", 1080),
            custom_width=merged.get("custom_width", 1920),
            custom_height=merged.get("custom_height", 1080),
            fps_mode=merged.get("fps_mode", FPS_MODE_SOURCE),
            max_fps=merged.get("max_fps", 30.0),
            custom_fps=merged.get("custom_fps", 30.0),
            rate_control=merged.get("rate_control", RC_TARGET_SIZE),
            explicit_bitrate=merged.get("explicit_bitrate", 0),
            scaler=merged.get("scaler", SCALER_NEIGHBOR),
            audio_bitrate=merged.get("audio_bitrate", 128_000),
            audio_channels=merged.get("audio_channels", 2),
            audio_sample_rate=merged.get("audio_sample_rate", 44100),
            keep_audio=bool(merged.get("keep_audio", False)),
            preset=merged.get("preset", "medium"),
            two_pass=merged.get("two_pass", True),
            video_encoder=merged.get("video_encoder", "libx264"),
            crf=merged.get("crf", 23),
            tune=merged.get("tune", ""),
            workflow=merged.get("workflow", WORKFLOW_COMPRESSION),
            rate_control_method=merged.get("rate_control_method", RCM_CBR),
            cq=merged.get("cq", merged.get("qp", 23)),
            qp=merged.get("qp", 23),
            transform_intent=(
                ProfileTransformIntent.from_dict(transform_data)
                if transform_data is not None
                else None
            ),
            profile_id=merged.get("profile_id") or None,
            schema_version=merged.get("schema_version", PROFILE_SCHEMA_VERSION),
        )


@dataclass
class QueueItem:
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    plan: EncodePlan | None = None
    state: QueueState = QueueState.PENDING
    progress: float = 0.0
    progress_info: EncodeProgress | None = None
    status_text: str = ""
    error: str = ""
    error_detail: str = ""
    result_path: str = ""
    result_size: int = 0
    added_at: str = ""
    started_at: str = ""
    finished_at: str = ""


@dataclass
class AppSettings:
    version: int = 1
    default_profile_id: str = PROFILE_ID_DISCORD_FREE
    default_scaler: str = SCALER_NEIGHBOR
    output_dir: str = ""
    ffmpeg_path: str = ""
    ffprobe_path: str = ""
    encoder_cache_days: int = 7
    check_updates: bool = True
    last_update_check: str = ""
    compression_suffix: str = "_tucked_{size}"
    upscale_suffix: str = "_upscaled_{width}x{height}"
    clear_completed_automatically: bool = False
    last_task: str = WORKFLOW_COMPRESSION
    last_compress_profile_id: str = ""
    last_upscale_profile_id: str = ""
    left_sidebar_width: int = 240
    window_width: int = 1240
    window_height: int = 800
    profiles: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        import dataclasses

        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AppSettings:
        valid_keys = {f.name for f in fields(cls)}
        filtered = {k: v for k, v in data.items() if k in valid_keys}
        return cls(**filtered)


DEFAULT_PROFILES: list[Profile] = [
    Profile(
        profile_id=PROFILE_ID_DISCORD_FREE,
        name="Discord Free - 20MB",
        target_size_bytes=DISCORD_FREE_LIMIT,
        resolution_mode=RES_MODE_SOURCE,
        max_width=3840,
        max_height=2160,
        fps_mode=FPS_MODE_SOURCE,
        rate_control=RC_TARGET_SIZE,
        keep_audio=True,
        workflow=WORKFLOW_COMPRESSION,
        rate_control_method=RCM_CBR,
    ),
    Profile(
        profile_id=PROFILE_ID_DISCORD_NITRO_BASIC,
        name="Discord Nitro Basic - 50MB",
        target_size_bytes=DISCORD_NITRO_BASIC_LIMIT,
        resolution_mode=RES_MODE_SOURCE,
        max_width=3840,
        max_height=2160,
        fps_mode=FPS_MODE_SOURCE,
        rate_control=RC_TARGET_SIZE,
        keep_audio=True,
        workflow=WORKFLOW_COMPRESSION,
        rate_control_method=RCM_CBR,
    ),
    Profile(
        profile_id=PROFILE_ID_DISCORD_NITRO,
        name="Discord Nitro - 500MB",
        target_size_bytes=DISCORD_NITRO_LIMIT,
        resolution_mode=RES_MODE_SOURCE,
        max_width=3840,
        max_height=2160,
        fps_mode=FPS_MODE_SOURCE,
        rate_control=RC_TARGET_SIZE,
        keep_audio=True,
        workflow=WORKFLOW_COMPRESSION,
        rate_control_method=RCM_CBR,
    ),
    Profile(
        profile_id=PROFILE_ID_1440P_UPSCALE,
        name="1440p Upscale (2560x1440)",
        target_size_bytes=500 * 1024 * 1024,
        resolution_mode=RES_MODE_CUSTOM,
        custom_width=2560,
        custom_height=1440,
        fps_mode=FPS_MODE_SOURCE,
        rate_control=RC_TARGET_SIZE,
        scaler=SCALER_NEIGHBOR,
        keep_audio=True,
        workflow=WORKFLOW_UPSCALE,
        rate_control_method=RCM_CRF,
        crf=18,
        two_pass=False,
        preset="medium",
    ),
    Profile(
        profile_id=PROFILE_ID_4K_UPSCALE,
        name="4K Upscale (3840x2160)",
        target_size_bytes=500 * 1024 * 1024,
        resolution_mode=RES_MODE_CUSTOM,
        custom_width=3840,
        custom_height=2160,
        fps_mode=FPS_MODE_SOURCE,
        rate_control=RC_TARGET_SIZE,
        scaler=SCALER_NEIGHBOR,
        keep_audio=True,
        workflow=WORKFLOW_UPSCALE,
        rate_control_method=RCM_CRF,
        crf=18,
        two_pass=False,
        preset="medium",
    ),
]

PROFILE_ID_LEGACY_CUSTOM = "custom"
LEGACY_BUILTIN_IDS = frozenset({"custom"})


def profiles_to_dicts(profiles: list[Profile]) -> list[dict[str, Any]]:
    return [p.to_dict() for p in profiles]


def dicts_to_profiles(data: list[dict[str, Any]]) -> list[Profile]:
    return [Profile.from_dict(d) for d in data]


def export_profiles_json(profiles: list[Profile], path: Path) -> None:
    data = {
        "version": PROFILE_SCHEMA_VERSION,
        "profiles": profiles_to_dicts(profiles),
    }
    raw = json.dumps(data, indent=2, ensure_ascii=False)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(raw, encoding="utf-8")
        tmp.replace(path)
    except Exception:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise


def import_profiles_json(path: Path) -> list[Profile]:
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        raise ValueError("Profile file is empty")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in profile file: {e}") from e
    if not isinstance(data, dict):
        raise ValueError("Profile file must be a JSON object")
    file_version = data.get("version", 1)
    if file_version > PROFILE_SCHEMA_VERSION:
        raise ValueError(
            f"Profile schema version {file_version} is newer than "
            f"supported version {PROFILE_SCHEMA_VERSION}"
        )
    profiles_data = data.get("profiles")
    if profiles_data is None:
        raise ValueError("Profile file missing 'profiles' key")
    if not isinstance(profiles_data, list):
        raise ValueError("'profiles' must be a list")
    if not profiles_data:
        raise ValueError("Profile file contains no profiles")
    return dicts_to_profiles(profiles_data)


_X26X_PRESETS = frozenset(
    {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}
)
_NVENC_PRESETS = frozenset({"p1", "p2", "p3", "p4", "p5", "p6", "p7"})
_AMF_PRESETS = frozenset({"speed", "balanced", "quality"})
_VALID_PRESETS = _X26X_PRESETS | _NVENC_PRESETS | _AMF_PRESETS


def _validate_preset_for_encoder(preset: str, video_encoder: str) -> None:
    if video_encoder in _AUTO_ENCODERS:
        if preset not in _VALID_PRESETS:
            raise ValueError(f"preset must be one of {sorted(_VALID_PRESETS)}")
        return
    valid = (
        _X26X_PRESETS
        if video_encoder in _CPU_ENCODERS
        else (_NVENC_PRESETS if video_encoder in _NVENC_ENCODERS else _AMF_PRESETS)
    )
    if preset not in valid:
        raise ValueError(f"preset must be one of {sorted(valid)} for {video_encoder}")


_PROFILE_REQUIRED = frozenset({"name", "profile_id"})
_PROFILE_KNOWN = frozenset(
    {
        "profile_id",
        "name",
        "target_size_bytes",
        "resolution_mode",
        "max_width",
        "max_height",
        "custom_width",
        "custom_height",
        "fps_mode",
        "max_fps",
        "custom_fps",
        "rate_control",
        "explicit_bitrate",
        "audio_bitrate",
        "audio_channels",
        "audio_sample_rate",
        "keep_audio",
        "preset",
        "two_pass",
        "video_encoder",
        "crf",
        "tune",
        "schema_version",
        "scaler",
        "workflow",
        "rate_control_method",
        "cq",
        "qp",
        "transform_intent",
    }
)


def _native_preset_for_encoder(preset: str, video_encoder: str) -> str:
    if video_encoder in _AUTO_ENCODERS:
        return preset if preset in _VALID_PRESETS else "medium"
    if video_encoder in _CPU_ENCODERS:
        return preset if preset in _X26X_PRESETS else "medium"
    if video_encoder in _NVENC_ENCODERS:
        return {
            "ultrafast": "p1",
            "superfast": "p2",
            "veryfast": "p3",
            "faster": "p3",
            "fast": "p4",
            "medium": "p6",
            "slow": "p6",
            "slower": "p7",
            "veryslow": "p7",
        }.get(preset, preset if preset in _NVENC_PRESETS else "p5")
    return {
        "ultrafast": "speed",
        "superfast": "speed",
        "veryfast": "speed",
        "faster": "speed",
        "fast": "balanced",
        "medium": "balanced",
        "slow": "quality",
        "slower": "quality",
        "veryslow": "quality",
    }.get(preset, preset if preset in _AMF_PRESETS else "balanced")


def _migrate_profile_data(data: dict[str, Any]) -> dict[str, Any]:
    data = dict(data)
    version = data.get("schema_version", 1)
    workflow = data.get("workflow", WORKFLOW_COMPRESSION)
    encoder = data.get("video_encoder", "libx264")
    method = data.get("rate_control_method", RCM_CBR)

    if workflow == WORKFLOW_COMPRESSION:
        data["rate_control"] = RC_TARGET_SIZE
        data["explicit_bitrate"] = 0
        data["rate_control_method"] = RCM_CBR if encoder in _CPU_ENCODERS else RCM_VBR
        data["two_pass"] = bool(data.get("two_pass", True)) and encoder in _CPU_ENCODERS
    else:
        if method == RCM_CQP:
            data["rate_control"] = RC_TARGET_SIZE
        elif encoder in _NVENC_ENCODERS and method == RCM_CRF:
            data["rate_control_method"] = RCM_CQ
            data["cq"] = data.get("cq", data.get("qp", 23))
            data["rate_control"] = RC_TARGET_SIZE
        elif method in (RCM_CBR, RCM_VBR):
            data["rate_control"] = RC_EXPLICIT_BITRATE
        elif encoder in _CPU_ENCODERS:
            data["rate_control_method"] = RCM_CRF
            data["rate_control"] = RC_TARGET_SIZE
        else:
            data["rate_control_method"] = RCM_CQ
            data["rate_control"] = RC_TARGET_SIZE
            data["cq"] = data.get("cq", data.get("qp", 23))
        data["two_pass"] = False

    data["preset"] = _native_preset_for_encoder(data.get("preset", "medium"), encoder)
    if version < PROFILE_SCHEMA_VERSION:
        data["schema_version"] = PROFILE_SCHEMA_VERSION
    return data


_LEGACY_DISCORD_FREE_DEFAULTS: dict[str, Any] = {
    "profile_id": PROFILE_ID_DISCORD_FREE,
    "name": "Discord Free - 10MB",
    "target_size_bytes": 10 * 1024 * 1024,
    "resolution_mode": RES_MODE_SOURCE,
    "max_width": 3840,
    "max_height": 2160,
    "custom_width": 1920,
    "custom_height": 1080,
    "fps_mode": FPS_MODE_SOURCE,
    "max_fps": 30.0,
    "custom_fps": 30.0,
    "rate_control": RC_TARGET_SIZE,
    "explicit_bitrate": 0,
    "scaler": SCALER_NEIGHBOR,
    "audio_bitrate": 128_000,
    "audio_channels": 2,
    "audio_sample_rate": 44100,
    "keep_audio": True,
    "preset": "medium",
    "two_pass": True,
    "video_encoder": "libx264",
    "crf": 23,
    "tune": "",
    "workflow": WORKFLOW_COMPRESSION,
    "rate_control_method": RCM_CBR,
    "cq": 23,
    "qp": 23,
    "transform_intent": None,
}


def _migrate_builtin_profile_defaults(data: dict[str, Any]) -> dict[str, Any]:
    is_untouched_discord_free = all(
        data.get(key) == expected for key, expected in _LEGACY_DISCORD_FREE_DEFAULTS.items()
    )
    if not is_untouched_discord_free:
        return data

    migrated = dict(data)
    migrated["name"] = "Discord Free - 20MB"
    migrated["target_size_bytes"] = DISCORD_FREE_LIMIT
    return migrated


def _validate_profile_dict(data: dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise ValueError("Profile must be a JSON object")
    missing = _PROFILE_REQUIRED - set(data.keys())
    if missing:
        raise ValueError(f"Profile missing required fields: {', '.join(sorted(missing))}")
    unknown = set(data.keys()) - _PROFILE_KNOWN
    if unknown:
        raise ValueError(f"Profile has unknown fields: {', '.join(sorted(unknown))}")

    transform_intent = data.get("transform_intent")
    if transform_intent is not None:
        if not isinstance(transform_intent, dict):
            raise ValueError("transform_intent must be an object or null")
        ProfileTransformIntent.from_dict(transform_intent)

    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Profile name must be a non-empty string")
    if len(name) > 80:
        raise ValueError("Profile name must be 80 characters or fewer")

    pid = data.get("profile_id", "")
    if not isinstance(pid, str) or not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", pid):
        raise ValueError(f"Invalid profile_id {pid!r}: must be lowercase alphanumeric with hyphens")

    tsize = data.get("target_size_bytes", 0)
    if not isinstance(tsize, (int, float)) or isinstance(tsize, bool):
        raise ValueError("target_size_bytes must be a number, not boolean")
    if not math.isfinite(tsize) or tsize < MIN_TARGET_SIZE_BYTES:
        raise ValueError("target_size_bytes must be finite and at least 2 MB")

    for key in ("max_width", "max_height"):
        if key in data:
            val = data[key]
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                raise ValueError(f"{key} must be a finite number, not boolean")
            if not math.isfinite(val) or val < 1:
                raise ValueError(f"{key} must be finite and >= 1")

    for key in ("custom_width", "custom_height"):
        if key in data:
            val = data[key]
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                raise ValueError(f"{key} must be a finite number, not boolean")
            if not math.isfinite(val) or val < 1:
                raise ValueError(f"{key} must be finite and >= 1")

    if "max_fps" in data:
        val = data["max_fps"]
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            raise ValueError("max_fps must be a finite number, not boolean")
        if not math.isfinite(val) or val < 0.1:
            raise ValueError("max_fps must be finite and >= 0.1")

    if "custom_fps" in data:
        val = data["custom_fps"]
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            raise ValueError("custom_fps must be a finite number, not boolean")
        if not math.isfinite(val) or val < 0.1:
            raise ValueError("custom_fps must be finite and >= 0.1")

    abr = data.get("audio_bitrate", 0)
    if isinstance(abr, bool) or not isinstance(abr, (int, float)):
        raise ValueError("audio_bitrate must be a number, not boolean")
    if not math.isfinite(abr) or abr < 0:
        raise ValueError("audio_bitrate must be finite and >= 0")

    ebr = data.get("explicit_bitrate", 0)
    if isinstance(ebr, bool) or not isinstance(ebr, (int, float)):
        raise ValueError("explicit_bitrate must be a number, not boolean")
    if not math.isfinite(ebr):
        raise ValueError("explicit_bitrate must be finite")
    if ebr < 0:
        raise ValueError("explicit_bitrate must be >= 0")

    preset = data.get("preset", "medium")
    if preset not in _VALID_PRESETS:
        raise ValueError(f"preset must be one of {sorted(_VALID_PRESETS)}")

    two_pass = data.get("two_pass", True)
    if not isinstance(two_pass, bool):
        raise ValueError("two_pass must be a boolean")

    if "keep_audio" in data and not isinstance(data["keep_audio"], bool):
        raise ValueError("keep_audio must be a boolean")

    resolution_mode = data.get("resolution_mode", RES_MODE_SOURCE)
    if resolution_mode not in _VALID_RES_MODES:
        raise ValueError(f"resolution_mode must be one of {sorted(_VALID_RES_MODES)}")

    fps_mode = data.get("fps_mode", FPS_MODE_SOURCE)
    if fps_mode not in _VALID_FPS_MODES:
        raise ValueError(f"fps_mode must be one of {sorted(_VALID_FPS_MODES)}")

    rate_control = data.get("rate_control", RC_TARGET_SIZE)
    if rate_control not in _VALID_RC_MODES:
        raise ValueError(f"rate_control must be one of {sorted(_VALID_RC_MODES)}")
    if data.get("workflow", WORKFLOW_COMPRESSION) == WORKFLOW_COMPRESSION and ebr:
        raise ValueError("Compression profiles cannot persist an explicit bitrate")

    scaler = data.get("scaler", SCALER_NEIGHBOR)
    if scaler not in _VALID_SCALERS:
        if scaler == "nearest":
            data["scaler"] = SCALER_NEIGHBOR
        else:
            raise ValueError(f"scaler must be one of {sorted(_VALID_SCALERS)}")

    video_encoder = data.get("video_encoder", "libx264")
    if video_encoder not in _VALID_VIDEO_ENCODER_CHOICES:
        raise ValueError(f"video_encoder must be one of {sorted(_VALID_VIDEO_ENCODER_CHOICES)}")

    crf = data.get("crf", 23)
    if isinstance(crf, bool) or not isinstance(crf, (int, float)):
        raise ValueError("crf must be a number, not boolean")
    if not math.isfinite(float(crf)):
        raise ValueError("crf must be finite")
    crf_int = int(crf)
    if crf_int < 0 or crf_int > 51:
        raise ValueError("crf must be between 0 and 51")

    cq = data.get("cq", data.get("qp", 23))
    if isinstance(cq, bool) or not isinstance(cq, (int, float)):
        raise ValueError("cq must be a number, not boolean")
    if not math.isfinite(float(cq)):
        raise ValueError("cq must be finite")
    cq_int = int(cq)
    if cq_int < 0 or cq_int > 51:
        raise ValueError("cq must be between 0 and 51")

    qp = data.get("qp", 23)
    if isinstance(qp, bool) or not isinstance(qp, (int, float)):
        raise ValueError("qp must be a number, not boolean")
    if not math.isfinite(float(qp)):
        raise ValueError("qp must be finite")
    qp_int = int(qp)
    if qp_int < 0 or qp_int > 51:
        raise ValueError("qp must be between 0 and 51")

    tune = data.get("tune", "")
    if not isinstance(tune, str):
        raise ValueError("tune must be a string")
    _validate_tune_for_encoder(tune, video_encoder)

    workflow = data.get("workflow", WORKFLOW_COMPRESSION)
    if workflow not in _VALID_WORKFLOWS:
        raise ValueError(f"workflow must be one of {sorted(_VALID_WORKFLOWS)}")

    rc_method = data.get("rate_control_method", RCM_CBR)
    if rc_method not in _VALID_RC_METHODS:
        raise ValueError(f"rate_control_method must be one of {sorted(_VALID_RC_METHODS)}")
    _validate_rc_method_for_encoder(rc_method, video_encoder)
    _validate_preset_for_encoder(preset, video_encoder)

    two_pass = data.get("two_pass", True)
    rate_control = data.get("rate_control", RC_TARGET_SIZE)

    new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
        workflow, rate_control, rc_method, video_encoder, two_pass
    )
    if new_rcm != rc_method:
        data["rate_control_method"] = new_rcm
        rc_method = new_rcm
    if new_two_pass != two_pass:
        data["two_pass"] = new_two_pass
        two_pass = new_two_pass

    validate_rate_control_matrix(workflow, rate_control, rc_method, video_encoder, two_pass)

    schema_ver = data.get("schema_version", 1)
    if schema_ver > PROFILE_SCHEMA_VERSION:
        raise ValueError(f"schema_version {schema_ver} > supported {PROFILE_SCHEMA_VERSION}")


AUDIO_OVERHEAD_FACTOR = 0.08


def estimate_size_from_bitrate(
    duration_s: float,
    video_bitrate_bps: int,
    audio_bitrate_bps: int,
) -> int:
    video_bytes = (video_bitrate_bps / 8) * duration_s
    audio_bytes = (audio_bitrate_bps / 8) * duration_s
    overhead = (video_bytes + audio_bytes) * AUDIO_OVERHEAD_FACTOR
    return int(video_bytes + audio_bytes + overhead)


def find_profile_by_id(profiles: list[Profile], profile_id: str) -> Profile | None:
    for p in profiles:
        if p.profile_id == profile_id:
            return p
    return None


def merge_imported_profiles(
    existing: list[Profile],
    imported: list[Profile],
) -> list[Profile]:
    result = list(existing)
    seen: set[str] = {p.profile_id for p in existing if p.profile_id is not None}
    for profile in imported:
        if profile.profile_id is None:
            profile.profile_id = uuid.uuid4().hex[:12]
        if profile.profile_id not in seen:
            result.append(profile)
            seen.add(profile.profile_id)
        else:
            profile.profile_id = uuid.uuid4().hex[:12]
            result.append(profile)
            seen.add(profile.profile_id)
    return result


def _fields_for(cls: type) -> set[str]:
    return {f.name for f in fields(cls)}
