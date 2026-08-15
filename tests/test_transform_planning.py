from tuck.encoding.filters import build_plan_video_filters
from tuck.models import (
    RES_MODE_CUSTOM,
    RES_MODE_SOURCE,
    SIZING_MODE_FILL,
    SIZING_MODE_FIT,
    SIZING_MODE_STRETCH,
    CropRect,
    OutputGeometry,
    PlanRequest,
    Profile,
    ProfileTransformIntent,
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


def test_source_resolution_stretch_uses_uncropped_source_canvas(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    transform = VideoTransform(
        crop=CropRect(581, 0, 758, 1080),
        sizing_mode=SIZING_MODE_STRETCH,
    )

    result = plan(
        source,
        Profile(name="Stretch", resolution_mode=RES_MODE_SOURCE, two_pass=False),
        output=tmp_path / "output.mp4",
        request=PlanRequest(transform=transform),
        source_info=_source_info(source),
    )

    assert (result.target_width, result.target_height) == (1920, 1080)
    assert result.transform.output == OutputGeometry(1920, 1080)
    assert result.apply_scale
    assert build_plan_video_filters(result) == [
        "crop=758:1080:581:0:exact=1",
        "scale=1920:1080:flags=neighbor",
        "setsar=1",
    ]


def test_profile_transform_intent_is_materialized_for_source(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    profile = Profile(
        name="Vertical upload",
        resolution_mode=RES_MODE_CUSTOM,
        custom_width=1080,
        custom_height=1920,
        two_pass=False,
        transform_intent=ProfileTransformIntent(crop_aspect="9:16", sizing_mode="fill"),
    )

    result = plan(
        source,
        profile,
        output=tmp_path / "output.mp4",
        source_info=_source_info(source),
    )

    assert result.transform.crop is not None
    assert result.transform.crop.width * 16 == result.transform.crop.height * 9
    assert result.transform.crop.x + result.transform.crop.width <= 1920
    assert result.transform.crop.y + result.transform.crop.height <= 1080
    assert result.transform.crop_aspect == "9:16"
    assert (result.target_width, result.target_height) == (1080, 1920)


def test_rotated_profile_crop_aspect_is_final_orientation(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    profile = Profile(
        name="Rotated widescreen",
        two_pass=False,
        transform_intent=ProfileTransformIntent(crop_aspect="16:9", rotation=90),
    )

    result = plan(
        source,
        profile,
        output=tmp_path / "output.mp4",
        source_info=_source_info(source),
    )

    assert result.transform.crop is not None
    assert result.transform.crop.width * 16 == result.transform.crop.height * 9
    assert result.target_width * 9 == result.target_height * 16


def test_manual_job_transform_overrides_profile_intent(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    profile = Profile(
        name="Vertical upload",
        two_pass=False,
        transform_intent=ProfileTransformIntent(crop_aspect="9:16", sizing_mode="fill"),
    )
    manual = VideoTransform(
        crop=CropRect(100, 100, 800, 800),
        crop_aspect="free",
        sizing_mode=SIZING_MODE_FIT,
        output=OutputGeometry(1000, 1000),
    )

    result = plan(
        source,
        profile,
        output=tmp_path / "output.mp4",
        request=PlanRequest(transform=manual),
        source_info=_source_info(source),
    )

    assert result.transform.crop == manual.crop
    assert result.transform.crop_aspect == "free"
    assert result.transform.sizing_mode == SIZING_MODE_FIT
