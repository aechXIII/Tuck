from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Iterator
from fractions import Fraction
from pathlib import Path
from threading import Event

import av
from av.container import InputContainer

from ..models.cutting import CutAnalysis, CutPlan, CutRequest
from .analysis import (
    CutAnalysisError,
    CutRequestWork,
    analyze_source,
    source_identity,
)
from .planner import OUTPUT_FORMATS, CutPlanChanged, plan_cut
from .timeline import MAX_PACKET_BYTES, MAX_PACKETS


def check_cut_cancel(cancel: Event) -> None:
    if isinstance(cancel, CutRequestWork):
        cancel.check()
    if cancel.is_set():
        raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.")


def validate_cut_source(plan: CutPlan, cancel: Event) -> None:
    check_cut_cancel(cancel)
    try:
        identity = source_identity(Path(plan.identity.path), cancel)
    except CutAnalysisError:
        raise
    except (OSError, ValueError) as exc:
        raise CutAnalysisError(
            "source_changed", "The video is no longer available. Add it again before exporting."
        ) from exc
    if identity != plan.identity:
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")


def check_source_unchanged(plan: CutPlan) -> None:
    """A quick check that the source was not replaced or edited since its bytes were hashed."""
    try:
        stat = Path(plan.identity.path).stat()
    except OSError as exc:
        raise CutAnalysisError(
            "source_changed", "The video is no longer available. Add it again before exporting."
        ) from exc
    if (stat.st_size, stat.st_mtime_ns) != (plan.identity.size, plan.identity.mtime_ns):
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")


def prepare_cut(
    plan: CutPlan, cancel: Event, ffprobe: str | None, *, reuse_analysis: bool = True
) -> CutAnalysis:
    validate_cut_source(plan, cancel)
    if (
        plan.issues
        or plan.precision not in ("keyframes", "exact")
        or "." + plan.container not in OUTPUT_FORMATS
    ):
        raise CutAnalysisError("unsupported_cut", "This cut plan is not ready to export.")
    source, output = Path(plan.identity.path), Path(plan.output_path)
    if output.resolve() == source.resolve() or (output.exists() and output.samefile(source)):
        raise CutAnalysisError("invalid_output", "Choose an output name different from the source.")
    # the identity check above hashed every byte, so an analysis of the same bytes still holds
    analysis = plan.analysis if reuse_analysis else None
    if analysis is None or analysis.identity != plan.identity:
        analysis = analyze_source(source, cancel, lambda _: None, ffprobe=ffprobe)
    if analysis.identity != plan.identity:
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")
    if analysis.issues:
        raise CutAnalysisError(analysis.issues[0].code, analysis.issues[0].message)
    rebuilt = plan_cut(
        plan.request
        or CutRequest(
            str(source),
            tuple(s.requested for s in plan.segments),
            plan.precision,
            plan.include_audio,
            (),
            False,
            str(output.parent),
            output.name,
        ),
        analysis,
    )
    if (
        not plan.segments
        or rebuilt.issues
        or rebuilt.segments != plan.segments
        or rebuilt.exported_duration != plan.exported_duration
    ):
        raise CutPlanChanged(rebuilt)
    return analysis


def rebuild_cut_plan(plan: CutPlan, cancel: Event, *, ffprobe: str | None = None) -> CutPlan:
    # a retry reads the keyframes again rather than trusting the earlier scan
    analysis = prepare_cut(plan, cancel, ffprobe, reuse_analysis=False)
    if plan.request is None:
        raise CutAnalysisError("plan_changed", "Review the cut plan before retrying.")
    rebuilt = plan_cut(plan.request, analysis)
    if rebuilt.fingerprint != plan.fingerprint:
        raise CutPlanChanged(rebuilt)
    return rebuilt


def output_frame_times(plan: CutPlan, analysis: CutAnalysis) -> list[Fraction]:
    """Presentation times of every kept video frame on the joined timeline."""
    frames = list(analysis.frames)
    times: list[Fraction] = []
    elapsed = Fraction(0)
    for segment in plan.segments:
        if segment.start_kind == "collapsed":
            continue
        first, last = segment.resolved.start.seconds, segment.resolved.end.seconds
        low, high = bisect_left(frames, first), bisect_left(frames, last)
        times.extend(elapsed + frame - first for frame in frames[low:high])
        elapsed += last - first
    return times


def decode_times(presented: list[Fraction], reorder: int) -> list[Fraction]:
    """One decode timeline for any frame timing.

    The k-th decoded picture takes the (k - reorder)-th presentation time, so decode times
    rise steadily and never pass the presentation time of a picture the decoder holds back.
    """
    if not presented:
        return []
    step = presented[1] - presented[0] if len(presented) > 1 else Fraction(1, 30)
    lead = [presented[0] - (reorder - k) * step for k in range(min(reorder, len(presented)))]
    return lead + presented[: len(presented) - len(lead)]


def to_ticks(time: Fraction, base: Fraction) -> int:
    # containers with coarse time bases round; round half away from zero, like FFmpeg
    value = time / base
    return int(value + (Fraction(1, 2) if value >= 0 else Fraction(-1, 2)))


def _track_times(
    plan: CutPlan, analysis: CutAnalysis
) -> dict[int, dict[int, list[tuple[Fraction, Fraction]]]]:
    """For each kept track: packet number -> [(output start, output duration), ...]."""
    ranges = [
        (s.resolved.start.seconds, s.resolved.end.seconds)
        for s in plan.segments
        if s.start_kind != "collapsed"
    ]
    packets_by_track = {t.index: t.packets for t in analysis.tracks}
    result: dict[int, dict[int, list[tuple[Fraction, Fraction]]]] = {}
    for track in plan.tracks:
        if not track.keep or track.index not in packets_by_track:
            continue
        packets = packets_by_track[track.index]
        times: dict[int, list[tuple[Fraction, Fraction]]] = {}
        elapsed = Fraction(0)
        for number, piece in enumerate(track.segments):
            first, last = ranges[number] if number < len(ranges) else (Fraction(0), Fraction(0))
            anchor = packets[piece.first].start.seconds if piece.stop > piece.first else Fraction(0)
            for index in range(piece.first, piece.stop):
                packet = packets[index]
                start, duration = packet.start.seconds, packet.duration.seconds
                if piece.clip:
                    shown = max(start, first)
                    until = min(start + duration, last) if duration else shown
                    times.setdefault(index, []).append((elapsed + shown - first, until - shown))
                else:
                    # keep the source spacing inside a segment, so a gap in the source audio
                    # is not closed up and later sound does not move earlier
                    times.setdefault(index, []).append(
                        (piece.output_start.seconds + start - anchor, duration)
                    )
            elapsed += last - first
        result[track.index] = times
    return result


def selected_packets(
    incoming: InputContainer,
    plan: CutPlan,
    analysis: CutAnalysis,
    cancel: Event,
    *,
    kind: str | None = None,
) -> Iterator[av.Packet]:
    """Stream the planned packets with their joined output timestamps, without encoding."""
    origin = analysis.origin.seconds
    segments = [s for s in plan.segments if s.start_kind != "collapsed"]
    starts = [s.resolved.start.seconds for s in segments]
    offsets = []
    elapsed = Fraction(0)
    for segment in segments:
        offsets.append(elapsed - segment.resolved.start.seconds)
        elapsed += segment.resolved.end.seconds - segment.resolved.start.seconds
    presented = output_frame_times(plan, analysis)
    decoding = decode_times(presented, analysis.reorder_frames)
    decoded = 0
    tracks = _track_times(plan, analysis)
    counters = dict.fromkeys(tracks, -1)
    wanted = [analysis.video_index, *tracks]
    streams = [
        s for s in incoming.streams if s.index in wanted and (kind is None or s.type == kind)
    ]
    for count, packet in enumerate(incoming.demux(*streams), 1):
        check_cut_cancel(cancel)
        if count > MAX_PACKETS or packet.size > MAX_PACKET_BYTES:
            raise CutAnalysisError("cut_failed", "The video exceeds the packet copy limit.")
        if not packet.size or packet.pts is None:
            continue
        if packet.is_corrupt or not packet.time_base:
            raise CutAnalysisError("cut_failed", "A media packet cannot be copied safely.")
        base = Fraction(packet.time_base)
        time = packet.pts * base - origin
        if packet.stream.index == analysis.video_index:
            index = bisect_right(starts, time) - 1
            if index < 0 or time >= segments[index].resolved.end.seconds:
                continue
            if decoded >= len(decoding):
                raise CutAnalysisError("plan_changed", "The video frames changed since analysis.")
            packet.pts = to_ticks(time + offsets[index], base)
            packet.dts = to_ticks(decoding[decoded], base)
            decoded += 1
            yield packet
            continue
        counters[packet.stream.index] += 1
        placements = tracks[packet.stream.index].get(counters[packet.stream.index])
        if not placements:
            continue
        for number, (start, duration) in enumerate(placements):
            # a subtitle shown across a cut appears once in each kept part
            copy = packet if number == len(placements) - 1 else av.Packet(bytes(packet))
            copy.stream = packet.stream
            copy.time_base = packet.time_base
            copy.pts = copy.dts = to_ticks(start, base)
            if duration:
                copy.duration = to_ticks(duration, base)
            yield copy
