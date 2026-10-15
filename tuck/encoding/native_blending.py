"""Optional exact native kernels for weighted frame blending."""

from __future__ import annotations

import ctypes
import logging
import sys
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger(__name__)
_BYTE_POINTER = ctypes.POINTER(ctypes.c_uint8)
_FLOAT_POINTER = ctypes.POINTER(ctypes.c_float)
_FINISH_POINTER = ctypes.POINTER(ctypes.c_uint64)
_ONE_BITS = 0x3F800000
_FINISH_TRANSFERS = frozenset(
    {"bt709", "smpte170m", "iec61966-2-1", "linear", "gamma22", "gamma28"}
)


def _candidate_paths() -> list[Path]:
    filename = "native_blending.dll" if sys.platform == "win32" else "libnative_blending.so"
    frozen = getattr(sys, "_MEIPASS", None)
    if frozen is not None:
        return [Path(frozen) / filename]
    return [Path(__file__).resolve().parents[2] / "build" / "native" / filename]


@lru_cache(maxsize=1)
def _load_library() -> ctypes.CDLL | None:
    path = next((candidate for candidate in _candidate_paths() if candidate.is_file()), None)
    if path is None:
        logger.debug("Native frame blending is unavailable; using NumPy")
        return None
    try:
        library = ctypes.CDLL(str(path))
        library.tuck_blending_abi.argtypes = []
        library.tuck_blending_abi.restype = ctypes.c_uint
        if library.tuck_blending_abi() != 1:
            raise RuntimeError("The native blending helper has an incompatible ABI")
        library.tuck_blend_encoded.argtypes = [
            _BYTE_POINTER,
            ctypes.POINTER(_BYTE_POINTER),
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.c_size_t,
            ctypes.c_uint32,
            ctypes.c_int,
        ]
        library.tuck_blend_encoded.restype = ctypes.c_int
        library.tuck_accumulate_linear.argtypes = [
            _FLOAT_POINTER,
            ctypes.POINTER(_BYTE_POINTER),
            _FLOAT_POINTER,
            _FLOAT_POINTER,
            ctypes.c_size_t,
            ctypes.c_uint32,
            ctypes.c_int,
        ]
        library.tuck_accumulate_linear.restype = ctypes.c_int
        finish = getattr(library, "tuck_finish_linear", None)
        if finish is not None:
            finish.argtypes = [
                _BYTE_POINTER,
                _FLOAT_POINTER,
                _FINISH_POINTER,
                ctypes.c_size_t,
            ]
            finish.restype = ctypes.c_int
    except (OSError, AttributeError) as exc:
        raise RuntimeError(f"Cannot load the native blending helper: {path.name}") from exc
    return library


def finish_linear_numpy(values: NDArray[np.float32], transfer: str) -> NDArray[np.uint8]:
    # this frame owns the accumulator; reuse it without changing float32 rounding
    np.clip(values, 0, 1, out=values)
    if transfer in {"gamma22", "gamma28"}:
        np.power(values, 1 / (2.2 if transfer == "gamma22" else 2.8), out=values)
    elif transfer != "linear":
        srgb = transfer == "iec61966-2-1"
        mask = values <= 0.0031308 if srgb else values < 0.018
        low = values * (12.92 if srgb else 4.5)
        np.power(values, 1 / 2.4 if srgb else 0.45, out=values)
        np.multiply(values, 1.055 if srgb else 1.099, out=values)
        np.subtract(values, 0.055 if srgb else 0.099, out=values)
        np.copyto(values, low, where=mask)
    np.clip(values, 0, 1, out=values)
    np.multiply(values, 255, out=values)
    np.rint(values, out=values)
    return values.astype(np.uint8)


@lru_cache(maxsize=6)
def _linear_finish_table(transfer: str) -> NDArray[np.uint64] | None:
    if transfer not in _FINISH_TRANSFERS:
        return None
    starts = np.arange((_ONE_BITS >> 16) + 1, dtype=np.uint32) << 16
    ends = np.minimum(starts + 65535, _ONE_BITS).astype(np.uint32)
    first = finish_linear_numpy(starts.view(np.float32).copy(), transfer)
    last = finish_linear_numpy(ends.view(np.float32).copy(), transfer)
    if first[0] != 0 or last[-1] != 255:
        return None
    # a coarse bucket may be constant or cross exactly one byte boundary
    if np.any(last < first) or np.any(last.astype(np.uint16) - first > 1):
        return None
    if np.any(first[1:] < last[:-1]) or np.any(first[1:].astype(np.uint16) - last[:-1] > 1):
        return None
    active = np.flatnonzero(last != first)
    low, high = starts[active].copy(), ends[active].copy()
    for _ in range(16):
        middle = (low + high) // 2
        codes = finish_linear_numpy(middle.view(np.float32).copy(), transfer)
        upper = codes > first[active]
        high = np.where(upper, middle, high)
        low = np.where(upper, low, middle + 1)
    table = np.empty(starts.shape, dtype=np.uint64)
    # the high word is the byte value; the low word is the next byte's exact float32 boundary
    table[:] = (first.astype(np.uint64) << 32) | np.uint64(0xFFFFFFFF)
    table[active] = (first[active].astype(np.uint64) << 32) | high.astype(np.uint64)
    for index, boundary in zip(active, high, strict=True):
        # verify every float32 value where power rounding could cross this boundary
        bits = np.arange(int(starts[index]), int(ends[index]) + 1, dtype=np.uint32)
        actual = finish_linear_numpy(bits.view(np.float32).copy(), transfer)
        expected = first[index] + (bits >= boundary)
        if not np.array_equal(actual, expected):
            return None
    table.flags.writeable = False
    return table


def finish_linear(values: NDArray[np.float32], transfer: str) -> NDArray[np.uint8] | None:
    """Quantize the owned accumulator in place, or return None for the NumPy fallback."""
    if not isinstance(values, np.ndarray) or values.dtype != np.float32:
        raise TypeError("Linear finishing requires float32 values")
    if not values.flags.c_contiguous or not values.flags.writeable:
        raise ValueError("Linear finishing requires writable contiguous values")
    library = _load_library()
    if library is None:
        return None
    finish = getattr(library, "tuck_finish_linear", None)
    if finish is None:
        return None
    table = _linear_finish_table(transfer)
    if table is None:
        return None
    output = np.empty(values.shape, dtype=np.uint8)
    if not values.size:
        return output
    result = finish(
        output.ctypes.data_as(_BYTE_POINTER),
        values.ctypes.data_as(_FLOAT_POINTER),
        table.ctypes.data_as(_FINISH_POINTER),
        values.size,
    )
    if result != 0:
        raise RuntimeError("The native linear finishing call failed")
    return output


def _validate_pictures(pictures: Sequence[NDArray[np.uint8]], count: int) -> None:
    if not 1 <= len(pictures) <= 256 or len(pictures) != count:
        raise ValueError("Frame blending requires 1 to 256 pictures and one weight per picture")
    if not isinstance(pictures[0], np.ndarray):
        raise TypeError("Frame blending pictures must be uint8 arrays")
    shape = pictures[0].shape
    for picture in pictures:
        if not isinstance(picture, np.ndarray) or picture.dtype != np.uint8:
            raise TypeError("Frame blending pictures must be uint8 arrays")
        if (
            picture.ndim != 3
            or picture.shape != shape
            or shape[2] != 3
            or shape[0] < 1
            or shape[1] < 1
            or not picture.flags.c_contiguous
        ):
            raise ValueError("Frame blending requires matching contiguous RGB pictures")


def blend_encoded(
    pictures: Sequence[NDArray[np.uint8]], weights: Sequence[int]
) -> NDArray[np.uint8] | None:
    _validate_pictures(pictures, len(weights))
    if any(not isinstance(weight, int) or isinstance(weight, bool) for weight in weights):
        raise TypeError("Encoded blending weights must be integers")
    if any(weight < 0 or weight > 65536 for weight in weights) or sum(weights) != 65536:
        raise ValueError("Encoded blending weights must sum to 65536")
    library = _load_library()
    if library is None:
        return None
    output = np.empty(pictures[0].shape, dtype=np.uint8)
    pointers = (_BYTE_POINTER * len(pictures))(
        *[picture.ctypes.data_as(_BYTE_POINTER) for picture in pictures]
    )
    native_weights = (ctypes.c_uint32 * len(weights))(*weights)
    result = library.tuck_blend_encoded(
        output.ctypes.data_as(_BYTE_POINTER),
        pointers,
        native_weights,
        output.size,
        len(pictures),
        1,
    )
    if result != 0:
        raise RuntimeError("The native encoded blending call failed")
    return output


def accumulate_linear(
    pictures: Sequence[NDArray[np.uint8]],
    weights: Sequence[np.float32],
    lookup: NDArray[np.float32],
) -> NDArray[np.float32] | None:
    _validate_pictures(pictures, len(weights))
    if any(type(weight) is not np.float32 for weight in weights):
        raise TypeError("Linear blending weights must be float32 values")
    if any(not np.isfinite(weight) or weight < 0 or weight > 1 for weight in weights):
        raise ValueError("Linear blending weights must be finite values from zero to one")
    if not isinstance(lookup, np.ndarray) or lookup.dtype != np.float32:
        raise TypeError("Linear blending requires a float32 lookup table")
    if (
        lookup.shape != (256,)
        or not lookup.flags.c_contiguous
        or not lookup.flags.aligned
        or not np.all(np.isfinite(lookup))
    ):
        raise ValueError("Linear blending requires a contiguous finite lookup table of 256 values")
    library = _load_library()
    if library is None:
        return None
    output = np.empty(pictures[0].shape, dtype=np.float32)
    pointers = (_BYTE_POINTER * len(pictures))(
        *[picture.ctypes.data_as(_BYTE_POINTER) for picture in pictures]
    )
    native_weights = (ctypes.c_float * len(weights))(*weights)
    result = library.tuck_accumulate_linear(
        output.ctypes.data_as(_FLOAT_POINTER),
        pointers,
        native_weights,
        lookup.ctypes.data_as(_FLOAT_POINTER),
        output.size,
        len(pictures),
        1,
    )
    if result != 0:
        raise RuntimeError("The native linear blending call failed")
    return output
