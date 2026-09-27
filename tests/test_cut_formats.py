import subprocess
from fractions import Fraction
from threading import Event

import av
import pytest
from media.cut_fixtures import find_tools

from tuck.bridge_serialization import queue_item_dict
from tuck.cutting.analysis import analyze_source
from tuck.cutting.bitstream import HevcConfig
from tuck.cutting.exact import exact_media_reason
from tuck.cutting.planner import parse_cut_request, plan_cut
from tuck.cutting.runner import CutRunner
from tuck.cutting.serialization import cut_plan_preview_dict
from tuck.models.cutting import MediaTime
from tuck.queue import QueueItem


@pytest.fixture(scope="module")
def tools():
    value = find_tools()
    if value is None:
        pytest.skip("FFmpeg is required")
    return value


@pytest.fixture(scope="module")
def encoders(tools):
    return subprocess.run(
        [tools.ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True
    ).stdout


def need(encoders, *names):
    for name in names:
        if f" {name} " not in encoders:
            pytest.skip(f"{name} is not available")


VIDEO = "testsrc2=size=160x96:rate=30:duration=6"
GOP = ["-g", "30", "-keyint_min", "30", "-sc_threshold", "0"]


def make(tools, path, *args):
    tools.run(["-v", "error", "-y", "-f", "lavfi", "-i", VIDEO, *args, str(path)])
    return path


def cut(source, ranges, precision="keyframes"):
    analysis = analyze_source(source, Event(), lambda _: None)
    assert analysis.issues == ()
    request = parse_cut_request(
        {
            "operation": "cut",
            "source": str(source),
            "precision": precision,
            "segments": [
                {
                    "start": MediaTime.from_seconds(Fraction(a)).to_dict(),
                    "end": MediaTime.from_seconds(Fraction(b)).to_dict(),
                }
                for a, b in ranges
            ],
        }
    )
    plan = plan_cut(request, analysis)
    assert plan.issues == ()
    output = CutRunner().run(plan)
    return analysis, plan, output


def kept_frames(analysis, plan):
    return sum(
        1
        for frame in analysis.frames
        for segment in plan.segments
        if segment.resolved.start.seconds <= frame < segment.resolved.end.seconds
    )


def analysis_of(source):
    return analyze_source(source, Event(), lambda _: None)


def frame_count(path):
    with av.open(str(path)) as container:
        return sum(1 for _ in container.decode(video=0))


def test_hevc_matroska_keeps_every_track_chapters_and_attachments(tools, encoders, tmp_path):
    need(encoders, "libx265", "libopus")
    subtitle = tmp_path / "s.srt"
    subtitle.write_text(
        "1\n00:00:00,500 --> 00:00:01,500\nFirst\n\n2\n00:00:04,200 --> 00:00:05,000\nSecond\n",
        encoding="utf-8",
    )
    chapters = tmp_path / "chapters.txt"
    chapters.write_text(
        ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=One\n"
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=3000\nEND=6000\ntitle=Two\n",
        encoding="utf-8",
    )
    source = tmp_path / "rich source.mkv"
    tools.run(
        [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            VIDEO,
            "-f",
            "lavfi",
            "-i",
            "sine=duration=6",
            "-i",
            str(subtitle),
            "-i",
            str(chapters),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-map",
            "2:s",
            "-map_chapters",
            "3",
            "-c:v",
            "libx265",
            "-x265-params",
            "log-level=error:keyint=30:min-keyint=30",
            "-c:a:0",
            "aac",
            "-c:a:1",
            "libopus",
            "-c:s",
            "srt",
            "-attach",
            str(subtitle),
            "-metadata:s:t",
            "mimetype=text/plain",
            str(source),
        ]
    )
    _, plan, output = cut(source, [(0, 2), (4, 6)])
    first, second = plan.segments
    joined = first.resolved.end.seconds - first.resolved.start.seconds
    assert output.name == "rich source_cut.mkv"
    assert [t.kind for t in plan.tracks if t.keep] == ["audio", "audio", "subtitle", "attachment"]
    assert [c.title for c in plan.chapters] == ["One", "Two"]
    preview = cut_plan_preview_dict(plan)
    assert preview["chapter_count"] == 2
    assert [(t["kind"], t["keep"]) for t in preview["tracks"]] == [
        (t.kind, t.keep) for t in plan.tracks
    ]
    with av.open(str(output)) as container:
        assert [s.type for s in container.streams] == [
            "video",
            "audio",
            "audio",
            "subtitle",
            "attachment",
        ]
        kept = container.chapters()
        assert [c["metadata"]["title"] for c in kept] == ["One", "Two"]
        assert kept[1]["start"] * kept[1]["time_base"] == joined
        subtitles = [p for p in container.demux(container.streams.subtitles[0]) if p.size]
        times = [(p.pts * p.time_base, p.duration * p.time_base) for p in subtitles]
    # the first line keeps its time; the second moves back with its part of the video
    second_start = joined + Fraction(21, 5) - second.resolved.start.seconds
    assert times == [(Fraction(1, 2), 1), (second_start, Fraction(4, 5))]
    assert frame_count(output) == kept_frames(analysis_of(source), plan)


def test_variable_frame_rate_video_keeps_its_own_frame_times(tools, encoders, tmp_path):
    need(encoders, "libx264")
    source = make(
        tools,
        tmp_path / "vfr.mp4",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=6",
        "-vf",
        "select=not(eq(mod(n\\,3)\\,1))",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        *GOP,
        "-bf",
        "2",
        "-c:a",
        "aac",
    )
    analysis, _, output = cut(source, [(0, 2), (3, 5)])
    kept = [f for f in analysis.frames if f < 2 or 3 <= f < 5]
    assert frame_count(output) == len(kept)


@pytest.mark.parametrize(
    ("name", "video", "audio"),
    [
        ("av1.mp4", ["-c:v", "libsvtav1", *GOP], ["-c:a", "libopus"]),
        ("vp9.webm", ["-c:v", "libvpx-vp9", *GOP], ["-c:a", "libopus"]),
        ("h264.ts", ["-c:v", "libx264", *GOP, "-bf", "2"], ["-c:a", "aac"]),
        ("h264.mov", ["-c:v", "libx264", *GOP, "-bf", "2"], ["-c:a", "aac"]),
        ("mpeg4.avi", ["-c:v", "mpeg4", *GOP], ["-c:a", "libmp3lame"]),
        ("h264.flv", ["-c:v", "libx264", *GOP], ["-c:a", "aac"]),
        ("h264.3gp", ["-c:v", "libx264", *GOP], ["-c:a", "aac"]),
    ],
)
def test_other_codecs_and_containers_are_cut_into_the_same_container(
    tools, encoders, tmp_path, name, video, audio
):
    need(encoders, video[1], audio[1])
    source = make(tools, tmp_path / name, "-f", "lavfi", "-i", "sine=duration=6", *video, *audio)
    analysis, plan, output = cut(source, [(1, 3), (4, 6)])
    assert output.suffix == source.suffix
    assert frame_count(output) == kept_frames(analysis, plan)


def test_rotation_is_kept(tools, encoders, tmp_path):
    need(encoders, "libx264")
    plain = make(tools, tmp_path / "plain.mp4", "-c:v", "libx264", *GOP)
    rotated = tmp_path / "rotated.mp4"
    tools.run(
        [
            "-v",
            "error",
            "-y",
            "-display_rotation",
            "90",
            "-i",
            str(plain),
            "-c",
            "copy",
            str(rotated),
        ]
    )
    _, _, output = cut(rotated, [(1, 4)])
    probe = subprocess.run(
        [
            tools.ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream_side_data=rotation",
            "-of",
            "csv=p=0",
            str(output),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert probe.stdout.strip() == "90"


def test_open_gop_starts_are_cut_and_marked_not_checked(tools, encoders, tmp_path):
    need(encoders, "libx264")
    source = make(
        tools,
        tmp_path / "open.mp4",
        "-c:v",
        "libx264",
        *GOP,
        "-bf",
        "2",
        "-x264-params",
        "open-gop=1:b-adapt=0",
    )
    analysis, plan, output = cut(source, [(1, 3), (4, 6)])
    assert [note.code for note in plan.unverified] == ["unverified_start"]
    assert frame_count(output) == kept_frames(analysis, plan)
    # the note reaches the Inspector and the queue so the export is not presented as checked
    message = plan.unverified[0].message
    assert cut_plan_preview_dict(plan)["unverified"] == [
        {"code": "unverified_start", "message": message, "field": None, "title": ""}
    ]
    assert queue_item_dict(QueueItem(plan=plan))["unverified"] == [message]


def probe_video(tools, path, entries):
    out = subprocess.run(
        [
            tools.ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            f"stream={entries}",
            "-of",
            "default=nw=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def test_hevc_tag_timescale_and_ten_bit_video_are_kept(tools, encoders, tmp_path):
    need(encoders, "libx265")
    source = make(
        tools,
        tmp_path / "phone.mp4",
        "-c:v",
        "libx265",
        "-x265-params",
        "log-level=error:keyint=30:min-keyint=30",
        "-pix_fmt",
        "yuv420p10le",
        "-tag:v",
        "hvc1",
        "-video_track_timescale",
        "600",
    )
    _, _, output = cut(source, [(1, 3), (4, 6)])
    assert probe_video(tools, output, "codec_tag_string,time_base,pix_fmt") == {
        "codec_tag_string": "hvc1",
        "time_base": "1/600",
        "pix_fmt": "yuv420p10le",
    }


@pytest.mark.parametrize("precision", ["keyframes", "exact"])
def test_colour_description_is_kept(tools, encoders, tmp_path, precision):
    need(encoders, "libx264")
    source = make(
        tools,
        tmp_path / "colour.mp4",
        "-c:v",
        "libx264",
        *GOP,
        "-pix_fmt",
        "yuv420p",
        # FFmpeg's colour options do not reach x264 for generated input, so set its VUI
        "-x264-params",
        "colorprim=smpte170m:transfer=bt709:colormatrix=smpte170m:range=tv",
    )
    _, _, output = cut(source, [(Fraction(13, 10), 3), (Fraction(41, 10), 6)], precision)
    frame = subprocess.run(
        [
            tools.ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-read_intervals",
            "%+#1",
            "-show_entries",
            "frame=color_primaries,color_transfer,color_space",
            "-of",
            "default=nw=1",
            str(output),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # with Exact the first frame is an encoded edge, which must describe colour like the source
    assert "color_primaries=smpte170m" in frame and "color_transfer=bt709" in frame


@pytest.mark.parametrize(
    ("name", "video"),
    [
        (
            "hevc.mp4",
            ["-c:v", "libx265", *GOP, "-tag:v", "hvc1", "-x265-params", "log-level=error"],
        ),
        (
            "hevc10.mkv",
            ["-c:v", "libx265", *GOP, "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error"],
        ),
        ("av1.mp4", ["-c:v", "libsvtav1", *GOP]),
        ("av1.webm", ["-c:v", "libaom-av1", "-cpu-used", "8", *GOP]),
        ("vp9.webm", ["-c:v", "libvpx-vp9", *GOP]),
        ("vp8.webm", ["-c:v", "libvpx", *GOP]),
        (
            "vfr.mkv",
            [
                "-vf",
                r"select=not(eq(mod(n\,3)\,1))",
                "-fps_mode",
                "vfr",
                "-c:v",
                "libx264",
                *GOP,
                "-bf",
                "2",
            ],
        ),
    ],
)
def test_exact_cuts_other_codecs_frame_accurately(tools, encoders, tmp_path, name, video):
    need(encoders, video[video.index("-c:v") + 1])
    source = make(tools, tmp_path / name, *video)
    analysis = analysis_of(source)
    frames = analysis.frames
    # cut points between keyframes, so both edges of each part are re-encoded
    ranges = [(frames[14], frames[60]), (frames[75], frames[110])]
    reason = exact_media_reason(analysis)
    if reason.startswith("This build cannot"):
        pytest.skip(reason)
    assert reason == ""
    _, plan, output = cut(source, ranges, "exact")
    assert [s.start_kind for s in plan.segments] == ["exact", "exact"]
    assert frame_count(output) == 46 + 35
    with av.open(str(source)) as original, av.open(str(output)) as result:
        assert (
            result.streams.video[0].codec_context.name
            == original.streams.video[0].codec_context.name
        )
        assert result.streams.video[0].codec_tag == original.streams.video[0].codec_tag
        if name.startswith("hevc"):
            # the edges' own parameter sets sit beside the source's in one configuration
            config = HevcConfig.parse(result.streams.video[0].codec_context.extradata)
            assert len(config.units(33)) == len(config.units(34)) == 2
