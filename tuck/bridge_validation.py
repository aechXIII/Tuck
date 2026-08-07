from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .models import (
    _VALID_RC_METHODS,
    _VALID_SCALERS,
    _VALID_VIDEO_ENCODERS,
    _VALID_WORKFLOWS,
    RC_TARGET_SIZE,
    WORKFLOW_COMPRESSION,
    PlanRequest,
    _validate_preset_for_encoder,
    _validate_rc_method_for_encoder,
    _validate_tune_for_encoder,
    validate_rate_control_matrix,
)

VIDEO_EXTENSIONS = frozenset({".mp4", ".mkv", ".webm", ".mov", ".avi", ".wmv", ".flv", ".m4v"})


def validate_path(path: str) -> str:
    if not path or not isinstance(path, str):
        raise ValueError("Invalid path: empty or not a string")
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    return str(p.resolve())


def validate_video_paths(paths: Sequence[object]) -> tuple[list[str], list[str]]:
    accepted: list[str] = []
    rejected: list[str] = []
    seen: set[str] = set()
    for raw_path in paths:
        if not isinstance(raw_path, str) or not raw_path:
            rejected.append("Invalid file path")
            continue
        try:
            path = validate_path(raw_path)
        except (ValueError, FileNotFoundError):
            rejected.append(raw_path)
            continue
        if Path(path).suffix.lower() not in VIDEO_EXTENSIONS:
            rejected.append(raw_path)
            continue
        if path not in seen:
            seen.add(path)
            accepted.append(path)
    return accepted, rejected


def _opt_str(raw: dict[str, Any], key: str) -> str | None:
    if key in raw:
        val = raw[key]
        if val is None:
            return None
        if not isinstance(val, str):
            raise ValueError(f"{key} must be a string, not {type(val).__name__}")
        return val
    return None


def _opt_int(raw: dict[str, Any], key: str) -> int | None:
    if key in raw:
        val = raw[key]
        if val is None:
            return None
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            raise ValueError(f"{key} must be a number, not {type(val).__name__}")
        if not math.isfinite(float(val)):
            raise ValueError(f"{key} must be a finite number")
        if isinstance(val, float) and not float(val).is_integer():
            raise ValueError(f"{key} must be an integer, not a fractional float")
        return int(val)
    return None


def _opt_float(raw: dict[str, Any], key: str) -> float | None:
    if key in raw:
        val = raw[key]
        if val is None:
            return None
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            raise ValueError(f"{key} must be a number, not {type(val).__name__}")
        if not math.isfinite(float(val)):
            raise ValueError(f"{key} must be a finite number")
        return float(val)
    return None


def _opt_bool(raw: dict[str, Any], key: str) -> bool | None:
    if key in raw:
        val = raw[key]
        if val is None:
            return None
        if not isinstance(val, bool):
            raise ValueError(f"{key} must be a boolean, not {type(val).__name__}")
        return val
    return None


def parse_plan_request(
    raw: dict[str, Any],
    validate_path_fn: Callable[[str], str],
) -> PlanRequest:
    source = raw.get("source", "")
    if not source or not isinstance(source, str):
        raise ValueError("source must be a non-empty string")
    source = validate_path_fn(source)

    req = PlanRequest(
        source=source,
        profile_id=_opt_str(raw, "profile_id") or "",
        target_size_bytes=_opt_int(raw, "target_size_bytes"),
        resolution_mode=_opt_str(raw, "resolution_mode"),
        custom_width=_opt_int(raw, "custom_width"),
        custom_height=_opt_int(raw, "custom_height"),
        fps_mode=_opt_str(raw, "fps_mode"),
        custom_fps=_opt_float(raw, "custom_fps"),
        rate_control=_opt_str(raw, "rate_control"),
        explicit_bitrate=_opt_int(raw, "explicit_bitrate"),
        audio_bitrate=_opt_int(raw, "audio_bitrate"),
        keep_audio=_opt_bool(raw, "keep_audio"),
        scaler=_opt_str(raw, "scaler"),
        video_encoder=_opt_str(raw, "video_encoder"),
        crf=_opt_int(raw, "crf"),
        cq=_opt_int(raw, "cq"),
        tune=_opt_str(raw, "tune"),
        two_pass=_opt_bool(raw, "two_pass"),
        preset=_opt_str(raw, "preset"),
        workflow=_opt_str(raw, "workflow"),
        rate_control_method=_opt_str(raw, "rate_control_method"),
        qp=_opt_int(raw, "qp"),
    )
    req.validate()
    return req


_UI_TO_SCHEMA: dict[str, str] = {
    "target_size_mb": "target_size_bytes",
    "audio_bitrate_kbps": "audio_bitrate",
    "explicit_bitrate_kbps": "explicit_bitrate",
}


def normalize_profile_ui_payload(data: dict[str, Any]) -> dict[str, Any]:
    data = dict(data)
    for ui_name, schema_name in _UI_TO_SCHEMA.items():
        if ui_name in data and schema_name not in data:
            raw = data.pop(ui_name)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise ValueError(f"{ui_name} must be a number, not {type(raw).__name__}")
            if not math.isfinite(float(raw)):
                raise ValueError(f"{ui_name} must be a finite number")
            if isinstance(raw, float) and not raw.is_integer():
                raise ValueError(f"{ui_name} must be an integer, not a fractional float")
            try:
                if schema_name == "target_size_bytes":
                    data["target_size_bytes"] = int(float(raw) * 1024 * 1024)
                elif schema_name == "audio_bitrate":
                    data["audio_bitrate"] = int(raw) * 1000
                elif schema_name == "explicit_bitrate":
                    data["explicit_bitrate"] = int(raw) * 1000
            except (ValueError, TypeError) as e:
                raise ValueError(f"Invalid value for {ui_name}: {raw!r}") from e

    if "two_pass" in data and not isinstance(data["two_pass"], bool):
        raise ValueError(f"two_pass must be a boolean, not {type(data['two_pass']).__name__}")

    if "keep_audio" in data and not isinstance(data["keep_audio"], bool):
        raise ValueError(f"keep_audio must be a boolean, not {type(data['keep_audio']).__name__}")

    if "video_encoder" in data:
        ve = data["video_encoder"]
        if not isinstance(ve, str) or ve not in _VALID_VIDEO_ENCODERS:
            raise ValueError(
                f"video_encoder must be one of {sorted(_VALID_VIDEO_ENCODERS)}, not {ve!r}"
            )

    if "crf" in data:
        crf = data["crf"]
        if isinstance(crf, bool) or not isinstance(crf, (int, float)):
            raise ValueError(f"crf must be a number, not {type(crf).__name__}")
        if not math.isfinite(float(crf)):
            raise ValueError("crf must be finite")
        crf_int = int(crf)
        if crf_int < 0 or crf_int > 51:
            raise ValueError("crf must be between 0 and 51")

    for key in ("cq", "qp"):
        if key in data:
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} must be a number, not {type(value).__name__}")
            if not math.isfinite(float(value)):
                raise ValueError(f"{key} must be finite")
            value_int = int(value)
            if value_int < 0 or value_int > 51:
                raise ValueError(f"{key} must be between 0 and 51")

    if "tune" in data:
        tune = data["tune"]
        if not isinstance(tune, str):
            raise ValueError(f"tune must be a string, not {type(tune).__name__}")
        video_encoder = data.get("video_encoder")
        _validate_tune_for_encoder(tune, video_encoder)

    if "scaler" in data:
        scaler = data["scaler"]
        if not isinstance(scaler, str):
            raise ValueError(f"scaler must be a string, not {type(scaler).__name__}")
        if scaler == "nearest":
            data["scaler"] = "neighbor"
        elif scaler not in _VALID_SCALERS:
            raise ValueError(f"scaler must be one of {sorted(_VALID_SCALERS)}")

    if "workflow" in data:
        wf = data["workflow"]
        if not isinstance(wf, str) or wf not in _VALID_WORKFLOWS:
            raise ValueError(f"workflow must be one of {sorted(_VALID_WORKFLOWS)}")

    if "rate_control_method" in data:
        rcm = data["rate_control_method"]
        if not isinstance(rcm, str) or rcm not in _VALID_RC_METHODS:
            raise ValueError(f"rate_control_method must be one of {sorted(_VALID_RC_METHODS)}")
        video_encoder = data.get("video_encoder", "libx264")
        _validate_rc_method_for_encoder(rcm, video_encoder)

    if "preset" in data:
        preset = data["preset"]
        if not isinstance(preset, str):
            raise ValueError("preset must be a string")
        _validate_preset_for_encoder(preset, data.get("video_encoder", "libx264"))

    workflow = data.get("workflow", WORKFLOW_COMPRESSION)
    if workflow == WORKFLOW_COMPRESSION and "explicit_bitrate" in data:
        raise ValueError("Compression profiles cannot persist an explicit bitrate")
    rate_control = data.get("rate_control", RC_TARGET_SIZE)
    rc_method = data.get("rate_control_method", "cbr")
    video_encoder = data.get("video_encoder", "libx264")
    two_pass = bool(data.get("two_pass", True))
    validate_rate_control_matrix(workflow, rate_control, rc_method, video_encoder, two_pass)

    return data
