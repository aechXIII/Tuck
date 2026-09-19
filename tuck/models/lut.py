from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class LutSettings:
    enabled: bool = False
    strength: float = 1.0
    path: str = ""
    name: str = ""

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise ValueError("LUT enabled must be a boolean")
        if (
            isinstance(self.strength, bool)
            or not isinstance(self.strength, (int, float))
            or not math.isfinite(self.strength)
            or not 0 <= self.strength <= 1
        ):
            raise ValueError("LUT strength must be between 0 and 1")
        if not isinstance(self.path, str) or not isinstance(self.name, str):
            raise ValueError("LUT path and name must be text")
        if self.enabled and not self.path:
            raise ValueError("Choose a LUT file before enabling it")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: object) -> LutSettings:
        if not isinstance(raw, dict) or raw.keys() - {"enabled", "strength", "path", "name"}:
            raise ValueError("LUT settings must be an object with supported settings")
        return cls(**raw)
