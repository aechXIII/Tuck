"""Test clips for the native player's seek check, made reproducibly with FFmpeg 7.1.

Every frame shows its index, so a captured picture can be checked by eye. `seek-fixtures.txt`
lists each clip's frame times the way the player's decoder computes them (best-effort timestamps
in the stream's time base, minus the file's start), for `tuck_player_seek_check` to compare against,
and the sounds it reads with the mix's reader.

    python scripts/player_fixtures.py --out build/player-fixtures
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
from fractions import Fraction
from pathlib import Path

# drawtext needs a font file: without one it falls back to fontconfig, which crashes FFmpeg
# where fontconfig isn't set up
DEFAULT_FONT = (
    "C:/Windows/Fonts/arial.ttf"
    if platform.system() == "Windows"
    else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
)
NUMBERS = (
    "drawtext=fontfile='{font}':text='%{{n}}':fontsize=160:fontcolor=white:box=1:"
    "boxcolor=black@0.8:x=(w-tw)/2:y=(h-th)/2"
)
TEST_PATTERN = ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12"]

# name: (source, encoder arguments). Software-only formats check the decoders without a GPU path.
CLIPS: dict[str, tuple[list[str], list[str]]] = {
    "numbers-h264.mp4": (
        TEST_PATTERN,
        ["-vf", NUMBERS, "-c:v", "libx264", "-g", "90", "-bf", "2", "-pix_fmt", "yuv420p"],
    ),
    "numbers-hevc10.mp4": (
        TEST_PATTERN,
        [
            "-vf",
            NUMBERS + ",format=yuv420p10le",
            "-c:v",
            "libx265",
            "-x265-params",
            "keyint=90:log-level=error",
            "-tag:v",
            "hvc1",
        ],
    ),
    "numbers-vp9.webm": (
        TEST_PATTERN,
        ["-vf", NUMBERS, "-c:v", "libvpx-vp9", "-g", "90", "-b:v", "2M"],
    ),
    "numbers-av1.mkv": (
        TEST_PATTERN,
        ["-vf", NUMBERS, "-c:v", "libsvtav1", "-g", "90", "-preset", "8"],
    ),
    "numbers-h264-444.mp4": (
        TEST_PATTERN,
        ["-vf", NUMBERS, "-c:v", "libx264", "-g", "90", "-pix_fmt", "yuv444p"],
    ),
    "numbers-mpeg4.avi": (
        TEST_PATTERN,
        ["-vf", NUMBERS, "-c:v", "mpeg4", "-g", "90", "-q:v", "4"],
    ),
    # frames 1/60 to 3/60 s apart: an irregular subset of a 60 fps source, kept as it is
    "numbers-vfr.mp4": (
        ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60:duration=12"],
        [
            "-vf",
            "select='not(mod(n\\,3))+eq(mod(n\\,7)\\,1)'," + NUMBERS,
            "-fps_mode",
            "passthrough",
            "-c:v",
            "libx264",
            "-g",
            "90",
            "-bf",
            "2",
            "-pix_fmt",
            "yuv420p",
        ],
    ),
    # a keyframe every 10 s at 1080p60, so a seek near the end of a group decodes 600 frames
    "numbers-longgop.mp4": (
        ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=20"],
        [
            "-vf",
            NUMBERS,
            "-c:v",
            "libx264",
            "-g",
            "600",
            "-keyint_min",
            "600",
            "-sc_threshold",
            "0",
            "-bf",
            "3",
            "-pix_fmt",
            "yuv420p",
        ],
    ),
}
# a steady tone at a rate the mix resamples, so any stretch of it is loud
SOUNDS: dict[str, list[str]] = {
    "sound-aac.m4a": [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=6",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
    ],
}
# shown turned a quarter, as phones record: the stream's display matrix says so
ROTATED = ("numbers-rotated.mp4", "numbers-h264.mp4", "90")


def run(*command: str) -> str:
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def frame_times(ffprobe: str, path: Path) -> list[Fraction]:
    probe = json.loads(
        run(
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=time_base:format=start_time:frame=best_effort_timestamp",
            "-show_frames",
            "-of",
            "json",
            str(path),
        )
    )
    time_base = Fraction(probe["streams"][0]["time_base"])
    # the start is whole microseconds, as the decoder reads it from AVFormatContext.start_time
    start = Fraction(probe["format"].get("start_time", "0"))
    return [int(frame["best_effort_timestamp"]) * time_base - start for frame in probe["frames"]]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--font", default=DEFAULT_FONT, help="font file for the frame numbers")
    args = parser.parse_args()
    font = Path(args.font)
    if not font.is_file():
        raise SystemExit(f"No font file at {font}; pass one with --font")
    # inside a filter argument a drive colon must be escaped
    numbers = NUMBERS.format(font=font.as_posix().replace(":", "\\:"))
    version = run(args.ffmpeg, "-hide_banner", "-version").splitlines()[0]
    if " 7.1" not in version:
        raise SystemExit(f"The fixtures are made with FFmpeg 7.1, not: {version}")
    args.out.mkdir(parents=True, exist_ok=True)
    for name, (source, encode) in CLIPS.items():
        encode = [arg.replace(NUMBERS, numbers) for arg in encode]
        run(
            args.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *source,
            *encode,
            str(args.out / name),
        )
    for name, arguments in SOUNDS.items():
        run(
            args.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *arguments,
            str(args.out / name),
        )
    rotated, original, angle = ROTATED
    run(
        args.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-display_rotation:v:0",
        angle,
        "-i",
        str(args.out / original),
        "-c",
        "copy",
        str(args.out / rotated),
    )
    lines = []
    for name in [*CLIPS, rotated]:
        times = frame_times(args.ffprobe, args.out / name)
        lines.append(" ".join(["clip", name, str(len(times)), *(f"{float(t):.9f}" for t in times)]))
        print(f"{name}: {len(times)} frames")
    lines.extend(f"sound {name} 0" for name in SOUNDS)
    (args.out / "seek-fixtures.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
