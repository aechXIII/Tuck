from __future__ import annotations

import os
import subprocess

import pytest

from tuck.engine import _find_ffmpeg
from tuck.probe import _parse_display_rotation, probe


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, 0), (90, 90), (-90, 270), (180, 180), (270, 270), (360, 0)],
)
def test_parse_display_rotation_normalizes_quarter_turns(value, expected) -> None:
    stream = {"side_data_list": [{"rotation": value}]}
    assert _parse_display_rotation(stream) == expected


def test_parse_display_rotation_supports_legacy_rotate_tag() -> None:
    assert _parse_display_rotation({"tags": {"rotate": "90"}}) == 90


def test_parse_display_rotation_preserves_non_quarter_angles() -> None:
    assert _parse_display_rotation({"side_data_list": [{"rotation": 45}]}) == 45


def test_probe_reports_display_oriented_dimensions(tmp_path) -> None:
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        pytest.skip("ffmpeg unavailable")

    base = tmp_path / "base.mp4"
    rotated = tmp_path / "rotated.mp4"
    create = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=1:duration=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(base),
        ],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if create.returncode != 0:
        pytest.skip("cannot create orientation fixture")
    rotate = subprocess.run(
        [ffmpeg, "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", str(rotated)],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if rotate.returncode != 0:
        pytest.skip("ffmpeg does not support display_rotation")

    info = probe(rotated)

    assert (info.coded_width, info.coded_height) == (320, 240)
    assert (info.width, info.height) == (240, 320)
    assert info.display_rotation == 90
