from tuck.models import (
    RES_MODE_CUSTOM,
    SIZING_MODE_FILL,
    SIZING_MODE_FIT,
    CropRect,
    OutputGeometry,
    PlanRequest,
    Profile,
    VideoInfo,
    VideoTransform,
)
from tuck.planner import plan


def _source_info(path, width=1920, height=1080):
    return VideoInfo(
        path=str(path),
        duration=10.0,
        width=width,
        height=height,
        fps=30.0,
        video_codec="h264",
    )


def test_planner_inverts_source_output_for_quarter_turn(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    result = plan(
        source,
        Profile(name="Rotate", two_pass=False),
        output=tmp_path / "output.mp4",
        request=PlanRequest(transform=VideoTransform(rotation=90, sizing_mode=SIZING_MODE_FIT)),
        source_info=_source_info(source),
    )
    assert (result.target_width, result.target_height) == (1080, 1920)
    assert result.transform.output == OutputGeometry(1080, 1920)


def test_planner_fit_reports_contained_final_dimensions(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    transform = VideoTransform(
        sizing_mode=SIZING_MODE_FIT,
        output=OutputGeometry(1080, 1920),
    )
    result = plan(
        source,
        Profile(name="Fit", two_pass=False),
        output=tmp_path / "output.mp4",
        request=PlanRequest(transform=transform),
        source_info=_source_info(source),
    )
    assert (result.target_width, result.target_height) == (1080, 608)
    assert result.apply_scale


def test_planner_fill_reports_requested_final_dimensions(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    transform = VideoTransform(
        crop=CropRect(660, 0, 600, 1080),
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1080, 1920),
    )
    result = plan(
        source,
        Profile(name="Fill", two_pass=False),
        output=tmp_path / "output.mp4",
        request=PlanRequest(transform=transform),
        source_info=_source_info(source),
    )
    assert (result.target_width, result.target_height) == (1080, 1920)
    assert result.apply_scale


def test_legacy_custom_request_keeps_stretch_compatibility(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    request = PlanRequest(
        resolution_mode=RES_MODE_CUSTOM,
        custom_width=1000,
        custom_height=1000,
    )
    result = plan(
        source,
        Profile(name="Legacy", two_pass=False),
        output=tmp_path / "output.mp4",
        request=request,
        source_info=_source_info(source),
    )
    assert (result.target_width, result.target_height) == (1000, 1000)
    assert result.transform.sizing_mode == "stretch"


def test_explicit_stretch_scales_crop_to_source_geometry(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        sizing_mode="stretch",
        output=OutputGeometry(1920, 1080),
    )
    result = plan(
        source,
        Profile(name="Stretch", two_pass=False),
        output=tmp_path / "output.mp4",
        request=PlanRequest(transform=transform),
        source_info=_source_info(source),
    )
    assert (result.target_width, result.target_height) == (1920, 1080)
    assert result.apply_scale
