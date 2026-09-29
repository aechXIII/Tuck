from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Iterator
from fractions import Fraction
from pathlib import Path
from threading import Event

import av
from av.container import InputContainer

from ..models.cutting import CutAnalysis, CutPlan, CutRequest
from .analysis import CutAnalysisError, analyze_source, check_cancel, source_identity
from .output_timing import decode_times, output_frame_times, round_div, ticks_from, to_ticks
from .planner import OUTPUT_FORMATS, CutPlanChanged, plan_cut
from .timeline import MAX_PACKET_BYTES, MAX_PACKETS


def check_cut_cancel(cancel: Event) -> None:
    check_cancel(cancel, "cut_cancelled", "Cutting was cancelled.")


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
        analysis = analyze_source(source, cancel, lambda _: None, plan.identity, ffprobe=ffprobe)
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


def _track_times(
    plan: CutPlan, analysis: CutAnalysis
) -> dict[int, tuple[int, dict[int, list[tuple[int, int]]]]]:
    """For each kept track: a denominator, and packet number -> [(output start, output
    duration), ...] as whole numbers over that denominator."""
    ranges = [
        (s.resolved.start.seconds, s.resolved.end.seconds)
        for s in plan.segments
        if s.start_kind != "collapsed"
    ]
    tracks_by_index = {t.index: t for t in analysis.tracks}
    result: dict[int, tuple[int, dict[int, list[tuple[int, int]]]]] = {}
    for track in plan.tracks:
        if not track.keep or track.index not in tracks_by_index:
            continue
        packets = tracks_by_index[track.index].whole_times
        # one denominator that also holds every segment edge, so each packet costs a few
        # whole-number steps rather than fraction math
        scale = math.lcm(
            packets.denominator,
            *(edge.denominator for pair in ranges for edge in pair),
            *(piece.output_start.seconds.denominator for piece in track.segments),
        )
        step = scale // packets.denominator
        times: dict[int, list[tuple[int, int]]] = {}
        elapsed = 0
        for number, piece in enumerate(track.segments):
            first, last = (
                (int(ranges[number][0] * scale), int(ranges[number][1] * scale))
                if number < len(ranges)
                else (0, 0)
            )
            anchor = packets.starts[piece.first] * step if piece.stop > piece.first else 0
            output_start = int(piece.output_start.seconds * scale)
            for index in range(piece.first, piece.stop):
                start, duration = packets.starts[index] * step, packets.durations[index] * step
                if piece.clip:
                    shown = max(start, first)
                    until = min(start + duration, last) if duration else shown
                    times.setdefault(index, []).append((elapsed + shown - first, until - shown))
                else:
                    # keep the source spacing inside a segment, so a gap in the source audio
                    # is not closed up and later sound does not move earlier
                    times.setdefault(index, []).append((output_start + start - anchor, duration))
            elapsed += last - first
        result[track.index] = (scale, times)
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
    offsets = []
    elapsed = Fraction(0)
    for segment in segments:
        offsets.append(elapsed - segment.resolved.start.seconds)
        elapsed += segment.resolved.end.seconds - segment.resolved.start.seconds
    # every packet of a stream carries that stream's time base
    bases: dict[int, Fraction] = {}
    # the video is placed in whole ticks, since fraction math on every frame of a long
    # video costs seconds: where each segment starts and ends, and how far it moves
    starts: list[int] = []
    ends: list[int] = []
    shifts: list[Fraction] = []
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
        pts = packet.pts
        if not packet.size or pts is None:
            continue
        stream_index = packet.stream.index
        base = bases.get(stream_index)
        if base is None:
            time_base = packet.time_base
            if not time_base:
                raise CutAnalysisError("cut_failed", "A media packet cannot be copied safely.")
            base = bases[stream_index] = Fraction(time_base)
            if stream_index == analysis.video_index:
                starts = [ticks_from(s.resolved.start.seconds + origin, base) for s in segments]
                ends = [ticks_from(s.resolved.end.seconds + origin, base) for s in segments]
                shifts = [(offset - origin) / base for offset in offsets]
        if packet.is_corrupt:
            raise CutAnalysisError("cut_failed", "A media packet cannot be copied safely.")
        if stream_index == analysis.video_index:
            index = bisect_right(starts, pts) - 1
            if index < 0 or pts >= ends[index]:
                continue
            if decoded >= len(decoding):
                raise CutAnalysisError("plan_changed", "The video frames changed since analysis.")
            shift = shifts[index]
            packet.pts = round_div(pts * shift.denominator + shift.numerator, shift.denominator)
            packet.dts = to_ticks(decoding[decoded], base)
            decoded += 1
            yield packet
            continue
        counters[stream_index] += 1
        scale, times = tracks[stream_index]
        placements = times.get(counters[stream_index])
        if not placements:
            continue
        divisor = scale * base.numerator
        for number, (start, duration) in enumerate(placements):
            # a subtitle shown across a cut appears once in each kept part
            copy = packet if number == len(placements) - 1 else av.Packet(bytes(packet))
            copy.stream = packet.stream
            copy.time_base = packet.time_base
            copy.pts = copy.dts = round_div(start * base.denominator, divisor)
            if duration:
                copy.duration = round_div(duration * base.denominator, divisor)
            yield copy
