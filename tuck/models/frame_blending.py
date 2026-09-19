from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class FrameBlending:
    enabled: bool = False
    amount: float = 1.0
    curve: str = "equal"
    sigma: float = 0.25
    peak: float = 0.5
    power: float = 1.0
    custom_weights: tuple[float, ...] = ()
    linear_light: bool = False

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool or type(self.linear_light) is not bool:
            raise ValueError("Frame blending switches must be booleans")
        for name, low, high in (
            ("amount", 0, 4),
            ("sigma", 0.05, 1),
            ("peak", 0.05, 0.95),
            ("power", 0.1, 8),
        ):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not low <= value <= high
            ):
                raise ValueError(f"Frame blending {name} must be between {low} and {high}")
        if self.curve not in (
            "equal",
            "vegas",
            "gaussian",
            "triangular",
            "ascending",
            "descending",
        ):
            raise ValueError("Unknown frame blending weighting curve")
        if not isinstance(self.custom_weights, tuple) or len(self.custom_weights) > 64:
            raise ValueError("Custom weights must contain at most 64 numbers")
        for value in self.custom_weights:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 1000
            ):
                raise ValueError("Custom weights must be finite numbers between 0 and 1000")
        if self.custom_weights and sum(self.custom_weights) <= 0:
            raise ValueError("Custom weights must include a positive weight")

    def to_dict(self) -> dict[str, object]:
        result = asdict(self)
        result["custom_weights"] = list(self.custom_weights)
        return result

    @classmethod
    def from_dict(cls, raw: object) -> FrameBlending:
        if not isinstance(raw, dict):
            raise ValueError("Frame blending must be an object")
        known = {
            "enabled",
            "amount",
            "curve",
            "sigma",
            "peak",
            "power",
            "custom_weights",
            "linear_light",
        }
        if raw.keys() - known:
            raise ValueError("Unknown frame blending setting")
        data = dict(raw)
        weights = data.get("custom_weights", [])
        if not isinstance(weights, (list, tuple)):
            raise ValueError("Custom weights must be an array")
        data["custom_weights"] = tuple(weights)
        return cls(**data)


def vegas_weights(source_fps: float, output_fps: float, amount: float) -> tuple[float, ...]:
    """Vegas-style weights: an odd count, with half-weight ends for even blend factors."""
    if not all(math.isfinite(value) for value in (source_fps, output_fps, amount)):
        raise ValueError("Vegas weighting needs finite frame rates and blur amount")
    if source_fps <= 0 or output_fps <= 0 or not 0 <= amount <= 4:
        raise ValueError("Vegas weighting needs positive frame rates and blur amount from 0 to 4")
    factor = source_fps / output_fps * amount
    if factor > 255:
        raise ValueError(
            "Vegas blending window is too large; lower blur amount or increase output FPS"
        )
    count = int(factor)
    if count <= 1:
        return (1.0,)
    if count % 2:
        return (1.0,) * count
    return (1.0,) + (2.0,) * (count - 1) + (1.0,)


def interval_weight(
    settings: FrameBlending, start: float, end: float, *, vegas: tuple[float, ...] = ()
) -> float:
    """Integrate exposure density on [0, 1], from earlier to later source time."""
    start, end = max(0.0, start), min(1.0, end)
    if end <= start:
        return 0.0
    weights = settings.custom_weights or (vegas if settings.curve == "vegas" else ())
    if settings.curve == "vegas" and not weights:
        raise ValueError("Vegas weighting requires source and output frame rates")
    if weights:
        count = len(weights)
        return sum(
            w * max(0, min(end, (i + 1) / count) - max(start, i / count))
            for i, w in enumerate(weights)
        )

    def integral(x: float) -> float:
        if settings.curve == "gaussian":
            return (
                settings.sigma
                * math.sqrt(math.pi / 2)
                * math.erf((x - 0.5) / (settings.sigma * math.sqrt(2)))
            )
        if settings.curve == "triangular":
            peak = settings.peak
            return x * x / (2 * peak) if x <= peak else (0.5 - (1 - x) ** 2 / (2 * (1 - peak)))
        if settings.curve == "ascending":
            return x ** (settings.power + 1) / (settings.power + 1)
        if settings.curve == "descending":
            return -((1 - x) ** (settings.power + 1)) / (settings.power + 1)
        return x

    return max(0.0, integral(end) - integral(start))
