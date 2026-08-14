from __future__ import annotations

from pathlib import Path
from typing import Any

from .models import EncodePlan, Profile, QueueItem, VideoInfo, calculate_transform_geometry


def video_info_dict(info: VideoInfo) -> dict[str, Any]:
    return {
        "path": info.path,
        "duration": info.duration,
        "duration_str": info.duration_str,
        "width": info.width,
        "height": info.height,
        "coded_width": info.coded_width or info.width,
        "coded_height": info.coded_height or info.height,
        "display_rotation": info.display_rotation,
        "resolution": info.resolution_str,
        "fps": round(info.fps, 2),
        "video_codec": info.video_codec,
        "audio_codec": info.audio_codec,
        "audio_channels": info.audio_channels,
        "audio_sample_rate": info.audio_sample_rate,
        "file_size": info.file_size,
        "file_size_mb": round(info.file_size / (1024 * 1024), 2),
        "bitrate_kbps": round(info.bitrate / 1000) if info.bitrate else 0,
        "has_audio": info.has_audio,
    }


def profile_ui_dict(
    profile: Profile,
    *,
    include_explicit_bitrate: bool = False,
) -> dict[str, Any]:
    data = {
        "profile_id": profile.profile_id,
        "name": profile.name,
        "target_size_bytes": profile.target_size_bytes,
        "target_size_mb": round(profile.target_size_bytes / (1024 * 1024), 2),
        "resolution_mode": profile.resolution_mode,
        "max_width": profile.max_width,
        "max_height": profile.max_height,
        "custom_width": profile.custom_width,
        "custom_height": profile.custom_height,
        "fps_mode": profile.fps_mode,
        "max_fps": profile.max_fps,
        "custom_fps": profile.custom_fps,
        "rate_control": profile.rate_control,
        "explicit_bitrate_kbps": (
            round(profile.explicit_bitrate / 1000) if profile.explicit_bitrate else 0
        ),
        "scaler": profile.scaler,
        "audio_bitrate": profile.audio_bitrate,
        "audio_bitrate_kbps": round(profile.audio_bitrate / 1000),
        "keep_audio": profile.keep_audio,
        "two_pass": profile.two_pass,
        "preset": profile.preset,
        "video_encoder": profile.video_encoder,
        "crf": profile.crf,
        "tune": profile.tune,
        "workflow": profile.workflow,
        "rate_control_method": profile.rate_control_method,
        "cq": profile.cq,
        "qp": profile.qp,
        "transform_intent": (
            profile.transform_intent.to_dict() if profile.transform_intent is not None else None
        ),
    }
    if include_explicit_bitrate:
        data["explicit_bitrate"] = profile.explicit_bitrate
    return data


def plan_preview_dict(plan: EncodePlan) -> dict[str, Any]:
    source_info = plan.source_info
    geometry = (
        calculate_transform_geometry(plan.transform, source_info.width, source_info.height)
        if source_info is not None
        else None
    )
    return {
        "source": plan.source,
        "output": plan.output,
        "profile_id": plan.profile_id,
        "target_width": plan.target_width,
        "target_height": plan.target_height,
        "target_fps": round(plan.target_fps, 2),
        "video_bitrate_kbps": round(plan.video_bitrate / 1000),
        "audio_bitrate_kbps": round(plan.audio_bitrate / 1000),
        "copy_audio": plan.copy_audio,
        "estimated_size": plan.estimated_size,
        "estimated_size_mb": round(plan.estimated_size / (1024 * 1024), 2),
        "target_size_mb": round(plan.target_size / (1024 * 1024), 2),
        "two_pass": plan.two_pass,
        "preset": plan.preset,
        "resolution_mode": plan.resolution_mode,
        "fps_mode": plan.fps_mode,
        "rate_control": plan.rate_control,
        "apply_scale": plan.apply_scale,
        "apply_fps_filter": plan.apply_fps_filter,
        "scaler": plan.scaler,
        "video_encoder": plan.video_encoder,
        "crf": plan.crf,
        "tune": plan.tune,
        "explicit_bitrate_kbps": (
            round(plan.explicit_bitrate / 1000) if plan.explicit_bitrate else 0
        ),
        "source_name": Path(plan.source).name,
        "output_name": Path(plan.output).name,
        "workflow": plan.workflow,
        "rate_control_method": plan.rate_control_method,
        "cq": plan.cq,
        "qp": plan.qp,
        "trim_start": round(float(plan.trim_start or 0.0), 3),
        "trim_end": round(float(plan.trim_end or 0.0), 3),
        "trim_duration": round(float(plan.trim_duration), 3),
        "has_trim": plan.has_trim,
        "crop": plan.transform.crop.to_dict() if plan.transform.crop else None,
        "transform": plan.transform.to_dict(),
        "transform_geometry": geometry.to_dict() if geometry is not None else None,
    }


def queue_item_dict(item: QueueItem) -> dict[str, Any]:
    plan = item.plan
    duration = float(plan.trim_duration or 0.0) if plan is not None else 0.0
    if duration <= 0 and plan is not None and plan.source_info is not None:
        duration = float(plan.source_info.duration or 0.0)

    progress_info = item.progress_info.to_dict() if item.progress_info is not None else None
    status = item.status_text or (progress_info["status_text"] if progress_info else "")
    transform = plan.transform if plan is not None else None
    return {
        "id": item.id,
        "source": Path(plan.source).name if plan else "",
        "source_path": plan.source if plan else "",
        "output": Path(plan.output).name if plan else "",
        "state": item.state.value,
        "progress": round(item.progress, 1),
        "progress_info": progress_info,
        "status_text": status,
        "duration": duration,
        "two_pass": bool(plan.two_pass) if plan else False,
        "error": item.error,
        "error_detail": item.error_detail or "",
        "result_path": item.result_path,
        "result_size": item.result_size,
        "result_size_mb": round(item.result_size / (1024 * 1024), 2) if item.result_size else 0,
        "added_at": item.added_at,
        "started_at": item.started_at,
        "finished_at": item.finished_at,
        "trim_start": float(plan.trim_start) if plan else 0.0,
        "trim_end": float(plan.trim_end) if plan else 0.0,
        "has_trim": bool(plan.has_trim) if plan else False,
        "crop": transform.crop.to_dict() if transform is not None and transform.crop else None,
        "transform": transform.to_dict() if transform is not None else None,
    }
