from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterator
from fractions import Fraction
from pathlib import Path
from threading import Event

import av
from av.audio.stream import AudioStream
from av.container import InputContainer

from ..models.cutting import CutAnalysis, CutPlan, CutRequest
from .analysis import (
    MAX_PACKET_BYTES,
    MAX_PACKETS,
    CutAnalysisError,
    analyze_source,
    source_identity,
)
from .planner import plan_cut


def check_cut_cancel(cancel: Event) -> None:
    if cancel.is_set():
        raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.")


def validate_cut_source(plan: CutPlan, cancel: Event) -> None:
    check_cut_cancel(cancel)
    if source_identity(Path(plan.identity.path), cancel) != plan.identity:
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")


def prepare_cut(plan: CutPlan, cancel: Event, ffprobe: str | None) -> CutAnalysis:
    validate_cut_source(plan, cancel)
    if plan.issues or plan.precision != "keyframes" or plan.container != "mp4":
        raise CutAnalysisError("unsupported_cut", "This cut plan is not ready to export.")
    source, output = Path(plan.identity.path), Path(plan.output_path)
    if output.resolve() == source.resolve() or (output.exists() and output.samefile(source)):
        raise CutAnalysisError("invalid_output", "Choose an output name different from the source.")
    analysis = analyze_source(source, cancel, lambda _: None, ffprobe=ffprobe)
    if analysis.identity != plan.identity:
        raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")
    if analysis.issues:
        raise CutAnalysisError(analysis.issues[0].code, analysis.issues[0].message)
    rebuilt = plan_cut(
        CutRequest(
            str(source),
            tuple(s.requested for s in plan.segments),
            "keyframes",
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
        raise CutAnalysisError("plan_changed", "The cut boundaries changed. Review the cuts again.")
    return analysis


def selected_packets(
    incoming: InputContainer,
    plan: CutPlan,
    analysis: CutAnalysis,
    cancel: Event,
    *,
    kind: str | None = None,
) -> Iterator[av.Packet]:
    """Stream the planned packets with their joined output timestamps, without encoding."""
    video_starts = [s.resolved.start.seconds for s in plan.segments]
    audio_segments = [s for s in plan.segments if s.audio_source is not None]
    audio_starts = [s.audio_source.start.seconds for s in audio_segments if s.audio_source]
    offsets = []
    elapsed = Fraction(0)
    for segment in plan.segments:
        offsets.append(elapsed - segment.resolved.start.seconds - analysis.origin.seconds)
        elapsed += segment.resolved.end.seconds - segment.resolved.start.seconds
    streams = [
        s
        for s in incoming.streams
        if (s.type == "video" or (s.type == "audio" and plan.include_audio))
        and (kind is None or s.type == kind)
    ]
    for count, packet in enumerate(incoming.demux(*streams), 1):
        check_cut_cancel(cancel)
        if count > MAX_PACKETS or packet.size > MAX_PACKET_BYTES:
            raise CutAnalysisError("cut_failed", "The video exceeds the packet copy limit.")
        if not packet.size:
            continue
        if (
            packet.is_corrupt
            or packet.pts is None
            or packet.dts is None
            or not packet.time_base
            or not packet.duration
        ):
            raise CutAnalysisError("cut_failed", "A media packet cannot be copied safely.")
        base = Fraction(packet.time_base)
        time = packet.pts * base - analysis.origin.seconds
        duration = packet.duration * base
        if packet.stream.type == "video":
            index = bisect_right(video_starts, time) - 1
            if index < 0 or time + duration > plan.segments[index].resolved.end.seconds:
                continue
            offset = offsets[index]
        elif isinstance(packet.stream, AudioStream):
            index = bisect_right(audio_starts, time) - 1
            skip = int.from_bytes(bytes(packet.get_sidedata("skip_samples"))[:4], "little")
            priming = (
                plan.segments[0].resolved.start.seconds == 0
                and time + duration == 0
                and skip > 0
                and skip == duration * packet.stream.codec_context.sample_rate
            )
            if priming:
                offset = -analysis.origin.seconds
            elif index < 0:
                continue
            else:
                segment = audio_segments[index]
                if segment.audio_source is None or segment.audio_output is None:
                    raise CutAnalysisError("plan_changed", "The audio cut boundaries are missing.")
                if time + duration > segment.audio_source.end.seconds:
                    continue
                offset = (
                    segment.audio_output.start.seconds
                    - segment.audio_source.start.seconds
                    - analysis.origin.seconds
                )
        else:
            raise CutAnalysisError("unsupported_stream", "This stream cannot be copied.")
        ticks = offset / base
        if ticks.denominator != 1:
            raise CutAnalysisError("cut_failed", "The cut timestamps cannot be copied exactly.")
        packet.pts += ticks.numerator
        packet.dts += ticks.numerator
        yield packet
