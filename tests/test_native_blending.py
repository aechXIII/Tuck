from __future__ import annotations

import ctypes
import importlib.util
import shutil
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent


def test_native_source_is_available_for_reproducible_builds():
    assert (ROOT / "tuck" / "encoding" / "native_blending.c").is_file()


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    source = ROOT / "tuck" / "encoding" / "native_blending.c"
    assert source.is_file(), "The real native blending kernel is required"
    spec = importlib.util.spec_from_file_location(
        "build_native_blending_test", ROOT / "scripts" / "build_native_blending.py"
    )
    assert spec and spec.loader
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    path = builder.build(tmp_path_factory.mktemp("native-blending"))
    assert path.is_file()
    return path


@pytest.fixture
def native(library, monkeypatch):
    from tuck.encoding import native_blending

    native_blending._load_library.cache_clear()
    monkeypatch.setattr(native_blending, "_candidate_paths", lambda: [library])
    yield native_blending
    native_blending._load_library.cache_clear()


def encoded_reference(pictures, weights):
    accumulator = np.zeros(pictures[0].shape, dtype=np.uint32)
    for picture, weight in zip(pictures, weights, strict=True):
        accumulator += picture.astype(np.uint32) * weight
    return ((accumulator + 32768) >> 16).astype(np.uint8)


@pytest.mark.parametrize("count", [1, 2, 3, 17, 256])
@pytest.mark.parametrize("width", [1, 2, 7, 8, 9, 15, 16, 17, 33])
def test_encoded_matches_exact_numpy_arithmetic(native, count, width):
    generator = np.random.default_rng(829 + count)
    pictures = [generator.integers(0, 256, (3, width, 3), dtype=np.uint8) for _ in range(count)]
    weights = generator.multinomial(65536, np.full(count, 1 / count)).tolist()
    originals = [picture.copy() for picture in pictures]
    result = native.blend_encoded(pictures, weights)
    assert result is not None
    np.testing.assert_array_equal(result, encoded_reference(pictures, weights))
    assert result.flags.c_contiguous and result.dtype == np.uint8
    for picture, original in zip(pictures, originals, strict=True):
        np.testing.assert_array_equal(picture, original)


def test_encoded_extremes_zero_weights_and_half_ties(native):
    picture = np.array([[[0, 1, 255], [255, 128, 254], [0, 0, 0]]], dtype=np.uint8)
    zero = np.zeros_like(picture)
    np.testing.assert_array_equal(native.blend_encoded([picture], [65536]), picture)
    np.testing.assert_array_equal(native.blend_encoded([picture, zero], [0, 65536]), zero)
    np.testing.assert_array_equal(
        native.blend_encoded([picture, zero], [32768, 32768]),
        np.array([[[0, 1, 128], [128, 64, 127], [0, 0, 0]]], dtype=np.uint8),
    )
    white = np.full((1, 17, 3), 255, dtype=np.uint8)
    np.testing.assert_array_equal(native.blend_encoded([white] * 256, [256] * 256), white)


@pytest.mark.parametrize("width", [1, 7, 8, 9, 17, 33])
@pytest.mark.parametrize("count", [1, 3, 17, 256])
def test_linear_matches_float32_product_then_ordered_add_bits(native, width, count):
    generator = np.random.default_rng(1289)
    pictures = [generator.integers(0, 256, (2, width, 3), dtype=np.uint8) for _ in range(count)]
    lookup = (np.arange(256, dtype=np.float32) / np.float32(255)) ** np.float32(2.2)
    weights = generator.random(count, dtype=np.float32)
    weights /= weights.sum()
    weights[0] = np.float32(0)
    expected = np.zeros(pictures[0].shape, dtype=np.float32)
    for picture, weight in zip(pictures, weights, strict=True):
        expected += lookup[picture] * weight
    actual = native.accumulate_linear(pictures, weights, lookup)
    assert actual is not None
    np.testing.assert_array_equal(actual.view(np.uint32), expected.view(np.uint32))


@pytest.mark.parametrize(
    "pictures,weights",
    [
        ([], []),
        ([np.zeros((0, 1, 3), dtype=np.uint8)], [65536]),
        ([np.zeros((1, 1, 4), dtype=np.uint8)], [65536]),
        ([np.zeros((1, 1, 3), dtype=np.float32)], [65536]),
        ([np.zeros((2, 2, 3), dtype=np.uint8)[:, ::2]], [65536]),
        ([np.zeros((1, 1, 3), dtype=np.uint8)] * 257, [1] * 257),
        ([np.zeros((1, 1, 3), dtype=np.uint8)], []),
        ([np.zeros((1, 1, 3), dtype=np.uint8)], [-1]),
        ([np.zeros((1, 1, 3), dtype=np.uint8)], [65537]),
        ([np.zeros((1, 1, 3), dtype=np.uint8)], [1]),
        ([np.zeros((1, 1, 3), dtype=np.uint8)], [65536.0]),
        ([np.zeros((1, 1, 3), dtype=np.uint8), np.zeros((2, 1, 3), dtype=np.uint8)], [1, 65535]),
    ],
)
def test_invalid_encoded_input_never_reaches_native(native, pictures, weights):
    with pytest.raises((ValueError, TypeError)):
        native.blend_encoded(pictures, weights)


@pytest.mark.parametrize("weight", [np.float32(-1), np.float32(np.nan), np.float32(np.inf), 1.0])
def test_invalid_linear_weights(native, weight):
    with pytest.raises((ValueError, TypeError)):
        native.accumulate_linear(
            [np.zeros((1, 1, 3), dtype=np.uint8)], [weight], np.zeros(256, dtype=np.float32)
        )


@pytest.mark.parametrize(
    "lookup",
    [
        np.zeros(255, dtype=np.float32),
        np.zeros(256),
        np.zeros(512, dtype=np.float32)[::2],
        np.full(256, np.nan, dtype=np.float32),
    ],
)
def test_invalid_linear_lookup(native, lookup):
    with pytest.raises((ValueError, TypeError)):
        native.accumulate_linear([np.zeros((1, 1, 3), dtype=np.uint8)], [np.float32(1)], lookup)


def test_missing_native_helper_keeps_source_fallback_available(monkeypatch, tmp_path):
    from tuck.encoding import native_blending

    native_blending._load_library.cache_clear()
    monkeypatch.setattr(native_blending, "_candidate_paths", lambda: [tmp_path / "missing"])
    picture = np.zeros((1, 1, 3), dtype=np.uint8)
    assert native_blending.blend_encoded([picture], [65536]) is None
    assert (
        native_blending.accumulate_linear([picture], [np.float32(1)], np.zeros(256, np.float32))
        is None
    )
    native_blending._load_library.cache_clear()


def test_broken_present_library_is_not_hidden(monkeypatch, tmp_path):
    from tuck.encoding import native_blending

    path = tmp_path / "broken.dll"
    path.write_bytes(b"invalid native library")
    native_blending._load_library.cache_clear()
    monkeypatch.setattr(native_blending, "_candidate_paths", lambda: [path])
    with pytest.raises(RuntimeError, match="load"):
        native_blending.blend_encoded([np.zeros((1, 1, 3), dtype=np.uint8)], [65536])
    native_blending._load_library.cache_clear()


@pytest.mark.parametrize("linear", [False, True])
def test_native_call_failure_is_not_retried_with_numpy(native, monkeypatch, linear):
    library = native._load_library()
    function = "tuck_accumulate_linear" if linear else "tuck_blend_encoded"
    monkeypatch.setattr(library, function, lambda *args: -1)
    picture = np.zeros((1, 1, 3), dtype=np.uint8)
    with pytest.raises(RuntimeError, match="call failed"):
        if linear:
            native.accumulate_linear([picture], [np.float32(1)], np.zeros(256, dtype=np.float32))
        else:
            native.blend_encoded([picture], [65536])


def test_scalar_kernel_matches_auto_dispatch(library):
    loaded = ctypes.CDLL(str(library))
    pointer = ctypes.POINTER(ctypes.c_uint8)
    function = loaded.tuck_blend_encoded
    function.argtypes = [
        pointer,
        ctypes.POINTER(pointer),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.c_size_t,
        ctypes.c_uint32,
        ctypes.c_int,
    ]
    function.restype = ctypes.c_int
    generator = np.random.default_rng(22)
    pictures = [generator.integers(0, 256, 31, dtype=np.uint8) for _ in range(5)]
    weights = (ctypes.c_uint32 * 5)(1, 0, 65532, 2, 1)
    inputs = (pointer * 5)(*[picture.ctypes.data_as(pointer) for picture in pictures])
    outputs = [np.zeros(31, dtype=np.uint8) for _ in range(2)]
    for mode, output in enumerate(outputs):
        assert function(output.ctypes.data_as(pointer), inputs, weights, 31, 5, mode) == 0
    np.testing.assert_array_equal(outputs[0], outputs[1])


@pytest.mark.parametrize("length", [1, 7, 8, 9, 15, 16, 17, 257])
def test_native_kernels_preserve_unaligned_buffer_boundaries(library, length):
    loaded = ctypes.CDLL(str(library))
    byte_pointer = ctypes.POINTER(ctypes.c_uint8)
    float_pointer = ctypes.POINTER(ctypes.c_float)
    encoded = loaded.tuck_blend_encoded
    encoded.argtypes = [
        byte_pointer,
        ctypes.POINTER(byte_pointer),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.c_size_t,
        ctypes.c_uint32,
        ctypes.c_int,
    ]
    encoded.restype = ctypes.c_int
    linear = loaded.tuck_accumulate_linear
    linear.argtypes = [
        float_pointer,
        ctypes.POINTER(byte_pointer),
        float_pointer,
        float_pointer,
        ctypes.c_size_t,
        ctypes.c_uint32,
        ctypes.c_int,
    ]
    linear.restype = ctypes.c_int
    generator = np.random.default_rng(588)
    padded = [generator.integers(0, 256, length + 14, dtype=np.uint8) for _ in range(5)]
    pictures = [picture[5:-9] for picture in padded]
    pointers = (byte_pointer * 5)(*[picture.ctypes.data_as(byte_pointer) for picture in pictures])
    quantized = (ctypes.c_uint32 * 5)(1, 0, 65532, 2, 1)
    weights = np.array([0.3, 0, 0.2, 0.1, 0.4], dtype=np.float32)
    lookup = generator.random(256, dtype=np.float32)
    expected = np.zeros(length, dtype=np.float32)
    for picture, weight in zip(pictures, weights, strict=True):
        expected += lookup[picture] * weight
    for simd in [0, 1]:
        output = np.full(length + 14, 173, dtype=np.uint8)
        assert (
            encoded(output[5:-9].ctypes.data_as(byte_pointer), pointers, quantized, length, 5, simd)
            == 0
        )
        assert np.all(output[:5] == 173) and np.all(output[-9:] == 173)
        expected_integer = encoded_reference(pictures, [1, 0, 65532, 2, 1])
        np.testing.assert_array_equal(output[5:-9], expected_integer)
        floats = np.full(length + 14, np.float32(-173), dtype=np.float32)
        assert (
            linear(
                floats[5:-9].ctypes.data_as(float_pointer),
                pointers,
                weights.ctypes.data_as(float_pointer),
                lookup.ctypes.data_as(float_pointer),
                length,
                5,
                simd,
            )
            == 0
        )
        assert np.all(floats[:5] == -173) and np.all(floats[-9:] == -173)
        np.testing.assert_array_equal(floats[5:-9].view(np.uint32), expected.view(np.uint32))


def test_unaligned_contiguous_rgb_input_is_supported(native):
    pictures = [np.arange(124, dtype=np.uint8)[1:].reshape(1, 41, 3)]
    np.testing.assert_array_equal(native.blend_encoded(pictures, [65536]), pictures[0])


@pytest.mark.parametrize("platform", ["windows", "linux"])
@pytest.mark.parametrize("present", [False, True])
def test_pyinstaller_requires_and_collects_the_real_native_helper(
    library, tmp_path, platform, present
):
    filename = "native_blending.dll" if platform == "windows" else "libnative_blending.so"
    suffix = "" if platform == "windows" else "-linux"
    native_path = tmp_path / "build" / "native" / filename
    native_path.parent.mkdir(parents=True)
    if present:
        shutil.copy2(library, native_path)
    for entry in ("sidecar_entry.py", "cli_entry.py"):
        path = tmp_path / "tuck" / entry
        path.parent.mkdir(exist_ok=True)
        path.write_text("")
    analyses = []

    def analysis(*args, **kwargs):
        analyses.append(kwargs)
        return SimpleNamespace(
            pure=[], scripts=[], binaries=kwargs["binaries"], zipfiles=[], datas=kwargs["datas"]
        )

    namespace = {
        "SPECPATH": str(tmp_path / "scripts"),
        "Analysis": analysis,
        "MERGE": lambda *args: None,
        "PYZ": lambda *args: None,
        "EXE": lambda *args, **kwargs: None,
        "COLLECT": lambda *args, **kwargs: None,
    }
    source = (ROOT / "scripts" / f"tuck-sidecar{suffix}.spec").read_text()
    if not present:
        with pytest.raises(FileNotFoundError, match="native blending"):
            exec(compile(source, f"tuck-sidecar{suffix}.spec", "exec"), namespace)
    else:
        exec(compile(source, f"tuck-sidecar{suffix}.spec", "exec"), namespace)
        assert analyses
        assert all((str(native_path), ".") in entry["binaries"] for entry in analyses)
        assert all("tuck.encoding.native_blending" in entry["hiddenimports"] for entry in analyses)
