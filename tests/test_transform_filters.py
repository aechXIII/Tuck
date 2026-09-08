from pathlib import Path

import pytest

from tuck.encoding.command import build_base_cmd
from tuck.encoding.filters import build_video_filters
from tuck.engine import FFmpegEngine
from tuck.models import (
    RCM_CBR,
    SIZING_MODE_FILL,
    SIZING_MODE_FIT,
    CropRect,
    EncodePlan,
    OutputGeometry,
    VideoInfo,
    VideoTransform,
)


def _info(width=1920, height=1080):
    return VideoInfo(
        path="source.mp4",
        duration=10.0,
        width=width,
        height=height,
        fps=30.0,
        video_codec="h264",
    )


def _filters(transform, width=1920, height=1080):
    return build_video_filters(
        transform=transform,
        source_width=width,
        source_height=height,
        scaler="lanczos",
    )


def test_crop_and_rotate_filter_order():
    transform = VideoTransform(crop=CropRect(100, 50, 800, 600), rotation=90)
    assert _filters(transform) == ["crop=800:600:100:50:exact=1", "transpose=clock"]


@pytest.mark.parametrize(
    ("horizontal", "vertical", "expected"),
    [
        (False, False, []),
        (True, False, ["hflip"]),
        (False, True, ["vflip"]),
        (True, True, ["hflip", "vflip"]),
    ],
)
def test_crop_and_flip_filter_order(horizontal, vertical, expected):
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        flip_horizontal=horizontal,
        flip_vertical=vertical,
    )
    assert _filters(transform) == ["crop=800:600:100:50:exact=1", *expected]


def test_crop_and_fit_filter_order():
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        sizing_mode=SIZING_MODE_FIT,
        output=OutputGeometry(1000, 1000),
    )
    assert _filters(transform) == [
        "crop=800:600:100:50:exact=1",
        "scale=1000:750:flags=lanczos",
    ]


def test_crop_and_fill_filter_order():
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1000, 1000),
    )
    assert _filters(transform) == [
        "crop=800:600:100:50:exact=1",
        "crop=600:600:100:0:exact=1",
        "scale=1000:1000:flags=lanczos",
    ]


def test_crop_and_stretch_filter_order():
    transform = VideoTransform(
        crop=CropRect(660, 0, 600, 1080),
        sizing_mode="stretch",
        output=OutputGeometry(1920, 1080),
    )
    assert _filters(transform) == [
        "crop=600:1080:660:0:exact=1",
        "scale=1920:1080:flags=lanczos",
        "setsar=1",
    ]


def test_crop_rotate_and_scale_filter_order():
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        rotation=90,
        sizing_mode=SIZING_MODE_FIT,
        output=OutputGeometry(1080, 1920),
    )
    assert _filters(transform) == [
        "crop=800:600:100:50:exact=1",
        "transpose=clock",
        "scale=1080:1440:flags=lanczos",
    ]


def test_full_combined_transform_filter_order():
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        rotation=90,
        flip_horizontal=True,
        flip_vertical=True,
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1080, 1920),
    )
    assert _filters(transform) == [
        "crop=800:600:100:50:exact=1",
        "transpose=clock",
        "hflip",
        "vflip",
        "crop=450:800:75:0:exact=1",
        "scale=1080:1920:flags=lanczos",
    ]


@pytest.mark.parametrize("encoder", ["libx264", "h264_nvenc", "h264_amf"])
def test_all_encoders_share_the_combined_filter_chain(encoder):
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        rotation=270,
        flip_horizontal=True,
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1080, 1920),
    )
    plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_info(),
        video_encoder=encoder,
        rate_control_method=RCM_CBR,
        transform=transform,
    )
    cmd = build_base_cmd("ffmpeg", plan, Path(plan.source))
    assert cmd[cmd.index("-vf") + 1] == (
        "crop=800:600:100:50:exact=1,transpose=cclock,hflip,"
        "crop=450:800:75:0:exact=1,scale=1080:1920:flags=neighbor"
    )


def test_two_pass_uses_the_same_combined_filter_chain(monkeypatch, tmp_path):
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        rotation=90,
        flip_vertical=True,
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1080, 1920),
    )
    plan = EncodePlan(
        source="source.mp4",
        output=str(tmp_path / "output.mp4"),
        source_info=_info(),
        two_pass=True,
        transform=transform,
    )
    commands = []
    engine = FFmpegEngine()
    monkeypatch.setattr(
        engine,
        "_run_pass",
        lambda command, *_args, **_kwargs: commands.append(command),
    )
    engine._encode_two_pass(
        "ffmpeg",
        plan,
        Path(plan.source),
        Path(plan.output),
        10.0,
        None,
    )
    pass_filters = [command[command.index("-vf") + 1] for command in commands]
    assert len(pass_filters) == 2
    assert pass_filters[0] == pass_filters[1]


def test_target_size_retries_preserve_the_complete_transform(tmp_path):
    output = tmp_path / "output.mp4"
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        crop_aspect="4:3",
        rotation=270,
        flip_horizontal=True,
        flip_vertical=True,
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1080, 1920),
    )
    plan = EncodePlan(
        source="source.mp4",
        output=str(output),
        video_bitrate=1_000_000,
        audio_bitrate=0,
        two_pass=False,
        target_size=10_000_000,
        rate_control_method=RCM_CBR,
        transform=transform,
    )
    seen = []
    engine = FFmpegEngine()

    def encode_once(_ffmpeg, attempt_plan, *_args, **_kwargs):
        seen.append(attempt_plan.transform)
        output.write_bytes(b"x" * 4_000_000)
        return output

    engine._encode_single_pass = encode_once
    engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 10.0, None)
    # one retry happens on the undershoot, then the content-limited output stops it
    assert len(seen) == 2
    assert seen == [transform] * 2
