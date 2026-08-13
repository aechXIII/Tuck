from __future__ import annotations

from pathlib import Path
from typing import Any

from .models import EncodePlan, QueueItem, calculate_transform_geometry


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
