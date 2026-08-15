from __future__ import annotations

from pathlib import Path

import pytest

from tuck.bridge_validation import parse_plan_request
from tuck.encoding.command import build_base_cmd
from tuck.models import (
    AudioClip,
    AudioTrack,
    EncodePlan,
    PlanRequest,
    Profile,
    Segment,
    VideoInfo,
    map_source_range_to_output,
    source_audio_output_pieces,
)
from tuck.planner import plan


def _clip(source: str = "music.mp3", **overrides) -> AudioClip:
    values = {
        "source": source,
        "timeline_start": 2.0,
        "source_in": 1.0,
        "source_out": 9.0,
        "timeline_duration": 8.0,
        "gain_db": -3.0,
        "fade_in": 0.5,
        "fade_out": 1.0,
        "loop": False,
        "muted": False,
    }
    values.update(overrides)
    return AudioClip(**values)


def _track(source: str = "music.mp3", **overrides) -> AudioTrack:
    values = {
        "track_id": "music-1",
        "name": "Music",
        "gain_db": -6.0,
        "muted": False,
        "clips": [_clip(source)],
    }
    values.update(overrides)
    return AudioTrack(**values)


def _video_info(*, has_audio: bool = True) -> VideoInfo:
    return VideoInfo(
        path="source.mp4",
        duration=12.0,
        width=1280,
        height=720,
        fps=30.0,
        video_codec="h264",
        audio_codec="aac" if has_audio else "",
        audio_channels=2 if has_audio else 0,
        audio_sample_rate=48_000 if has_audio else 0,
        audio_bitrate=192_000 if has_audio else 0,
        has_audio=has_audio,
    )


def test_audio_clip_and_track_round_trip() -> None:
    track = _track()

    restored = AudioTrack.from_dict(track.to_dict())

    assert restored == track
    restored.validate(timeline_duration=12.0, source_durations={"music.mp3": 10.0})


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"timeline_start": -1}, "timeline_start"),
        ({"source_out": 1}, "source_out"),
        ({"timeline_duration": 9}, "selected source range"),
        ({"gain_db": 13}, "gain_db"),
        ({"fade_in": 5, "fade_out": 4}, "fades"),
    ],
)
def test_audio_clip_rejects_invalid_values(overrides, message) -> None:
    with pytest.raises(ValueError, match=message):
        _clip(**overrides).validate()


def test_audio_track_rejects_overlapping_clips() -> None:
    track = _track(
        clips=[
            _clip(timeline_start=0, timeline_duration=4, source_out=5),
            _clip(timeline_start=3, timeline_duration=2, source_out=3),
        ]
    )

    with pytest.raises(ValueError, match="must not overlap"):
        track.validate()


def test_bridge_resolves_imported_audio_paths(tmp_path: Path) -> None:
    video = tmp_path / "video.mp4"
    music = tmp_path / "music.mp3"
    video.write_bytes(b"video")
    music.write_bytes(b"audio")
    raw_track = _track(str(music)).to_dict()

    request = parse_plan_request(
        {
            "source": str(video),
            "audio_enabled": True,
            "source_audio_muted": True,
            "source_audio_gain_db": -4,
            "audio_tracks": [raw_track],
        },
        lambda path: str(Path(path).resolve()),
    )

    assert request.audio_enabled is True
    assert request.source_audio_muted is True
    assert request.source_audio_gain_db == -4
    assert request.audio_tracks is not None
    assert request.audio_tracks[0].clips[0].source == str(music.resolve())


def test_bridge_rejects_unsupported_audio_track_source(tmp_path: Path) -> None:
    video = tmp_path / "video.mp4"
    not_audio = tmp_path / "notes.txt"
    video.write_bytes(b"video")
    not_audio.write_text("not audio")
    raw_track = _track(str(not_audio)).to_dict()

    with pytest.raises(ValueError, match="Unsupported audio file type"):
        parse_plan_request(
            {"source": str(video), "audio_tracks": [raw_track]},
            lambda path: str(Path(path).resolve()),
        )


def test_planner_keeps_imported_audio_when_video_has_no_source_audio(tmp_path: Path) -> None:
    video = tmp_path / "silent.mp4"
    music = tmp_path / "music.mp3"
    video.write_bytes(b"video")
    music.write_bytes(b"audio")
    request = PlanRequest(
        source=str(video),
        segments=[Segment(0, 12)],
        audio_tracks=[_track(str(music))],
    )

    result = plan(
        video,
        Profile(name="Audio mix", keep_audio=True, two_pass=False),
        request=request,
        source_info=_video_info(has_audio=False),
        audio_source_durations={str(music): 10.0},
    )

    assert result.audio_bitrate == 128_000
    assert not result.copy_audio
    assert result.audio_tracks == request.audio_tracks


def test_audio_mix_command_adds_loop_gain_fades_delay_and_mix() -> None:
    track = _track(
        clips=[
            _clip(
                timeline_start=2,
                timeline_duration=8,
                loop=True,
                fade_in=0.5,
                fade_out=1.0,
            )
        ]
    )
    encode_plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_video_info(),
        segments=[Segment(0, 12)],
        audio_bitrate=192_000,
        source_audio_gain_db=-2,
        audio_tracks=[track],
    )

    command = build_base_cmd("ffmpeg", encode_plan, Path(encode_plan.source))
    graph = command[command.index("-filter_complex") + 1]

    assert command.count("-i") == 2
    assert "-stream_loop" not in command
    assert "atrim=start=1.000:end=9.000" in graph
    assert "aloop=loop=-1:size=" in graph
    assert "volume=-9.00dB" in graph
    assert "afade=t=in:st=0:d=0.500" in graph
    assert "afade=t=out:st=7.000:d=1.000" in graph
    assert "adelay=2000:all=1" in graph
    assert "amix=inputs=2" in graph
    assert command[command.index("-c:a") + 1] == "aac"


def test_master_audio_mute_omits_imported_inputs() -> None:
    encode_plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_video_info(),
        segments=[Segment(0, 12)],
        audio_bitrate=192_000,
        audio_enabled=False,
        audio_tracks=[_track()],
    )

    command = build_base_cmd("ffmpeg", encode_plan, Path(encode_plan.source))

    assert command.count("-i") == 1
    assert "-an" in command
    assert "music.mp3" not in command


def test_encode_plan_round_trip_preserves_audio_timeline() -> None:
    original = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_video_info(),
        segments=[Segment(0, 12)],
        source_audio_muted=True,
        source_audio_gain_db=-5,
        audio_tracks=[_track()],
    )

    restored = EncodePlan.from_dict(original.to_dict())

    assert restored.source_audio_muted is True
    assert restored.source_audio_gain_db == -5
    assert restored.audio_tracks == original.audio_tracks


def test_source_audio_hole_maps_to_output_pieces_without_changing_video() -> None:
    video = [Segment(0, 12)]
    audio = [Segment(0, 3), Segment(6, 12)]

    pieces = source_audio_output_pieces(video, audio)

    assert [
        (round(piece.source_start, 3), round(piece.source_end, 3), round(piece.output_start, 3))
        for piece in pieces
    ] == [
        (0.0, 3.0, 0.0),
        (6.0, 12.0, 6.0),
    ]


def test_imported_clip_follows_source_time_across_video_gaps() -> None:
    pieces = map_source_range_to_output([Segment(0, 3), Segment(6, 12)], 2.0, 10.0)

    assert [
        (round(piece.output_start, 3), round(piece.source_start, 3), round(piece.duration, 3))
        for piece in pieces
    ] == [
        (2.0, 2.0, 1.0),
        (3.0, 6.0, 4.0),
    ]


def test_source_audio_cut_leaves_video_and_inserts_silence() -> None:
    encode_plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_video_info(),
        segments=[Segment(0, 12)],
        source_audio_segments=[Segment(0, 4), Segment(8, 12)],
        audio_bitrate=192_000,
    )

    command = build_base_cmd("ffmpeg", encode_plan, Path(encode_plan.source))
    graph = command[command.index("-filter_complex") + 1]

    assert "trim=start=0.000:end=12.000" in graph
    assert "atrim=start=0.000:end=4.000" in graph
    assert "atrim=start=8.000:end=12.000" in graph
    assert "adelay=8000:all=1" in graph
    assert command[command.index("-c:a") + 1] == "aac"


def test_uncut_source_audio_across_a_video_gap_is_not_independent() -> None:
    encode_plan = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_video_info(),
        segments=[Segment(0, 5), Segment(8, 10)],
        source_audio_segments=[Segment(0, 10)],
        audio_bitrate=192_000,
    )

    command = build_base_cmd("ffmpeg", encode_plan, Path(encode_plan.source))
    graph = command[command.index("-filter_complex") + 1]

    assert "concat=n=2:v=1:a=1" in graph
    assert "adelay" not in graph


def test_encode_plan_round_trip_preserves_source_audio_segments() -> None:
    original = EncodePlan(
        source="source.mp4",
        output="output.mp4",
        source_info=_video_info(),
        segments=[Segment(0, 12)],
        source_audio_segments=[Segment(0, 3), Segment(6, 12)],
    )

    restored = EncodePlan.from_dict(original.to_dict())

    assert restored.source_audio_segments == original.source_audio_segments
