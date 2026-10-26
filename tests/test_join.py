import json
import subprocess
from fractions import Fraction
from pathlib import Path
from threading import Event

import pytest
from conftest import wait_until
from media.cut_fixtures import find_tools

from tuck.joining.plan import (
    JoinError,
    concat_list,
    copy_command,
    copy_mismatch,
    encode_candidates,
    encode_command,
    joined_output,
    source_from_probe,
)
from tuck.joining.service import FFmpegRun, JoinService
from tuck.sidecar.handlers import dispatch
from tuck.sidecar.protocol import Request


def _probe(**video: object) -> dict[str, object]:
    stream = {
        "codec_type": "video",
        "codec_name": "h264",
        "profile": "High",
        "width": 1920,
        "height": 1080,
        "pix_fmt": "yuv420p",
        "sample_aspect_ratio": "1:1",
        "avg_frame_rate": "60/1",
        "r_frame_rate": "60/1",
        "extradata_hash": "SHA256:aa",
    }
    stream.update(video)
    audio = {
        "codec_type": "audio",
        "codec_name": "aac",
        "profile": "LC",
        "sample_rate": "48000",
        "channels": 2,
        "channel_layout": "stereo",
        "extradata_hash": "SHA256:bb",
    }
    return {"streams": [stream, audio], "format": {"duration": "12.5"}}


def _source(name: str = "a.mp4", **video: object):
    return source_from_probe(Path("/videos") / name, _probe(**video))


def test_matching_videos_join_without_re_encoding():
    sources = [_source("a.mp4"), _source("b.mp4")]
    assert sources[0].duration == 12.5
    assert sources[0].video.rate == Fraction(60)
    assert copy_mismatch(sources) == ""


@pytest.mark.parametrize(
    ("other", "reason"),
    [
        (_source("b.mkv"), "different kinds of files"),
        (_source("b.mp4", codec_name="hevc"), "different codecs (h264 and hevc)"),
        (_source("b.mp4", width=1280, height=720), "picture sizes differ (1920x1080 and 1280x720)"),
        (_source("b.mp4", avg_frame_rate="30/1"), "frame rates differ (60 fps and 30 fps)"),
        (_source("b.mp4", extradata_hash="SHA256:cc"), "different encoder settings"),
        (_source("b.mp4", side_data_list=[{"rotation": -90}]), "turned differently"),
    ],
)
def test_videos_that_cant_share_one_header_say_why(other, reason):
    assert reason in copy_mismatch([_source("a.mp4"), other])


def test_every_sound_track_has_to_match_for_a_lossless_join():
    two = _probe()
    two["streams"].append(dict(two["streams"][1]))
    first = source_from_probe(Path("/videos/a.mp4"), two)
    assert len(first.audio_tracks) == 2
    assert "numbers of sound tracks" in copy_mismatch([first, _source("b.mp4")])
    assert copy_mismatch([first, source_from_probe(Path("/videos/b.mp4"), two)]) == ""


def test_sound_has_to_match_for_a_lossless_join():
    silent = source_from_probe(Path("/videos/b.mp4"), {"streams": [_probe()["streams"][0]]})
    assert "sound" in copy_mismatch([_source(), silent])
    other_rate = _probe()
    other_rate["streams"][1]["sample_rate"] = "44100"
    assert "sound" in copy_mismatch([_source(), source_from_probe(Path("/v/b.mp4"), other_rate)])


def test_a_file_without_video_is_refused():
    with pytest.raises(JoinError, match="no video"):
        source_from_probe(Path("/videos/song.mp4"), {"streams": [_probe()["streams"][1]]})


def test_a_line_break_in_a_name_falls_back_to_re_encoding():
    odd = source_from_probe(Path("/videos/two\nlines.mp4"), _probe())
    assert "line break" in copy_mismatch([_source(), odd])


def test_concat_list_quotes_odd_names_the_way_ffmpeg_reads_them():
    paths = [Path("/v/it's a clip.mp4"), Path("/v/C:\\Games\\clip #1.mp4"), Path("/v/ünïcode.mp4")]
    lines = concat_list(paths).splitlines()
    # the names are made absolute, which on Windows adds the drive
    quote, backslashes, accents = (str(path.absolute()) for path in paths)
    assert lines[0] == "ffconcat version 1.0"
    assert lines[1] == "file '" + quote.replace("'", "'\\''") + "'"
    assert lines[2] == f"file '{backslashes}'" and "\\" in lines[2]
    assert lines[3] == f"file '{accents}'"


def test_joined_video_is_named_after_the_first_one():
    assert joined_output(Path("/v/Match 1.mov"), ".mov") == Path("/v/Match 1_joined.mov")
    assert joined_output(Path("/v/Match 1.mov"), ".mp4") == Path("/v/Match 1_joined.mp4")


def test_copy_and_encode_commands_keep_the_sources_untouched():
    sources = [_source("a.mp4"), _source("b.mp4", width=1280, height=720)]
    output = Path("/v/.tuck-x/joined.mp4")
    copy = copy_command("ffmpeg", Path("/v/.tuck-x/videos.ffconcat"), output)
    assert copy[-1] == str(output) and "-c" in copy and "copy" in copy
    # every sound track is copied, so game and microphone tracks stay apart
    assert copy[copy.index("0:v:0") + 1 : copy.index("0:v:0") + 3] == ["-map", "0:a?"]
    encode = encode_command("ffmpeg", sources, output, "libx264")
    assert encode[-1] == str(output)
    graph = encode[encode.index("-filter_complex") + 1]
    # every video is fitted into the first one's picture and frame rate
    assert graph.count("scale=1920:1080:force_original_aspect_ratio=decrease") == 2
    assert "concat=n=2:v=1:a=1" in graph and "fps=" not in graph
    assert encode[encode.index("-r") : encode.index("-r") + 4] == ["-r", "60/1", "-fps_mode", "cfr"]
    assert [encode[i + 1] for i, arg in enumerate(encode) if arg == "-i"] == [
        str(Path("/videos/a.mp4")),
        str(Path("/videos/b.mp4")),
    ]


def test_a_video_without_sound_gets_silence_in_a_re_encoded_join():
    data = _probe()
    silent = source_from_probe(Path("/videos/b.mp4"), {**data, "streams": data["streams"][:1]})
    graph = encode_command("ffmpeg", [_source(), silent], Path("/o.mp4"), "libx264")
    joined = graph[graph.index("-filter_complex") + 1]
    assert "anullsrc=r=48000:cl=stereo,atrim=duration=12.500000[a1]" in joined


def test_a_re_encoded_join_mixes_every_sound_track_into_one():
    two = _probe()
    two["streams"].append(dict(two["streams"][1]))
    recording = source_from_probe(Path("/videos/a.mp4"), two)
    command = encode_command("ffmpeg", [recording, _source("b.mp4")], Path("/o.mp4"), "libx264")
    graph = command[command.index("-filter_complex") + 1]
    # game and microphone are both heard, at their own levels, like an export with one track
    assert "[0:a:0]aresample=48000," in graph and "[0:a:1]aresample=48000," in graph
    mixed = "[a0t0][a0t1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a0]"
    assert mixed in graph
    assert "[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]" in graph
    assert "concat=n=2:v=1:a=1" in graph
    assert command.count("-map") == 2


def test_graphics_card_encoders_are_tried_before_the_processor():
    available = ["h264_nvenc", "h264_amf", "libx264", "hevc_nvenc", "libx265"]
    assert encode_candidates(available) == ["h264_nvenc", "h264_amf", "libx264"]
    assert encode_candidates([]) == ["libx264"]


class _Fixture:
    def __init__(self, tmp_path: Path, *, matching: bool = True) -> None:
        self.paths = [tmp_path / "Clip.mp4", tmp_path / "Other.mp4"]
        for path in self.paths:
            path.write_bytes(b"source bytes")
        self.matching = matching

    def probe(self, path: Path):
        size = {} if self.matching or path.name == "Clip.mp4" else {"width": 640, "height": 360}
        return source_from_probe(path, _probe(**size))


def _service(monkeypatch, fixture: _Fixture, runner, encoders=lambda: ["libx264"]):
    import tuck.joining.service as service

    monkeypatch.setattr(service, "probe_source", lambda _ffprobe, path: fixture.probe(path))
    return JoinService(runner=runner, tools=lambda: ("ffmpeg", "ffprobe"), encoders=encoders)


def _writes_output(command, duration, cancel, progress):
    progress(0.5)
    Path(command[-1]).write_bytes(b"joined")
    progress(1.0)
    return FFmpegRun(0, "")


def _finished(joins: JoinService, work_id: str):
    wait_until(lambda: joins.get(work_id).status != "running", what="the join to finish")
    return joins.get(work_id)


def test_join_publishes_beside_the_first_video_without_replacing_anything(tmp_path, monkeypatch):
    fixture = _Fixture(tmp_path)
    taken = tmp_path / "Clip_joined.mp4"
    taken.write_bytes(b"older join")
    commands = []

    def runner(command, duration, cancel, progress):
        commands.append(command)
        listing = Path(command[command.index("-i") + 1])
        assert listing.read_text(encoding="utf-8").count("file '") == 2
        return _writes_output(command, duration, cancel, progress)

    joins = _service(monkeypatch, fixture, runner)
    try:
        joins.start(fixture.paths, "join-1")
        result = _finished(joins, "join-1")
    finally:
        joins.close()
    assert result.status == "done" and result.lossless is True
    assert result.output_path == str(tmp_path / "Clip_joined_1.mp4")
    assert Path(result.output_path).read_bytes() == b"joined"
    assert taken.read_bytes() == b"older join"
    assert all(path.read_bytes() == b"source bytes" for path in fixture.paths)
    # the scratch folder and the reserved name are gone
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "Clip.mp4",
        "Clip_joined.mp4",
        "Clip_joined_1.mp4",
        "Other.mp4",
    ]
    assert "concat" in commands[0]


def test_different_videos_are_re_encoded_and_say_why(tmp_path, monkeypatch):
    fixture = _Fixture(tmp_path, matching=False)
    joins = _service(monkeypatch, fixture, _writes_output)
    try:
        joins.start(fixture.paths, "join-2")
        result = _finished(joins, "join-2")
    finally:
        joins.close()
    assert result.status == "done" and result.lossless is False
    assert "picture sizes differ" in result.reason
    assert result.encoder == "libx264"
    assert result.output_path.endswith("Clip_joined.mp4")


def test_a_graphics_card_that_fails_hands_the_join_to_the_processor(tmp_path, monkeypatch):
    fixture = _Fixture(tmp_path, matching=False)
    used = []

    def runner(command, duration, cancel, progress):
        encoder = command[command.index("-c:v") + 1]
        used.append(encoder)
        if encoder == "h264_nvenc":
            return FFmpegRun(1, "No NVENC capable devices found\n")
        return _writes_output(command, duration, cancel, progress)

    joins = _service(monkeypatch, fixture, runner, encoders=lambda: ["h264_nvenc", "libx264"])
    try:
        joins.start(fixture.paths, "join-3")
        result = _finished(joins, "join-3")
    finally:
        joins.close()
    assert used == ["h264_nvenc", "libx264"]
    assert result.status == "done" and result.encoder == "libx264"
    assert (
        result.fallback == "The NVIDIA encoder couldn't be used, so the processor made this video."
    )


def test_a_failed_join_says_what_happened_and_leaves_nothing_behind(tmp_path, monkeypatch):
    fixture = _Fixture(tmp_path)

    def runner(command, duration, cancel, progress):
        Path(command[-1]).write_bytes(b"partial")
        return FFmpegRun(1, "av_interleaved_write_frame(): No space left on device\n")

    joins = _service(monkeypatch, fixture, runner)
    try:
        joins.start(fixture.paths, "join-4")
        result = _finished(joins, "join-4")
    finally:
        joins.close()
    assert result.status == "failed" and result.code == "join_failed"
    assert result.message.startswith("The disk is full")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Clip.mp4", "Other.mp4"]


def test_cancelling_stops_ffmpeg_and_saves_nothing(tmp_path, monkeypatch):
    from tuck.joining.service import JoinCancelled

    fixture = _Fixture(tmp_path)
    started = Event()

    def runner(command, duration, cancel, progress):
        Path(command[-1]).write_bytes(b"partial")
        started.set()
        assert cancel.wait(5)
        raise JoinCancelled

    joins = _service(monkeypatch, fixture, runner)
    try:
        joins.start(fixture.paths, "join-5")
        assert started.wait(5)
        assert joins.cancel("join-5")
        result = _finished(joins, "join-5")
        assert not joins.cancel("join-5")
    finally:
        joins.close()
    assert result.status == "cancelled"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Clip.mp4", "Other.mp4"]


def test_one_join_runs_at_a_time_and_requests_are_checked(tmp_path, monkeypatch):
    fixture = _Fixture(tmp_path)
    release = Event()

    def runner(command, duration, cancel, progress):
        release.wait(5)
        return _writes_output(command, duration, cancel, progress)

    joins = _service(monkeypatch, fixture, runner)
    try:
        with pytest.raises(JoinError, match="between 2"):
            joins.start(fixture.paths[:1], "one")
        with pytest.raises(JoinError, match="only once"):
            joins.start([fixture.paths[0], fixture.paths[0]], "twice")
        joins.start(fixture.paths, "first")
        with pytest.raises(JoinError) as busy:
            joins.start(fixture.paths, "second")
        assert busy.value.code == "join_busy"
        release.set()
        assert _finished(joins, "first").status == "done"
        assert joins.get("unknown").status == "missing"
    finally:
        release.set()
        joins.close()


def test_missing_media_tools_are_named(tmp_path):
    fixture = _Fixture(tmp_path)
    joins = JoinService(tools=lambda: (None, "ffprobe"))
    try:
        joins.start(fixture.paths, "tools")
        result = _finished(joins, "tools")
    finally:
        joins.close()
    assert result.code == "tools_missing" and "Settings > Media tools" in result.message


def test_bridge_validates_join_requests_before_starting_work(tmp_path):
    from tuck.bridge import BridgeAPI

    api = BridgeAPI.__new__(BridgeAPI)
    api._joins = JoinService(tools=lambda: (None, None))
    fixture = _Fixture(tmp_path)
    paths = [str(path) for path in fixture.paths]
    try:
        for params in (
            {"paths": paths[:1], "work_id": "w"},
            {"paths": [paths[0], 3], "work_id": "w"},
            {"paths": paths, "work_id": 1},
            {"paths": paths, "work_id": "w", "output": "/tmp/x.mp4"},
        ):
            bad = dispatch(api, Request("bad", "join_videos", params))
            assert not bad.ok and bad.error.code == "INVALID_REQUEST"
        missing = dispatch(
            api, Request("gone", "join_videos", {"paths": [paths[0], "/nope.mp4"], "work_id": "w"})
        )
        assert not missing.ok and missing.error.code == "INVALID_JOIN"
        assert missing.error.details["field"] == "join"
        started = dispatch(api, Request("ok", "join_videos", {"paths": paths, "work_id": "w"}))
        assert started.ok and started.result["status"] == "running"
        wait_until(lambda: api._joins.get("w").status != "running")
        status = dispatch(api, Request("get", "get_join", {"work_id": "w"}))
        assert status.ok and status.result["code"] == "tools_missing"
        cancelled = dispatch(api, Request("cancel", "cancel_join", {"work_id": "w"}))
        assert cancelled.ok and cancelled.result == {"cancelled": False}
    finally:
        api._joins.close()


TOOLS = find_tools()
needs_ffmpeg = pytest.mark.skipif(TOOLS is None, reason="FFmpeg and FFprobe are needed")


def _encoders() -> str:
    assert TOOLS is not None
    return subprocess.run(
        [TOOLS.ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True
    ).stdout


def _clip(path: Path, *, size: str, rate: int, seconds: int, audio: bool = True) -> Path:
    assert TOOLS is not None
    args = ["-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
        args += ["-c:a", "aac", "-b:a", "96k", "-ac", "2"]
    args += ["-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-g", "30"]
    args += ["-pix_fmt", "yuv420p", str(path)]
    TOOLS.run(args)
    return path


def _streams(path: Path) -> dict[str, object]:
    assert TOOLS is not None
    output = TOOLS.run(
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], probe=True
    ).stdout
    return json.loads(output)


def _real_service() -> JoinService:
    assert TOOLS is not None
    return JoinService(tools=lambda: (TOOLS.ffmpeg, TOOLS.ffprobe), encoders=lambda: ["libx264"])


@needs_ffmpeg
def test_real_ffmpeg_joins_matching_clips_losslessly(tmp_path):
    if "libx264" not in _encoders():
        pytest.skip("this FFmpeg has no libx264 to make the test clips")
    folder = tmp_path / "it's a [test] folder"
    folder.mkdir()
    first = _clip(folder / "Round 1's clip.mp4", size="320x240", rate=30, seconds=2)
    second = _clip(folder / "Round 2.mp4", size="320x240", rate=30, seconds=3)
    joins = _real_service()
    try:
        joins.start([first, second], "real-copy")
        wait_until(lambda: joins.get("real-copy").status != "running", timeout=60)
        result = joins.get("real-copy")
    finally:
        joins.close()
    assert result.status == "done", result.message
    assert result.lossless is True
    output = Path(result.output_path)
    assert output == folder / "Round 1's clip_joined.mp4"
    data = _streams(output)
    assert float(data["format"]["duration"]) == pytest.approx(5.0, abs=0.1)
    assert [s["codec_name"] for s in data["streams"]] == ["h264", "aac"]


@needs_ffmpeg
def test_real_ffmpeg_re_encodes_clips_that_differ(tmp_path):
    if "libx264" not in _encoders():
        pytest.skip("this FFmpeg has no libx264 to make and re-encode the test clips")
    first = _clip(tmp_path / "wide.mp4", size="320x180", rate=30, seconds=2)
    second = _clip(tmp_path / "small.mp4", size="160x160", rate=25, seconds=2, audio=False)
    joins = _real_service()
    try:
        joins.start([first, second], "real-encode")
        wait_until(lambda: joins.get("real-encode").status != "running", timeout=120)
        result = joins.get("real-encode")
    finally:
        joins.close()
    assert result.status == "done", result.message
    assert result.lossless is False and result.encoder == "libx264"
    data = _streams(Path(result.output_path))
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = next(s for s in data["streams"] if s["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"]) == ("h264", 320, 180)
    # every frame of both videos, none skipped where they meet
    assert video["avg_frame_rate"] == "30/1" and int(video["nb_frames"]) == 120
    assert audio["codec_name"] == "aac"
    assert float(data["format"]["duration"]) == pytest.approx(4.0, abs=0.15)
    assert Path(result.output_path).name == "wide_joined.mp4"


@needs_ffmpeg
def test_real_ffmpeg_re_encoded_join_keeps_a_second_sound_track(tmp_path):
    if "libx264" not in _encoders():
        pytest.skip("this FFmpeg has no libx264 to make and re-encode the test clips")
    assert TOOLS is not None
    # a recording with a silent game track and the sound on its second (microphone) track
    recording = tmp_path / "recording.mp4"
    TOOLS.run(
        [
            *("-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30"),
            *("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"),
            *("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"),
            *("-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "2", "-ac", "2"),
            *("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"),
            *("-c:a", "aac", "-b:a", "96k", str(recording)),
        ]
    )
    other = _clip(tmp_path / "small.mp4", size="160x160", rate=25, seconds=2, audio=False)
    joins = _real_service()
    try:
        joins.start([recording, other], "real-tracks")
        wait_until(lambda: joins.get("real-tracks").status != "running", timeout=120)
        result = joins.get("real-tracks")
    finally:
        joins.close()
    assert result.status == "done", result.message
    output = Path(result.output_path)
    audio = [s for s in _streams(output)["streams"] if s["codec_type"] == "audio"]
    assert len(audio) == 1
    levels = TOOLS.run(
        ["-v", "info", "-i", str(output), "-t", "1.8", "-af", "volumedetect", "-f", "null", "-"]
    ).stderr.decode("utf-8", "replace")
    loudest = float(levels.split("max_volume:")[1].split("dB")[0])
    # the microphone's tone is there, not only the silent first track
    assert loudest > -40, levels[-400:]
