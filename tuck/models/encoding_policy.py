from __future__ import annotations

from ..desktop_platform import is_linux_desktop

RES_MODE_SOURCE = "source"
RES_MODE_LIMIT = "limit"
RES_MODE_CUSTOM = "custom"
# sizes the shorter side, so a vertical video stays vertical (1440 means 2560x1440 or 1440x2560)
RES_MODE_SHORT_SIDE = "short_side"
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


def short_side_name(short_side: int) -> str:
    return "4K" if short_side == 2160 else f"{short_side}p"


VALID_RES_MODES = frozenset({RES_MODE_SOURCE, RES_MODE_LIMIT, RES_MODE_CUSTOM, RES_MODE_SHORT_SIDE})
VALID_FPS_MODES = frozenset({FPS_MODE_SOURCE, FPS_MODE_LIMIT, FPS_MODE_CUSTOM})
VALID_RC_MODES = frozenset({RC_TARGET_SIZE, RC_EXPLICIT_BITRATE})
VALID_WORKFLOWS = frozenset({WORKFLOW_COMPRESSION, WORKFLOW_UPSCALE})
VALID_RC_METHODS = frozenset({RCM_CRF, RCM_CQP, RCM_CQ, RCM_CBR, RCM_VBR})
VALID_SCALERS = frozenset(
    {SCALER_BILINEAR, SCALER_BICUBIC, SCALER_LANCZOS, SCALER_NEIGHBOR, SCALER_POINT}
)
# Tuck offers two kinds of scaling, Smooth (lanczos) and Sharp pixels (neighbor); older
# profiles, settings and commands may still name one of the other filters
_SMOOTH_SCALERS = frozenset({SCALER_BILINEAR, SCALER_BICUBIC, SCALER_LANCZOS})
_SHARP_SCALERS = frozenset({SCALER_NEIGHBOR, SCALER_POINT, "nearest"})


def normalize_scaler(value: object) -> str:
    """Maps any accepted scaler name to lanczos or neighbor; raises ValueError otherwise."""
    if isinstance(value, str) and value in _SMOOTH_SCALERS:
        return SCALER_LANCZOS
    if isinstance(value, str) and value in _SHARP_SCALERS:
        return SCALER_NEIGHBOR
    raise ValueError(f"scaler must be one of {sorted(VALID_SCALERS)}")


ENCODER_AUTO = "auto"
ENCODER_AUTO_COMPRESSION = "auto_compression"
ENCODER_AUTO_FAST = "auto_fast"
AUTO_ENCODERS: frozenset[str] = frozenset(
    {ENCODER_AUTO, ENCODER_AUTO_COMPRESSION, ENCODER_AUTO_FAST}
)
VALID_VIDEO_ENCODERS: frozenset[str] = frozenset(
    {
        "libx264",
        "libx265",
        "h264_nvenc",
        "hevc_nvenc",
        "h264_amf",
        "hevc_amf",
        "h264_vaapi",
        "hevc_vaapi",
    }
)
VALID_VIDEO_ENCODER_CHOICES: frozenset[str] = VALID_VIDEO_ENCODERS | AUTO_ENCODERS
CPU_ENCODERS: frozenset[str] = frozenset({"libx264", "libx265"})
NVENC_ENCODERS: frozenset[str] = frozenset({"h264_nvenc", "hevc_nvenc"})
AMF_ENCODERS: frozenset[str] = frozenset({"h264_amf", "hevc_amf"})
VAAPI_ENCODERS: frozenset[str] = frozenset({"h264_vaapi", "hevc_vaapi"})
HEVC_ENCODERS: frozenset[str] = frozenset({"libx265", "hevc_nvenc", "hevc_amf", "hevc_vaapi"})


def validate_ten_bit_for_encoder(ten_bit: bool, video_encoder: str) -> None:
    # almost nothing plays 10-bit H.264, and Auto always starts on H.264
    if ten_bit and video_encoder not in HEVC_ENCODERS:
        raise ValueError("10-bit color needs an H.265 encoder.")


# AMF and VAAPI keep a quality level with constant QP, which has no peak. Intel's capped modes
# drop the quality level instead: QVBR spends the whole cap (20 Mbps where QP 30 needs 7.7) and
# ICQ ignores the cap (measured 5 Nov on the laptop's Arrow Lake)
CAPPABLE_QUALITY_ENCODERS: frozenset[str] = CPU_ENCODERS | NVENC_ENCODERS


def validate_bitrate_cap_for_encoder(bitrate_cap: int, video_encoder: str) -> None:
    if bitrate_cap and video_encoder in AMF_ENCODERS | VAAPI_ENCODERS:
        raise ValueError(
            "Only software and NVIDIA encoders can cap a Quality export's bitrate. "
            "Choose one of them or clear Max bitrate."
        )


def validate_encoder_supported_on_desktop(video_encoder: str) -> None:
    if video_encoder in VAAPI_ENCODERS and not is_linux_desktop():
        raise ValueError(f"Hardware encoder '{video_encoder}' is only supported on Linux.")
    if is_linux_desktop() and video_encoder in AMF_ENCODERS:
        raise ValueError(
            f"Hardware encoder '{video_encoder}' is not supported on Linux. "
            "Choose libx264, libx265, or Auto."
        )


X264_TUNES: frozenset[str] = frozenset(
    {"", "film", "animation", "grain", "stillimage", "psnr", "ssim", "fastdecode", "zerolatency"}
)
X265_TUNES: frozenset[str] = frozenset(
    {"", "psnr", "ssim", "grain", "zerolatency", "fastdecode", "animation"}
)
ALL_TUNES: frozenset[str] = X264_TUNES | X265_TUNES

QUALITY_RC_METHODS: frozenset[str] = frozenset({RCM_CRF, RCM_CQ, RCM_CQP})
# the first profile schema that can hold Compress's Quality goal
SCHEMA_COMPRESSION_QUALITY = 7
BITRATE_RC_METHODS: frozenset[str] = frozenset({RCM_CBR, RCM_VBR})

X26X_PRESETS = frozenset(
    {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}
)
NVENC_PRESETS = frozenset({"p1", "p2", "p3", "p4", "p5", "p6", "p7"})
AMF_PRESETS = frozenset({"speed", "balanced", "quality"})
VALID_PRESETS = X26X_PRESETS | NVENC_PRESETS | AMF_PRESETS


def validate_tune_for_encoder(tune: str, video_encoder: str | None) -> None:
    if tune not in ALL_TUNES:
        raise ValueError(f"tune must be one of {sorted(ALL_TUNES)}")
    if not tune:
        return
    if video_encoder == "libx265" and tune not in X265_TUNES:
        raise ValueError(f"tune '{tune}' is not compatible with libx265")
    if video_encoder == "libx264" and tune not in X264_TUNES:
        raise ValueError(f"tune '{tune}' is not compatible with libx264")


def validate_rc_method_for_encoder(rc_method: str, video_encoder: str) -> None:
    if rc_method not in VALID_RC_METHODS:
        raise ValueError(f"rate_control_method must be one of {sorted(VALID_RC_METHODS)}")
    if video_encoder in AUTO_ENCODERS:
        return
    if video_encoder not in VALID_VIDEO_ENCODERS:
        raise ValueError(
            f"rate_control_method: unknown video_encoder '{video_encoder}'; "
            f"must be one of {sorted(VALID_VIDEO_ENCODER_CHOICES)}"
        )
    if video_encoder in CPU_ENCODERS:
        if rc_method not in (RCM_CRF, RCM_CBR):
            raise ValueError(
                f"rate_control_method '{rc_method}' not supported for {video_encoder}; "
                "use crf or cbr"
            )
    elif video_encoder in NVENC_ENCODERS | AMF_ENCODERS | VAAPI_ENCODERS and rc_method not in (
        RCM_CQ,
        RCM_CQP,
        RCM_CBR,
        RCM_VBR,
    ):
        raise ValueError(
            f"rate_control_method '{rc_method}' not supported for {video_encoder}; "
            "use cq, cbr, or vbr"
        )


def validate_rate_control_matrix(
    workflow: str,
    rate_control: str,
    rate_control_method: str,
    video_encoder: str,
    two_pass: bool,
) -> None:
    is_compression = workflow == WORKFLOW_COMPRESSION
    is_upscale = workflow == WORKFLOW_UPSCALE
    is_quality_method = rate_control_method in QUALITY_RC_METHODS
    is_bitrate_method = rate_control_method in BITRATE_RC_METHODS
    is_auto = video_encoder in AUTO_ENCODERS
    is_cpu = video_encoder in CPU_ENCODERS or is_auto

    # a quality method is Compress's Quality goal; the bitrate methods are its Size goal
    if is_compression and rate_control != RC_TARGET_SIZE:
        raise ValueError("Compression workflow requires rate_control 'target_size'.")

    if is_upscale:
        if is_bitrate_method and rate_control != RC_EXPLICIT_BITRATE:
            raise ValueError(
                "Upscale workflow with CBR/VBR requires rate_control 'explicit_bitrate'."
            )
        if is_quality_method and rate_control != RC_TARGET_SIZE:
            raise ValueError("Upscale CRF or constant quality requires rate_control 'target_size'.")
        if (
            video_encoder in CPU_ENCODERS
            and rate_control_method != RCM_CRF
            and not is_bitrate_method
        ):
            raise ValueError("Software Upscale requires CRF or an explicit bitrate method.")
        if (
            not is_auto
            and video_encoder in NVENC_ENCODERS | AMF_ENCODERS | VAAPI_ENCODERS
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
                "Two-pass encoding is only available for CPU encoders "
                f"(libx264/libx265), not '{video_encoder}'."
            )
        if not is_bitrate_method:
            raise ValueError(
                "Two-pass encoding requires a bitrate-driven rate-control method "
                f"(CBR for CPU), not '{rate_control_method}'."
            )


def quality_method_for_encoder(video_encoder: str) -> str:
    """The quality level an encoder takes: CRF in software, CQ on a GPU.

    Auto choices that try the GPU first take CQ; the runner turns it into CRF when they fall back
    to the CPU, and back the other way.
    """
    if video_encoder in CPU_ENCODERS or video_encoder == ENCODER_AUTO_COMPRESSION:
        return RCM_CRF
    return RCM_CQ


def stored_rate_control_method(workflow: str, rate_control_method: str, schema_version: int) -> str:
    """The method a stored profile means, given the version that saved it.

    Before schema 7 a compression profile's CRF or CQP still meant its target size, and Tuck
    read it as CBR. Only Tuck 0.7.1 and later save a quality method for compression, as the
    Quality goal, and they write schema 7 or newer.
    """
    if (
        workflow == WORKFLOW_COMPRESSION
        and rate_control_method in QUALITY_RC_METHODS
        and schema_version < SCHEMA_COMPRESSION_QUALITY
    ):
        return RCM_CBR
    return rate_control_method


def normalize_legacy_rc_matrix(
    workflow: str,
    rate_control: str,
    rate_control_method: str,
    video_encoder: str,
    two_pass: bool,
) -> tuple[str, bool]:
    is_compression = workflow == WORKFLOW_COMPRESSION
    is_upscale = workflow == WORKFLOW_UPSCALE
    is_quality_method = rate_control_method in QUALITY_RC_METHODS
    is_cpu = video_encoder in CPU_ENCODERS

    new_rcm = rate_control_method
    new_two_pass = two_pass

    if is_compression and not is_quality_method:
        new_rcm = RCM_CBR
        new_two_pass = new_two_pass and is_cpu

    if is_upscale and not is_quality_method and rate_control == RC_TARGET_SIZE:
        new_rcm = RCM_CRF if is_cpu else RCM_CQ

    if new_two_pass and (
        workflow != WORKFLOW_COMPRESSION or not is_cpu or new_rcm not in BITRATE_RC_METHODS
    ):
        new_two_pass = False

    return new_rcm, new_two_pass


def size_target_rate_control_method(workflow: str, rate_control_method: str) -> str:
    """Compression always encodes to its size budget with capped VBR.

    Profiles keep saying "cbr" for compression so older versions can still read them; the plan
    is where it becomes VBR. Strict CBR pads simple scenes and starves busy ones for no size
    benefit, because the size budget, not a constant bitrate, is what the export has to meet.
    """
    if workflow == WORKFLOW_COMPRESSION and rate_control_method in BITRATE_RC_METHODS:
        return RCM_VBR
    return rate_control_method


def validate_preset_for_encoder(preset: str, video_encoder: str) -> None:
    if video_encoder in AUTO_ENCODERS:
        if preset not in VALID_PRESETS:
            raise ValueError(f"preset must be one of {sorted(VALID_PRESETS)}")
        return
    valid = (
        X26X_PRESETS
        if video_encoder in CPU_ENCODERS
        else (NVENC_PRESETS if video_encoder in NVENC_ENCODERS else AMF_PRESETS)
    )
    if preset not in valid:
        raise ValueError(f"preset must be one of {sorted(valid)} for {video_encoder}")


def native_preset_for_encoder(preset: str, video_encoder: str) -> str:
    if video_encoder in AUTO_ENCODERS:
        return preset if preset in VALID_PRESETS else "medium"
    if video_encoder in CPU_ENCODERS:
        return preset if preset in X26X_PRESETS else "medium"
    if video_encoder in NVENC_ENCODERS:
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
        }.get(preset, preset if preset in NVENC_PRESETS else "p5")
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
    }.get(preset, preset if preset in AMF_PRESETS else "balanced")
