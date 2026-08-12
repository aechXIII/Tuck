from __future__ import annotations

from dataclasses import dataclass
from typing import Any

CROP_ALIGNMENT = 2


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


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
class VideoTransform:
    crop: CropRect | None = None

    def __post_init__(self) -> None:
        if self.crop is not None and not isinstance(self.crop, CropRect):
            raise ValueError("crop must be a CropRect or None")

    def validate_for_source(self, source_width: int, source_height: int) -> None:
        if self.crop is not None:
            self.crop.validate_for_source(source_width, source_height)

    def to_dict(self) -> dict[str, Any]:
        return {"crop": self.crop.to_dict() if self.crop is not None else None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VideoTransform:
        unexpected = set(data) - {"crop"}
        if unexpected:
            raise ValueError(f"transform contains unsupported fields: {sorted(unexpected)}")
        crop_data = data.get("crop")
        if crop_data is not None and not isinstance(crop_data, dict):
            raise ValueError("crop must be an object or null")
        return cls(crop=CropRect.from_dict(crop_data) if crop_data is not None else None)
