"""Measure safe cut boundaries with bounded memory and cancellable local-media work."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path
from threading import Event
from time import monotonic

import av
from av.error import FFmpegError

from ..media_tools import find_ffprobe
from ..models.cutting import (
    AnalysisProgress,
    CutAnalysis,
    CutIssue,
    MediaTime,
    PacketTiming,
    SourceIdentity,
    StreamDescriptor,
)

ANALYSIS_VERSION = (
    "cut-prefix-1/pyav-" + av.__version__ + "/" + repr(sorted(av.library_versions.items()))
)
MAX_PACKETS = 500_000
MAX_PACKET_BYTES = 32 * 1024 * 1024
MAX_METADATA_BYTES = 4 * 1024 * 1024
ProgressCallback = Callable[[AnalysisProgress], None]


class CutAnalysisError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class CutRequestWork(Event):
    def __init__(self) -> None:
        super().__init__()
        # leave time to return a refusal before the native 120-second timeout
        self.deadline = monotonic() + 90

    def check(self) -> None:
        if monotonic() >= self.deadline:
            raise CutAnalysisError(
                "cut_timed_out",
                "Preparing the cut took too long. Read its keyframes again and retry.",
            )
        if self.is_set():
            raise CutAnalysisError("analysis_cancelled", "Cut preparation was cancelled.")


def check_cancel(cancel: Event) -> None:
    if isinstance(cancel, CutRequestWork):
        cancel.check()
    if cancel.is_set():
        raise CutAnalysisError("analysis_cancelled", "Keyframe analysis was cancelled.")


def analysis_version(ffprobe: str | None = None) -> str:
    binary = ffprobe or find_ffprobe()
    if not binary:
        raise CutAnalysisError("analysis_failed", "FFprobe is not available.")
    tool = Path(binary).stat()
    return f"{ANALYSIS_VERSION}/probe-{Path(binary).resolve()}-{tool.st_size}-{tool.st_mtime_ns}"


def source_identity(path: Path, cancel: Event) -> SourceIdentity:
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError("Choose a video file")
    before = resolved.stat()
    digest = hashlib.sha256()
    with resolved.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            check_cancel(cancel)
            digest.update(chunk)
    check_cancel(cancel)
    after = resolved.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ino,
    ):
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")
    return SourceIdentity(str(resolved), after.st_size, after.st_mtime_ns, digest.hexdigest())


def read_inventory(
    path: Path, cancel: Event, ffprobe: str
) -> tuple[tuple[StreamDescriptor, ...], tuple[CutIssue, ...]]:
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            [
                ffprobe,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-show_chapters",
                "-of",
                "json",
                str(path),
            ],
            stdout=output,
            stderr=errors,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = time.monotonic() + 30
        try:
            while process.poll() is None:
                check_cancel(cancel)
                if (
                    max(os.fstat(output.fileno()).st_size, os.fstat(errors.fileno()).st_size)
                    > MAX_METADATA_BYTES
                ):
                    raise CutAnalysisError(
                        "analysis_failed", "The video has too much metadata to analyze."
                    )
                if time.monotonic() > deadline:
                    raise CutAnalysisError(
                        "analysis_failed", "Reading the video metadata timed out."
                    )
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        if process.returncode:
            raise CutAnalysisError("analysis_failed", "The video metadata could not be read.")
        output.seek(0)
        payload = output.read(MAX_METADATA_BYTES + 1)
        if len(payload) > MAX_METADATA_BYTES:
            raise CutAnalysisError("analysis_failed", "The video has too much metadata to analyze.")
    raw = json.loads(payload)
    if not isinstance(raw, dict) or not isinstance(raw.get("streams"), list):
        raise CutAnalysisError("analysis_failed", "The video metadata is incomplete.")
    streams = []
    for stream in raw["streams"]:
        if not isinstance(stream, dict) or type(stream.get("index")) is not int:
            raise CutAnalysisError("analysis_failed", "The video stream metadata is incomplete.")
        tags = stream.get("tags", {})
        dispositions = stream.get("disposition", {})
        properties = {str(k): str(v) for k, v in stream.items() if isinstance(v, (str, int))}
        side_data = stream.get("side_data_list", [])
        if isinstance(side_data, list) and side_data:
            properties["side_data"] = json.dumps(side_data, sort_keys=True)
            for entry in side_data:
                if isinstance(entry, dict) and "rotation" in entry:
                    properties["rotation"] = str(entry["rotation"])
        streams.append(
            StreamDescriptor(
                stream["index"],
                str(stream.get("codec_type", "unknown")),
                str(stream.get("codec_name", "unknown")),
                tuple(sorted(properties.items())),
                tuple(sorted((str(k), str(v)) for k, v in tags.items()))
                if isinstance(tags, dict)
                else (),
                tuple(sorted(str(k) for k, v in dispositions.items() if v == 1))
                if isinstance(dispositions, dict)
                else (),
            )
        )
    issues = []
    videos = [s for s in streams if s.kind == "video"]
    audios = [s for s in streams if s.kind == "audio"]
    if (
        len(videos) != 1
        or len(audios) > 1
        or any(s.kind not in {"video", "audio"} for s in streams)
    ):
        issues.append(
            CutIssue(
                "unsupported_stream",
                "Lossless cut currently supports one video and at most one audio track. "
                "Other streams cannot be preserved yet.",
            )
        )
    if videos:
        properties = dict(videos[0].properties)
        if properties.get("side_data") or dict(videos[0].metadata).get("rotate"):
            issues.append(
                CutIssue(
                    "unsupported_stream",
                    "This video's extra display metadata cannot be preserved by lossless cuts yet.",
                )
            )
        if (
            videos[0].codec != "h264"
            or properties.get("pix_fmt") != "yuv420p"
            or properties.get("color_transfer") in {"smpte2084", "arib-std-b67"}
            or properties.get("field_order") not in {None, "progressive", "unknown"}
        ):
            issues.append(
                CutIssue(
                    "unsupported_codec",
                    "Lossless cut currently needs progressive SDR 8-bit H.264 video.",
                )
            )
    if audios and audios[0].codec != "aac":
        issues.append(
            CutIssue("unsupported_codec", "Lossless cut currently supports AAC source audio.")
        )
    container = raw.get("format", {})
    if (
        not isinstance(container, dict)
        or path.suffix.lower() != ".mp4"
        or "mp4" not in str(container.get("format_name", "")).split(",")
    ):
        issues.append(CutIssue("unsupported_codec", "Lossless cut currently supports MP4 files."))
    if raw.get("chapters"):
        issues.append(
            CutIssue(
                "unsupported_stream", "Chapter preservation is not available for lossless cuts yet."
            )
        )
    return tuple(streams), tuple(issues)


def has_idr(payload: bytes, length_size: int) -> bool:
    cursor = 0
    found = False
    while cursor < len(payload):
        if cursor + length_size > len(payload):
            return False
        length = int.from_bytes(payload[cursor : cursor + length_size], "big")
        cursor += length_size
        if length <= 0 or cursor + length > len(payload):
            return False
        found |= payload[cursor] & 0x1F == 5
        cursor += length
    return found


def analyze_source(
    path: Path,
    cancel: Event,
    on_progress: ProgressCallback,
    *,
    ffprobe: str | None = None,
    max_packets: int = MAX_PACKETS,
) -> CutAnalysis:
    check_cancel(cancel)
    identity = source_identity(path, cancel)
    binary = ffprobe or find_ffprobe()
    if not binary:
        raise CutAnalysisError("analysis_failed", "FFprobe is not available.")
    version = analysis_version(binary)
    streams, issues = read_inventory(Path(identity.path), cancel, binary)
    zero = MediaTime(0)
    if issues:
        return CutAnalysis(identity, streams, zero, zero, zero, (), (), (), zero, issues, version)
    keys: list[MediaTime] = []
    safe_ends: list[MediaTime] = []
    audio: list[PacketTiming] = []
    seen: set[Fraction] = set()
    origin: Fraction | None = None
    step = Fraction(0)
    high = Fraction(0)
    lag = Fraction(0)
    video_count = 0
    on_progress(AnalysisProgress(None, zero))
    try:
        with av.open(identity.path) as container:
            video = container.streams.video[0]
            config = video.codec_context.extradata
            if not config or len(config) < 5 or config[0] != 1:
                raise CutAnalysisError(
                    "unsupported_codec", "The H.264 packet format is not supported for copying."
                )
            length_size = (config[4] & 3) + 1
            declared_duration = Fraction(container.duration or 0, av.time_base)
            audio_stream = container.streams.audio[0] if container.streams.audio else None
            audio_quantum = Fraction(0)
            if audio_stream is not None:
                codec = audio_stream.codec_context
                if codec.profile != "LC" or codec.frame_size != 1024 or codec.sample_rate <= 0:
                    raise CutAnalysisError(
                        "unsupported_stream", "This audio profile is not qualified for copying yet."
                    )
                audio_quantum = Fraction(1024, codec.sample_rate)
            raw_audio: list[PacketTiming] = []
            previous_video_dts: Fraction | None = None
            for count, packet in enumerate(container.demux(), 1):
                check_cancel(cancel)
                if count > max_packets or packet.size > MAX_PACKET_BYTES:
                    raise CutAnalysisError(
                        "unsupported_stream", "This video exceeds the current cut analysis limit."
                    )
                if not packet.size:
                    continue
                if packet.is_corrupt:
                    raise CutAnalysisError(
                        "unsupported_stream", "The video does not contain complete media packets."
                    )
                if (
                    packet.pts is None
                    or packet.dts is None
                    or packet.duration is None
                    or packet.duration <= 0
                    or packet.time_base is None
                ):
                    raise CutAnalysisError(
                        "unsupported_codec", "This video's packet timing cannot be copied safely."
                    )
                base = Fraction(packet.time_base)
                pts, dts, duration = packet.pts * base, packet.dts * base, packet.duration * base
                if packet.stream.type == "audio":
                    skipped = bytes(packet.get_sidedata("skip_samples"))
                    skip_samples = int.from_bytes(skipped[:4], "little") if len(skipped) >= 4 else 0
                    discard_samples = (
                        int.from_bytes(skipped[4:8], "little") if len(skipped) >= 8 else 0
                    )
                    if (
                        pts != dts
                        or duration > audio_quantum
                        or (skip_samples and (raw_audio or skip_samples != 1024))
                        or discard_samples
                        or (
                            raw_audio
                            and (
                                raw_audio[-1].duration.seconds != audio_quantum
                                or pts != raw_audio[-1].start.seconds + audio_quantum
                            )
                        )
                    ):
                        raise CutAnalysisError(
                            "unsupported_stream",
                            "This audio has timing or padding that cannot be copied safely yet.",
                        )
                    raw_audio.append(
                        PacketTiming(
                            MediaTime.from_seconds(pts),
                            MediaTime.from_seconds(duration),
                            skip_samples,
                        )
                    )
                    continue
                if origin is None:
                    if not packet.is_keyframe:
                        raise CutAnalysisError(
                            "unsupported_codec",
                            "The video does not begin at a safe H.264 access point.",
                        )
                    origin, step = pts, duration
                if previous_video_dts is not None and dts != previous_video_dts + step:
                    raise CutAnalysisError(
                        "unsupported_codec", "The video has irregular decode timestamps."
                    )
                previous_video_dts = dts
                relative = pts - origin
                if duration != step or relative < 0 or relative % step or relative in seen:
                    raise CutAnalysisError(
                        "unsupported_codec",
                        "Variable or irregular frame timing is not supported "
                        "for lossless cuts yet.",
                    )
                seen.add(relative)
                video_count += 1
                high = max(high, relative + duration)
                lag = max(lag, pts - dts)
                if packet.is_keyframe:
                    if not has_idr(bytes(packet), length_size):
                        raise CutAnalysisError(
                            "unsupported_codec",
                            "This video uses an open GOP or an unverified access point.",
                        )
                    keys.append(MediaTime.from_seconds(relative))
                # a complete presentation prefix can end without retaining a later reference picture
                if high == video_count * step:
                    safe_ends.append(MediaTime.from_seconds(high))
                if video_count == 1 or video_count % 256 == 0:
                    coverage = safe_ends[-1] if safe_ends else zero
                    fraction = (
                        min(0.99, float(coverage.seconds / declared_duration))
                        if declared_duration > 0
                        else None
                    )
                    on_progress(AnalysisProgress(fraction, coverage, tuple(keys)))
            if (
                origin is None
                or video_count < 2
                or high != video_count * step
                or video.frames <= 0
                or video.frames != video_count
                or video.duration is None
                or video.time_base is None
                or abs(video.duration * Fraction(video.time_base) - high) > step
            ):
                raise CutAnalysisError(
                    "unsupported_codec",
                    "The video does not contain a complete constant-rate frame sequence.",
                )
            if audio_stream is not None and (
                not raw_audio
                or audio_stream.frames != len(raw_audio)
                or raw_audio[0].duration.seconds != audio_quantum
                or raw_audio[0].start.seconds - origin > audio_quantum
                or raw_audio[0].start.seconds - origin < -2 * audio_quantum
            ):
                raise CutAnalysisError(
                    "unsupported_stream",
                    "The audio does not contain a complete aligned packet sequence.",
                )
            audio = [
                PacketTiming(
                    MediaTime.from_seconds(p.start.seconds - origin), p.duration, p.skip_samples
                )
                for p in raw_audio
            ]
    except FFmpegError as exc:
        raise CutAnalysisError("analysis_failed", "The video packets could not be read.") from exc
    except CutAnalysisError as exc:
        if exc.code not in {"unsupported_codec", "unsupported_stream"}:
            raise
        issues = (CutIssue(exc.code, str(exc)),)
    if source_identity(Path(identity.path), cancel) != identity:
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")
    result = CutAnalysis(
        identity,
        streams,
        MediaTime.from_seconds(origin or Fraction(0)),
        MediaTime.from_seconds(step),
        MediaTime.from_seconds(high),
        tuple(keys),
        tuple(safe_ends),
        tuple(audio),
        MediaTime.from_seconds(lag),
        issues,
        version,
    )
    on_progress(AnalysisProgress(1, result.duration, result.keyframes))
    return result
