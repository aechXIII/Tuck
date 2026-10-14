from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def patched_ffmpeg():
    from tuck.media_tools import find_ffmpeg

    binary = find_ffmpeg()
    if binary is None:
        pytest.skip("FFmpeg is unavailable")
    help_result = subprocess.run(
        [binary, "-hide_banner", "-h", "filter=mix"], capture_output=True, text=True, check=True
    )
    if "exact integer mixing" not in help_result.stdout:
        pytest.skip("This FFmpeg does not include the integer mixing patch")
    return binary


@pytest.mark.parametrize("cpu_flags", ["0", "all"])
@pytest.mark.parametrize(
    "pixel_format,count,options",
    [
        ("yuv420p", 3, ""),
        ("yuv420p", 5, ""),
        ("yuv444p", 7, ":planes=1"),
        ("gbrap", 5, ""),
        ("rgb24", 5, ""),
        ("yuv420p", 4, ""),
        ("yuv420p", 5, ":weights='1 2 1 2 1'"),
        ("yuv420p", 5, ":weights='2 2 2 2 2'"),
        ("yuv420p", 5, ":scale=0.2"),
        ("yuv420p10le", 5, ""),
        ("gbrpf32le", 5, ""),
    ],
)
def test_ffmpeg_integer_dispatch_preserves_pixels_and_timestamps(
    patched_ffmpeg, pixel_format, count, options, cpu_flags
):
    split = "".join(f"[s{i}]" for i in range(count))
    branches = [f"[s{i}]trim=start_frame={i},setpts=PTS-STARTPTS[b{i}]" for i in range(count)]
    inputs = "".join(f"[b{i}]" for i in range(count))
    results = []
    for enabled in (0, 1):
        graph = ";".join(
            [
                f"[0:v]format={pixel_format},split={count}{split}",
                *branches,
                f"{inputs}mix=inputs={count}:integer={enabled}:duration=shortest{options}[out]",
            ]
        )
        result = subprocess.run(
            [
                patched_ffmpeg,
                "-hide_banner",
                "-v",
                "error",
                "-cpuflags",
                cpu_flags,
                "-filter_complex_threads",
                "3",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=66x34:rate=30:duration=0.6",
                "-filter_complex",
                graph,
                "-map",
                "[out]",
                "-c:v",
                "rawvideo",
                "-threads",
                "1",
                "-f",
                "framemd5",
                "-",
            ],
            capture_output=True,
            check=True,
        )
        results.append(result.stdout)
    assert results[0] == results[1]
    assert (
        len([line for line in results[1].splitlines() if not line.startswith(b"#")]) == 19 - count
    )


def test_ffmpeg_mix_keeps_positional_arguments(patched_ffmpeg):
    results = []
    for expression in ("mix=3", "mix=inputs=3"):
        result = subprocess.run(
            [
                patched_ffmpeg,
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=66x34:rate=30:duration=0.1",
                "-filter_complex",
                f"[0:v]split=3[a][b][c];[a][b][c]{expression}[out]",
                "-map",
                "[out]",
                "-c:v",
                "rawvideo",
                "-threads",
                "1",
                "-f",
                "framemd5",
                "-",
            ],
            capture_output=True,
            check=True,
        )
        results.append(result.stdout)
    assert results[0] == results[1]


@pytest.fixture(scope="module")
def native_mix(tmp_path_factory):
    compiler = shutil.which("gcc") or shutil.which("cc")
    if compiler is None:
        pytest.skip("A C compiler is required to check the native mixing kernel")
    directory = tmp_path_factory.mktemp("mix-integer")
    source = directory / "check.c"
    header = (ROOT / "packaging" / "ffmpeg-mix-integer.h").as_posix()
    source.write_text(
        f'#include "{header}"\n'
        "int has_avx2(void) {\n"
        "#if MIX_INTEGER_AVX2\n"
        '  return __builtin_cpu_supports("avx2") != 0;\n'
        "#else\n"
        "  return 0;\n"
        "#endif\n"
        "}\n"
        "void blend(unsigned char *out, unsigned char **in, int count, int width, int vector) {\n"
        "#if MIX_INTEGER_AVX2\n"
        "  if (vector && has_avx2()) { mix_line_integer_avx2(out, in, count, width); return; }\n"
        "#endif\n"
        "  mix_line_integer_c(out, in, count, width);\n"
        "}\n",
        encoding="utf-8",
    )
    library = directory / ("mix.dll" if os.name == "nt" else "mix.so")
    result = subprocess.run(
        [
            compiler,
            "-shared",
            "-O3",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-o",
            str(library),
            str(source),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    loaded = ctypes.CDLL(str(library))
    byte_pointer = ctypes.POINTER(ctypes.c_uint8)
    loaded.blend.argtypes = [
        byte_pointer,
        ctypes.POINTER(byte_pointer),
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
    ]
    loaded.blend.restype = None
    loaded.has_avx2.restype = ctypes.c_int

    def run(pictures: np.ndarray, vector: bool) -> np.ndarray:
        if vector and not loaded.has_avx2():
            pytest.skip("AVX2 is unavailable on this CPU")
        count, width = pictures.shape
        source_pixels = np.pad(pictures, ((0, 0), (5, 7)), constant_values=173)
        before = source_pixels.copy()
        output = np.full(width + 12, 173, dtype=np.uint8)
        inputs = (byte_pointer * count)(
            *[
                ctypes.cast(
                    source_pixels.ctypes.data + i * source_pixels.strides[0] + 5, byte_pointer
                )
                for i in range(count)
            ]
        )
        loaded.blend(
            ctypes.cast(output.ctypes.data + 5, byte_pointer), inputs, count, width, int(vector)
        )
        assert np.all(output[:5] == 173) and np.all(output[-7:] == 173)
        assert np.array_equal(source_pixels, before)
        return output[5:-7]

    return run


@pytest.mark.parametrize("vector", [False, True])
@pytest.mark.parametrize("count", [3, 5, 7, 15, 31, 63, 127, 255])
def test_integer_mix_matches_every_possible_pixel_sum(native_mix, count, vector):
    totals = np.arange(255 * count + 1, dtype=np.int32)
    pictures = np.empty((count, len(totals)), dtype=np.uint8)
    for i in range(count):
        pictures[i] = np.clip(totals - i * 255, 0, 255)
    expected = np.rint(totals.astype(np.float32) * np.float32(1 / count)).astype(np.uint8)
    assert np.array_equal(native_mix(pictures, vector), expected)


@pytest.mark.parametrize("vector", [False, True])
@pytest.mark.parametrize("width", [1, 15, 16, 17, 31, 32, 33, 257, 1921])
def test_integer_mix_handles_unaligned_rows_and_partial_vectors(native_mix, width, vector):
    generator = np.random.default_rng(12)
    for count in [3, 5, 31, 255]:
        pictures = generator.integers(0, 256, size=(count, width), dtype=np.uint8)
        expected = ((pictures.sum(axis=0) + count // 2) // count).astype(np.uint8)
        assert np.array_equal(native_mix(pictures, vector), expected)
