from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Union, cast

# These aliases are evaluated at import time, so Union keeps diagnostics usable on Python 3.9.
JsonPrimitive = Union[str, int, float, bool, None]  # noqa: UP007
JsonValue = Union[  # noqa: UP007
    JsonPrimitive,
    Sequence["JsonValue"],
    Mapping[str, "JsonValue"],
]
BridgeResult = Union[Mapping[str, JsonValue], Sequence[JsonValue]]  # noqa: UP007


def normalize_bridge_result(value: object) -> BridgeResult:
    """Return JSON-compatible bridge data or a stable contract error."""
    if isinstance(value, (dict, list)) and _is_json_value(value):
        return cast(BridgeResult, value)
    return {"ok": False, "error": "Invalid backend response"}


def _is_json_value(value: object) -> bool:
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False
