import subprocess
from fractions import Fraction
from threading import Event

import pytest
from media.cut_fixtures import find_tools

from tuck.cutting.timeline import TimelineError, is_clean_entry, read_timeline


@pytest.fixture(scope="module")
def tools():
    value = find_tools()
    if value is None:
        pytest.skip("FFmpeg is required")
    return value


@pytest.fixture(scope="module")
def encoders(tools):
    listing = subprocess.run(
        [tools.ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True
    )
    return listing.stdout


def encode(tools, encoders, path, video, *extra, rate=30, duration=3, source="testsrc2"):
    if f" {video[1]} " not in encoders:
        pytest.skip(f"{video[1]} is not available")
    tools.run(
        [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"{source}=size=160x96:rate={rate}:duration={duration}",
            *video,
            *extra,
            str(path),
        ]
    )
    return path


H264 = [
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-bf",
    "3",
    "-pix_fmt",
    "yuv420p",
]


def seconds(values):
    return [float(v) for v in values]


def test_h264_mp4_has_verified_entry_points_and_complete_prefix_ends(tools, encoders, tmp_path):
    timeline = read_timeline(str(encode(tools, encoders, tmp_path / "a.mp4", H264)), Event())
    video = timeline.video
    assert timeline.format_name.startswith("mov,mp4")
    assert video.codec == "h264"
    assert len(video.frames) == 90 and video.constant_rate and video.regular_decode
    assert video.nominal_step == Fraction(1, 30)
    assert video.keyframes == (0, 1, 2)
    assert not video.unverified_keyframes
    assert video.end == 3 and video.safe_ends[-1] == 3
    # with B-frames only some prefixes are complete, and each ends on a frame edge
    assert all(end * 30 == int(end * 30) for end in video.safe_ends)


def test_mpeg_ts_uses_annex_b_start_codes(tools, encoders, tmp_path):
    timeline = read_timeline(str(encode(tools, encoders, tmp_path / "a.ts", H264)), Event())
    assert timeline.video.keyframes == (0, 1, 2)
    assert not timeline.video.unverified_keyframes


def test_h264_open_gop_keyframes_are_usable_but_unverified(tools, encoders, tmp_path):
    path = encode(
        tools,
        encoders,
        tmp_path / "open.mp4",
        [*H264[:-2], "-x264-params", "open-gop=1:b-adapt=0", "-pix_fmt", "yuv420p"],
    )
    video = read_timeline(str(path), Event()).video
    assert len(video.keyframes) >= 2
    assert video.unverified_keyframes


def test_variable_frame_rate_keeps_every_frame_time(tools, encoders, tmp_path):
    path = encode(
        tools,
        encoders,
        tmp_path / "vfr.mp4",
        H264,
        "-vf",
        "select=not(eq(mod(n\\,3)\\,1))",
        "-fps_mode",
        "vfr",
    )
    video = read_timeline(str(path), Event()).video
    assert not video.constant_rate
    assert len(video.frames) == 60
    gaps = {b - a for a, b in zip(video.frames, video.frames[1:], strict=False)}
    assert gaps == {Fraction(1, 30), Fraction(2, 30)}


def test_hevc_cra_in_matroska_is_a_verified_entry_point(tools, encoders, tmp_path):
    path = encode(
        tools,
        encoders,
        tmp_path / "a.mkv",
        [
            "-c:v",
            "libx265",
            "-g",
            "30",
            "-x265-params",
            "log-level=error:open-gop=1:keyint=30:min-keyint=30",
        ],
        "-pix_fmt",
        "yuv420p",
    )
    timeline = read_timeline(str(path), Event())
    video = timeline.video
    assert timeline.format_name.startswith("matroska")
    assert video.codec == "hevc"
    assert len(video.keyframes) == 3 and not video.unverified_keyframes
    # millisecond container timestamps make even a steady 30 fps uneven
    assert len(video.frames) == 90 and not video.constant_rate


@pytest.mark.parametrize(
    ("name", "codec"),
    [
        ("a.mp4", ["-c:v", "libsvtav1", "-g", "30", "-pix_fmt", "yuv420p"]),
        ("b.mkv", ["-c:v", "libsvtav1", "-g", "30", "-pix_fmt", "yuv420p"]),
        ("c.webm", ["-c:v", "libvpx-vp9", "-g", "30", "-pix_fmt", "yuv420p"]),
    ],
)
def test_av1_and_vp9_key_frames_are_verified(tools, encoders, tmp_path, name, codec):
    video = read_timeline(str(encode(tools, encoders, tmp_path / name, codec)), Event()).video
    assert video.codec in {"av1", "vp9"}
    assert len(video.keyframes) == 3 and not video.unverified_keyframes


def test_all_intra_video_can_start_on_any_frame(tools, encoders, tmp_path):
    video = read_timeline(
        str(encode(tools, encoders, tmp_path / "a.mkv", ["-c:v", "mjpeg"])), Event()
    ).video
    assert len(video.keyframes) == len(video.frames) == 90
    assert not video.unverified_keyframes


def test_other_tracks_keep_their_packet_timing(tools, encoders, tmp_path):
    subtitle = tmp_path / "s.srt"
    subtitle.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello\n", encoding="utf-8")
    path = tmp_path / "tracks.mkv"
    tools.run(
        [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x96:rate=30:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=3",
            "-i",
            str(subtitle),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-map",
            "2:s",
            *H264,
            "-c:a:0",
            "aac",
            "-c:a:1",
            "libopus",
            "-c:s",
            "srt",
            str(path),
        ]
    )
    others = read_timeline(str(path), Event()).others
    assert [(o.kind, o.codec) for o in others] == [
        ("audio", "aac"),
        ("audio", "opus"),
        ("subtitle", "subrip"),
    ]
    assert others[2].packets[0].start == 1 and others[2].packets[0].duration == 1


def test_cover_art_is_not_taken_for_the_video(tools, encoders, tmp_path):
    video_path = encode(tools, encoders, tmp_path / "v.mp4", H264)
    cover = tmp_path / "cover.png"
    tools.run(
        [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:size=64x64",
            "-frames:v",
            "1",
            str(cover),
        ]
    )
    path = tmp_path / "cover.mp4"
    tools.run(
        [
            "-v",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(cover),
            "-map",
            "1",
            "-map",
            "0",
            "-c",
            "copy",
            "-disposition:0",
            "attached_pic",
            str(path),
        ]
    )
    assert read_timeline(str(path), Event()).video.codec == "h264"


def test_files_without_video_or_timing_are_errors(tools, tmp_path):
    audio = tmp_path / "audio.m4a"
    tools.run(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", str(audio)])
    with pytest.raises(TimelineError) as error:
        read_timeline(str(audio), Event())
    assert error.value.code == "unsupported_stream"


def test_entry_point_rules_by_codec():
    idr = b"\x00\x00\x00\x05\x65\x88\x84\x00\x10"
    non_idr = b"\x00\x00\x00\x05\x41\x9a\x00\x00\x10"
    assert is_clean_entry("h264", idr, 4) is True
    assert is_clean_entry("h264", non_idr, 4) is False
    assert is_clean_entry("h264", b"\x00\x00\x01\x65\x88\x84", None) is True
    cra = bytes([0, 0, 0, 3, 21 << 1, 1, 0xAF])
    trail = bytes([0, 0, 0, 3, 1 << 1, 1, 0xAF])
    assert is_clean_entry("hevc", cra, 4) is True
    assert is_clean_entry("hevc", trail, 4) is False
    assert is_clean_entry("av1", b"", None) is True
    assert is_clean_entry("mpeg2video", b"", None) is None
