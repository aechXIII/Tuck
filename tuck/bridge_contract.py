from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Union

# These aliases are evaluated at import time, so Union keeps diagnostics usable on Python 3.9.
JsonPrimitive = Union[str, int, float, bool, None]  # noqa: UP007
JsonValue = Union[  # noqa: UP007
    JsonPrimitive,
    Sequence["JsonValue"],
    Mapping[str, "JsonValue"],
]
BridgeResult = Union[Mapping[str, JsonValue], Sequence[JsonValue]]  # noqa: UP007
