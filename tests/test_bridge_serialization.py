import pytest

from tuck.bridge_serialization import (
    plan_preview_dict,
    profile_ui_dict,
    queue_item_dict,
    video_info_dict,
)
from tuck.models import (
    CropRect,
    EncodePlan,
    OutputGeometry,
    Profile,
    ProfileTransformIntent,
    QueueItem,
    Segment,
    VideoInfo,
    VideoTransform,
)


def test_video_info_serialization_includes_display_geometry() -> None:
    info = VideoInfo(
        path="phone.mp4",
        duration=3.0,
        width=1080,
        height=1920,
        coded_width=1920,
        coded_height=1080,
        display_rotation=90,
        fps=29.97,
        video_codec="h264",
    )

    data = video_info_dict(info)

    assert data["resolution"] == "1080x1920"
    assert data["coded_width"] == 1920
    assert data["coded_height"] == 1080
    assert data["display_rotation"] == 90


def test_profile_ui_serialization_has_one_explicit_bitrate_compatibility_switch() -> None:
    profile = Profile(
        name="Vertical",
        explicit_bitrate=2_000_000,
        transform_intent=ProfileTransformIntent(crop_aspect="9:16", sizing_mode="fill"),
    )

    settings_data = profile_ui_dict(profile)
    profile_data = profile_ui_dict(profile, include_explicit_bitrate=True)

    assert "explicit_bitrate" not in settings_data
    assert profile_data["explicit_bitrate"] == 2_000_000
    assert settings_data["explicit_bitrate_kbps"] == 2000
    assert settings_data["transform_intent"] == profile.transform_intent.to_dict()


def test_preview_serialization_includes_python_planned_geometry() -> None:
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        rotation=90,
        sizing_mode="fill",
        output=OutputGeometry(1080, 1920),
    )
    plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        target_width=1080,
        target_height=1920,
        source_info=VideoInfo(
            path="source.mp4",
            duration=10.0,
            width=1920,
            height=1080,
            fps=30.0,
            video_codec="h264",
        ),
        transform=transform,
    )

    data = plan_preview_dict(plan)

    assert data["transform"] == transform.to_dict()
    assert data["transform_geometry"] == {
        "selected_width": 800,
        "selected_height": 600,
        "oriented_width": 600,
        "oriented_height": 800,
        "fill_crop": {"x": 75, "y": 0, "width": 450, "height": 800},
        "output_width": 1080,
        "output_height": 1920,
    }


def test_preview_serialization_keeps_legacy_crop_field() -> None:
    crop = CropRect(10, 20, 200, 100)
    data = plan_preview_dict(
        EncodePlan(
            source="source.mp4",
            output="output.mp4",
            transform=VideoTransform(crop=crop),
        )
    )

    assert data["crop"] == crop.to_dict()
    assert data["transform_geometry"] is None


def test_multi_segment_preview_and_queue_serialization_is_not_a_continuous_trim() -> None:
    plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=VideoInfo(
            path="source.mp4",
            duration=10,
            width=1280,
            height=720,
            fps=30,
            video_codec="h264",
        ),
        segments=[Segment(0, 1.5), Segment(4, 6)],
    )

    preview = plan_preview_dict(plan)
    queued = queue_item_dict(QueueItem(plan=plan))

    for data in (preview, queued):
        assert data["segments"] == [
            {"start": 0.0, "end": 1.5},
            {"start": 4.0, "end": 6.0},
        ]
        assert data["segment_count"] == 2
        assert data["selected_duration"] == pytest.approx(3.5)
        assert data["trim_start"] is None
        assert data["trim_end"] is None
