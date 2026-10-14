import subprocess
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import pytest

from tuck.bridge import BridgeAPI
from tuck.media_tools import find_ffmpeg
from tuck.request_work import RequestWork

pytestmark = pytest.mark.usefixtures("skip_if_no_ffmpeg", "skip_if_no_ffprobe")


def write_video(
    path: Path, *, offset: int = 0, quadrants: bool = False, width: int = 960, height: int = 540
) -> Path:
    with av.open(str(path), "w") as container:
        stream = container.add_stream("ffv1", rate=10)
        stream.width, stream.height = width, height
        stream.pix_fmt = "bgr0"
        stream.time_base = Fraction(1, 1000)
        for pts, color in [(0, (255, 0, 0)), (100, (0, 255, 0)), (400, (0, 0, 255))]:
            pixels = np.full((height, width, 3), color, dtype=np.uint8)
            if quadrants:
                pixels[:270, :480] = (255, 0, 0)
                pixels[:270, 480:] = (0, 255, 0)
                pixels[270:, :480] = (0, 0, 255)
                pixels[270:, 480:] = (255, 255, 255)
            frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
            frame.pts = pts + offset
            frame.time_base = Fraction(1, 1000)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return path


@pytest.fixture
def source(tmp_path):
    return write_video(tmp_path / "colored.mkv")


def save(source: Path, output: Path, time: object = 0.0, **kwargs):
    return BridgeAPI.__new__(BridgeAPI).export_frame(
        {"source": str(source), "output": str(output), "time": time, **kwargs}
    )


def read_png(path: Path) -> np.ndarray:
    assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    with av.open(str(path)) as container:
        return next(container.decode(video=0)).to_ndarray(format="rgb24")


@pytest.mark.parametrize(
    "time,want_pts,want", [(0, 0, (255, 0, 0)), (0.35, 0.1, (0, 255, 0)), (0.5, 0.4, (0, 0, 255))]
)
def test_saves_native_size_previous_source_frame(source, tmp_path, time, want_pts, want):
    output = tmp_path / "żółć frame.PNG"
    result = save(source, output, time)
    assert result["ok"], result
    assert result["path"] == str(output)
    assert (result["width"], result["height"]) == (960, 540)
    assert result["time"] == pytest.approx(want_pts)
    assert result["warnings"] == []
    picture = read_png(output)
    assert picture.shape == (540, 960, 3)
    np.testing.assert_allclose(picture[270, 480], want, atol=2)
    assert set(tmp_path.iterdir()) == {source, output}


@pytest.mark.parametrize(
    "time,want_pts,want", [(0, 5, (255, 0, 0)), (5.35, 5.1, (0, 255, 0)), (5.5, 5.4, (0, 0, 255))]
)
def test_nonzero_source_pts_uses_absolute_playhead(tmp_path, time, want_pts, want):
    source = write_video(tmp_path / "offset.mkv", offset=5000)
    output = tmp_path / "frame.png"
    result = save(source, output, time)
    assert result["ok"], result
    assert result["time"] == pytest.approx(want_pts)
    np.testing.assert_allclose(read_png(output)[270, 480], want, atol=2)


@pytest.mark.parametrize(
    "time", [True, None, "0", -0.01, float("nan"), float("inf"), 10**1000, 0.6]
)
def test_rejects_invalid_or_past_end_time(source, tmp_path, time):
    output = tmp_path / "frame.png"
    result = save(source, output, time)
    assert result["ok"] is False
    assert "time" in result["error"].lower()
    assert not output.exists()


@pytest.mark.parametrize(
    "changes",
    [
        {"unexpected": 1},
        {"transform": {"output": {"width": 100, "height": 100}}},
        {"transform": {"rotation": True}},
        {"transform": {"unknown": 1}},
        {"transform": {"crop": {"x": 900, "y": 0, "width": 100, "height": 100}}},
        {"lut": {"strength": True}},
        {"lut": {"unknown": 1}},
        {"lut": {"enabled": True, "path": "missing.cube"}},
    ],
)
def test_rejects_invalid_edit_or_unknown_request(source, tmp_path, changes):
    output = tmp_path / "frame.png"
    result = save(source, output, **changes)
    assert result["ok"] is False
    assert result["error"]
    assert not output.exists()


@pytest.mark.parametrize("output", ["relative.png", "frame.jpg", "frame"])
def test_requires_absolute_png_destination(source, tmp_path, output):
    destination = output if output == "relative.png" else str(tmp_path / output)
    result = BridgeAPI.__new__(BridgeAPI).export_frame(
        {"source": str(source), "output": destination, "time": 0}
    )
    assert result["ok"] is False


def test_applies_crop_rotation_and_flips(source, tmp_path):
    output = tmp_path / "frame.png"
    result = save(
        source,
        output,
        transform={
            "crop": {"x": 10, "y": 20, "width": 400, "height": 200},
            "rotation": 90,
            "flip_horizontal": True,
            "flip_vertical": True,
        },
    )
    assert result["ok"], result
    assert read_png(output).shape == (400, 200, 3)


def test_square_pixels_preserve_source_display_shape(tmp_path):
    original = write_video(tmp_path / "original.mkv")
    source = tmp_path / "wide.mkv"
    subprocess.run(
        [find_ffmpeg(), "-y", "-i", str(original), "-vf", "setsar=2", "-c:v", "ffv1", str(source)],
        capture_output=True,
        check=True,
    )
    output = tmp_path / "frame.png"
    result = save(source, output)
    assert result["ok"], result
    assert read_png(output).shape == (540, 1920, 3)


def test_failed_save_preserves_destination_and_cleans_workspace(source, tmp_path, monkeypatch):
    output = tmp_path / "frame.png"
    output.write_bytes(b"original")
    monkeypatch.setattr("tuck.frame_export.find_ffmpeg", lambda: str(tmp_path / "missing.exe"))
    result = save(source, output)
    assert result["ok"] is False
    assert output.read_bytes() == b"original"
    assert set(tmp_path.iterdir()) == {source, output}


def test_cancelled_request_never_replaces_existing_destination(source, tmp_path):
    output = tmp_path / "frame.png"
    output.write_bytes(b"original")
    work = RequestWork()
    work.set()
    result = BridgeAPI.__new__(BridgeAPI).export_frame(
        {"source": str(source), "output": str(output), "time": 0}, work=work
    )
    assert result["ok"] is False
    assert output.read_bytes() == b"original"


def test_crop_rotation_and_both_flips_change_pixels(tmp_path):
    source = write_video(tmp_path / "quadrants.mkv", quadrants=True)
    output = tmp_path / "frame.png"
    result = save(
        source,
        output,
        transform={
            "crop": {"x": 0, "y": 0, "width": 800, "height": 400},
            "rotation": 90,
            "flip_horizontal": True,
            "flip_vertical": True,
        },
    )
    assert result["ok"], result
    picture = read_png(output)
    assert picture.shape == (800, 400, 3)
    np.testing.assert_allclose(picture[50, 50], (0, 255, 0), atol=2)
    np.testing.assert_allclose(picture[50, 350], (255, 255, 255), atol=2)
    np.testing.assert_allclose(picture[750, 50], (255, 0, 0), atol=2)
    np.testing.assert_allclose(picture[750, 350], (0, 0, 255), atol=2)


def test_metadata_rotation_matches_the_upright_source(tmp_path):
    original = write_video(tmp_path / "quadrants.mkv", quadrants=True)
    encoded = tmp_path / "encoded.mp4"
    source = tmp_path / "rotated.mp4"
    subprocess.run(
        [find_ffmpeg(), "-y", "-i", str(original), "-c:v", "libx264", "-crf", "0", str(encoded)],
        capture_output=True,
        check=True,
    )
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-display_rotation",
            "90",
            "-i",
            str(encoded),
            "-c",
            "copy",
            str(source),
        ],
        capture_output=True,
        check=True,
    )
    output = tmp_path / "frame.png"
    result = save(source, output)
    assert result["ok"], result
    picture = read_png(output)
    assert picture.shape == (960, 540, 3)
    np.testing.assert_allclose(picture[50, 50], (0, 255, 0), atol=4)
    np.testing.assert_allclose(picture[50, 490], (255, 255, 255), atol=4)
    np.testing.assert_allclose(picture[910, 50], (255, 0, 0), atol=4)
    np.testing.assert_allclose(picture[910, 490], (0, 0, 255), atol=4)


def test_tall_pixel_aspect_keeps_full_source_detail(tmp_path):
    original = write_video(tmp_path / "original.mkv")
    source = tmp_path / "tall.mkv"
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-i",
            str(original),
            "-vf",
            "setsar=1/2",
            "-c:v",
            "ffv1",
            str(source),
        ],
        capture_output=True,
        check=True,
    )
    output = tmp_path / "frame.png"
    result = save(source, output)
    assert result["ok"], result
    assert read_png(output).shape == (1080, 960, 3)


def test_missing_and_nonvideo_sources_fail_without_creating_output(tmp_path):
    output = tmp_path / "frame.png"
    source = tmp_path / "missing.mkv"
    assert save(source, output)["ok"] is False
    source.write_bytes(b"not a video")
    assert save(source, output)["ok"] is False
    assert not output.exists()


def test_imported_lut_changes_pixels(source, tmp_path, monkeypatch):
    from tuck.lut import import_lut
    from tuck.settings import configure_storage_root, get_settings_manager

    monkeypatch.setattr("tuck.settings._settings_manager", None)
    monkeypatch.setattr("tuck.settings._storage_root", None)
    configure_storage_root(tmp_path / "settings")
    lut_source = tmp_path / "invert.cube"
    lut_source.write_text("LUT_1D_SIZE 2\n1 1 1\n0 0 0\n")
    lut = import_lut(lut_source, get_settings_manager().data_dir / "luts")
    output = tmp_path / "frame.png"
    result = save(source, output, lut={"enabled": True, "path": str(lut.path), "strength": 1})
    assert result["ok"], result
    np.testing.assert_allclose(read_png(output)[270, 480], (0, 255, 255), atol=2)


def test_hdr_frame_uses_the_export_tone_mapping(source, tmp_path):
    from tuck.encoding.capabilities import can_tone_map_hdr
    from tuck.probe import probe

    if not can_tone_map_hdr():
        pytest.skip("FFmpeg has no HDR tone mapping filters")
    hdr = tmp_path / "hdr.mkv"
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-i",
            str(source),
            "-vf",
            "format=yuv420p10le,setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc",
            "-pix_fmt",
            "yuv420p10le",
            "-c:v",
            "ffv1",
            "-colorspace",
            "bt2020nc",
            "-color_trc",
            "smpte2084",
            "-color_primaries",
            "bt2020",
            str(hdr),
        ],
        capture_output=True,
        check=True,
    )
    assert probe(hdr).is_hdr
    output = tmp_path / "frame.png"
    result = save(hdr, output)
    assert result["ok"], result
    assert result["warnings"] == []
    assert read_png(output).shape == (540, 960, 3)
    # converting tagged PQ directly to RGB clips this red to 255; tone mapping
    # keeps the display-referred highlight below that clipped result
    red = read_png(output)[270, 480]
    assert 20 < red[0] < 250


def test_sidecar_frame_request_validates_envelope_and_reports_published_file(source, tmp_path):
    from tuck.sidecar.handlers import dispatch
    from tuck.sidecar.protocol import Request

    api = BridgeAPI.__new__(BridgeAPI)
    output = tmp_path / "frame.png"
    request = {"source": str(source), "output": str(output), "time": 0.35}
    response = dispatch(api, Request("frame", "export_frame", {"request": request}))
    assert response.ok
    assert response.result["path"] == str(output)
    np.testing.assert_allclose(read_png(output)[270, 480], (0, 255, 0), atol=2)
    invalid = dispatch(
        api, Request("invalid", "export_frame", {"request": request, "unexpected": 1})
    )
    assert not invalid.ok
    assert invalid.error.code == "INVALID_REQUEST"


def test_odd_source_dimensions_are_not_rounded_for_video_encoding(tmp_path):
    source = write_video(tmp_path / "odd.mkv", width=961, height=541)
    output = tmp_path / "frame.png"
    result = save(source, output)
    assert result["ok"], result
    assert read_png(output).shape == (541, 961, 3)


def test_verification_failure_preserves_existing_file_and_cleans_workspace(
    source, tmp_path, monkeypatch
):
    def corrupt_png(command, work):
        Path(command[-1]).write_bytes(b"not a PNG")

    output = tmp_path / "frame.png"
    output.write_bytes(b"original")
    monkeypatch.setattr("tuck.frame_export._run_ffmpeg", corrupt_png)
    result = save(source, output)
    assert result["ok"] is False
    assert output.read_bytes() == b"original"
    assert set(tmp_path.iterdir()) == {source, output}


def test_successful_save_atomically_replaces_existing_file(source, tmp_path):
    output = tmp_path / "frame.png"
    output.write_bytes(b"original")
    result = save(source, output)
    assert result["ok"], result
    assert result["path"] == str(output)
    assert read_png(output).shape == (540, 960, 3)
    assert set(tmp_path.iterdir()) == {source, output}


def test_expired_request_never_replaces_existing_destination(source, tmp_path):
    output = tmp_path / "frame.png"
    output.write_bytes(b"original")
    result = BridgeAPI.__new__(BridgeAPI).export_frame(
        {"source": str(source), "output": str(output), "time": 0}, work=RequestWork(seconds=-1)
    )
    assert result["ok"] is False
    assert "timed out" in result["error"].lower()
    assert output.read_bytes() == b"original"


def test_frame_geometry_override_leaves_default_video_alignment_unchanged():
    from tuck.encoding.filters import build_plan_video_filters
    from tuck.models import EncodePlan, TransformGeometry, VideoInfo

    plan = EncodePlan(
        source="source.mkv",
        output="frame.png",
        source_info=VideoInfo("source.mkv", 1, 961, 541, 60, "ffv1"),
    )
    assert build_plan_video_filters(plan) == ["scale=960:540:flags=neighbor", "setsar=1"]
    exact = TransformGeometry(961, 541, 961, 541, None, 961, 541)
    assert build_plan_video_filters(plan, geometry=exact) == []


def test_destination_directory_cannot_be_saved_as_a_numbered_png(source, tmp_path):
    output = tmp_path / "folder.png"
    output.mkdir()
    result = save(source, output)
    assert result["ok"] is False
    assert set(tmp_path.iterdir()) == {source, output}
