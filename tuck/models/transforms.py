from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

CROP_ALIGNMENT = 2
CROP_ASPECT_FREE = "free"
CROP_ASPECT_16_9 = "16:9"
CROP_ASPECT_9_16 = "9:16"
CROP_ASPECT_1_1 = "1:1"
CROP_ASPECT_4_3 = "4:3"
CROP_ASPECT_RATIOS: dict[str, tuple[int, int] | None] = {
    CROP_ASPECT_FREE: None,
    CROP_ASPECT_16_9: (16, 9),
    CROP_ASPECT_9_16: (9, 16),
    CROP_ASPECT_1_1: (1, 1),
    CROP_ASPECT_4_3: (4, 3),
}
SIZING_MODE_FIT = "fit"
SIZING_MODE_FILL = "fill"
SIZING_MODE_STRETCH = "stretch"
SIZING_MODES = frozenset({SIZING_MODE_FIT, SIZING_MODE_FILL, SIZING_MODE_STRETCH})
ROTATIONS = frozenset({0, 90, 180, 270})


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _optional_bool(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean")
    return value


def _even_floor(value: float) -> int:
    return max(2, math.floor(value / 2) * 2)


def _even_nearest(value: float, maximum: int) -> int:
    return max(2, min(round(value / 2) * 2, math.floor(maximum / 2) * 2))


@dataclass(frozen=True)
class CropRect:
    x: int
    y: int
    width: int
    height: int

    def __post_init__(self) -> None:
        if isinstance(self.x, bool) or not isinstance(self.x, int) or self.x < 0:
            raise ValueError("crop x must be a non-negative integer")
        if isinstance(self.y, bool) or not isinstance(self.y, int) or self.y < 0:
            raise ValueError("crop y must be a non-negative integer")
        _positive_int(self.width, "crop width")
        _positive_int(self.height, "crop height")

    def validate_for_source(
        self,
        source_width: int,
        source_height: int,
        *,
        alignment: int = CROP_ALIGNMENT,
    ) -> None:
        _positive_int(source_width, "source width")
        _positive_int(source_height, "source height")
        if self.x + self.width > source_width or self.y + self.height > source_height:
            raise ValueError("crop must remain inside source dimensions")
        if alignment > 1 and any(value % alignment for value in (self.width, self.height)):
            raise ValueError(
                f"crop width and height must be divisible by {alignment} for yuv420p output"
            )

    def to_dict(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CropRect:
        unexpected = set(data) - {"x", "y", "width", "height"}
        if unexpected:
            raise ValueError(f"crop contains unsupported fields: {sorted(unexpected)}")
        try:
            return cls(x=data["x"], y=data["y"], width=data["width"], height=data["height"])
        except KeyError as exc:
            raise ValueError(f"crop is missing required field: {exc.args[0]}") from exc


@dataclass(frozen=True)
class OutputGeometry:
    width: int
    height: int

    def __post_init__(self) -> None:
        _positive_int(self.width, "output width")
        _positive_int(self.height, "output height")
        if self.width < 2:
            raise ValueError("output width must be at least 2")
        if self.height < 2:
            raise ValueError("output height must be at least 2")

    def to_dict(self) -> dict[str, int]:
        return {"width": self.width, "height": self.height}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> OutputGeometry:
        unexpected = set(data) - {"width", "height"}
        if unexpected:
            raise ValueError(f"output contains unsupported fields: {sorted(unexpected)}")
        try:
            return cls(width=data["width"], height=data["height"])
        except KeyError as exc:
            raise ValueError(f"output is missing required field: {exc.args[0]}") from exc


@dataclass(frozen=True)
class ProfileTransformIntent:
    crop_aspect: str = CROP_ASPECT_FREE
    rotation: int = 0
    sizing_mode: str = SIZING_MODE_FIT

    def __post_init__(self) -> None:
        if not isinstance(self.crop_aspect, str) or self.crop_aspect not in CROP_ASPECT_RATIOS:
            raise ValueError(f"crop_aspect must be one of {sorted(CROP_ASPECT_RATIOS)}")
        if (
            isinstance(self.rotation, bool)
            or not isinstance(self.rotation, int)
            or self.rotation not in ROTATIONS
        ):
            raise ValueError("rotation must be one of 0, 90, 180, or 270")
        if not isinstance(self.sizing_mode, str) or self.sizing_mode not in SIZING_MODES:
            raise ValueError(f"sizing_mode must be one of {sorted(SIZING_MODES)}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "crop_aspect": self.crop_aspect,
            "rotation": self.rotation,
            "sizing_mode": self.sizing_mode,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProfileTransformIntent:
        expected = {"crop_aspect", "rotation", "sizing_mode"}
        unexpected = set(data) - expected
        if unexpected:
            raise ValueError(f"transform_intent contains unsupported fields: {sorted(unexpected)}")
        return cls(
            crop_aspect=data.get("crop_aspect", CROP_ASPECT_FREE),
            rotation=data.get("rotation", 0),
            sizing_mode=data.get("sizing_mode", SIZING_MODE_FIT),
        )


@dataclass(frozen=True)
class VideoTransform:
    crop: CropRect | None = None
    crop_aspect: str = CROP_ASPECT_FREE
    rotation: int = 0
    flip_horizontal: bool = False
    flip_vertical: bool = False
    sizing_mode: str = SIZING_MODE_STRETCH
    output: OutputGeometry | None = None

    def __post_init__(self) -> None:
        if self.crop is not None and not isinstance(self.crop, CropRect):
            raise ValueError("crop must be a CropRect or None")
        if not isinstance(self.crop_aspect, str) or self.crop_aspect not in CROP_ASPECT_RATIOS:
            raise ValueError(f"crop_aspect must be one of {sorted(CROP_ASPECT_RATIOS)}")
        if (
            isinstance(self.rotation, bool)
            or not isinstance(self.rotation, int)
            or self.rotation not in ROTATIONS
        ):
            raise ValueError("rotation must be one of 0, 90, 180, or 270")
        _optional_bool(self.flip_horizontal, "flip_horizontal")
        _optional_bool(self.flip_vertical, "flip_vertical")
        if not isinstance(self.sizing_mode, str) or self.sizing_mode not in SIZING_MODES:
            raise ValueError(f"sizing_mode must be one of {sorted(SIZING_MODES)}")
        if self.output is not None and not isinstance(self.output, OutputGeometry):
            raise ValueError("output must be an OutputGeometry or None")

    def validate_for_source(self, source_width: int, source_height: int) -> None:
        if self.crop is not None:
            self.crop.validate_for_source(source_width, source_height)

    def to_dict(self) -> dict[str, Any]:
        return {
            "crop": self.crop.to_dict() if self.crop is not None else None,
            "crop_aspect": self.crop_aspect,
            "rotation": self.rotation,
            "flip_horizontal": self.flip_horizontal,
            "flip_vertical": self.flip_vertical,
            "sizing_mode": self.sizing_mode,
            "output": self.output.to_dict() if self.output is not None else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VideoTransform:
        expected = {
            "crop",
            "crop_aspect",
            "rotation",
            "flip_horizontal",
            "flip_vertical",
            "sizing_mode",
            "output",
        }
        unexpected = set(data) - expected
        if unexpected:
            raise ValueError(f"transform contains unsupported fields: {sorted(unexpected)}")
        crop_data = data.get("crop")
        if crop_data is not None and not isinstance(crop_data, dict):
            raise ValueError("crop must be an object or null")
        output_data = data.get("output")
        if output_data is not None and not isinstance(output_data, dict):
            raise ValueError("output must be an object or null")
        return cls(
            crop=CropRect.from_dict(crop_data) if crop_data is not None else None,
            crop_aspect=data.get("crop_aspect", CROP_ASPECT_FREE),
            rotation=data.get("rotation", 0),
            flip_horizontal=data.get("flip_horizontal", False),
            flip_vertical=data.get("flip_vertical", False),
            sizing_mode=data.get("sizing_mode", SIZING_MODE_STRETCH),
            output=OutputGeometry.from_dict(output_data) if output_data is not None else None,
        )


@dataclass(frozen=True)
class TransformGeometry:
    selected_width: int
    selected_height: int
    oriented_width: int
    oriented_height: int
    fill_crop: CropRect | None
    output_width: int
    output_height: int

    @property
    def scale_input_width(self) -> int:
        return self.fill_crop.width if self.fill_crop is not None else self.oriented_width

    @property
    def scale_input_height(self) -> int:
        return self.fill_crop.height if self.fill_crop is not None else self.oriented_height

    @property
    def requires_scale(self) -> bool:
        return (self.scale_input_width, self.scale_input_height) != (
            self.output_width,
            self.output_height,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "selected_width": self.selected_width,
            "selected_height": self.selected_height,
            "oriented_width": self.oriented_width,
            "oriented_height": self.oriented_height,
            "fill_crop": self.fill_crop.to_dict() if self.fill_crop is not None else None,
            "output_width": self.output_width,
            "output_height": self.output_height,
        }


def oriented_dimensions(
    transform: VideoTransform,
    source_width: int,
    source_height: int,
) -> tuple[int, int]:
    _positive_int(source_width, "source width")
    _positive_int(source_height, "source height")
    transform.validate_for_source(source_width, source_height)
    selected_width = transform.crop.width if transform.crop is not None else source_width
    selected_height = transform.crop.height if transform.crop is not None else source_height
    if transform.rotation in (90, 270):
        return selected_height, selected_width
    return selected_width, selected_height


def crop_for_aspect(
    source_width: int,
    source_height: int,
    crop_aspect: str,
    current: CropRect | None = None,
) -> CropRect:
    _positive_int(source_width, "source width")
    _positive_int(source_height, "source height")
    if not isinstance(crop_aspect, str) or crop_aspect not in CROP_ASPECT_RATIOS:
        raise ValueError(f"crop_aspect must be one of {sorted(CROP_ASPECT_RATIOS)}")
    base = current or CropRect(0, 0, source_width, source_height)
    base.validate_for_source(source_width, source_height, alignment=1)
    ratio = CROP_ASPECT_RATIOS[crop_aspect]
    if ratio is None:
        return base
    ratio_width, ratio_height = ratio
    unit = math.floor(min(base.width / ratio_width, base.height / ratio_height))
    unit = math.floor(unit / CROP_ALIGNMENT) * CROP_ALIGNMENT
    if unit < CROP_ALIGNMENT:
        raise ValueError("source is too small for the selected crop aspect")
    width = ratio_width * unit
    height = ratio_height * unit
    center_x = base.x + base.width / 2
    center_y = base.y + base.height / 2
    x = round(center_x - width / 2)
    y = round(center_y - height / 2)
    x = max(0, min(x, source_width - width))
    y = max(0, min(y, source_height - height))
    return CropRect(x, y, width, height)


def fit_output_dimensions(
    source_width: int,
    source_height: int,
    requested_width: int,
    requested_height: int,
) -> tuple[int, int]:
    _positive_int(source_width, "source width")
    _positive_int(source_height, "source height")
    _positive_int(requested_width, "output width")
    _positive_int(requested_height, "output height")
    scale = min(requested_width / source_width, requested_height / source_height)
    return (
        _even_nearest(source_width * scale, requested_width),
        _even_nearest(source_height * scale, requested_height),
    )


def fill_crop_dimensions(
    source_width: int,
    source_height: int,
    output_width: int,
    output_height: int,
) -> CropRect | None:
    _positive_int(source_width, "source width")
    _positive_int(source_height, "source height")
    _positive_int(output_width, "output width")
    _positive_int(output_height, "output height")
    source_ratio = source_width / source_height
    output_ratio = output_width / output_height
    if math.isclose(source_ratio, output_ratio, rel_tol=0.0, abs_tol=1e-9):
        return None
    divisor = math.gcd(output_width, output_height)
    ratio_width = output_width // divisor
    ratio_height = output_height // divisor
    unit = math.floor(min(source_width / ratio_width, source_height / ratio_height))
    if unit > 0:
        width = ratio_width * unit
        height = ratio_height * unit
    elif source_ratio > output_ratio:
        height = source_height
        width = max(1, round(height * output_ratio))
    else:
        width = source_width
        height = max(1, round(width / output_ratio))
    x = (source_width - width) // 2
    y = (source_height - height) // 2
    return CropRect(x, y, width, height)


def calculate_transform_geometry(
    transform: VideoTransform,
    source_width: int,
    source_height: int,
) -> TransformGeometry:
    _positive_int(source_width, "source width")
    _positive_int(source_height, "source height")
    selected_width = transform.crop.width if transform.crop is not None else source_width
    selected_height = transform.crop.height if transform.crop is not None else source_height
    oriented_width, oriented_height = oriented_dimensions(
        transform,
        source_width,
        source_height,
    )
    requested = transform.output or OutputGeometry(oriented_width, oriented_height)
    fill_crop = None
    if transform.sizing_mode == SIZING_MODE_FIT:
        output_width, output_height = fit_output_dimensions(
            oriented_width,
            oriented_height,
            requested.width,
            requested.height,
        )
    elif transform.sizing_mode == SIZING_MODE_FILL:
        output_width = _even_floor(requested.width)
        output_height = _even_floor(requested.height)
        fill_crop = fill_crop_dimensions(
            oriented_width,
            oriented_height,
            output_width,
            output_height,
        )
    else:
        output_width = _even_floor(requested.width)
        output_height = _even_floor(requested.height)
    return TransformGeometry(
        selected_width=selected_width,
        selected_height=selected_height,
        oriented_width=oriented_width,
        oriented_height=oriented_height,
        fill_crop=fill_crop,
        output_width=output_width,
        output_height=output_height,
    )
