from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace

from ..models import (
    SIZING_MODE_STRETCH,
    CropRect,
    EncodePlan,
    OutputGeometry,
    TransformGeometry,
    VideoTransform,
    calculate_transform_geometry,
)

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


def build_rotation_filters(rotation: int) -> list[str]:
    if rotation == 90:
        return ["transpose=clock"]
    if rotation == 180:
        return ["hflip", "vflip"]
    if rotation == 270:
        return ["transpose=cclock"]
    return []


def build_transform_filters(
    transform: VideoTransform,
    geometry: TransformGeometry,
    *,
    scaler: str = "neighbor",
    force_scale: bool = False,
) -> list[str]:
    filters: list[str] = []
    if transform.crop is not None:
        filters.append(build_crop_filter(transform.crop))
    filters.extend(build_rotation_filters(transform.rotation))
    if transform.flip_horizontal:
        filters.append("hflip")
    if transform.flip_vertical:
        filters.append("vflip")
    if geometry.fill_crop is not None:
        filters.append(build_crop_filter(geometry.fill_crop))
    if geometry.requires_scale or force_scale:
        filters.append(
            f"scale={geometry.output_width}:{geometry.output_height}:"
            f"flags={scaler_to_ffmpeg_flag(scaler)}"
        )
        if transform.sizing_mode == SIZING_MODE_STRETCH:
            filters.append("setsar=1")
    return filters


def build_video_filters(
    *,
    transform: VideoTransform | None = None,
    geometry: TransformGeometry | None = None,
    source_width: int = 0,
    source_height: int = 0,
    crop: CropRect | None = None,
    scale_width: int = 0,
    scale_height: int = 0,
    scaler: str = "neighbor",
    frame_rate: float = 0.0,
) -> list[str]:
    if transform is None:
        filters: list[str] = []
        if crop is not None:
            filters.append(build_crop_filter(crop))
        if scale_width > 0 and scale_height > 0:
            filters.append(
                f"scale={scale_width}:{scale_height}:flags={scaler_to_ffmpeg_flag(scaler)}"
            )
    else:
        effective_transform = transform
        force_scale = False
        if effective_transform.output is None and scale_width > 0 and scale_height > 0:
            force_scale = True
            effective_transform = replace(
                effective_transform,
                output=OutputGeometry(scale_width, scale_height),
            )
        if geometry is None:
            if source_width <= 0 or source_height <= 0:
                if effective_transform.output is not None:
                    raise ValueError("source dimensions are required for transform filters")
                geometry = TransformGeometry(2, 2, 2, 2, None, 2, 2)
            else:
                geometry = calculate_transform_geometry(
                    effective_transform,
                    source_width,
                    source_height,
                )
        filters = build_transform_filters(
            effective_transform,
            geometry,
            scaler=scaler,
            force_scale=force_scale,
        )
    if frame_rate > 0:
        filters.append(f"fps={frame_rate}")
    return filters


def join_video_filters(filters: Iterable[str]) -> str:
    return ",".join(filters)


def build_plan_video_filters(plan: EncodePlan) -> list[str]:
    crop = plan.transform.crop
    source_width = plan.source_info.width if plan.source_info is not None else 0
    source_height = plan.source_info.height if plan.source_info is not None else 0
    if crop is not None:
        source_width = max(source_width, crop.x + crop.width)
        source_height = max(source_height, crop.y + crop.height)
    if source_width <= 0:
        source_width = plan.target_width
    if source_height <= 0:
        source_height = plan.target_height
    return build_video_filters(
        transform=plan.transform,
        source_width=source_width,
        source_height=source_height,
        scale_width=plan.target_width if plan.apply_scale else 0,
        scale_height=plan.target_height if plan.apply_scale else 0,
        scaler=plan.scaler,
        frame_rate=plan.target_fps if plan.apply_fps_filter else 0.0,
    )
