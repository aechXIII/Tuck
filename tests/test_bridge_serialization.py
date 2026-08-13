from tuck.bridge_serialization import plan_preview_dict
from tuck.models import (
    CropRect,
    EncodePlan,
    OutputGeometry,
    VideoInfo,
    VideoTransform,
)


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
