from __future__ import annotations

import math
from pathlib import Path

import pytest

from tuck.audio_mix import (
    clip_pieces,
    clip_placements,
    compile_cut_preview_mix,
    compile_preview_mix,
    preview_mix_dict,
)
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
    # the player skips the cut in the picture itself, so the clip stays whole on its timeline
    assert [(piece.start, piece.end) for piece in music.pieces] == [(8, 16)]
    assert mix.duration == 30


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
    mix = compile_cut_preview_mix("source.mkv", [Segment(1, 4), Segment(6, 9)], 2, include_audio)

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
