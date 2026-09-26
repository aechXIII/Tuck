"""Resolve validated cut intent against measured packet boundaries without doing I/O."""

import json
import math
from bisect import bisect_left, bisect_right
from dataclasses import asdict
from fractions import Fraction
from hashlib import sha256
from pathlib import Path

from ..models.cutting import (
    CutAnalysis,
    CutIssue,
    CutPlan,
    CutRange,
    CutRequest,
    CutSegment,
    MediaTime,
)
from .analysis import CutAnalysisError
from .exact import exact_media_reason

EDIT_NAMES = {
    "crop": "Crop",
    "flip": "Flip",
    "rotation": "Rotation",
    "resize": "Resize",
    "lut": "Color LUT",
    "fps": "Frame rate",
    "frame_blending": "Frame blending",
    "source_gain": "Source volume",
    "source_fades": "Source fades",
    "added_audio": "Added audio",
    "muted_segments": "Muted audio segments",
}


class CutPlanChanged(CutAnalysisError):
    def __init__(self, current_plan: CutPlan) -> None:
        super().__init__(
            "plan_changed", "The cut plan changed. Review the current cuts before exporting."
        )
        self.current_plan = current_plan


def parse_cut_export(raw: object) -> tuple[CutRequest, str]:
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
        {key: value for key, value in raw.items() if key != "plan_fingerprint"}
    ), fingerprint


def parse_cut_request(raw: object) -> CutRequest:
    if not isinstance(raw, dict):
        raise ValueError("Expected a cut request object")
    allowed = {
        "operation",
        "source",
        "segments",
        "precision",
        "include_audio",
        "edits",
        "without_edits",
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
    without_edits = raw.get("without_edits", False)
    if type(include_audio) is not bool or type(without_edits) is not bool:
        raise ValueError("Audio and edit choices must be boolean values")
    edits = raw.get("edits", [])
    if not isinstance(edits, list) or any(
        not isinstance(e, str) or e not in EDIT_NAMES for e in edits
    ):
        raise ValueError("The cut request contains an unknown edit")
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
    directory = raw.get("output_dir", str(source_path.parent))
    name = raw.get("output_name", source_path.stem + "_cut.mp4")
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
    if name.split(".", 1)[0].upper() in reserved or Path(name).suffix.lower() != ".mp4":
        raise ValueError("Choose an MP4 filename that is not a reserved device name")
    output_dir = str(Path(directory).resolve())
    if Path(output_dir) / name == source_path:
        raise ValueError("The output must have a different name from the source")
    return CutRequest(
        str(source_path),
        tuple(segments),
        precision,
        include_audio,
        tuple(sorted(set(edits))),
        without_edits,
        output_dir,
        name,
    )


def plan_cut(request: CutRequest, analysis: CutAnalysis, *, exact_encoder: bool = False) -> CutPlan:
    issues = list(analysis.issues)
    exact_reason = exact_media_reason(analysis) or (
        "" if exact_encoder else "Exact needs FFmpeg with the libx264 encoder."
    )
    exact = request.precision == "exact"
    if request.source != analysis.identity.path:
        issues.insert(
            0, CutIssue("source_changed", "The cut analysis belongs to a different video.")
        )
    if request.edits and not request.without_edits:
        names = ", ".join(EDIT_NAMES[edit] for edit in request.edits)
        issues.append(
            CutIssue(
                "incompatible_edit",
                f"{names} need re-encoding. Choose Compress or export without these edits.",
                "edits",
            )
        )
    if exact and exact_reason:
        issues.append(CutIssue("exact_unavailable", exact_reason, "precision"))
    keys = [t.seconds for t in analysis.keyframes]
    step = analysis.frame_duration.seconds
    ends = [t.seconds for t in analysis.safe_ends]
    segments = []
    elapsed = Fraction(0)
    audio_elapsed = Fraction(0)
    packets = analysis.audio_packets
    # analysis qualifies uniform AAC frames, with only a shorter final packet
    quantum = packets[0].duration.seconds if packets else Fraction(0)
    for requested in request.segments:
        start, end = requested.start.seconds, requested.end.seconds
        if end > analysis.duration.seconds and not analysis.issues:
            issues.append(
                CutIssue("invalid_range", "A kept segment extends beyond the video.", "segments")
            )
        if exact:
            # Exact keeps every frame that starts inside the requested range
            start = math.ceil(start / step) * step
            end = min(math.floor(end / step) * step, analysis.duration.seconds)
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
            kind = "at_start" if start == first == 0 else "keyframe" if start == first else "moved"
            moved = math.ceil((end - last) / step)
        audio_source = audio_output = None
        count = 0
        if request.include_audio and packets:
            permitted = [
                p
                for p in packets
                if p.start.seconds < last and p.start.seconds + p.duration.seconds > first
            ]
            count = round((elapsed + last - first) / quantum) - round(audio_elapsed / quantum)
            if count <= 0 or count > len(permitted):
                issues.append(
                    CutIssue(
                        "unsupported_stream",
                        "This segment is too short to keep copied audio in sync. "
                        "Widen it or turn Include audio off.",
                        "include_audio",
                    )
                )
                count = 0
            else:
                wanted = first + audio_elapsed - elapsed
                nearest = min(
                    range(len(permitted)), key=lambda i: abs(permitted[i].start.seconds - wanted)
                )
                nearest = min(nearest, len(permitted) - count)
                chosen = permitted[nearest : nearest + count]
                source_end = chosen[-1].start.seconds + chosen[-1].duration.seconds
                duration = sum((p.duration.seconds for p in chosen), Fraction(0))
                if abs(audio_elapsed + duration - (elapsed + last - first)) > quantum:
                    issues.append(
                        CutIssue(
                            "unsupported_stream",
                            "The copied audio would not stay in sync. Turn Include audio off.",
                            "include_audio",
                        )
                    )
                    count = 0
                else:
                    audio_source = CutRange(chosen[0].start, MediaTime.from_seconds(source_end))
                    audio_output = CutRange(
                        MediaTime.from_seconds(audio_elapsed),
                        MediaTime.from_seconds(audio_elapsed + duration),
                    )
                    audio_elapsed += duration
        segments.append(
            CutSegment(
                requested,
                CutRange(MediaTime.from_seconds(first), MediaTime.from_seconds(last)),
                kind,
                moved,
                audio_source,
                audio_output,
                count,
                copied,
            )
        )
        elapsed += last - first
    duration = analysis.duration.seconds
    estimate = round(analysis.identity.size * elapsed / duration) if duration else 0
    fingerprint_data = {
        "request": asdict(request),
        "identity": asdict(analysis.identity),
        "segments": [asdict(s) for s in segments],
        "version": analysis.version,
        "planner": 2,
    }
    fingerprint = sha256(
        json.dumps(fingerprint_data, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return CutPlan(
        analysis.identity,
        tuple(segments),
        request.precision,
        request.include_audio,
        str(Path(request.output_dir) / request.output_name),
        MediaTime.from_seconds(elapsed),
        estimate,
        tuple(issues),
        not exact_reason,
        exact_reason,
        fingerprint,
        request=request,
    )
