"""What joining videos into one file means: which videos can be joined without re-encoding,
the file the result goes to, and the FFmpeg commands for either way."""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from ..media_tools import media_tool_environment
from ..models.encoding_policy import AMF_ENCODERS, NVENC_ENCODERS, VAAPI_ENCODERS
from ..output_paths import OUTPUT_EXTENSIONS
from ..probe import parse_display_rotation

JOINED_SUFFIX = "_joined"
MAX_JOIN_VIDEOS = 100
# a re-encoded join is H.264 and AAC in MP4, which every player and Tuck itself can open
ENCODED_EXTENSION = ".mp4"
AUDIO_RATE = 48000
_PROBE_TIMEOUT = 60


class JoinError(Exception):
    """A join that can't go ahead; the message says what to do instead."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class VideoFacts:
    codec: str
    profile: str
    width: int
    height: int
    pixel_format: str
    aspect: str
    rate: Fraction
    field_order: str
    color: tuple[str, str, str, str]
    rotation: int
    extradata: str


@dataclass(frozen=True)
class AudioFacts:
    codec: str
    profile: str
    sample_rate: int
    channels: int
    layout: str
    extradata: str


@dataclass(frozen=True)
class JoinSource:
    path: Path
    duration: float
    video: VideoFacts
    # every sound track in file order; a recording can keep game and microphone apart
    audio_tracks: tuple[AudioFacts, ...] = ()

    @property
    def audio(self) -> AudioFacts | None:
        # a re-encoded join keeps the first track, the one players play
        return self.audio_tracks[0] if self.audio_tracks else None

    @property
    def display_size(self) -> tuple[int, int]:
        # a phone video stored sideways plays upright, and so does its part of the join
        if self.video.rotation % 180 == 90:
            return self.video.height, self.video.width
        return self.video.width, self.video.height


def _text(stream: dict[str, object], key: str) -> str:
    value = stream.get(key)
    return str(value) if value is not None else ""


def _number(value: object) -> int:
    try:
        return int(str(value))
    except ValueError:
        return 0


def _rate(stream: dict[str, object]) -> Fraction:
    for key in ("avg_frame_rate", "r_frame_rate"):
        try:
            rate = Fraction(str(stream.get(key) or "0/1"))
        except (ValueError, ZeroDivisionError):
            continue
        if rate > 0:
            return rate
    return Fraction(0)


def _duration(data: dict[str, object], video: dict[str, object]) -> float:
    fmt = data.get("format")
    for raw in (fmt.get("duration") if isinstance(fmt, dict) else None, video.get("duration")):
        try:
            seconds = float(str(raw))
        except ValueError:
            continue
        if seconds > 0:
            return seconds
    return 0.0


def source_from_probe(path: Path, data: dict[str, object]) -> JoinSource:
    """The facts a join needs from ffprobe's JSON for one video."""
    listed = data.get("streams")
    streams = [s for s in listed if isinstance(s, dict)] if isinstance(listed, list) else []
    # a cover picture is a video stream too, but never the video
    videos = [
        s
        for s in streams
        if s.get("codec_type") == "video"
        and not (isinstance(s.get("disposition"), dict) and s["disposition"].get("attached_pic"))
    ]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if not videos:
        raise JoinError("no_video", f"{path.name} has no video to join.")
    video = videos[0]
    color = tuple(
        _text(video, key)
        for key in ("color_range", "color_space", "color_transfer", "color_primaries")
    )
    facts = VideoFacts(
        codec=_text(video, "codec_name"),
        profile=_text(video, "profile"),
        width=_number(video.get("width")),
        height=_number(video.get("height")),
        pixel_format=_text(video, "pix_fmt"),
        aspect=_text(video, "sample_aspect_ratio"),
        rate=_rate(video),
        field_order=_text(video, "field_order"),
        color=(color[0], color[1], color[2], color[3]),
        rotation=parse_display_rotation(video),
        extradata=_text(video, "extradata_hash"),
    )
    if facts.width <= 0 or facts.height <= 0:
        raise JoinError("no_video", f"Tuck couldn't read the picture size of {path.name}.")
    tracks = tuple(
        AudioFacts(
            codec=_text(stream, "codec_name"),
            profile=_text(stream, "profile"),
            sample_rate=_number(stream.get("sample_rate")),
            channels=_number(stream.get("channels")),
            layout=_text(stream, "channel_layout"),
            extradata=_text(stream, "extradata_hash"),
        )
        for stream in audios
    )
    return JoinSource(path, _duration(data, video), facts, tracks)


def probe_source(ffprobe: str, path: Path) -> JoinSource:
    command = [
        ffprobe,
        *("-v", "error", "-print_format", "json"),
        # the codec setup bytes decide whether two files can share one stream header
        *("-show_data_hash", "sha256", "-show_format", "-show_streams"),
        "--",
        str(path),
    ]
    try:
        result = subprocess.run(
            command,
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=_PROBE_TIMEOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise JoinError("unreadable", f"Tuck couldn't read {path.name}.") from exc
    if result.returncode != 0:
        raise JoinError(
            "unreadable",
            f"Tuck couldn't read {path.name}. Check that it plays in another app.",
        )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise JoinError("unreadable", f"Tuck couldn't read {path.name}.") from exc
    if not isinstance(data, dict):
        raise JoinError("unreadable", f"Tuck couldn't read {path.name}.")
    return source_from_probe(path, data)


def _format_rate(rate: Fraction) -> str:
    return f"{float(rate):.3g} fps"


def copy_mismatch(sources: list[JoinSource]) -> str:
    """Why these videos can't be joined by copying their streams, or "" when they can.

    Copying writes one stream header for the whole file, so every video has to share it:
    the same codec setup, picture, frame rate and audio, in the same kind of file.
    """
    first = sources[0]
    suffix = first.path.suffix.lower()
    for other in sources[1:]:
        a, b = first.video, other.video
        if other.path.suffix.lower() != suffix:
            return "the videos are different kinds of files"
        if a.codec != b.codec:
            return f"the videos use different codecs ({a.codec} and {b.codec})"
        if (a.width, a.height) != (b.width, b.height):
            return f"the picture sizes differ ({a.width}x{a.height} and {b.width}x{b.height})"
        if a.rate != b.rate:
            return f"the frame rates differ ({_format_rate(a.rate)} and {_format_rate(b.rate)})"
        if a.rotation != b.rotation:
            return "the videos are turned differently"
        if (a.profile, a.pixel_format, a.aspect, a.field_order, a.color, a.extradata) != (
            b.profile,
            b.pixel_format,
            b.aspect,
            b.field_order,
            b.color,
            b.extradata,
        ):
            return "the videos were recorded with different encoder settings"
        if (first.audio is None) != (other.audio is None):
            return "some videos have sound and some don't"
        if len(first.audio_tracks) != len(other.audio_tracks):
            return "the videos have different numbers of sound tracks"
        if first.audio_tracks != other.audio_tracks:
            return "their sound is in different formats"
    if suffix not in OUTPUT_EXTENSIONS:
        return "Tuck can't write this kind of file without re-encoding"
    # the concat list is read line by line, so a name with a line break can't be listed
    if any("\n" in str(s.path) or "\r" in str(s.path) for s in sources):
        return "a file name has a line break in it"
    return ""


def concat_list(paths: list[Path]) -> str:
    """The list FFmpeg's concat reader takes, with each name quoted as it expects.

    Inside single quotes everything is literal, backslashes in Windows paths included; a
    quote itself is closed, escaped and reopened.
    """
    lines = ["ffconcat version 1.0"]
    for path in paths:
        quoted = str(path.absolute()).replace("'", "'\\''")
        lines.append(f"file '{quoted}'")
    return "\n".join(lines) + "\n"


def joined_output(first: Path, extension: str) -> Path:
    """Where the joined video goes: beside the first video, named after it.

    The name is only asked for; the output transaction reserves it and numbers it when the
    name is taken, so an existing file, a source included, is never written over.
    """
    return first.parent / f"{first.stem}{JOINED_SUFFIX}{extension}"


def total_duration(sources: list[JoinSource]) -> float:
    if any(source.duration <= 0 for source in sources):
        return 0.0
    return sum(source.duration for source in sources)


def _progress_args() -> list[str]:
    # progress records go to stderr with the errors; nothing else is printed there
    return ["-hide_banner", "-nostdin", "-v", "error", "-nostats", "-progress", "pipe:2"]


def copy_command(ffmpeg: str, concat_file: Path, output: Path) -> list[str]:
    # every sound track is kept; subtitles and data tracks rarely line up across recordings
    return [
        ffmpeg,
        *_progress_args(),
        *("-f", "concat", "-safe", "0", "-i", str(concat_file)),
        *("-map", "0:v:0", "-map", "0:a?"),
        *("-c", "copy", "-map_metadata", "0", str(output)),
    ]


def encode_candidates(available: list[str]) -> list[str]:
    """H.264 encoders to try in order: the graphics card's first, the processor's last."""
    order = [e for e in available if e in NVENC_ENCODERS | AMF_ENCODERS | VAAPI_ENCODERS]
    order = [e for e in order if e.startswith("h264_")]
    return [*order, "libx264"]


def _even(value: int) -> int:
    return max(2, value - value % 2)


def encode_graph(sources: list[JoinSource], *, vaapi: bool) -> tuple[str, bool]:
    """A filter graph that fits every video to the first one's picture.

    Pictures are scaled to fit and centred on black, so nothing is cropped or stretched.
    Videos without sound get silence, so the sound stays in step with the pictures.
    Returns the graph and whether the result has sound.
    """
    width, height = (_even(side) for side in sources[0].display_size)
    has_audio = any(source.audio for source in sources)
    parts: list[str] = []
    labels: list[str] = []
    for index, source in enumerate(sources):
        parts.append(
            f"[{index}:v:0]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{index}]"
        )
        labels.append(f"[v{index}]")
        if not has_audio:
            continue
        if source.audio:
            parts.append(
                f"[{index}:a:0]aresample={AUDIO_RATE},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]"
            )
        else:
            parts.append(
                f"anullsrc=r={AUDIO_RATE}:cl=stereo,atrim=duration={source.duration:.6f}[a{index}]"
            )
        labels.append(f"[a{index}]")
    audio_count = 1 if has_audio else 0
    joined = "[vjoined][ajoined]" if has_audio else "[vjoined]"
    parts.append(f"{''.join(labels)}concat=n={len(sources)}:v=1:a={audio_count}{joined}")
    if vaapi:
        parts.append("[vjoined]format=nv12,hwupload[vout]")
    else:
        parts.append("[vjoined]null[vout]")
    return ";".join(parts), has_audio


# a high quality that keeps the joined video a good source for trimming and exporting again
_QUALITY_ARGS: dict[str, list[str]] = {
    "libx264": ["-preset", "medium", "-crf", "18"],
    "h264_nvenc": ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
    "h264_amf": ["-usage", "transcoding", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18"],
    "h264_vaapi": ["-rc_mode", "CQP", "-qp", "19"],
}


def encode_command(
    ffmpeg: str,
    sources: list[JoinSource],
    output: Path,
    encoder: str,
    *,
    vaapi_init: list[str] | None = None,
) -> list[str]:
    vaapi = encoder in VAAPI_ENCODERS
    if vaapi and not vaapi_init:
        raise ValueError("VAAPI encoding needs a render device")
    graph, has_audio = encode_graph(sources, vaapi=vaapi)
    rate = sources[0].video.rate or Fraction(30)
    command = [ffmpeg, *_progress_args(), *(vaapi_init or [])]
    for source in sources:
        command += ["-i", str(source.path)]
    command += ["-filter_complex", graph, "-map", "[vout]"]
    # the first video's frame rate is set on the output, not with an fps filter per video:
    # FFmpeg 7.1's fps filter drops each video's last frame, so every join skipped a frame
    command += ["-r", f"{rate.numerator}/{rate.denominator}", "-fps_mode", "cfr"]
    if has_audio:
        command += ["-map", "[ajoined]", "-c:a", "aac", "-b:a", "192k"]
    command += ["-c:v", encoder, *_QUALITY_ARGS[encoder]]
    return [*command, "-movflags", "+faststart", str(output)]
