"""Resolve validated cut intent against measured packet boundaries without doing I/O."""

import json
from bisect import bisect_left, bisect_right
from dataclasses import asdict, replace
from fractions import Fraction
from hashlib import sha256
from pathlib import Path

from ..models.cutting import (
    Chapter,
    CutAnalysis,
    CutIssue,
    CutPlan,
    CutRange,
    CutRequest,
    CutSegment,
    MediaTime,
    TrackPackets,
    TrackSegment,
)
from ..models.ui_preferences import DEFAULT_CUT_SUFFIX
from ..output_paths import export_directory
from .analysis import CutAnalysisError
from .exact import exact_media_reason
from .tracks import plan_tracks


class CutPlanChanged(CutAnalysisError):
    def __init__(self, current_plan: CutPlan) -> None:
        super().__init__(
            "plan_changed", "The cut plan changed. Review the current cuts before exporting."
        )
        self.current_plan = current_plan


def parse_cut_export(
    raw: object,
    *,
    name_suffix: str = DEFAULT_CUT_SUFFIX,
    output_folder: str = "",
    output_subfolder: str = "",
) -> tuple[CutRequest, str]:
    if not isinstance(raw, dict):
        raise ValueError("Expected a cut request object")
    fingerprint = raw.get("plan_fingerprint")
    if (
        not isinstance(fingerprint, str)
        or len(fingerprint) != 64
        or any(c not in "0123456789abcdef" for c in fingerprint)
    ):
        raise ValueError("Review the cut plan before exporting.")
    return parse_cut_request(
        {key: value for key, value in raw.items() if key != "plan_fingerprint"},
        name_suffix=name_suffix,
        output_folder=output_folder,
        output_subfolder=output_subfolder,
    ), fingerprint


def parse_cut_request(
    raw: object,
    *,
    name_suffix: str = DEFAULT_CUT_SUFFIX,
    output_folder: str = "",
    output_subfolder: str = "",
) -> CutRequest:
    """Validate a cut request from the bridge.

    name_suffix, output_folder and output_subfolder come from the user's settings
    and place the output when the request does not; the caller has already checked them.
    """
    if not isinstance(raw, dict):
        raise ValueError("Expected a cut request object")
    allowed = {
        "operation",
        "source",
        "segments",
        "precision",
        "include_audio",
        "output_dir",
        "output_name",
        "_request_id",
    }
    if set(raw) - allowed:
        raise ValueError("Cut requests cannot contain encoding options or unknown fields")
    if raw.get("operation") != "cut":
        raise ValueError("Unknown export operation")
    source = raw.get("source")
    if not isinstance(source, str) or not source.strip() or "\x00" in source:
        raise ValueError("Choose a source video")
    source_path = Path(source).resolve()
    precision = raw.get("precision", "keyframes")
    if precision not in ("keyframes", "exact"):
        raise ValueError("Choose On keyframes or Exact precision")
    include_audio = raw.get("include_audio", True)
    if type(include_audio) is not bool:
        raise ValueError("Include audio must be on or off")
    ranges = raw.get("segments")
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 1000:
        raise ValueError("Choose between 1 and 1000 kept segments")
    segments = []
    previous_end = Fraction(0)
    for segment in ranges:
        if not isinstance(segment, dict) or set(segment) != {"start", "end"}:
            raise ValueError("Each segment needs a start and end time")
        start, end = MediaTime.from_dict(segment["start"]), MediaTime.from_dict(segment["end"])
        if start.seconds < previous_end or end.seconds <= start.seconds:
            raise ValueError("Kept segments must be in order and must not overlap")
        segments.append(CutRange(start, end))
        previous_end = end.seconds
    directory = raw.get(
        "output_dir", str(export_directory(source_path, output_folder, output_subfolder))
    )
    # the cut keeps the source's container, so it keeps its extension too
    extension = source_path.suffix.lower() or ".mp4"
    name = raw.get("output_name", source_path.stem + name_suffix + extension)
    if not isinstance(directory, str) or not directory or "\x00" in directory:
        raise ValueError("Choose an output directory")
    if (
        not isinstance(name, str)
        or not name
        or len(name) > 200
        or name.endswith((".", " "))
        or any(ord(c) < 32 or c in '<>:"/\\|?*' for c in name)
    ):
        raise ValueError("Choose a filename without path separators or reserved characters")
    reserved = {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
    if name.split(".", 1)[0].upper() in reserved or Path(name).suffix.lower() != extension:
        raise ValueError(f"Choose a {extension} filename that is not a reserved device name")
    output_dir = str(Path(directory).resolve())
    if Path(output_dir) / name == source_path:
        raise ValueError("The output must have a different name from the source")
    return CutRequest(
        str(source_path),
        tuple(segments),
        precision,
        include_audio,
        output_dir,
        name,
    )


# the source container is kept; this maps its file extension to the muxer that writes it
OUTPUT_FORMATS = {
    ".mp4": "mp4",
    ".m4v": "mp4",
    ".mov": "mov",
    ".3gp": "3gp",
    ".mkv": "matroska",
    ".webm": "webm",
    ".ts": "mpegts",
    ".m2ts": "mpegts",
    ".mts": "mpegts",
    ".avi": "avi",
    ".flv": "flv",
    ".ogv": "ogg",
}


def _frame_edges(analysis: CutAnalysis) -> list[Fraction]:
    if analysis.frames:
        return [*analysis.frames, analysis.duration.seconds]
    step, end = analysis.frame_duration.seconds, analysis.duration.seconds
    if step <= 0:
        return [Fraction(0), end]
    return [index * step for index in range(int(end / step) + 1)]


def _nearest(edges: list[Fraction], time: Fraction) -> Fraction:
    # timeline times are player floats; the nearest frame edge keeps a plain split contiguous
    index = bisect_left(edges, time)
    candidates = edges[max(0, index - 1) : index + 1]
    return min(candidates, key=lambda edge: (abs(edge - time), -edge))


def _chapters(
    analysis: CutAnalysis, ranges: list[tuple[Fraction, Fraction]]
) -> tuple[Chapter, ...]:
    kept = []
    elapsed = Fraction(0)
    for first, last in ranges:
        for chapter in analysis.chapters:
            start = max(chapter.start.seconds, first)
            end = min(chapter.end.seconds, last)
            if end > start:
                kept.append(
                    Chapter(
                        MediaTime.from_seconds(elapsed + start - first),
                        MediaTime.from_seconds(elapsed + end - first),
                        chapter.title,
                    )
                )
        elapsed += last - first
    return tuple(kept)


def _audio_fields(segment: CutSegment, track: TrackPackets, piece: TrackSegment) -> CutSegment:
    """Describe the main audio track's cut on the segment, for the Inspector."""
    times = track.whole_times
    chosen = range(piece.first, piece.stop)
    # encoder priming before the first frame is not part of the kept range
    priming = [i for i in chosen if times.ends[i] <= 0]
    heard = [i for i in chosen if times.ends[i] > 0] or list(chosen)
    output_start = piece.output_start.seconds + Fraction(
        sum(times.durations[i] for i in priming), times.denominator
    )
    length = Fraction(sum(times.durations[i] for i in heard), times.denominator)
    source_end = Fraction(times.ends[heard[-1]], times.denominator)
    return replace(
        segment,
        audio_source=CutRange(track.packets[heard[0]].start, MediaTime.from_seconds(source_end)),
        audio_output=CutRange(
            MediaTime.from_seconds(output_start), MediaTime.from_seconds(output_start + length)
        ),
        audio_packet_count=len(heard),
    )


def plan_cut(request: CutRequest, analysis: CutAnalysis) -> CutPlan:
    issues = list(analysis.issues)
    exact_reason = exact_media_reason(analysis)
    exact = request.precision == "exact"
    if request.source != analysis.identity.path:
        issues.insert(
            0, CutIssue("source_changed", "The cut analysis belongs to a different video.")
        )
    if exact and exact_reason:
        issues.append(CutIssue("exact_unavailable", exact_reason, "precision"))
    suffix = Path(request.output_name).suffix.lower()
    if suffix not in OUTPUT_FORMATS and not analysis.issues:
        issues.append(
            CutIssue("unsupported_codec", "Lossless cut cannot write this file type yet.")
        )
    keys = [t.seconds for t in analysis.keyframes]
    ends = [t.seconds for t in analysis.safe_ends]
    open_keys = {t.seconds for t in analysis.open_keyframes}
    joins_open_key = False
    edges = _frame_edges(analysis)
    frames = edges[:-1]
    duration = analysis.duration.seconds
    segments: list[CutSegment] = []
    ranges: list[tuple[Fraction, Fraction]] = []
    kept: list[int] = []
    elapsed = Fraction(0)
    for requested in request.segments:
        start, end = requested.start.seconds, requested.end.seconds
        if end > duration and not analysis.issues:
            issues.append(
                CutIssue("invalid_range", "A kept segment extends beyond the video.", "segments")
            )
        if exact:
            start = _nearest(edges, start)
            end = min(_nearest(edges, end), duration)
        left = bisect_left(keys, start)
        right = bisect_right(ends, end) - 1
        copyable = left < len(keys) and right >= 0 and keys[left] < ends[right]
        if (exact and end <= start) or (not exact and not copyable):
            issues.append(
                CutIssue(
                    "segment_collapsed",
                    "A segment is shorter than one frame. Widen it or remove it."
                    if exact
                    else "A segment has no copyable frames. "
                    "Widen it, remove it, or use Exact when available.",
                    "segments",
                )
            )
            segments.append(
                CutSegment(requested, CutRange(requested.start, requested.start), "collapsed", 0)
            )
            continue
        copied = None
        if exact:
            first, last = start, end
            if copyable:
                copied = CutRange(
                    MediaTime.from_seconds(keys[left]), MediaTime.from_seconds(ends[right])
                )
            copy_start = keys[left] if copyable else None
            kind = (
                "at_start"
                if start == copy_start == 0
                else "keyframe"
                if start == copy_start
                else "exact"
            )
            moved = 0
        else:
            first, last = keys[left], ends[right]
            copy_start = first
            kind = "at_start" if start == first == 0 else "keyframe" if start == first else "moved"
            # frames that start between the copyable end and the requested end are left out
            moved = bisect_left(frames, end) - bisect_left(frames, last)
        # an open keyframe decodes cleanly only when nothing comes before it in the output;
        # after a kept part or an encoded edge the decoder drops or reorders frames
        if copy_start is not None and copy_start in open_keys and (kept or first < copy_start):
            joins_open_key = True
        kept.append(len(segments))
        ranges.append((first, last))
        segments.append(
            CutSegment(
                requested,
                CutRange(MediaTime.from_seconds(first), MediaTime.from_seconds(last)),
                kind,
                moved,
                copied=copied,
            )
        )
        elapsed += last - first
    if joins_open_key:
        issues.append(
            CutIssue(
                "unsupported_cut",
                "This video's keyframes cannot be joined without damaging the picture. "
                "Keep one segment with On keyframes, or use Compress.",
                "precision" if exact else "segments",
            )
        )
    tracks, track_issues, notes = plan_tracks(analysis, ranges, request.include_audio)
    issues.extend(track_issues)
    audio = next((t for t in tracks if t.kind == "audio" and t.keep), None)
    if audio is not None:
        track = next(t for t in analysis.tracks if t.index == audio.index)
        for number, piece in zip(kept, audio.segments, strict=True):
            segments[number] = _audio_fields(segments[number], track, piece)
    estimate = round(analysis.identity.size * elapsed / duration) if duration else 0
    chapters = _chapters(analysis, ranges)
    fingerprint_data = {
        "request": asdict(request),
        "identity": asdict(analysis.identity),
        "segments": [asdict(s) for s in segments],
        "tracks": [asdict(t) for t in tracks],
        "chapters": [asdict(c) for c in chapters],
        "version": analysis.version,
        "planner": 3,
    }
    fingerprint = sha256(
        json.dumps(fingerprint_data, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return CutPlan(
        analysis.identity,
        tuple(segments),
        request.precision,
        request.include_audio and audio is not None,
        str(Path(request.output_dir) / request.output_name),
        MediaTime.from_seconds(elapsed),
        estimate,
        tuple(issues),
        not exact_reason,
        exact_reason,
        fingerprint,
        suffix.lstrip(".") or "mp4",
        request=request,
        tracks=tracks,
        chapters=chapters,
        unverified=(*analysis.unverified, *notes),
        analysis=analysis,
    )
