from __future__ import annotations

import dataclasses
import subprocess
import threading
from pathlib import Path

import pytest
from conftest import wait_until

from tuck.encoding.gif import (
    build_gif_command,
    gif_dimensions,
    make_gif,
    preview_plan,
    read_gif_frames,
)
from tuck.encoding.runner import EncodeCancelled, FFmpegEngine
from tuck.gif_preview import GifPreviews
from tuck.models import (
    CropRect,
    EncodePlan,
    PlanRequest,
    Profile,
    Segment,
    VideoInfo,
    VideoTransform,
)
from tuck.models.gif import GifSettings
from tuck.planner import plan as make_plan
from tuck.planner import plan_gif
from tuck.queue_store import _saved_export, export_record


def _base(duration: float = 12.0, **changes: object) -> EncodePlan:
    info = VideoInfo(
        path="clip.mp4", duration=duration, width=1280, height=720, fps=60, video_codec="h264"
    )
    plan = EncodePlan(
        source="clip.mp4",
        output="clip_tucked.mp4",
        source_info=info,
        target_width=1280,
        target_height=720,
        segments=[Segment(0, duration)],
    )
    return dataclasses.replace(plan, **changes)


def _gif(base: EncodePlan | None = None, **settings: object) -> EncodePlan:
    return dataclasses.replace(
        base or _base(), output="clip_tucked.gif", gif=GifSettings(**settings)
    )


def test_settings_refuse_values_a_gif_cant_have():
    assert GifSettings.from_dict({"width": 320, "fps": 24, "speed": 2}) == GifSettings(
        width=320, fps=24.0, speed=2.0
    )
    for bad in (
        {"fps": 60},
        {"width": 8},
        {"colors": 300},
        {"speed": 8},
        {"dither": "dots"},
        {"size_limit": 1000},
        {"back_and_forth": 1},
        {"loop": 0},
    ):
        with pytest.raises(ValueError):
            GifSettings.from_dict(bad)


def test_plan_names_the_gif_and_keeps_it_within_the_video(tmp_path):
    source = tmp_path / "Replay.mp4"
    source.write_bytes(b"x")
    base = _base(source=str(source), target_width=640, target_height=360)
    gif = plan_gif(base, GifSettings(width=1280, fps=50), compression_suffix="_tucked_{size}")
    assert Path(gif.output).name == "Replay_tucked.gif"
    assert gif.gif is not None
    # never wider than the exported picture or faster than the video
    assert gif.gif.width == 640
    assert gif.gif.fps == 50.0
    slow = dataclasses.replace(base, source_info=dataclasses.replace(base.source_info, fps=24))
    assert plan_gif(slow, GifSettings(fps=30)).gif.fps == 24.0
    assert gif.audio_enabled is False and gif.target_size == 0
    (tmp_path / "Replay_tucked.gif").write_bytes(b"x")
    assert Path(plan_gif(base, GifSettings()).output).name == "Replay_tucked_1.gif"


def test_gif_keeps_the_crop_shape():
    tall = _base(target_width=406, target_height=720)
    assert gif_dimensions(tall, 320) == (320, 568)
    assert gif_dimensions(_base(), 480) == (480, 270)
    assert gif_dimensions(_base(), 5000) == (1280, 720)


def test_command_seeks_to_each_segment_and_builds_the_palette():
    plan = _gif(_base(segments=[Segment(1, 2), Segment(4, 5)]), colors=64, plays=3)
    cmd = build_gif_command("ffmpeg", plan, plan.gif, Path("out.gif"), width=480, fps=15)
    assert cmd.count("-i") == 2
    assert cmd[cmd.index("-ss") + 1] == "1.000000"
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "concat=n=2:v=1:a=0[joined]" in graph
    assert "fps=15,scale=480:270:flags=lanczos" in graph
    assert "palettegen=max_colors=64:stats_mode=diff" in graph
    assert "paletteuse=dither=sierra2_4a:diff_mode=rectangle[gif]" in graph
    # plays three times: the first, then two repeats
    assert cmd[cmd.index("-loop") + 1] == "2"
    assert cmd[-4:] == ["-f", "gif", "-y", "out.gif"]


def test_command_choices_reach_ffmpeg():
    plan = _gif(
        speed=2.0,
        back_and_forth=True,
        plays=1,
        dither="pattern",
        palette="frame",
        sharp_pixels=True,
        drop_repeated_frames=True,
    )
    cmd = build_gif_command("ffmpeg", plan, plan.gif, Path("out.gif"), width=320, fps=10)
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "setpts=PTS/2,fps=10,scale=320:180:flags=neighbor," in graph
    assert ",mpdecimate[picture]" in graph
    assert "[backward]reverse[reversed]" in graph
    assert "stats_mode=single" in graph and "dither=bayer" in graph and ":new=1" in graph
    assert cmd[cmd.index("-loop") + 1] == "-1"


def test_gaps_stay_black_in_a_placed_timeline():
    plan = _gif(_base(segments=[Segment(1, 2, 0.0), Segment(4, 5, 1.5)]))
    cmd = build_gif_command("ffmpeg", plan, plan.gif, Path("out.gif"), width=480, fps=15)
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert cmd.count("-i") == 1
    assert "color=black" in graph


def test_a_long_timeline_is_previewed_from_pieces():
    long = _gif(_base(duration=120))
    pieces = [Segment(10, 11), Segment(50, 51), Segment(90, 91)]
    sample, scale = preview_plan(long, longest=30, pieces=pieces)
    assert sample.segments == pieces
    assert scale == pytest.approx(40)
    short = _gif(_base(duration=20))
    assert preview_plan(short, longest=30, pieces=pieces) == (short, 1.0)


def _write(path: Path, size: int) -> None:
    path.write_bytes(b"GIF89a" + (2).to_bytes(2, "little") * 2 + b"\x00\x00\x00" + b"\x3b")
    with path.open("ab") as handle:
        handle.truncate(size)


def test_size_limit_lowers_the_frame_rate_then_the_width(tmp_path):
    # a stand-in FFmpeg whose GIF size follows the frame rate and the picture's area
    runs: list[tuple[float, int]] = []

    def run(cmd: list[str], seconds: float) -> None:
        graph = cmd[cmd.index("-filter_complex") + 1]
        fps = float(graph.split("fps=")[1].split(",")[0])
        width = int(graph.split("scale=")[1].split(":")[0])
        runs.append((fps, width))
        _write(Path(cmd[-1]), round(fps * width * width * 0.5625 * 2))

    limited = _gif(width=480, fps=30, size_limit=2_000_000)
    result = make_gif("ffmpeg", limited, tmp_path / "out.gif", run)
    assert result.lowered and result.fits
    assert runs[0] == (30, 480)
    # every lower frame rate is predicted too big, so the width comes down at 10 fps
    assert runs[1:] == [(10, 388), (10, 432)]
    assert (result.fps, result.width) == (10, 388)
    assert (tmp_path / "out.gif").stat().st_size == result.size <= 2_000_000
    assert sorted(path.name for path in tmp_path.iterdir()) == ["out.gif"]

    # a bigger step the prediction skipped is tried, and kept when it fits
    runs.clear()
    roomy = make_gif(
        "ffmpeg", _gif(width=480, fps=30, size_limit=2_150_000), tmp_path / "roomy.gif", run
    )
    assert runs[1:] == [(10, 388), (10, 432)]
    assert (roomy.fps, roomy.width, roomy.fits) == (10, 432, True)

    tiny = _gif(width=480, fps=30, size_limit=100 * 1024)
    result = make_gif("ffmpeg", tiny, tmp_path / "tiny.gif", run)
    # the smallest setting is the closest it gets, and it says so
    assert not result.fits and result.lowered
    assert result.fps == 10 and result.width < 200


def test_a_gif_export_is_saved_with_its_own_kind():
    record = export_record("a1b2c3d4e5f6", _gif(), "2026-11-07T10:00:00", running=False)
    assert record["kind"] == "gif"
    restored = _saved_export(record)
    assert restored.plan.gif == GifSettings()
    video = export_record("a1b2c3d4e5f6", _base(), "2026-11-07T10:00:00", running=False)
    assert video["kind"] == "encode"
    with pytest.raises(ValueError):
        _saved_export({**record, "kind": "encode"})


class _BlockingEngine(FFmpegEngine):
    def __init__(self, started: threading.Event) -> None:
        super().__init__()
        self.started = started

    def make_gif(self, plan, output, on_progress=None, *, size_scale=1.0):  # type: ignore[override]
        del plan, on_progress, size_scale
        self.started.set()
        wait_until(self._cancel_event.is_set, timeout=5, what="cancel")
        raise EncodeCancelled("stopped")


def test_a_new_preview_stops_the_one_before_it(tmp_path):
    started = threading.Event()
    previews = GifPreviews(lambda: tmp_path, engine_factory=lambda: _BlockingEngine(started))
    failures: list[BaseException] = []

    def first() -> None:
        try:
            previews.make(_gif())
        except BaseException as exc:
            failures.append(exc)

    thread = threading.Thread(target=first)
    thread.start()
    assert started.wait(5)
    assert previews.cancel() is True
    thread.join(5)
    assert len(failures) == 1 and isinstance(failures[0], EncodeCancelled)
    assert not list((tmp_path / "gif-previews").glob("*.gif"))
    assert previews.cancel() is False


def test_bridge_waits_for_exports_and_refuses_bad_settings(monkeypatch, tmp_path):
    import tuck.settings as settings_mod
    from tuck.bridge import BridgeAPI

    monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
    api = BridgeAPI()
    api._settings.load()

    monkeypatch.setattr(api._queue, "snapshot", lambda: ([], object(), []))
    busy = api.make_gif_preview({"plan": {"source": "clip.mp4"}, "gif": {}, "_request_id": 3})
    assert busy == {
        "ok": False,
        "code": "export_running",
        "error": "Tuck makes the preview once the exports finish.",
        "_request_id": 3,
    }
    refused = api.enqueue_gif({"plan": {"source": "clip.mp4"}, "gif": {"fps": 90}})
    assert refused["ok"] is False
    assert api.cancel_gif_preview() == {"ok": True, "cancelled": False}


def test_refusals_reach_the_page_with_their_codes():
    from tuck.sidecar import handlers
    from tuck.sidecar.server import MEDIA_METHODS

    for method in ("make_gif_preview", "cancel_gif_preview", "enqueue_gif"):
        assert method in handlers._HANDLERS
    assert "make_gif_preview" in MEDIA_METHODS
    assert "cancel_gif_preview" not in MEDIA_METHODS
    for method in ("make_gif_preview", "estimate_size"):
        assert handlers._domain_code(method, None, "export_running") == "export_running"
        assert handlers._domain_code(method, None, "cancelled") == "cancelled"


def _source(tmp_path: Path) -> Path:
    from tuck.media_tools import find_ffmpeg

    source = tmp_path / "moving.mp4"
    ffmpeg = find_ffmpeg()
    assert ffmpeg
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=6",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        timeout=60,
    )
    return source


def _real_plan(source: Path, settings: GifSettings, **request: object) -> EncodePlan:
    from tuck.probe import probe

    profile = Profile(name="GIF", two_pass=False)
    base = make_plan(
        str(source),
        profile,
        request=PlanRequest(source=str(source), **request),
        source_info=probe(str(source)),
    )
    return plan_gif(base, settings)


@pytest.mark.usefixtures("skip_if_no_ffmpeg")
def test_real_gif_has_the_frames_and_shape_asked_for(tmp_path):
    source = _source(tmp_path)
    engine = FFmpegEngine()
    plain = _real_plan(source, GifSettings(width=320, fps=10), segments=[Segment(1, 3)])
    result = engine.make_gif(plain, tmp_path / "plain.gif")
    assert (result.width, result.height, result.frames) == (320, 180, 20)
    assert read_gif_frames(result.path) == (320, 180, 20)

    bounce = _real_plan(
        source,
        GifSettings(width=240, fps=10, speed=2.0, back_and_forth=True),
        segments=[Segment(0, 2), Segment(4, 6)],
    )
    assert engine.make_gif(bounce, tmp_path / "bounce.gif").frames == 40

    tall = _real_plan(
        source,
        GifSettings(width=180, fps=10),
        segments=[Segment(1, 2)],
        transform=VideoTransform(
            crop=CropRect(220, 0, 202, 360), crop_aspect="9:16", sizing_mode="fit"
        ),
    )
    shaped = engine.make_gif(tall, tmp_path / "tall.gif")
    assert (shaped.width, shaped.height) == (180, 320)


@pytest.mark.usefixtures("skip_if_no_ffmpeg")
def test_real_gif_export_is_published_and_meets_its_size_limit(tmp_path):
    source = _source(tmp_path)
    whole = _real_plan(source, GifSettings(width=640, fps=30), segments=[Segment(0, 4)])
    size = FFmpegEngine().make_gif(whole, tmp_path / "whole.gif").size
    limit = max(size // 3, 100 * 1024)
    limited = _real_plan(
        source, GifSettings(width=640, fps=30, size_limit=limit), segments=[Segment(0, 4)]
    )
    output = FFmpegEngine().encode(limited)
    assert output.suffix == ".gif" and output.name == "moving_tucked.gif"
    assert output.stat().st_size <= limit
    width, _, frames = read_gif_frames(output)
    assert width < 640 or frames < 120
    assert not list(tmp_path.glob("*.reserved"))
