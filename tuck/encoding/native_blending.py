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
    except (OSError, AttributeError) as exc:
        raise RuntimeError(f"Cannot load the native blending helper: {path.name}") from exc
    return library


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
