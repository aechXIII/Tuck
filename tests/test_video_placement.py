import subprocess
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.cutting.planner import parse_cut_request
from tuck.encoding.command import build_base_cmd
from tuck.encoding.frame_blending import (
    blended_frames,
    prepare_blended_video,
    tmix_blend,
    weighted_yuv_blend,
)
from tuck.models import (
    AudioClip,
    AudioTrack,
    EncodePlan,
    FrameBlending,
    PlanRequest,
    Profile,
    Segment,
    VideoInfo,
    map_source_range_to_output,
    source_audio_output_pieces,
    validate_segments,
)
from tuck.models.cutting import MediaTime
from tuck.planner import plan


def placed(start, end, at):
    return Segment.from_dict({"start": start, "end": end, "timeline_start": at})


def test_placement_round_trip_preserves_source_and_project_clocks():
    segment = placed(10, 20, 0)
    result = EncodePlan(source="source.mp4", output="output.mp4", segments=[segment])
    assert result.effective_duration == 10
    assert EncodePlan.from_dict(result.to_dict()).segments == [segment]
    assert Segment(10, 20).to_dict() == {"start": 10.0, "end": 20.0}
    assert EncodePlan(
        source="source.mp4", output="output.mp4", segments=[Segment(10, 20)]
    ).to_dict()["segments"] == [{"start": 10.0, "end": 20.0}]


def test_placed_duration_includes_leading_and_internal_gaps():
    segments = [placed(10, 12, 1), placed(2, 5, 4)]
    validate_segments(segments, 12)
    assert (
        EncodePlan(source="source.mp4", output="output.mp4", segments=segments).effective_duration
        == 7
    )
    assert [
        (p.source_start, p.source_end, p.output_start)
        for p in map_source_range_to_output(segments, 0, 12)
    ] == [(10, 12, 1), (2, 5, 4)]


def test_repeated_source_ranges_do_not_duplicate_source_audio():
    segments = [placed(2, 5, 0), placed(2, 5, 4)]
    pieces = source_audio_output_pieces(segments, None)
    assert [(p.source_start, p.source_end, p.output_start) for p in pieces] == [
        (2, 5, 0),
        (2, 5, 4),
    ]


def test_placed_source_audio_mask_selects_one_repeated_occurrence():
    video = [placed(2, 5, 0), placed(2, 5, 5)]
    for at in [0, 5]:
        mask = [placed(2, 5, at)]
        pieces = source_audio_output_pieces(video, mask)
        assert [(p.source_start, p.source_end, p.output_start) for p in pieces] == [(2, 5, at)]
        result = EncodePlan(
            source="source.mp4", output="output.mp4", segments=video, source_audio_segments=mask
        )
        assert EncodePlan.from_dict(result.to_dict()).source_audio_segments == mask


def test_placed_source_audio_mask_is_clipped_to_visible_project_ranges():
    pieces = source_audio_output_pieces([placed(4, 6, 2)], [placed(3, 7, 1)])
    assert [(p.source_start, p.source_end, p.output_start) for p in pieces] == [(4, 6, 2)]


@pytest.mark.parametrize("at", [True, -1, float("inf"), float("nan"), "1"])
def test_rejects_invalid_placement(at):
    with pytest.raises(ValueError, match="timeline_start"):
        placed(1, 2, at)


def test_rejects_placement_whose_project_end_overflows():
    with pytest.raises(ValueError, match="timeline_start"):
        placed(0, 1e308, 1.7e308)


def test_rejects_mixed_clocks_and_project_overlap():
    with pytest.raises(ValueError, match="timeline_start"):
        validate_segments([placed(2, 3, 0), Segment(3, 4)])
    with pytest.raises(ValueError, match="overlap"):
        validate_segments([placed(5, 7, 0), placed(0, 2, 1)])
    with pytest.raises(ValueError):
        Segment.from_dict({"start": 1, "end": 2, "timeline_start": 0, "other": 3})


def cut_request(tmp_path: Path, ranges):
    def moment(value):
        return MediaTime.from_seconds(Fraction(value)).to_dict()

    return {
        "operation": "cut",
        "source": str(tmp_path / "source.mp4"),
        "segments": [
            {"start": moment(a), "end": moment(b), "timeline_start": moment(t)}
            for a, b, t in ranges
        ],
    }


def test_contiguous_cut_placement_keeps_source_ranges(tmp_path):
    result = parse_cut_request(cut_request(tmp_path, [(10, 12, 0), (15, 18, 2)]))
    assert [(s.start.seconds, s.end.seconds) for s in result.segments] == [(10, 12), (15, 18)]


@pytest.mark.parametrize("ranges", [[(10, 12, 1)], [(0, 2, 0), (3, 5, 3)]])
def test_cut_rejects_gaps_with_export_guidance(tmp_path, ranges):
    with pytest.raises(ValueError, match=r"Compress.*Upscale.*gaps"):
        parse_cut_request(cut_request(tmp_path, ranges))


def test_cut_rejects_reordered_source_ranges(tmp_path):
    with pytest.raises(ValueError, match=r"source.*order.*Compress.*Upscale"):
        parse_cut_request(cut_request(tmp_path, [(10, 12, 0), (0, 2, 2)]))


def test_planner_uses_project_duration_for_audio_and_bitrate(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    music = tmp_path / "music.wav"
    music.touch()
    info = VideoInfo(
        path=str(source),
        duration=4,
        width=64,
        height=48,
        fps=30,
        video_codec="h264",
        has_audio=True,
        audio_codec="aac",
        audio_bitrate=128000,
    )
    request = PlanRequest(
        source=str(source),
        segments=[placed(1, 3, 5)],
        audio_tracks=[
            AudioTrack(
                track_id="music",
                name="Music",
                clips=[
                    AudioClip(
                        source=str(music),
                        timeline_start=0,
                        source_in=0,
                        source_out=7,
                        timeline_duration=7,
                    )
                ],
            )
        ],
    )
    result = plan(
        source,
        Profile(name="Placed", two_pass=False),
        request=request,
        source_info=info,
        audio_source_durations={str(music): 7},
    )
    assert result.effective_duration == 7
    assert not result.copy_audio
    assert EncodePlan.from_dict(result.to_dict()).audio_tracks == result.audio_tracks


def test_music_beyond_shorter_placed_export_is_preserved(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    music = tmp_path / "music.wav"
    music.touch()
    info = VideoInfo(
        path=str(source),
        duration=12,
        width=64,
        height=48,
        fps=30,
        video_codec="h264",
        has_audio=False,
    )
    track = AudioTrack(
        track_id="music",
        name="Music",
        clips=[
            AudioClip(
                source=str(music),
                timeline_start=0,
                source_in=0,
                source_out=12,
                timeline_duration=12,
            )
        ],
    )
    request = PlanRequest(source=str(source), segments=[placed(10, 12, 0)], audio_tracks=[track])
    result = plan(
        source,
        Profile(name="Placed", two_pass=False),
        request=request,
        source_info=info,
        audio_source_durations={str(music): 12},
    )
    assert result.effective_duration == 2
    assert result.audio_tracks == [track]
    assert EncodePlan.from_dict(result.to_dict()).audio_tracks == [track]


@pytest.mark.parametrize("mode", ["standard", "prepared", "streamed", "tmix"])
@pytest.mark.parametrize("music", [False, True])
def test_real_export_renders_black_and_silent_gaps(tmp_path, mode, music):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path / "source.mp4", duration=4, rate="12")
    output = tmp_path / "output.mp4"
    info = VideoInfo(
        path=str(source),
        duration=4,
        width=160,
        height=96,
        fps=12,
        video_codec="h264",
        pixel_format="yuv420p",
        has_audio=True,
        audio_codec="aac",
    )
    result = EncodePlan(
        source=str(source),
        output=str(output),
        source_info=info,
        segments=[placed(2, 3, 1), placed(0, 1, 3)],
        target_width=160,
        target_height=96,
        target_fps=6,
        video_encoder="libx264",
        preset="ultrafast",
        two_pass=False,
        audio_bitrate=128000,
        frame_blending=FrameBlending(enabled=mode != "standard"),
    )
    if music:
        music_path = tmp_path / "music.wav"
        tools.run(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", str(music_path)])
        result.source_audio_muted = True
        result.audio_tracks = [
            AudioTrack(
                track_id="music",
                name="Music",
                clips=[
                    AudioClip(
                        source=str(music_path),
                        timeline_start=0,
                        source_in=0,
                        source_out=4,
                        timeline_duration=4,
                    )
                ],
            )
        ]
    options = {}
    stream_input = None
    if mode in {"prepared", "streamed"}:
        prepared = tmp_path / "prepared.mkv"
        prepare_blended_video(result, prepared, lambda: None, lambda *_: None)
        if mode == "prepared":
            options["prepared_video"] = prepared
        else:
            options["streamed_video"] = True
            stream_input = prepared.read_bytes()
    elif mode == "tmix":
        blend = tmix_blend(result)
        assert blend is not None
        options["blend"] = blend
    command = build_base_cmd(tools.ffmpeg, result, source, **options)
    process = subprocess.run(
        [*command, "-y", str(output)], input=stream_input, capture_output=True, timeout=120
    )
    assert process.returncode == 0, process.stderr.decode(errors="replace")
    with av.open(str(output)) as container:
        frames = list(container.decode(video=0))
    assert float(frames[-1].time) >= 3.8
    for at, black in [(0.5, True), (1.5, False), (2.5, True), (3.5, False)]:
        frame = min(frames, key=lambda f: abs(float(f.time) - at))
        mean = float(frame.to_ndarray(format="rgb24").mean())
        assert (mean < 2) == black
    if mode == "standard":
        with av.open(str(source)) as container:
            original = list(container.decode(video=0))
        for project_at, source_at in [(1.5, 2.5), (3.5, 0.5)]:
            exported = min(frames, key=lambda frame: abs(float(frame.time) - project_at))
            expected = min(original, key=lambda frame: abs(float(frame.time) - source_at))
            difference = np.abs(
                exported.to_ndarray(format="rgb24").astype(np.int16)
                - expected.to_ndarray(format="rgb24").astype(np.int16)
            )
            assert difference.mean() < 5
    raw = tools.run(
        [
            "-v",
            "error",
            "-i",
            str(output),
            "-map",
            "0:a:0",
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "pipe:1",
        ]
    ).stdout
    samples = np.frombuffer(raw, dtype="<f4")
    assert len(samples) >= 4 * 48000 - 1024
    for start, end in [(12000, 36000), (108000, 132000)]:
        level = np.max(np.abs(samples[start:end]))
        assert (level > 0.01) if music else (level < 0.001)


def test_weighted_blending_keeps_placement_after_joining(tmp_path):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path / "source.mp4", duration=1, rate="12", audio=False)
    output = tmp_path / "output.mp4"
    info = VideoInfo(
        path=str(source),
        duration=1,
        width=160,
        height=96,
        fps=12,
        video_codec="h264",
        pixel_format="yuv420p",
        has_audio=False,
        color_space="bt709",
        color_transfer="bt709",
        color_primaries="bt709",
        color_range="tv",
    )
    result = EncodePlan(
        source=str(source),
        output=str(output),
        source_info=info,
        segments=[placed(0, 1, 1)],
        target_width=160,
        target_height=96,
        target_fps=6,
        video_encoder="libx264",
        preset="ultrafast",
        two_pass=False,
        frame_blending=FrameBlending(enabled=True, curve="gaussian"),
    )
    blend = weighted_yuv_blend(result)
    assert blend is not None
    command = build_base_cmd(tools.ffmpeg, result, source, blend=blend)
    process = subprocess.run([*command, "-y", str(output)], capture_output=True, timeout=120)
    assert process.returncode == 0, process.stderr.decode(errors="replace")
    with av.open(str(output)) as container:
        frames = list(container.decode(video=0))
    assert len(frames) == 12
    assert frames[3].to_ndarray(format="rgb24").mean() < 2
    assert frames[9].to_ndarray(format="rgb24").mean() > 10


@pytest.mark.parametrize("mode", ["standard", "prepared", "streamed", "tmix"])
@pytest.mark.parametrize("short_tail", [False, True])
def test_non_frame_aligned_segments_keep_one_project_frame_grid(tmp_path, mode, short_tail):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = tmp_path / "source.mp4"
    output = tmp_path / "output.mp4"
    tools.run(
        [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=32x32:r=10:d=2",
            "-f",
            "lavfi",
            "-i",
            "color=blue:s=32x32:r=10:d=2",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map",
            "[v]",
            "-c:v",
            "libx264",
            str(source),
        ]
    )
    info = VideoInfo(
        path=str(source),
        duration=4,
        width=32,
        height=32,
        fps=10,
        video_codec="h264",
        pixel_format="yuv420p",
        has_audio=False,
    )
    segments = [
        placed(0 if i % 2 == 0 else 2, (0 if i % 2 == 0 else 2) + 0.15, i * 0.15) for i in range(10)
    ]
    if short_tail:
        segments = [placed(0, 0.05, 0), placed(2, 2.05, 0.12)]
    result = EncodePlan(
        source=str(source),
        output=str(output),
        source_info=info,
        segments=segments,
        target_width=32,
        target_height=32,
        target_fps=10,
        video_encoder="libx264",
        preset="ultrafast",
        two_pass=False,
        frame_blending=FrameBlending(enabled=mode != "standard"),
    )
    options = {}
    stream_input = None
    if mode in {"prepared", "streamed"}:
        prepared = tmp_path / "prepared.nut"
        prepare_blended_video(result, prepared, lambda: None, lambda *_: None)
        if mode == "prepared":
            options["prepared_video"] = prepared
        else:
            options["streamed_video"] = True
            stream_input = prepared.read_bytes()
    elif mode == "tmix":
        blend = tmix_blend(result)
        assert blend is not None
        options["blend"] = blend
    command = build_base_cmd(tools.ffmpeg, result, source, **options)
    process = subprocess.run(
        [*command, "-y", str(output)], input=stream_input, capture_output=True, timeout=120
    )
    assert process.returncode == 0, process.stderr.decode(errors="replace")
    with av.open(str(output)) as container:
        frames = list(container.decode(video=0))
    colors = []
    for frame in frames:
        pixels = frame.to_ndarray(format="rgb24")
        colors.append(
            "X"
            if pixels.mean() < 2
            else "R"
            if pixels[:, :, 0].mean() > pixels[:, :, 2].mean()
            else "B"
        )
    assert "".join(colors) == ("RX" if short_tail else "RRBRRBRRBRRBRRB")


@pytest.mark.parametrize("delta", [-1, 1])
def test_cut_allows_one_microsecond_wire_rounding(tmp_path, delta):
    request = cut_request(tmp_path, [(10, 11, 0), (20, 21, Fraction(1_000_000 + delta, 1_000_000))])
    assert len(parse_cut_request(request).segments) == 2


def test_weighted_blending_samples_the_project_frame_phase(tmp_path):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source, output = tmp_path / "source.mp4", tmp_path / "output.mp4"
    tools.run(
        [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=32x32:r=12:d=1",
            "-vf",
            "geq=lum='N*20':cb=128:cr=128",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            str(source),
        ]
    )
    info = VideoInfo(
        path=str(source),
        duration=1,
        width=32,
        height=32,
        fps=12,
        video_codec="h264",
        pixel_format="yuv420p",
        has_audio=False,
        color_space="bt709",
        color_transfer="bt709",
        color_primaries="bt709",
        color_range="tv",
    )
    result = EncodePlan(
        source=str(source),
        output=str(output),
        source_info=info,
        segments=[placed(0, 1, 0.05)],
        target_width=32,
        target_height=32,
        target_fps=6,
        video_encoder="libx264",
        preset="ultrafast",
        two_pass=False,
        frame_blending=FrameBlending(enabled=True, curve="gaussian"),
    )
    expected = [float(pixels.mean()) for pixels in blended_frames(result, lambda: None)]
    blend = weighted_yuv_blend(result)
    assert blend is not None
    command = build_base_cmd(tools.ffmpeg, result, source, blend=blend)
    process = subprocess.run([*command, "-y", str(output)], capture_output=True, timeout=120)
    assert process.returncode == 0, process.stderr.decode(errors="replace")
    with av.open(str(output)) as container:
        actual = [
            float(frame.to_ndarray(format="rgb24").mean()) for frame in container.decode(video=0)
        ]
    assert len(actual) == len(expected)
    assert np.max(np.abs(np.array(actual) - np.array(expected))) < 3


def test_prepared_progress_includes_project_gap_frames(tmp_path):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path / "source.mp4", duration=1, rate="12", audio=False)
    info = VideoInfo(
        path=str(source),
        duration=1,
        width=160,
        height=96,
        fps=12,
        video_codec="h264",
        pixel_format="yuv420p",
        has_audio=False,
    )
    result = EncodePlan(
        source=str(source),
        output=str(tmp_path / "output.mp4"),
        source_info=info,
        segments=[placed(0, 0.25, 1)],
        target_fps=6,
        frame_blending=FrameBlending(enabled=True),
    )
    progress = []
    prepare_blended_video(
        result,
        tmp_path / "prepared.nut",
        lambda: None,
        lambda fraction, _rate: progress.append(fraction),
    )
    assert progress[0] == pytest.approx((1 / 6) / 1.25)
    assert progress[-1] == 1
