"""Measure safe cut boundaries with bounded memory and cancellable local-media work."""

from __future__ import annotations

import hashlib
import itertools
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
    Chapter,
    CutAnalysis,
    CutIssue,
    MediaTime,
    PacketTiming,
    SourceIdentity,
    StreamDescriptor,
    TrackPackets,
)
from .timeline import (
    MAX_PACKETS,
    MediaTimeline,
    TimelineError,
    is_clean_entry,
    read_timeline,
)

ANALYSIS_VERSION = (
    "cut-prefix-1/pyav-" + av.__version__ + "/" + repr(sorted(av.library_versions.items()))
)
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
    path: Path, cancel: Event, ffprobe: str, *, limits: bool = True
) -> tuple[tuple[StreamDescriptor, ...], tuple[CutIssue, ...]]:
    """Read the stream inventory. Every format is read; nothing is refused here."""
    del limits
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
    return tuple(streams), ()


def has_idr(payload: bytes, length_size: int) -> bool:
    return is_clean_entry("h264", payload, length_size) is True


def _unverified_notes(path: str, timeline: MediaTimeline) -> tuple[CutIssue, ...]:
    """What Tuck cannot confirm about this file. The cut still works and says so."""
    video = timeline.video
    notes = []
    if video.unverified_keyframes:
        notes.append(
            CutIssue(
                "unverified_start",
                "Cut starts use keyframes that could not be confirmed as clean starting points.",
            )
        )
    if (
        video.declared_video_duration is not None
        and video.declared_video_duration - video.end > video.nominal_step
    ):
        notes.append(
            CutIssue(
                "unverified_end", "The file seems incomplete: it ends before its stated length."
            )
        )
    for other in timeline.others:
        if other.kind != "audio" or not other.packets:
            continue
        packets = other.packets
        span = packets[-1].start + packets[-1].duration - packets[0].start
        longest = max(p.duration for p in packets)
        # a container edit list can shift audio without changing packet timestamps
        shifted = other.declared_duration is not None and abs(other.declared_duration - span) > max(
            longest, Fraction(1, 10)
        )
        durations = sorted(p.duration for p in packets)
        typical = durations[len(durations) // 2]
        # one packet stretched over a pause is a gap in disguise
        stretched = longest > 2 * typical
        if (
            shifted
            or stretched
            or any(
                later.start != earlier.start + earlier.duration
                for earlier, later in itertools.pairwise(packets)
                if earlier.duration
            )
        ):
            notes.append(
                CutIssue(
                    "unverified_audio",
                    "The audio has gaps or overlaps, so sync at the cuts is not checked.",
                    "include_audio",
                )
            )
            break
    return tuple(notes)


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
    on_progress(AnalysisProgress(None, zero))
    timeline: MediaTimeline | None = None
    unverified: tuple[CutIssue, ...] = ()

    def progress(keys: tuple[Fraction, ...], reached: Fraction) -> None:
        declared = timeline_duration[0]
        fraction = min(0.99, float(reached / declared)) if declared > 0 else None
        on_progress(
            AnalysisProgress(
                fraction,
                MediaTime.from_seconds(reached),
                tuple(MediaTime.from_seconds(k) for k in keys),
            )
        )

    with av.open(identity.path) as probe:
        timeline_duration = [Fraction(probe.duration or 0, av.time_base)]
    try:
        timeline = read_timeline(
            identity.path, cancel, progress, max_packets=max_packets, check_cancel=check_cancel
        )
        unverified = _unverified_notes(identity.path, timeline)
    except TimelineError as exc:
        if exc.code not in {"unsupported_codec", "unsupported_stream"}:
            raise CutAnalysisError(exc.code, str(exc)) from exc
        issues = (CutIssue(exc.code, str(exc)),)
    except FFmpegError as exc:
        raise CutAnalysisError("analysis_failed", "The video packets could not be read.") from exc
    if source_identity(Path(identity.path), cancel) != identity:
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")
    if timeline is None or issues:
        video = timeline.video if timeline else None
        return CutAnalysis(
            identity,
            streams,
            MediaTime.from_seconds(video.origin) if video else zero,
            MediaTime.from_seconds(video.nominal_step) if video else zero,
            MediaTime.from_seconds(video.end) if video else zero,
            tuple(MediaTime.from_seconds(k) for k in video.keyframes) if video else (),
            tuple(MediaTime.from_seconds(e) for e in video.safe_ends) if video else (),
            (),
            zero,
            issues,
            version,
        )
    video = timeline.video
    audio = next((o for o in timeline.others if o.kind == "audio"), None)
    tracks = tuple(
        TrackPackets(
            other.index,
            other.kind,
            other.codec,
            tuple(
                PacketTiming(
                    MediaTime.from_seconds(p.start),
                    MediaTime.from_seconds(p.duration),
                    p.skip_samples,
                    p.discard_samples,
                )
                for p in other.packets
            ),
        )
        for other in timeline.others
    )
    result = CutAnalysis(
        identity,
        streams,
        MediaTime.from_seconds(video.origin),
        MediaTime.from_seconds(video.nominal_step),
        MediaTime.from_seconds(video.end),
        tuple(MediaTime.from_seconds(k) for k in video.keyframes),
        tuple(MediaTime.from_seconds(e) for e in video.safe_ends),
        tuple(
            PacketTiming(
                MediaTime.from_seconds(p.start), MediaTime.from_seconds(p.duration), p.skip_samples
            )
            for p in (audio.packets if audio else ())
        ),
        MediaTime.from_seconds(video.decode_delay),
        (),
        version,
        frames=video.frames,
        tracks=tracks,
        chapters=tuple(
            Chapter(MediaTime.from_seconds(start), MediaTime.from_seconds(end), title)
            for start, end, title in timeline.chapters
        ),
        format_name=timeline.format_name,
        video_index=video.index,
        reorder_frames=video.reorder_frames,
        unverified=unverified,
    )
    on_progress(AnalysisProgress(1, result.duration, result.keyframes))
    return result
