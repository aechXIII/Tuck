from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from pathlib import Path

from ..models import (
    SIZING_MODE_STRETCH,
    CropRect,
    EncodePlan,
    OutputGeometry,
    TransformGeometry,
    VideoInfo,
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


_ZSCALE_MATRICES = frozenset({"bt2020nc", "bt2020c", "bt709"})
_ZSCALE_PRIMARIES = frozenset({"bt2020", "bt709", "smpte432", "smpte431"})


def hdr_to_sdr_filters(info: VideoInfo) -> list[str]:
    """Tone-map a PQ or HLG picture to BT.709 SDR.

    The input colours are named rather than read from the frames, because many HDR files leave
    the primaries or matrix untagged and zscale refuses a conversion it can't place. HDR video
    is BT.2020 almost without exception, so that is the fallback.
    """
    primaries = info.color_primaries if info.color_primaries in _ZSCALE_PRIMARIES else "bt2020"
    matrix = info.color_space if info.color_space in _ZSCALE_MATRICES else "bt2020nc"
    color_range = "pc" if info.color_range == "pc" else "tv"
    return [
        # 100 nits is the SDR reference white the highlights are compressed toward; the output
        # primaries are named too, since zscale reads them from the frame and an untagged frame
        # leaves it with no path to linear light
        f"zscale=tin={info.color_transfer}:pin={primaries}:min={matrix}:rin={color_range}"
        f":t=linear:npl=100:p={primaries}",
        "format=gbrpf32le",
        "zscale=p=bt709",
        # hable keeps midtones close to the source; desat=0 stops bright colours from being
        # pulled toward grey, which the default does strongly
        "tonemap=tonemap=hable:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
        "format=yuv420p",
    ]


def join_video_filters(filters: Iterable[str]) -> str:
    return ",".join(filters)


def build_plan_video_filters(
    plan: EncodePlan, *, geometry: TransformGeometry | None = None
) -> list[str]:
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
    filters = build_video_filters(
        transform=plan.transform,
        geometry=geometry,
        source_width=source_width,
        source_height=source_height,
        scale_width=plan.target_width if plan.apply_scale else 0,
        scale_height=plan.target_height if plan.apply_scale else 0,
        scaler=plan.scaler,
        frame_rate=plan.target_fps if plan.apply_fps_filter else 0.0,
    )

    if plan.tone_map_hdr and plan.source_info is not None:
        # after scaling and frame rate changes so the float conversion handles fewer pixels,
        # and before the LUT, which expects an SDR picture
        filters.extend(hdr_to_sdr_filters(plan.source_info))

    if plan.lut.enabled and plan.lut.strength > 0:
        if not plan.lut_filter_path:
            raise ValueError("LUT snapshot is missing. Create the export again")
        # FFmpeg parses option escaping after filter graph escaping
        path = Path(plan.lut_filter_path).as_posix()
        path = "".join("\\" + char if char in "\\':" else char for char in path)
        path = "".join("\\" + char if char in "\\'[],;" else char for char in path)
        filters.append(f"lut3d=file={path}:interp=trilinear")
    return filters
