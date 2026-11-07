from __future__ import annotations

import math
from dataclasses import asdict, dataclass

DITHER_SOFT = "soft"
DITHER_PATTERN = "pattern"
DITHER_OFF = "off"
DITHERS = (DITHER_SOFT, DITHER_PATTERN, DITHER_OFF)

PALETTE_WHOLE = "whole"
PALETTE_FRAME = "frame"
PALETTES = (PALETTE_WHOLE, PALETTE_FRAME)

MIN_WIDTH = 16
MAX_WIDTH = 3840
# a GIF times its frames in hundredths of a second, and browsers slow anything faster than
# 50 fps down to 10
MAX_FPS = 50.0
MIN_SPEED = 0.25
MAX_SPEED = 4.0
MAX_PLAYS = 100
MIN_SIZE_LIMIT = 100 * 1024


def _number(value: object, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"GIF {name} must be a number")
    if not low <= value <= high:
        raise ValueError(f"GIF {name} must be between {low:g} and {high:g}")
    return float(value)


@dataclass(frozen=True)
class GifSettings:
    width: int = 480
    fps: float = 15.0
    colors: int = 256
    speed: float = 1.0
    back_and_forth: bool = False
    # how many times it plays; 0 is forever
    plays: int = 0
    # bytes; 0 sets no limit. A bigger GIF gets a lower frame rate, then a smaller width
    size_limit: int = 0
    dither: str = DITHER_SOFT
    palette: str = PALETTE_WHOLE
    sharp_pixels: bool = False
    drop_repeated_frames: bool = False

    def __post_init__(self) -> None:
        for name in ("width", "colors", "plays", "size_limit"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"GIF {name.replace('_', ' ')} must be a whole number")
        _number(self.width, "width", MIN_WIDTH, MAX_WIDTH)
        _number(self.fps, "frame rate", 1, MAX_FPS)
        _number(self.colors, "colors", 2, 256)
        _number(self.speed, "speed", MIN_SPEED, MAX_SPEED)
        _number(self.plays, "plays", 0, MAX_PLAYS)
        if self.size_limit and self.size_limit < MIN_SIZE_LIMIT:
            raise ValueError("A GIF size limit must be at least 0.1 MB")
        for name in ("back_and_forth", "sharp_pixels", "drop_repeated_frames"):
            if type(getattr(self, name)) is not bool:
                raise ValueError("GIF switches must be booleans")
        if self.dither not in DITHERS:
            raise ValueError("Unknown GIF dithering")
        if self.palette not in PALETTES:
            raise ValueError("Unknown GIF palette")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: object) -> GifSettings:
        if not isinstance(raw, dict):
            raise ValueError("GIF settings must be an object")
        known = set(cls.__dataclass_fields__)
        if raw.keys() - known:
            raise ValueError("Unknown GIF setting")
        data = dict(raw)
        fps = data.get("fps")
        if isinstance(fps, int) and not isinstance(fps, bool):
            data["fps"] = float(fps)
        speed = data.get("speed")
        if isinstance(speed, int) and not isinstance(speed, bool):
            data["speed"] = float(speed)
        return cls(**data)
