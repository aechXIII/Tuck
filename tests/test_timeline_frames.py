import subprocess
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from itertools import count
from pathlib import Path
from types import SimpleNamespace

import av
import numpy as np
import pytest
from av.video.frame import VideoFrame

from tuck import timeline_frames
from tuck.media_server import MediaServer
from tuck.media_tools import find_ffmpeg
from tuck.request_work import RequestWork


@pytest.fixture
def source(tmp_path):
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is required for timeline media fixtures")
    source = tmp_path / "moving.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=20:duration=2",
            "-c:v",
            "libx264",
            "-g",
            "40",
            "-bf",
            "0",
            "-y",
            str(source),
        ],
        check=True,
    )
    return source


@pytest.fixture
def server(tmp_path):
    server = MediaServer()
    server.set_thumbnail_cache_dir(tmp_path / "cache")
    return server


def picture(path):
    with av.open(str(path)) as container:
        return next(container.decode(video=0)).to_ndarray(format="rgb24")


def generate(server, source, **kwargs):
    assert hasattr(server, "generate_timeline_frames"), "timeline sprite generation is missing"
    return server.generate_timeline_frames(
        source,
        **{
            "start": 0,
            "step": 0.25,
            "count": 16,
            "mode": "whole",
            "exact": False,
            **kwargs,
        },
    )


def test_sprite_clips_at_eof_and_keeps_the_source_grid(server, source):
    sprite = generate(server, source, start=1.5)
    assert sprite is not None
    assert (sprite.start, sprite.step, sprite.count) == (1.5, 0.25, 2)
    assert picture(sprite.path).shape == (84, 300, 3)
    assert generate(server, source, start=3) is None


def test_a_saved_strip_comes_back_without_loading_pyav(server, source, monkeypatch):
    first = generate(server, source)
    assert first is not None

    def no_wait() -> None:
        raise AssertionError("the saved strip waited for PyAV")

    monkeypatch.setattr("tuck.timeline_frames.load_media_libraries", no_wait)
    again = generate(server, source)
    assert again is not None
    assert (again.path, again.count) == (first.path, first.count)


def test_exact_frames_refine_keyframes_and_cache_separates_requests(server, source):
    key = generate(server, source, count=4)
    exact = generate(server, source, count=4, exact=True)
    assert key and exact and key.path != exact.path
    key_pixels, exact_pixels = picture(key.path), picture(exact.path)
    assert np.array_equal(key_pixels[:, :150], key_pixels[:, 150:300])
    assert not np.array_equal(exact_pixels[:, :150], exact_pixels[:, 150:300])
    assert generate(server, source, count=4) == key
    assert generate(server, source, count=4, mode="center").path != key.path
    assert generate(server, source, count=4, step=0.5).path != key.path
    before = Path(key.path).stat().st_ino
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert all(
            item == key for item in pool.map(lambda _: generate(server, source, count=4), range(8))
        )
    assert Path(key.path).stat().st_ino == before
    assert not list(Path(key.path).parent.glob(".timeline-*"))


@pytest.mark.parametrize(
    "field,value",
    [
        ("start", -1),
        ("start", float("nan")),
        ("start", True),
        ("step", 0),
        ("step", float("inf")),
        ("step", True),
        ("count", 0),
        ("count", 33),
        ("count", 1.5),
        ("count", True),
        ("mode", "other"),
        ("mode", []),
        ("exact", 1),
    ],
)
def test_invalid_requests_are_rejected_before_decode(server, source, field, value):
    with pytest.raises(ValueError):
        generate(server, source, **{field: value})


def test_corrupt_or_missing_media_has_no_sprite(server, tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"broken media")
    assert generate(server, bad) is None
    assert generate(server, tmp_path / "missing.mp4") is None


def test_rotated_center_crop_removes_outer_content_and_whole_keeps_letterboxing(server, tmp_path):
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is required for rotation fixture")
    original = tmp_path / "landscape.mp4"
    rotated = tmp_path / "portrait.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=lime:size=160x90:duration=0.2,drawbox=x=0:y=0:w=32:h=90:color=red:t=fill",
            "-c:v",
            "libx264",
            "-y",
            str(original),
        ],
        check=True,
    )
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-display_rotation",
            "90",
            "-i",
            str(original),
            "-c",
            "copy",
            "-y",
            str(rotated),
        ],
        check=True,
    )
    whole = generate(server, rotated, count=1)
    center = generate(server, rotated, count=1, mode="center")
    assert whole and center
    whole_pixels, center_pixels = picture(whole.path), picture(center.path)
    assert np.max(whole_pixels[:, :40]) < 12

    def red(pixels):
        return (pixels[:, :, 0] > 120) & (pixels[:, :, 1] < 70)

    assert np.count_nonzero(red(whole_pixels)) > 300
    assert np.count_nonzero(red(center_pixels)) == 0


def test_source_change_invalidates_sprite_and_cancelled_requests_do_not_publish(server, source):
    first = generate(server, source, count=2)
    source.touch()
    second = generate(server, source, count=2)
    assert first and second and first.path != second.path
    work = RequestWork()
    work.set()
    with pytest.raises(TimeoutError):
        generate(server, source, count=3, work=work)


def test_concurrent_first_requests_publish_one_complete_sprite(server, source):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: generate(server, source, start=0.125, count=3), range(4)))
    assert all(result == results[0] for result in results)
    assert results[0] and picture(results[0].path).shape == (84, 450, 3)
    assert len(list(Path(results[0].path).parent.glob("timeline_*.png"))) == 1


def test_exact_samples_closer_than_frame_period_reuse_the_same_picture(server, source):
    result = generate(server, source, start=0.001, step=0.001, count=4, exact=True)
    assert result
    pixels = picture(result.path)
    assert np.array_equal(pixels[:, :150], pixels[:, 150:300])
    assert np.array_equal(pixels[:, :150], pixels[:, 450:600])
    first = generate(server, source, count=1)
    assert first
    assert np.array_equal(pixels[:, :150], picture(first.path))


def test_exact_samples_hold_vfr_picture_until_its_next_timestamp(server, source, tmp_path):
    ffmpeg = find_ffmpeg()
    vfr = tmp_path / "vfr.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            "select='eq(n,0)+gte(n,10)'",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-bf",
            "0",
            "-g",
            "40",
            "-y",
            str(vfr),
        ],
        check=True,
    )
    reference = generate(server, vfr, count=1)
    sampled = generate(server, vfr, start=0.1, step=0.1, count=4, exact=True)
    assert reference and sampled
    pixels = picture(sampled.path)
    assert np.array_equal(pixels[:, :150], picture(reference.path))
    assert np.array_equal(pixels[:, :150], pixels[:, 450:600])


def test_cancellation_during_decode_propagates_and_publishes_nothing(server, source, monkeypatch):
    work = RequestWork()
    open_media = av.open

    def cancel_when_opening(*args, **kwargs):
        work.set()
        return open_media(*args, **kwargs)

    monkeypatch.setattr(av, "open", cancel_when_opening)
    with pytest.raises(TimeoutError):
        generate(server, source, work=work)
    assert not list((source.parent / "cache").glob("timeline_*.png"))


def test_unknown_duration_clips_decoded_eof_and_preserves_vfr_holds(
    server, source, tmp_path, monkeypatch
):
    ffmpeg = find_ffmpeg()
    vfr = tmp_path / "unknown-duration.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            "select='eq(n,0)+gte(n,10)'",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-bf",
            "0",
            "-g",
            "40",
            "-y",
            str(vfr),
        ],
        check=True,
    )
    open_media = av.open

    class StreamWithoutDuration:
        def __init__(self, stream):
            self.stream = stream
            self.duration = None

        def __getattr__(self, name):
            return getattr(self.stream, name)

    class ContainerWithoutDuration:
        def __init__(self, container):
            self.container = container
            self.duration = None
            self.streams = SimpleNamespace(
                video=[StreamWithoutDuration(container.streams.video[0])]
            )

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.container.close()

        def seek(self, offset, *, stream, backward):
            return self.container.seek(offset, stream=stream.stream, backward=backward)

        def demux(self, stream):
            return self.container.demux(stream.stream)

    # only remove duration metadata; seeks, decoded pictures and timestamps remain real
    with monkeypatch.context() as patch:
        patch.setattr(
            av,
            "open",
            lambda *args, **kwargs: ContainerWithoutDuration(open_media(*args, **kwargs)),
        )
        sampled = generate(server, vfr, start=0.1, step=0.1, count=32, exact=True)
    assert sampled and sampled.count == 19
    pixels = picture(sampled.path)
    assert pixels.shape == (84, 2850, 3)
    assert np.array_equal(pixels[:, :150], pixels[:, 450:600])


@pytest.fixture
def keyframes(tmp_path):
    """Four seconds with a keyframe every half second, and B-frames, which hold pictures back."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is required for timeline media fixtures")
    path = tmp_path / "keyframes.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=20:duration=4",
            "-c:v",
            "libx264",
            "-g",
            "10",
            "-keyint_min",
            "10",
            "-sc_threshold",
            "0",
            "-bf",
            "2",
            "-y",
            str(path),
        ],
        check=True,
    )
    return path


def test_threads_draw_the_same_pictures_as_one_thread(server, keyframes, tmp_path, monkeypatch):
    requests = [
        {"start": 0.1, "step": 0.25, "count": 16},
        {"start": 0.0, "step": 0.6, "count": 6, "exact": True},
        {"start": 0.3, "step": 0.1, "count": 12, "exact": True},
    ]
    monkeypatch.setattr(timeline_frames, "_DECODE_THREADS", 4)
    monkeypatch.setattr(timeline_frames, "_DECODERS", 4)
    threaded = [generate(server, keyframes, **request) for request in requests]
    monkeypatch.setattr(timeline_frames, "_DECODE_THREADS", 1)
    monkeypatch.setattr(timeline_frames, "_DECODERS", 1)
    alone = MediaServer()
    alone.set_thumbnail_cache_dir(tmp_path / "alone")
    for request, sprite in zip(requests, threaded, strict=True):
        single = generate(alone, keyframes, **request)
        assert sprite and single and sprite.count == single.count == request["count"]
        assert np.array_equal(picture(sprite.path), picture(single.path))


def test_a_keyframe_picture_is_the_keyframe_itself(server, keyframes):
    # B-frames make the decoder hold a keyframe back, so it is flushed out on its own; it must
    # still be the picture an exact request shows at that keyframe
    key = generate(server, keyframes, step=0.5, count=8)
    exact = generate(server, keyframes, step=0.5, count=8, exact=True)
    assert key and exact and key.count == exact.count == 8
    assert np.array_equal(picture(key.path), picture(exact.path))
    assert not np.array_equal(picture(key.path)[:, :150], picture(key.path)[:, 150:300])


def test_one_failing_thread_fails_the_whole_request(server, keyframes, monkeypatch):
    monkeypatch.setattr(timeline_frames, "_DECODERS", 4)
    draw = timeline_frames._TileDrawer.draw
    drawn = count()

    def fail_once(drawer, frame):
        if next(drawn) == 5:
            raise ValueError("Could not draw timeline picture")
        return draw(drawer, frame)

    monkeypatch.setattr(timeline_frames._TileDrawer, "draw", fail_once)
    assert generate(server, keyframes, count=16) is None
    assert not list((keyframes.parent / "cache").glob("timeline_*.png"))


def test_a_picture_of_another_shape_gets_its_own_drawing():
    wide = VideoFrame.from_ndarray(np.full((90, 160, 3), (200, 30, 30), np.uint8), format="rgb24")
    tall = VideoFrame.from_ndarray(np.full((160, 90, 3), (30, 200, 30), np.uint8), format="rgb24")
    shared = timeline_frames._TileDrawer("whole", Fraction(1))
    for frame in (wide, tall, wide):
        alone = timeline_frames._TileDrawer("whole", Fraction(1))
        assert np.array_equal(shared.draw(frame), alone.draw(frame))
