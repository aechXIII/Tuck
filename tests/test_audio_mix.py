from __future__ import annotations

import math
from fractions import Fraction
from pathlib import Path

import pytest

from tuck.audio_mix import (
    clip_pieces,
    clip_placements,
    compile_cut_preview_mix,
    compile_preview_mix,
)
from tuck.bridge_serialization import preview_mix_dict
from tuck.encoding.command import build_base_cmd
from tuck.models import AudioClip, AudioTrack, EncodePlan, Segment, SourceAudioTrack, VideoInfo


def _info(*, streams: int = 1) -> VideoInfo:
    return VideoInfo(
        path="source.mp4",
        duration=30.0,
        width=1280,
        height=720,
        fps=30.0,
        video_codec="h264",
        audio_codec="aac" if streams else "",
        audio_channels=2 if streams else 0,
        audio_sample_rate=48_000 if streams else 0,
        audio_bitrate=192_000 if streams else 0,
        has_audio=streams > 0,
        audio_stream_count=streams,
    )


def _clip(**overrides: object) -> AudioClip:
    values = {
        "source": "music.mp3",
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


def _track(clips: list[AudioClip], **overrides: object) -> AudioTrack:
    values = {
        "track_id": "music-1",
        "name": "Music",
        "gain_db": -6.0,
        "muted": False,
        "clips": clips,
    }
    values.update(overrides)
    return AudioTrack(**values)


def _plan(**overrides: object) -> EncodePlan:
    values = {
        "source": "source.mp4",
        "output": "out.mp4",
        "source_info": _info(),
        "segments": [Segment(0, 30)],
        "audio_bitrate": 192_000,
    }
    values.update(overrides)
    return EncodePlan(**values)


def test_the_preview_plays_the_source_and_added_clips_with_their_gains_and_fades() -> None:
    mix = compile_preview_mix(
        _plan(
            source_audio_gain_db=-2.0,
            audio_tracks=[_track([_clip(loop=True, timeline_duration=12)])],
        )
    )

    source, music = mix.voices
    assert (source.path, source.stream) == ("source.mp4", 0)
    assert [(piece.start, piece.end, piece.source_in) for piece in source.pieces] == [(0, 30, 0)]
    assert math.isclose(source.pieces[0].gain, 10 ** (-2 / 20))
    assert (music.path, music.stream) == ("music.mp3", 0)
    (piece,) = music.pieces
    assert (piece.start, piece.end, piece.source_in) == (2.0, 14.0, 1.0)
    assert math.isclose(piece.gain, 10 ** (-9 / 20)), "track and clip gains add in dB"
    assert (piece.fade_in, piece.fade_out) == (0.5, 1.0)
    assert (piece.loop_start, piece.loop_span) == (1.0, 8.0)


def test_muted_sound_and_switched_off_audio_play_nothing() -> None:
    muted_clip = compile_preview_mix(
        _plan(audio_tracks=[_track([_clip(), _clip(timeline_start=12, muted=True)])])
    )
    assert [piece.start for piece in muted_clip.voices[-1].pieces] == [2.0]
    muted_track = compile_preview_mix(_plan(audio_tracks=[_track([_clip()], muted=True)]))
    assert [voice.path for voice in muted_track.voices] == ["source.mp4"]
    muted_source = compile_preview_mix(
        _plan(source_audio_muted=True, audio_tracks=[_track([_clip()])])
    )
    assert [voice.path for voice in muted_source.voices] == ["music.mp3"]
    assert (
        compile_preview_mix(_plan(audio_enabled=False, audio_tracks=[_track([_clip()])])).voices
        == ()
    )


def test_every_kept_source_stream_plays_with_its_own_gain_and_boosts_stay() -> None:
    mix = compile_preview_mix(
        _plan(
            source_info=_info(streams=3),
            source_audio_tracks=[SourceAudioTrack(0, -1.5), SourceAudioTrack(2, 6.0)],
        )
    )

    assert [(voice.stream, round(voice.pieces[0].gain, 4)) for voice in mix.voices] == [
        (0, round(10 ** (-1.5 / 20), 4)),
        (2, round(10 ** (6 / 20), 4)),
    ]
    assert mix.voices[1].pieces[0].gain > 1, "a boost is played as the export plays it"


def test_without_moved_clips_the_preview_runs_in_source_time_and_skips_muted_parts() -> None:
    mix = compile_preview_mix(
        _plan(
            segments=[Segment(0, 10), Segment(12, 20)],
            source_audio_segments=[Segment(0, 4), Segment(13, 20)],
            audio_tracks=[_track([_clip(timeline_start=8, timeline_duration=8)])],
        )
    )

    source, music = mix.voices
    assert [(piece.start, piece.end, piece.source_in) for piece in source.pieces] == [
        (0, 4, 0),
        (13, 20, 13),
    ]
    # the player skips the cut in the picture itself, so the clip keeps its source time
    assert [(piece.start, piece.end, piece.source_in) for piece in music.pieces] == [
        (8, 10, 1),
        (12, 16, 5),
    ]
    assert mix.duration == 30


def test_a_clip_edge_in_a_removed_part_loses_its_fade_as_in_the_export() -> None:
    segments = [Segment(0, 10), Segment(12, 20)]
    clip = _clip(timeline_start=11, timeline_duration=6, fade_in=2.0, fade_out=1.0)
    track = _track([clip])
    plan = _plan(segments=segments, audio_tracks=[track])

    (previewed,) = compile_preview_mix(plan).voices[-1].pieces
    (shared,) = clip_pieces(track, clip, clip_placements(clip, segments, positioned=False))

    assert (previewed.start, previewed.end, previewed.source_in) == (12, 17, 2)
    assert (previewed.fade_in, previewed.fade_out) == (shared.fade_in, shared.fade_out) == (0, 1)


def test_a_fade_cut_short_by_a_cut_ends_where_the_export_ends_it() -> None:
    mix = compile_preview_mix(
        _plan(
            segments=[Segment(0, 10), Segment(12, 20)],
            audio_tracks=[_track([_clip(timeline_start=9, timeline_duration=6, fade_in=2.0)])],
        )
    )

    first, second = mix.voices[-1].pieces
    assert (first.start, first.end, first.fade_in, first.fade_out) == (9, 10, 1, 0)
    assert (second.start, second.end, second.fade_in, second.fade_out) == (12, 15, 0, 1)


def test_a_looped_clip_picks_up_its_loop_where_the_export_does_after_a_cut() -> None:
    clip = _clip(timeline_start=9, timeline_duration=6, source_in=1.0, source_out=3.0, loop=True)
    mix = compile_preview_mix(
        _plan(segments=[Segment(0, 10), Segment(12, 20)], audio_tracks=[_track([clip])])
    )

    first, second = mix.voices[-1].pieces
    assert (first.source_in, second.source_in) == (1, 2), "3 s into a 2 s loop is 1 s in"
    assert (second.loop_start, second.loop_span) == (1, 2)


def test_moved_clips_put_the_source_at_its_timeline_place() -> None:
    mix = compile_preview_mix(
        _plan(
            segments=[Segment(5, 10, timeline_start=0), Segment(12, 20, timeline_start=7)],
            audio_tracks=[_track([_clip(timeline_start=3, timeline_duration=6)])],
        )
    )

    source, music = mix.voices
    assert [(piece.start, piece.end, piece.source_in) for piece in source.pieces] == [
        (0, 5, 5),
        (7, 15, 12),
    ]
    assert [(piece.start, piece.end) for piece in music.pieces] == [(3, 9)]
    assert mix.duration == 15


def test_preview_and_export_take_an_added_clip_from_the_same_pieces() -> None:
    clip = _clip(timeline_start=3, timeline_duration=6, gain_db=4.0, fade_in=0.25, fade_out=0.75)
    track = _track([clip], gain_db=-1.0)
    segments = [Segment(5, 10, timeline_start=0), Segment(12, 20, timeline_start=7)]
    plan = _plan(segments=segments, audio_tracks=[track])

    (shared,) = clip_pieces(track, clip, clip_placements(clip, segments, positioned=True))
    (previewed,) = compile_preview_mix(plan).voices[-1].pieces
    command = build_base_cmd("ffmpeg", plan, Path("source.mp4"))
    graph = command[command.index("-filter_complex") + 1]

    assert previewed.start == shared.output_start
    assert previewed.end == shared.output_start + shared.duration
    assert math.isclose(previewed.gain, 10 ** (shared.gain_db / 20))
    assert (previewed.fade_in, previewed.fade_out) == (shared.fade_in, shared.fade_out)
    assert f"volume={shared.gain_db:.2f}dB" in graph
    assert f"adelay={round(shared.output_start * 1000)}:all=1" in graph


@pytest.mark.parametrize("include_audio", [True, False])
def test_a_lossless_cut_previews_every_stream_at_full_level(include_audio: bool) -> None:
    mix = compile_cut_preview_mix(
        "source.mkv", [Segment(1, 4), Segment(6, 9)], 2, include_audio, moved=False
    )

    if not include_audio:
        assert mix.voices == ()
        return
    assert [voice.stream for voice in mix.voices] == [0, 1]
    for voice in mix.voices:
        assert [
            (piece.start, piece.end, piece.source_in, piece.gain) for piece in voice.pieces
        ] == [
            (1, 4, 1, 1.0),
            (6, 9, 6, 1.0),
        ]


def test_moved_clips_in_a_lossless_cut_play_back_to_back_as_the_cut_writes_them() -> None:
    mix = compile_cut_preview_mix("source.mkv", [Segment(1, 4), Segment(6, 9)], 1, True, moved=True)

    assert mix.duration == 6
    assert [(piece.start, piece.end, piece.source_in) for piece in mix.voices[0].pieces] == [
        (0, 3, 1),
        (3, 6, 6),
    ]


def test_the_mix_goes_to_the_page_with_its_own_field_names() -> None:
    data = preview_mix_dict(
        compile_preview_mix(_plan(audio_tracks=[_track([_clip(loop=True, timeline_duration=12)])]))
    )

    assert data["duration"] == 30
    voices = data["voices"]
    assert isinstance(voices, list)
    assert voices[1]["pieces"][0] == {
        "start": 2.0,
        "end": 14.0,
        "sourceIn": 1.0,
        "gain": pytest.approx(10 ** (-9 / 20)),
        "fadeIn": 0.5,
        "fadeOut": 1.0,
        "loopStart": 1.0,
        "loopSpan": 8.0,
    }


def test_the_bridge_compiles_the_mix_from_the_export_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tuck.settings as settings_mod
    from tuck.bridge import BridgeAPI
    from tuck.models import AudioInfo
    from tuck.probe_cache import ProbeCache

    for folder in ("_config_dir", "_data_dir", "_cache_dir"):
        monkeypatch.setattr(settings_mod, folder, lambda: tmp_path)
    video = tmp_path / "video.mp4"
    music = tmp_path / "music.mp3"
    video.write_bytes(b"video")
    music.write_bytes(b"audio")
    api = BridgeAPI()
    api._settings.load()
    api._probe_cache = ProbeCache(lambda path: _info())
    api._audio_probe_cache = ProbeCache(
        lambda path: AudioInfo(path=path, duration=20.0, codec="mp3")
    )
    track = _track([_clip(source=str(music))]).to_dict()

    result = api.compile_preview_mix(
        {"source": str(video), "source_audio_gain_db": -6, "audio_tracks": [track]}
    )

    assert result["ok"] is True, result
    data = result["data"]
    assert isinstance(data, dict)
    voices = data["voices"]
    assert isinstance(voices, list)
    assert [(voice["path"], voice["stream"]) for voice in voices] == [
        (str(video), 0),
        (str(music.resolve()), 0),
    ]
    assert api.compile_preview_mix("not a request")["ok"] is False
    assert api.compile_preview_mix({"source": str(tmp_path / "missing.mp4")})["ok"] is False


def test_the_bridge_compiles_a_lossless_cut_with_moved_clips_from_its_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tuck.settings as settings_mod
    from tuck.bridge import BridgeAPI
    from tuck.models.cutting import MediaTime
    from tuck.probe_cache import ProbeCache

    for folder in ("_config_dir", "_data_dir", "_cache_dir"):
        monkeypatch.setattr(settings_mod, folder, lambda: tmp_path)
    video = tmp_path / "video.mp4"
    video.write_bytes(b"video")
    api = BridgeAPI()
    api._settings.load()
    api._probe_cache = ProbeCache(lambda path: _info(streams=2))

    def moment(seconds: int) -> dict[str, str | int]:
        return MediaTime.from_seconds(Fraction(seconds)).to_dict()

    def request(moved: bool) -> dict[str, object]:
        parts = [(2, 5, 0), (8, 10, 3)]
        return {
            "operation": "cut",
            "source": str(video),
            "segments": [
                {"start": moment(start), "end": moment(end)}
                | ({"timeline_start": moment(at)} if moved else {})
                for start, end, at in parts
            ],
        }

    placed, plain = (api.compile_preview_mix(request(moved)) for moved in (True, False))

    assert placed["ok"] is True, placed
    assert plain["ok"] is True, plain
    for result, starts in ((placed, [0.0, 3.0]), (plain, [2.0, 8.0])):
        data = result["data"]
        assert isinstance(data, dict)
        voices = data["voices"]
        assert isinstance(voices, list)
        assert [voice["stream"] for voice in voices] == [0, 1]
        assert [piece["start"] for piece in voices[0]["pieces"]] == starts
