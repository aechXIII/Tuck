from __future__ import annotations

from collections.abc import Iterable

from ..models import CropRect

_SCALER_TO_FFMPEG: dict[str, str] = {
    "bilinear": "bilinear",
    "bicubic": "bicubic",
    "lanczos": "lanczos",
    "nearest": "neighbor",
    "point": "neighbor",
}


def scaler_to_ffmpeg_flag(scaler: str) -> str:
    return _SCALER_TO_FFMPEG.get(scaler, "neighbor")


def build_crop_filter(crop: CropRect) -> str:
    return f"crop={crop.width}:{crop.height}:{crop.x}:{crop.y}:exact=1"


def build_video_filters(
    *,
    crop: CropRect | None = None,
    scale_width: int = 0,
    scale_height: int = 0,
    scaler: str = "neighbor",
    frame_rate: float = 0.0,
) -> list[str]:
    filters: list[str] = []
    if crop is not None:
        filters.append(build_crop_filter(crop))
    if scale_width > 0 and scale_height > 0:
        filters.append(f"scale={scale_width}:{scale_height}:flags={scaler_to_ffmpeg_flag(scaler)}")
    if frame_rate > 0:
        filters.append(f"fps={frame_rate}")
    return filters


def join_video_filters(filters: Iterable[str]) -> str:
    return ",".join(filters)
