"""Exports made for sharing: kept tracks mixed into one, Even out loudness, and muted stretches.

The real exports are judged by measuring their sound with FFmpeg, never by playing it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from tuck.audio_mix import compile_preview_mix, without_ranges
from tuck.bridge_validation import parse_plan_request
from tuck.encoding.capabilities import get_available_encoders
from tuck.encoding.command import LOUDNESS_TARGET, build_base_cmd
from tuck.engine import FFmpegEngine
from tuck.media_tools import find_ffmpeg, find_ffprobe
from tuck.models import (
    RCM_VBR,
    AudioClip,
    AudioTrack,
    EncodePlan,
    MuteRange,
    PlanRequest,
    Segment,
    SourceAudioTrack,
    SourceTrackSetting,
    TimelineAudioPiece,
    VideoInfo,
)
from tuck.probe import probe

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _info(path: str = "in.mkv", **overrides: object) -> VideoInfo:
    base = VideoInfo(
        path=path,
        duration=2.0,
        width=320,
        height=240,
        fps=25.0,
        video_codec="h264",
        audio_codec="aac",
        audio_channels=1,
        audio_sample_rate=48_000,
        audio_bitrate=64_000,
        has_audio=True,
        audio_stream_count=2,
        audio_codecs=["aac", "aac"],
    )
    return replace(base, **overrides)


def _plan(**overrides: object) -> EncodePlan:
    base = EncodePlan(
        source="in.mkv",
        output="out.mp4",
        target_width=320,
        target_height=240,
        target_fps=25.0,
        video_bitrate=400_000,
        original_video_bitrate=400_000,
        audio_bitrate=64_000,
        audio_sample_rate=48_000,
        two_pass=False,
        preset="ultrafast",
        video_encoder="libx264",
        rate_control_method=RCM_VBR,
        target_size=5 * 1024 * 1024,
        source_info=_info(),
    )
    return replace(base, **overrides)


def _graph(cmd: list[str]) -> list[str]:
    return cmd[cmd.index("-filter_complex") + 1].split(";")


def _maps(cmd: list[str]) -> list[str]:
    return [cmd[index + 1] for index, arg in enumerate(cmd) if arg == "-map"]


TWO_TRACKS = [SourceAudioTrack(0), SourceAudioTrack(1, -6.0)]


class TestOneTrack:
    def test_kept_tracks_are_mixed_into_one_output_track(self) -> None:
        cmd = build_base_cmd(
            "ffmpeg", _plan(source_audio_tracks=TWO_TRACKS, mix_audio_tracks=True), Path("in.mkv")
        )
        assert _maps(cmd) == ["[vout]", "[aout]"]
        graph = _graph(cmd)
        mix = next(part for part in graph if part.endswith("[aout]"))
        assert mix.startswith("[mix0][t1mix0]amix=inputs=2")
        assert "normalize=0" in mix
        # each track keeps its own level from its slider before the sum
        second = next(part for part in graph if part.startswith("[t1sa0]"))
        assert "volume=-6.00dB" in second

    def test_added_audio_joins_the_same_mix(self, tmp_path: Path) -> None:
        music = AudioTrack("music", "Music", [AudioClip(str(tmp_path / "m.wav"), 0, 0, 1, 1)])
        cmd = build_base_cmd(
            "ffmpeg",
            _plan(source_audio_tracks=TWO_TRACKS, audio_tracks=[music], mix_audio_tracks=True),
            Path("in.mkv"),
        )
        assert _maps(cmd) == ["[vout]", "[aout]"]
        mix = next(part for part in _graph(cmd) if part.endswith("[aout]"))
        assert mix.startswith("[mix0][t1mix0][mix2]amix=inputs=3")

    def test_separate_tracks_keep_one_output_track_each(self) -> None:
        cmd = build_base_cmd(
            "ffmpeg", _plan(source_audio_tracks=TWO_TRACKS, mix_audio_tracks=False), Path("in.mkv")
        )
        assert _maps(cmd) == ["[vout]", "[aout]", "[aout1]"]

    def test_one_kept_track_needs_no_mix(self) -> None:
        cmd = build_base_cmd(
            "ffmpeg",
            _plan(source_audio_tracks=[SourceAudioTrack(1)], mix_audio_tracks=True),
            Path("in.mkv"),
        )
        assert _maps(cmd) == ["0:v:0", "0:a:1?"]
        assert "-filter_complex" not in cmd

    def test_a_cut_still_mixes_rather_than_riding_the_video_concat(self) -> None:
        cmd = build_base_cmd(
            "ffmpeg",
            _plan(
                source_audio_tracks=[SourceAudioTrack(0), SourceAudioTrack(1)],
                mix_audio_tracks=True,
                segments=[Segment(0.0, 0.8), Segment(1.2, 2.0)],
            ),
            Path("in.mkv"),
        )
        graph = _graph(cmd)
        assert not any("v=1:a=1" in part for part in graph)
        assert _maps(cmd) == ["[vout]", "[aout]"]
        assert any(part.startswith("[mix0][t1mix0]amix=inputs=2") for part in graph)

    def test_the_bitrate_budget_counts_written_tracks(self) -> None:
        tracks = [SourceAudioTrack(index) for index in range(3)]
        assert _plan(source_audio_tracks=tracks).output_audio_track_count == 3
        mixed = _plan(source_audio_tracks=tracks, mix_audio_tracks=True)
        assert mixed.output_audio_track_count == 1
        assert mixed.total_audio_bitrate == mixed.audio_bitrate

    def test_plans_from_before_the_choice_keep_separate_tracks(self) -> None:
        data = _plan(source_audio_tracks=TWO_TRACKS, mix_audio_tracks=True).to_dict()
        data.pop("mix_audio_tracks")
        data.pop("even_out_loudness")
        restored = EncodePlan.from_dict(data)
        assert restored.mix_audio_tracks is False
        assert restored.even_out_loudness is False


class TestEvenOutLoudness:
    def test_the_mix_is_evened_out_and_returned_to_the_export_rate(self) -> None:
        cmd = build_base_cmd(
            "ffmpeg",
            _plan(source_audio_tracks=TWO_TRACKS, mix_audio_tracks=True, even_out_loudness=True),
            Path("in.mkv"),
        )
        mix = next(part for part in _graph(cmd) if part.endswith("[aout]"))
        assert mix.endswith(f"normalize=0,{LOUDNESS_TARGET},aresample=48000[aout]")
        assert "I=-14" in LOUDNESS_TARGET and "TP=-1.5" in LOUDNESS_TARGET
        # one pass: no measuring run and no measured values
        assert "measured_" not in " ".join(cmd)
        assert "print_format" not in " ".join(cmd)

    def test_each_separate_track_is_evened_out(self) -> None:
        cmd = build_base_cmd(
            "ffmpeg",
            _plan(source_audio_tracks=TWO_TRACKS, even_out_loudness=True),
            Path("in.mkv"),
        )
        graph = _graph(cmd)
        first = next(part for part in graph if part.endswith("[aout]"))
        second = next(part for part in graph if part.endswith("[aout1]"))
        assert first == f"[mix0]{LOUDNESS_TARGET},aresample=48000[aout]"
        assert second == f"[t1mix0]{LOUDNESS_TARGET},aresample=48000[aout1]"

    def test_a_plain_single_track_export_goes_through_the_filter(self) -> None:
        plan = _plan(
            source_info=_info(audio_stream_count=1, audio_codecs=["aac"]),
            even_out_loudness=True,
        )
        cmd = build_base_cmd("ffmpeg", plan, Path("in.mkv"))
        assert _maps(cmd) == ["[vout]", "[aout]"]
        assert any(LOUDNESS_TARGET in part for part in _graph(cmd))

    def test_the_video_analysis_pass_has_no_audio(self) -> None:
        plan = _plan(even_out_loudness=True, two_pass=True)
        cmd = build_base_cmd("ffmpeg", plan, Path("in.mkv"), include_audio=False)
        assert "loudnorm" not in " ".join(cmd)
        assert "-an" in cmd

    def test_off_leaves_the_audio_alone(self) -> None:
        plan = _plan(source_info=_info(audio_stream_count=1, audio_codecs=["aac"]))
        assert "loudnorm" not in " ".join(build_base_cmd("ffmpeg", plan, Path("in.mkv")))


class TestMutedStretches:
    def test_ranges_are_taken_out_of_pieces_in_source_time(self) -> None:
        pieces = [TimelineAudioPiece(0.0, 0.8, 0.0), TimelineAudioPiece(1.2, 2.0, 0.8)]
        assert without_ranges(pieces, (MuteRange(0.5, 1.5),)) == [
            TimelineAudioPiece(0.0, 0.5, 0.0),
            TimelineAudioPiece(1.5, 2.0, 1.1),
        ]
        # overlapping and out of order ranges, and one covering a piece, all work
        assert without_ranges(pieces, (MuteRange(1.0, 2.5), MuteRange(0.1, 0.2))) == [
            TimelineAudioPiece(0.0, 0.1, 0.0),
            TimelineAudioPiece(0.2, 0.8, 0.2),
        ]

    def test_a_source_track_range_follows_the_cut(self) -> None:
        plan = _plan(
            source_info=_info(audio_stream_count=1, audio_codecs=["aac"]),
            source_audio_tracks=[SourceAudioTrack(0, 0.0, (MuteRange(1.4, 1.7),))],
            segments=[Segment(0.0, 0.8), Segment(1.2, 2.0)],
        )
        graph = _graph(build_base_cmd("ffmpeg", plan, Path("in.mkv")))
        pieces = [part for part in graph if part.startswith("[0:a:0]")]
        # source 1.7 lands at 1.3 in the output once the 0.4 s cut closes
        assert pieces == [
            "[0:a:0]atrim=start=0.000:end=0.800,asetpts=PTS-STARTPTS,adelay=0:all=1,"
            "asetpts=N/SR/TB,apad=whole_dur=1.600,atrim=duration=1.600[mix0]",
            "[0:a:0]atrim=start=1.200:end=1.400,asetpts=PTS-STARTPTS,adelay=800:all=1,"
            "asetpts=N/SR/TB,apad=whole_dur=1.600,atrim=duration=1.600[mix1]",
            "[0:a:0]atrim=start=1.700:end=2.000,asetpts=PTS-STARTPTS,adelay=1300:all=1,"
            "asetpts=N/SR/TB,apad=whole_dur=1.600,atrim=duration=1.600[mix2]",
        ]

    def test_only_the_track_with_the_range_is_split(self) -> None:
        plan = _plan(
            source_audio_tracks=[
                SourceAudioTrack(0),
                SourceAudioTrack(1, 0.0, (MuteRange(0.5, 1.0),)),
            ]
        )
        graph = _graph(build_base_cmd("ffmpeg", plan, Path("in.mkv")))
        assert len([part for part in graph if part.startswith("[0:a:0]")]) == 1
        assert len([part for part in graph if part.startswith("[0:a:1]")]) == 2

    def test_an_added_track_range_is_in_the_tracks_own_time(self, tmp_path: Path) -> None:
        clip = AudioClip(str(tmp_path / "m.wav"), 0.5, 0.0, 1.5, 1.5)
        music = AudioTrack("music", "Music", [clip], mute_ranges=(MuteRange(1.0, 1.5),))
        plan = _plan(
            source_info=_info(audio_stream_count=1, audio_codecs=["aac"]), audio_tracks=[music]
        )
        graph = _graph(build_base_cmd("ffmpeg", plan, Path("in.mkv")))
        added = [part for part in graph if part.startswith("[1:a:0]")]
        assert len(added) == 2
        assert added[0].startswith("[1:a:0]atrim=start=0.000:duration=0.500")
        assert "adelay=500:all=1" in added[0]
        assert added[1].startswith("[1:a:0]atrim=start=1.000:duration=0.500")
        assert "adelay=1500:all=1" in added[1]

    @pytest.mark.parametrize("mix", [True, False])
    def test_a_track_muted_end_to_end_is_still_written(self, mix: bool) -> None:
        whole = (MuteRange(0.0, 2.0),)
        plan = _plan(
            source_audio_tracks=[SourceAudioTrack(0, 0.0, whole), SourceAudioTrack(1, 0.0, whole)],
            mix_audio_tracks=mix,
        )
        cmd = build_base_cmd("ffmpeg", plan, Path("in.mkv"))
        graph = _graph(cmd)
        assert _maps(cmd) == (["[vout]", "[aout]"] if mix else ["[vout]", "[aout]", "[aout1]"])
        assert "[0:a:0]volume=0,asetpts=PTS-STARTPTS,apad=whole_dur=2.000" in ";".join(graph)
        assert any(part.startswith("[0:a:1]volume=0") for part in graph)

    def test_the_preview_leaves_the_same_stretches_silent(self, tmp_path: Path) -> None:
        clip = AudioClip(str(tmp_path / "m.wav"), 0.0, 0.0, 2.0, 2.0)
        plan = _plan(
            source_info=_info(audio_stream_count=1, audio_codecs=["aac"]),
            source_audio_tracks=[SourceAudioTrack(0, 0.0, (MuteRange(1.4, 1.7),))],
            segments=[Segment(0.0, 0.8), Segment(1.2, 2.0)],
            audio_tracks=[AudioTrack("m", "Music", [clip], mute_ranges=(MuteRange(0.2, 0.4),))],
        )
        source, added = compile_preview_mix(plan).voices
        # without moved clips the player runs on source time and skips the cut itself
        assert [(piece.start, piece.end) for piece in source.pieces] == [
            (0.0, 0.8),
            (1.2, 1.4),
            (1.7, 2.0),
        ]
        assert [(piece.start, piece.end) for piece in added.pieces] == [
            (0.0, 0.2),
            (0.4, 0.8),
            (1.2, 2.0),
        ]

    def test_the_preview_of_moved_clips_uses_output_time(self) -> None:
        plan = _plan(
            source_info=_info(audio_stream_count=1, audio_codecs=["aac"]),
            source_audio_tracks=[SourceAudioTrack(0, 0.0, (MuteRange(1.4, 1.7),))],
            segments=[Segment(1.2, 2.0, timeline_start=0.0), Segment(0.0, 0.8, 0.8)],
        )
        (source,) = compile_preview_mix(plan).voices
        assert [
            (round(piece.start, 6), round(piece.end, 6), piece.source_in) for piece in source.pieces
        ] == [(0.0, 0.2, 1.2), (0.5, 0.8, 1.7), (0.8, 1.6, 0.0)]


class TestRequests:
    def test_the_bridge_reads_the_new_choices(self, tmp_path: Path) -> None:
        source = tmp_path / "in.mkv"
        source.write_bytes(b"x")
        request = parse_plan_request(
            {
                "source": str(source),
                "mix_audio_tracks": False,
                "even_out_loudness": True,
                "source_audio_mute_ranges": [{"start": 1.0, "end": 2.0}],
                "source_audio_extra_tracks": [
                    {"muted": False, "gain_db": 0, "mute_ranges": [{"start": 0, "end": 0.5}]}
                ],
            },
            lambda path: path,
        )
        assert request.mix_audio_tracks is False
        assert request.even_out_loudness is True
        assert request.source_audio_mute_ranges == [MuteRange(1.0, 2.0)]
        assert request.source_audio_extra_tracks == [
            SourceTrackSetting(mute_ranges=(MuteRange(0, 0.5),))
        ]

    @pytest.mark.parametrize(
        ("field", "value", "message"),
        [
            ("mix_audio_tracks", "yes", "must be a boolean"),
            ("even_out_loudness", 1, "must be a boolean"),
            ("source_audio_mute_ranges", {"start": 0, "end": 1}, "must be an array"),
            ("source_audio_mute_ranges", [{"start": 2, "end": 1}], "after its start"),
            ("source_audio_mute_ranges", [{"start": -1, "end": 1}], ">= 0"),
            ("source_audio_mute_ranges", [{"start": 0, "end": float("inf")}], "finite"),
            ("source_audio_mute_ranges", [{"start": 0}], "start and end"),
            ("source_audio_mute_ranges", [{"start": 0, "end": 1}] * 257, "too many"),
        ],
    )
    def test_the_bridge_rejects_bad_values(
        self, tmp_path: Path, field: str, value: object, message: str
    ) -> None:
        source = tmp_path / "in.mkv"
        source.write_bytes(b"x")
        with pytest.raises(ValueError, match=message):
            parse_plan_request({"source": str(source), field: value}, lambda path: path)

    def test_added_track_ranges_round_trip(self) -> None:
        track = AudioTrack("a", "A", [], mute_ranges=(MuteRange(1, 2),))
        assert AudioTrack.from_dict(track.to_dict()) == track
        plan = _plan(audio_tracks=[track], source_audio_tracks=TWO_TRACKS)
        assert EncodePlan.from_dict(plan.to_dict()).audio_tracks == [track]

    def test_requests_default_to_unset(self) -> None:
        request = PlanRequest()
        assert request.mix_audio_tracks is None
        assert request.even_out_loudness is None
        assert request.source_audio_mute_ranges is None


# real exports, measured rather than heard


def _ffmpeg_with_encoders() -> str:
    ffmpeg = find_ffmpeg()
    if not ffmpeg or not find_ffprobe():
        pytest.skip("FFmpeg and ffprobe are unavailable")
    # AAC is FFmpeg's own encoder; the picture needs x264
    if "libx264" not in get_available_encoders():
        pytest.skip("this FFmpeg has no libx264 encoder")
    return ffmpeg


def _make_source(ffmpeg: str, path: Path, *tracks: str, duration: float = 2.0) -> VideoInfo:
    cmd = [ffmpeg, "-y", "-v", "error", "-f", "lavfi"]
    cmd += ["-i", f"testsrc2=duration={duration}:size=320x240:rate=25"]
    for track in tracks:
        cmd += ["-f", "lavfi", "-i", f"{track}:d={duration}:sample_rate=48000"]
    cmd += ["-map", "0:v", *[arg for i in range(len(tracks)) for arg in ("-map", f"{i + 1}:a")]]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "128k", str(path)]
    result = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=_NO_WINDOW)
    if result.returncode != 0:
        pytest.skip(f"cannot create {path.name}: {result.stderr.decode(errors='replace')[-200:]}")
    return probe(path)


def _audio_streams(path: Path) -> int:
    ffprobe = find_ffprobe() or "ffprobe"
    out = subprocess.run(
        [
            *(ffprobe, "-v", "error", "-select_streams", "a"),
            *("-show_entries", "stream=index", "-of", "json", str(path)),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=_NO_WINDOW,
    ).stdout
    return len(json.loads(out)["streams"])


def _peak_db(path: Path, stream: int = 0, start: float = 0.0, length: float = 30.0) -> float:
    """The loudest sample of one audio stream in a window, from volumedetect"""
    ffmpeg = find_ffmpeg() or "ffmpeg"
    result = subprocess.run(
        [
            *(ffmpeg, "-nostats", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(path)),
            *("-map", f"0:a:{stream}", "-af", "volumedetect", "-f", "null", "-"),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        creationflags=_NO_WINDOW,
    )
    match = re.search(r"max_volume: (-?[\d.]+|-inf) dB", result.stderr)
    assert match, result.stderr[-400:]
    return float("-inf") if match.group(1) == "-inf" else float(match.group(1))


def _loudness(path: Path) -> tuple[float, float]:
    """Integrated loudness and true peak of the first audio stream, from ebur128"""
    ffmpeg = find_ffmpeg() or "ffmpeg"
    result = subprocess.run(
        [
            *(ffmpeg, "-nostats", "-i", str(path), "-map", "0:a:0"),
            *("-af", "ebur128=peak=true", "-f", "null", "-"),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        creationflags=_NO_WINDOW,
    )
    summary = result.stderr[result.stderr.rindex("Summary:") :]
    integrated = re.search(r"I:\s+(-?[\d.]+) LUFS", summary)
    peak = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+) dBFS", summary)
    assert integrated and peak, summary
    return float(integrated.group(1)), float(peak.group(1))


# FFmpeg's sine peaks at -18 dBFS, so "sounds" is well above -40 and silence well below
SILENT = "aevalsrc=0"
TONE = "sine=frequency=440"


class TestRealExports:
    def test_one_track_carries_the_second_tracks_sound(self, tmp_path: Path) -> None:
        ffmpeg = _ffmpeg_with_encoders()
        info = _make_source(ffmpeg, tmp_path / "in.mkv", SILENT, TONE)
        base = _plan(source=info.path, source_info=info, source_audio_tracks=TWO_TRACKS)
        mixed = FFmpegEngine().encode(
            replace(base, output=str(tmp_path / "mixed.mp4"), mix_audio_tracks=True)
        )
        assert _audio_streams(mixed) == 1
        assert _peak_db(mixed) > -40

        separate = FFmpegEngine().encode(
            replace(base, output=str(tmp_path / "separate.mp4"), mix_audio_tracks=False)
        )
        assert _audio_streams(separate) == 2
        # what most players play is the silent first track
        assert _peak_db(separate, 0) < -60
        assert _peak_db(separate, 1) > -40

    def test_a_muted_stretch_is_silent_where_the_cut_puts_it(self, tmp_path: Path) -> None:
        ffmpeg = _ffmpeg_with_encoders()
        info = _make_source(ffmpeg, tmp_path / "in.mkv", TONE)
        plan = _plan(
            source=info.path,
            output=str(tmp_path / "out.mp4"),
            source_info=info,
            source_audio_tracks=[SourceAudioTrack(0, 0.0, (MuteRange(1.4, 1.7),))],
            segments=[Segment(0.0, 0.8), Segment(1.2, 2.0)],
        )
        output = FFmpegEngine().encode(plan)
        # the muted source 1.4 to 1.7 is output 1.0 to 1.3; keep clear of AAC's edge smear
        assert _peak_db(output, start=1.08, length=0.14) < -50
        assert _peak_db(output, start=0.3, length=0.3) > -40
        assert _peak_db(output, start=1.38, length=0.15) > -40

    def test_even_out_loudness_lands_near_the_sharing_level(self, tmp_path: Path) -> None:
        ffmpeg = _ffmpeg_with_encoders()
        info = _make_source(
            ffmpeg, tmp_path / "in.mkv", "aevalsrc='0.02*sin(2*PI*440*t)'", duration=4.0
        )
        base = _plan(
            source=info.path,
            source_info=info,
            source_audio_tracks=[SourceAudioTrack(0)],
        )
        quiet = FFmpegEngine().encode(replace(base, output=str(tmp_path / "quiet.mp4")))
        even = FFmpegEngine().encode(
            replace(base, output=str(tmp_path / "even.mp4"), even_out_loudness=True)
        )
        quiet_level, _ = _loudness(quiet)
        level, peak = _loudness(even)
        assert quiet_level < -30
        assert level == pytest.approx(-14.0, abs=1.5)
        assert peak <= -0.5
