from dataclasses import replace
from fractions import Fraction

import pytest

from tuck.encoding import frame_blending
from tuck.encoding.command import _tmix_graph, can_hardware_decode_blend
from tuck.models import EncodePlan, FrameBlending, Segment, VideoInfo


def plan_for(duration=19.166667, **settings):
    return EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=VideoInfo(
            "source.mp4",
            duration,
            2560,
            1440,
            300,
            "av1",
            pixel_format="yuv420p",
            color_space="bt709",
            color_range="pc",
            color_transfer="bt709",
            color_primaries="bt709",
        ),
        target_fps=60,
        frame_blending=FrameBlending(enabled=True, curve="gaussian", **settings),
    )


def expanded(blend):
    result = []
    for piece in blend.pieces:
        frames = [
            [(end - len(piece.weights) + 1 + i, int(w)) for i, w in enumerate(piece.weights) if w]
            for end in range(piece.first, piece.last + 1, piece.step)
        ]
        result.extend([frames[0]] * piece.lead + frames + [frames[-1]] * piece.trail)
    return result


@pytest.mark.parametrize(
    "duration,count,outputs,last",
    [
        (19.166667, 5750, 1151, [(5747, 4400), (5748, 21565), (5749, 39571)]),
        (119.466667, 35837, 7169, [(35836, 65536)]),
    ],
)
def test_weighted_yuv_keeps_the_checked_gaussian_windows(
    monkeypatch, duration, count, outputs, last
):
    monkeypatch.setattr(
        frame_blending,
        "_frame_grid_samples",
        lambda *_: ([Fraction(i, 300) for i in range(count)], Fraction(1, 300)),
        raising=False,
    )
    blend = frame_blending.weighted_yuv_blend(plan_for(duration))
    assert blend is not None and blend.weighted
    windows = expanded(blend)
    assert len(windows) == outputs
    assert windows[0] == list(zip(range(5), [6339, 15758, 21342, 15758, 6339], strict=True))
    assert windows[-1] == last
    if count == 35837:
        assert windows[-2] == [(35835, 6339), (35836, 59197)]
    assert all(sum(weight for _, weight in window) == 65536 for window in windows)
    assert can_hardware_decode_blend(plan_for(duration), blend)


@pytest.mark.parametrize(
    "changes",
    [
        {"pixel_format": "rgb24"},
        {"color_space": "unknown"},
        {"variable_frame_rate": True},
        {"display_rotation": 90},
    ],
)
def test_weighted_yuv_keeps_unsupported_sources_on_the_existing_path(changes):
    plan = plan_for()
    plan.source_info = replace(plan.source_info, **changes)
    assert frame_blending.weighted_yuv_blend(plan) is None


def test_weighted_yuv_keeps_linear_light_and_edited_timelines_on_the_existing_path():
    assert frame_blending.weighted_yuv_blend(plan_for(linear_light=True)) is None
    plan = plan_for()
    plan.segments = [Segment(0, 1), Segment(3, 4)]
    assert frame_blending.weighted_yuv_blend(plan) is None


def test_weighted_yuv_downloads_once_and_preserves_all_end_windows(monkeypatch):
    monkeypatch.setattr(
        frame_blending,
        "_frame_grid_samples",
        lambda *_: ([Fraction(i, 300) for i in range(5750)], Fraction(1, 300)),
        raising=False,
    )
    blend = frame_blending.weighted_yuv_blend(plan_for())
    software = ";".join(_tmix_graph(blend, []))
    cuda = ";".join(_tmix_graph(blend, [], download=True))
    assert cuda.count("hwdownload") == 1
    assert cuda.replace("hwdownload,format=nv12,", "") == software
    assert "weights='4400 21565 39571'" in software
    assert "range=full" in software


@pytest.mark.parametrize("returncode,expected", [(0, True), (1, False)])
def test_linux_cuda_device_probe_works_without_hardware_encoding(monkeypatch, returncode, expected):
    from types import SimpleNamespace

    from tuck.encoding import hardware_decoding

    commands = []

    def run(command, **kwargs):
        commands.append(command)
        assert kwargs["stdin"] is not None
        return SimpleNamespace(returncode=returncode, stderr=b"device unavailable")

    monkeypatch.setattr(hardware_decoding.subprocess, "run", run)
    assert (
        hardware_decoding.device_available("ffmpeg", hardware_decoding.HardwareDecode("cuda"))
        is expected
    )
    assert "-init_hw_device" in commands[0]
    assert "h264_nvenc" not in commands[0]


@pytest.mark.ffmpeg
def test_weighted_yuv_preserves_rejection_of_interlaced_sources(tmp_path, skip_if_no_ffmpeg):
    import subprocess

    import av

    from tuck.encoding.runner import FFmpegEngine
    from tuck.media_tools import find_ffmpeg
    from tuck.models.encoding_policy import RCM_CRF, WORKFLOW_UPSCALE
    from tuck.probe import probe

    source = tmp_path / "interlaced.mp4"
    subprocess.run(
        [
            find_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x48:rate=50:duration=1",
            "-c:v",
            "libx264",
            "-flags",
            "+ilme+ildct",
            "-x264-params",
            "tff=1",
            "-color_range",
            "tv",
            "-vf",
            "setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709",
            "-colorspace",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_primaries",
            "bt709",
            str(source),
        ],
        check=True,
    )
    with av.open(str(source)) as container:
        assert next(container.decode(video=0)).interlaced_frame
    info = probe(source)
    plan = EncodePlan(
        source=str(source),
        output=str(tmp_path / "output.mp4"),
        source_info=info,
        target_width=64,
        target_height=48,
        target_fps=25,
        two_pass=False,
        workflow=WORKFLOW_UPSCALE,
        rate_control_method=RCM_CRF,
        video_encoder="libx264",
        audio_enabled=False,
        frame_blending=FrameBlending(enabled=True, curve="gaussian"),
    )
    assert frame_blending.weighted_yuv_blend(plan) is None
    with pytest.raises(ValueError, match="progressive video"):
        FFmpegEngine().encode(plan)


@pytest.mark.ffmpeg
@pytest.mark.parametrize("audio_enabled", [False, True])
def test_weighted_yuv_keeps_final_hold_when_audio_outlasts_video(
    tmp_path, skip_if_no_ffmpeg, audio_enabled
):
    import subprocess

    import av

    from tuck.encoding.runner import FFmpegEngine
    from tuck.media_tools import find_ffmpeg
    from tuck.models.encoding_policy import RCM_CRF, WORKFLOW_UPSCALE
    from tuck.probe import probe

    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            find_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x48:rate=300:duration=1.056666667",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1.068:sample_rate=48000",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-vf",
            "setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709",
            "-color_range",
            "tv",
            "-c:a",
            "aac",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    info = probe(source)
    plan = EncodePlan(
        source=str(source),
        output=str(tmp_path / "output.mp4"),
        source_info=info,
        target_width=64,
        target_height=48,
        target_fps=60,
        two_pass=False,
        workflow=WORKFLOW_UPSCALE,
        rate_control_method=RCM_CRF,
        preset="ultrafast",
        video_encoder="libx264",
        audio_bitrate=128_000,
        audio_sample_rate=48_000,
        audio_enabled=audio_enabled,
        frame_blending=FrameBlending(enabled=True, curve="gaussian"),
    )
    blend = frame_blending.weighted_yuv_blend(plan)
    assert blend is not None
    expected = len(expanded(blend))
    assert len(blend.pieces) == 3
    output = FFmpegEngine().encode(plan)
    with av.open(str(output)) as container:
        assert len(container.streams.audio) == int(audio_enabled)
        if audio_enabled:
            audio = container.streams.audio[0]
            assert abs(float(audio.duration * audio.time_base) - info.duration) < 0.002
        frames = list(container.decode(video=0))
    assert len(frames) == expected
    assert frames[-1].pts * frames[-1].time_base == Fraction(expected - 1, 60)


@pytest.mark.ffmpeg
@pytest.mark.parametrize("amount", [0.5, 1, 2, 4])
@pytest.mark.parametrize(
    "curve", ["gaussian", "triangular", "ascending", "descending", "vegas", "custom"]
)
def test_weighted_yuv_export_keeps_pixels_and_its_last_frame(
    tmp_path, skip_if_no_ffmpeg, amount, curve
):
    import subprocess

    import av
    import numpy as np

    from tuck.encoding import runner
    from tuck.media_tools import find_ffmpeg
    from tuck.models.encoding_policy import RCM_CRF, WORKFLOW_UPSCALE
    from tuck.probe import probe

    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            find_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x48:rate=12:duration=1",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-vf",
            "setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_primaries",
            "bt709",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    plan = EncodePlan(
        source=str(source),
        output=str(tmp_path / "output.mp4"),
        source_info=probe(str(source)),
        target_width=64,
        target_height=48,
        target_fps=4,
        workflow=WORKFLOW_UPSCALE,
        rate_control_method=RCM_CRF,
        two_pass=False,
        preset="ultrafast",
        crf=0,
        audio_enabled=False,
        frame_blending=FrameBlending(
            enabled=True,
            curve="equal" if curve == "custom" else curve,
            amount=amount,
            custom_weights=(0, 3, 1, 0, 7) if curve == "custom" else (),
        ),
    )
    blend = frame_blending.weighted_yuv_blend(plan)
    assert blend is not None
    output = runner.FFmpegEngine().encode(plan)
    with av.open(str(output)) as container:
        frames = list(container.decode(video=0))
    assert len(frames) == 4
    assert [frame.pts * frame.time_base for frame in frames] == [Fraction(n, 4) for n in range(4)]
    with av.open(str(source)) as container:
        source_pixels = [
            frame.to_ndarray(format="yuv420p").astype(np.float64)
            for frame in container.decode(video=0)
        ]
    for frame, window in zip(frames, expanded(blend), strict=True):
        expected = np.rint(sum(source_pixels[i] * weight for i, weight in window) / 65536)
        assert np.max(np.abs(frame.to_ndarray(format="yuv420p").astype(int) - expected)) <= 1


@pytest.mark.parametrize(
    "curve", ["gaussian", "triangular", "ascending", "descending", "vegas", "custom"]
)
@pytest.mark.parametrize("amount", [0.5, 1, 2, 4])
def test_weighted_yuv_keeps_reference_window_placement_and_density(monkeypatch, curve, amount):
    import numpy as np

    plan = plan_for(1.003334, amount=amount)
    plan.frame_blending = FrameBlending(
        enabled=True,
        curve="equal" if curve == "custom" else curve,
        amount=amount,
        custom_weights=(0, 3, 1, 0, 7) if curve == "custom" else (),
    )
    times = [Fraction(i, 300) for i in range(301)]
    monkeypatch.setattr(frame_blending, "_frame_grid_samples", lambda *_: (times, Fraction(1, 300)))
    blend = frame_blending.weighted_yuv_blend(plan)
    assert blend is not None
    expected = []

    def sources(*_):
        for n, t in enumerate(times):
            yield float(t), np.array([[[n & 255, n >> 8, 0]]], dtype=np.uint8)

    def capture(weighted, *_):
        weights = frame_blending._integer_weights([weight for _, weight in weighted])
        expected.append(
            [
                (int(pixels[0, 0, 0]) + 256 * int(pixels[0, 0, 1]), weight)
                for (pixels, _), weight in zip(weighted, weights, strict=True)
                if weight
            ]
        )
        return weighted[0][0]

    monkeypatch.setattr(frame_blending, "_source_frames", sources)
    monkeypatch.setattr(frame_blending, "_blend", capture)
    monkeypatch.setattr(frame_blending, "_workers", lambda: 1)
    list(frame_blending.blended_frames(plan, lambda: None))
    actual = expanded(blend)
    assert len(actual) == len(expected)
    for a, b in zip(actual, expected, strict=True):
        a, b = dict(a), dict(b)
        # a stable window avoids float timestamp noise in remainder ties
        assert max(abs(a.get(i, 0) - b.get(i, 0)) for i in a.keys() | b.keys()) <= 1
