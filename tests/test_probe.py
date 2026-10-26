from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from tuck.media_tools import find_ffmpeg, find_ffprobe
from tuck.probe import (
    FFPROBE_MISSING_MESSAGE,
    FILE_MISSING_MESSAGE,
    NO_AUDIO_MESSAGE,
    NO_PERMISSION_MESSAGE,
    NO_VIDEO_MESSAGE,
    TOO_SLOW_MESSAGE,
    UNREADABLE_MESSAGE,
    FFprobeMissing,
    MissingStream,
    ProbeTimeout,
    _run_ffprobe_json,
    _video_info,
    describe_probe_failure,
    parse_display_rotation,
    probe,
    probe_audio,
)

_VIDEO = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2"]
_AUDIO = ["-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2"]
_X264 = ["-c:v", "libx264", "-preset", "ultrafast"]

# files whose details the in-process reader must describe exactly as ffprobe does; the second
# list remuxes the first file, as phones and editors tag rotation after encoding
_PARITY_CASES: dict[str, tuple[list[str], list[str] | None]] = {
    "plain.mp4": ([*_VIDEO, *_AUDIO, *_X264, "-c:a", "aac"], None),
    "matroska.mkv": ([*_VIDEO, *_AUDIO, *_X264, "-c:a", "aac"], None),
    "transport.ts": ([*_VIDEO, *_X264, "-output_ts_offset", "3600"], None),
    "variable_rate.mp4": ([*_VIDEO, "-vf", "select='not(mod(n\\,3))+eq(n\\,1)'",
                           "-fps_mode", "vfr", *_X264], None),
    "ntsc.mp4": (["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30000/1001:duration=2",
                  *_X264], None),
    "anamorphic.mp4": ([*_VIDEO, "-vf", "setsar=16/11", *_X264], None),
    "full_range_bt2020.mp4": ([*_VIDEO, *_X264, "-pix_fmt", "yuvj420p", "-color_range", "pc",
                               "-color_primaries", "bt2020", "-color_trc", "smpte2084",
                               "-colorspace", "bt2020nc"], None),
    "audio_first.mp4": ([*_AUDIO, *_VIDEO, "-map", "0:a", "-map", "1:v", *_X264, "-c:a", "aac"],
                        None),
    "display_matrix.mp4": ([*_VIDEO, *_X264], ["-display_rotation:v:0", "270"]),
    "rotate_tag.mov": ([*_VIDEO, *_X264], ["-metadata:s:v:0", "rotate=90"]),
}  # fmt: skip


def _ffmpeg(ffmpeg: str, args: list[str]) -> bool:
    result = subprocess.run(
        [ffmpeg, "-y", "-v", "error", *args],
        capture_output=True,
        timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return result.returncode == 0


def test_probe_audio_accepts_audio_only_files(tmp_path, monkeypatch) -> None:
    source = tmp_path / "music.flac"
    source.write_bytes(b"audio")
    monkeypatch.setattr("tuck.media_tools.find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        "tuck.probe.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=(
                '{"format":{"duration":"12.5"},"streams":['
                '{"codec_type":"audio","codec_name":"flac","channels":2,'
                '"sample_rate":"48000","bit_rate":"900000"}]}'
            ),
            stderr="",
        ),
    )

    info = probe_audio(source)

    assert info.duration == 12.5
    assert info.codec == "flac"
    assert info.channels == 2
    assert info.sample_rate == 48_000
    assert info.bitrate == 900_000


@pytest.mark.parametrize("reader", [probe, probe_audio])
def test_ffprobe_fallback_reads_relative_dash_prefixed_paths(tmp_path, monkeypatch, reader):
    ffmpeg = find_ffmpeg()
    if not ffmpeg or not find_ffprobe():
        pytest.skip("ffmpeg and ffprobe are needed to check fallback paths")
    source = tmp_path / "-clip.mp4"
    assert _ffmpeg(ffmpeg, [*_VIDEO, *_AUDIO, *_X264, "-c:a", "aac", str(source)])

    def unreadable_by_pyav(_source):
        raise ValueError("use the fallback reader")

    monkeypatch.setattr("tuck.probe._read_with_pyav", unreadable_by_pyav)
    monkeypatch.chdir(tmp_path)

    info = reader(source.name)

    assert info.duration == pytest.approx(2, abs=0.1)
    assert info.path == source.name


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, 0), (90, 90), (-90, 270), (180, 180), (270, 270), (360, 0)],
)
def test_parse_display_rotation_normalizes_quarter_turns(value, expected) -> None:
    stream = {"side_data_list": [{"rotation": value}]}
    assert parse_display_rotation(stream) == expected


@pytest.mark.parametrize(("tag", "expected"), [("90", 270), ("270", 90), ("-90", 90), ("180", 180)])
def test_parse_display_rotation_supports_legacy_rotate_tag(tag, expected) -> None:
    assert parse_display_rotation({"tags": {"rotate": tag}}) == expected


def test_display_matrix_takes_precedence_over_legacy_tag() -> None:
    stream = {"side_data_list": [{"rotation": 90}], "tags": {"rotate": "270"}}
    assert parse_display_rotation(stream) == 90


def test_parse_display_rotation_preserves_non_quarter_angles() -> None:
    assert parse_display_rotation({"side_data_list": [{"rotation": 45}]}) == 45


def test_probe_reports_display_oriented_dimensions(tmp_path) -> None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("ffmpeg unavailable")

    base = tmp_path / "base.mp4"
    rotated = tmp_path / "rotated.mp4"
    create = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=1:duration=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(base),
        ],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if create.returncode != 0:
        pytest.skip("cannot create orientation fixture")
    rotate = subprocess.run(
        [ffmpeg, "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", str(rotated)],
        capture_output=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if rotate.returncode != 0:
        pytest.skip("ffmpeg does not support display_rotation")

    info = probe(rotated)

    assert (info.coded_width, info.coded_height) == (320, 240)
    assert (info.width, info.height) == (240, 320)
    assert info.display_rotation == 90


@pytest.mark.parametrize("name", sorted(_PARITY_CASES))
def test_probe_reads_the_same_details_as_ffprobe_without_starting_it(
    tmp_path, monkeypatch, name
) -> None:
    ffmpeg = find_ffmpeg()
    ffprobe = find_ffprobe()
    if not ffmpeg or not ffprobe:
        pytest.skip("ffmpeg and ffprobe are needed to compare the readers")
    encode, remux = _PARITY_CASES[name]
    source = tmp_path / name
    if remux is None:
        made = _ffmpeg(ffmpeg, [*encode, str(source)])
    else:
        base = tmp_path / f"base{source.suffix}"
        made = _ffmpeg(ffmpeg, [*encode, str(base)])
        if name.startswith("display_matrix"):
            made = made and _ffmpeg(ffmpeg, [*remux, "-i", str(base), "-c", "copy", str(source)])
        else:
            made = made and _ffmpeg(ffmpeg, ["-i", str(base), "-c", "copy", *remux, str(source)])
    if not made:
        pytest.skip(f"ffmpeg cannot create {name}")
    expected = _video_info(
        source, source.stat().st_size, _run_ffprobe_json(ffprobe, source, "probing")
    )

    def no_ffprobe(*_args, **_kwargs):
        raise AssertionError("probe started ffprobe")

    monkeypatch.setattr("tuck.probe._run_ffprobe_json", no_ffprobe)

    assert probe(source) == expected


def test_probe_falls_back_to_ffprobe_when_pyav_cannot_read(tmp_path, monkeypatch) -> None:
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"not a video")
    monkeypatch.setattr("tuck.media_tools.find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        "tuck.probe.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout=(
                '{"format":{"duration":"8.0","bit_rate":"2000000"},"streams":['
                '{"codec_type":"video","codec_name":"h264","width":1280,"height":720,'
                '"r_frame_rate":"30/1","avg_frame_rate":"30/1"}]}'
            ),
            stderr="",
        ),
    )

    info = probe(source)

    assert (info.width, info.height, info.duration, info.video_codec) == (1280, 720, 8.0, "h264")


def test_video_info_keeps_average_rate_track_count_and_hdr(tmp_path) -> None:
    source = tmp_path / "clip.mp4"
    data = {
        "format": {"duration": "4.0"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "hevc",
                "width": 1920,
                "height": 1080,
                "r_frame_rate": "120/1",
                "avg_frame_rate": "59/2",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
            },
            {"codec_type": "audio", "codec_name": "aac", "channels": 2},
            {"codec_type": "audio", "codec_name": "ac3", "channels": 6},
        ],
    }

    info = _video_info(source, 0, data)

    assert info.variable_frame_rate is True
    assert info.fps == 120.0
    assert info.average_fps == pytest.approx(29.5)
    assert info.decision_fps == pytest.approx(29.5)
    assert info.audio_stream_count == 2
    assert info.audio_channels == 2
    assert info.is_hdr


def test_video_info_lists_subtitle_tracks_in_file_order(tmp_path) -> None:
    source = tmp_path / "film.mkv"
    data = {
        "format": {"duration": "4.0"},
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360},
            {"codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"},
            {"codec_type": "audio", "codec_name": "aac", "channels": 2},
            {"codec_type": "subtitle", "codec_name": "subrip"},
        ],
    }

    info = _video_info(source, 0, data)

    assert info.subtitle_codecs == ["hdmv_pgs_subtitle", "subrip"]
    # counted among subtitle tracks, the way FFmpeg's 0:s:N names them
    assert info.text_subtitle_track == 1


def test_subtitle_tracks_survive_a_saved_plan(tmp_path) -> None:
    from tuck.models import EncodePlan, VideoInfo

    info = VideoInfo(
        path=str(tmp_path / "film.mkv"),
        duration=4.0,
        width=640,
        height=360,
        fps=25.0,
        video_codec="h264",
        subtitle_codecs=["ass"],
    )
    plan = EncodePlan(source=info.path, output=str(tmp_path / "out.mp4"), source_info=info)
    restored = EncodePlan.from_dict(plan.to_dict())
    assert restored.source_info is not None
    assert restored.source_info.text_subtitle_track == 0

    saved_before_subtitles = plan.to_dict()
    del saved_before_subtitles["source_info"]["subtitle_codecs"]
    older = EncodePlan.from_dict(saved_before_subtitles)
    assert older.source_info is not None
    assert older.source_info.text_subtitle_track is None


@pytest.mark.parametrize(
    ("exc", "message"),
    [
        (MissingStream("video", Path("song.mp3")), NO_VIDEO_MESSAGE),
        (MissingStream("audio", Path("clip.mp4")), NO_AUDIO_MESSAGE),
        (FFprobeMissing("ffprobe not found."), FFPROBE_MISSING_MESSAGE),
        (FileNotFoundError("File not found: /videos/clip.mp4"), FILE_MISSING_MESSAGE),
        (PermissionError(13, "Permission denied", "/videos/clip.mp4"), NO_PERMISSION_MESSAGE),
        (ProbeTimeout("ffprobe timed out probing: clip.mp4"), TOO_SLOW_MESSAGE),
        (
            subprocess.CalledProcessError(1, ["ffprobe", "-v", "quiet", "--", "clip.mp4"]),
            UNREADABLE_MESSAGE,
        ),
        (ValueError("Cannot determine duration for: clip.mp4"), UNREADABLE_MESSAGE),
        (OSError(5, "Input/output error"), UNREADABLE_MESSAGE),
    ],
)
def test_probe_failures_are_said_in_plain_words(exc, message) -> None:
    assert describe_probe_failure(exc) == message


def test_a_file_without_a_video_stream_is_told_apart(tmp_path, monkeypatch) -> None:
    source = tmp_path / "song.mp3"
    source.write_bytes(b"audio")
    monkeypatch.setattr("tuck.media_tools.find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        "tuck.probe.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout='{"format":{"duration":"3"},"streams":[{"codec_type":"audio"}]}',
            stderr="",
        ),
    )

    with pytest.raises(MissingStream) as error:
        probe(source)
    assert error.value.kind == "video"
    # code that reads any unusable file as a ValueError still does
    assert isinstance(error.value, ValueError)
