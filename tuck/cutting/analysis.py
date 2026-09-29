"""Measure safe cut boundaries with bounded memory and cancellable local-media work."""

from __future__ import annotations

import hashlib
import itertools
import json
import logging
import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path
from threading import Event

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
from ..request_work import RequestWork
from .timeline import (
    MAX_PACKETS,
    MediaTimeline,
    TimelineError,
    is_clean_entry,
    read_timeline,
    sweep_keyframes,
)

ANALYSIS_VERSION = (
    "cut-prefix-1/pyav-" + av.__version__ + "/" + repr(sorted(av.library_versions.items()))
)
MAX_METADATA_BYTES = 4 * 1024 * 1024
ProgressCallback = Callable[[AnalysisProgress], None]
logger = logging.getLogger(__name__)


class CutAnalysisError(ValueError):
    def __init__(self, code: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        # technical text for the expandable error details, kept out of the message
        self.detail = detail


def check_request(work: RequestWork) -> None:
    """Stop preparing a cut once its desktop request ran out of time or was cancelled."""
    if work.expired:
        raise CutAnalysisError(
            "cut_timed_out",
            "Preparing the cut took too long. Read its keyframes again and retry.",
        )
    if work.is_set():
        raise CutAnalysisError("analysis_cancelled", "Cut preparation was cancelled.")


def check_cancel(
    cancel: Event,
    code: str = "analysis_cancelled",
    message: str = "Keyframe analysis was cancelled.",
) -> None:
    if isinstance(cancel, RequestWork):
        check_request(cancel)
    if cancel.is_set():
        raise CutAnalysisError(code, message)


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
    identity: SourceIdentity | None = None,
    *,
    ffprobe: str | None = None,
    max_packets: int = MAX_PACKETS,
) -> CutAnalysis:
    """Read the keyframes and packet timing of `path`.

    `identity` is a hash the caller has just taken of these bytes, so it is not taken twice.
    The bytes are hashed again after the scan: an edit that keeps the size and time and is
    later undone must not leave keyframes from other bytes paired with this hash.
    """
    check_cancel(cancel)
    binary = ffprobe or find_ffprobe()
    if not binary:
        raise CutAnalysisError("analysis_failed", "FFprobe is not available.")
    version = analysis_version(binary)
    with ThreadPoolExecutor(1, thread_name_prefix="tuck-cut-inventory") as pool:
        # ffprobe runs as its own process, so the track list is read while the packets are
        inventory = pool.submit(read_inventory, path.resolve(strict=True), cancel, binary)
        try:
            if identity is None:
                identity = source_identity(path, cancel)
            scanned = _scan(identity, cancel, on_progress, max_packets)
            if source_identity(Path(identity.path), cancel) != identity:
                raise CutAnalysisError(
                    "source_changed", "The video changed. Read its keyframes again."
                )
        except Exception:
            # a file ffprobe cannot describe reports that, as it did before the scan ran alongside
            inventory.result()
            raise
        streams, issues = inventory.result()
    zero = MediaTime(0)
    if issues:
        return CutAnalysis(identity, streams, zero, zero, zero, (), (), (), zero, issues, version)
    timeline, unverified, issues = scanned
    return _analysis(identity, streams, version, timeline, unverified, issues, on_progress)


def _scan(
    identity: SourceIdentity, cancel: Event, on_progress: ProgressCallback, max_packets: int
) -> tuple[MediaTimeline | None, tuple[CutIssue, ...], tuple[CutIssue, ...]]:
    on_progress(AnalysisProgress(None, MediaTime(0)))
    timeline: MediaTimeline | None = None
    unverified: tuple[CutIssue, ...] = ()
    issues: tuple[CutIssue, ...] = ()
    progress = _progress_reporter(identity.path, on_progress)
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
    return timeline, unverified, issues


def _progress_reporter(
    path: str, on_progress: ProgressCallback
) -> Callable[[tuple[Fraction, ...], Fraction], None]:
    with av.open(path) as probe:
        declared = Fraction(probe.duration or 0, av.time_base)

    def report(keys: tuple[Fraction, ...], reached: Fraction) -> None:
        fraction = min(0.99, float(reached / declared)) if declared > 0 else None
        on_progress(
            AnalysisProgress(
                fraction,
                MediaTime.from_seconds(reached),
                tuple(MediaTime.from_seconds(k) for k in keys),
            )
        )

    return report


def preview_keyframes(
    path: Path, stopped: Callable[[], bool], on_progress: ProgressCallback
) -> None:
    """Show keyframes from the container's flags while the checked analysis hashes the file.

    Display only: a file this cannot read is left for the checked scan to report.
    """
    try:
        sweep_keyframes(str(path), stopped, _progress_reporter(str(path), on_progress))
    except (FFmpegError, OSError) as exc:
        logger.debug("Keyframe preview stopped for %s: %s", path, exc)


def _analysis(
    identity: SourceIdentity,
    streams: tuple[StreamDescriptor, ...],
    version: str,
    timeline: MediaTimeline | None,
    unverified: tuple[CutIssue, ...],
    issues: tuple[CutIssue, ...],
    on_progress: ProgressCallback,
) -> CutAnalysis:
    zero = MediaTime(0)
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
