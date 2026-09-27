"""Decide what each non-video track contributes to a joined cut, without doing I/O."""

from __future__ import annotations

from bisect import bisect_left
from fractions import Fraction

from ..models.cutting import (
    CutAnalysis,
    CutIssue,
    MediaTime,
    PacketTiming,
    TrackPackets,
    TrackPlan,
    TrackSegment,
)

# audio packets outside this length are too coarse to cut without audible extra sound
MAX_AUDIO_PACKET = Fraction(1, 5)
# codecs whose timing and priming Tuck has checked across joins
CHECKED_AUDIO = {"aac"}


def _end(packet: PacketTiming) -> Fraction:
    return packet.start.seconds + packet.duration.seconds


def _audio_segment(
    packets: tuple[PacketTiming, ...],
    first: Fraction,
    last: Fraction,
    audio_elapsed: Fraction,
    video_elapsed: Fraction,
    include_priming: bool,
) -> tuple[TrackSegment, Fraction] | None:
    """Choose whole packets for one segment so the joined audio stays next to the video.

    Packets never overlap a removed part by more than one packet, and every segment starts
    where the previous one ended, so drift cannot build up across joins.
    """
    starts = [p.start.seconds for p in packets]
    low = bisect_left(starts, first)
    while low > 0 and _end(packets[low - 1]) > first:
        low -= 1
    high = bisect_left(starts, last)
    if low >= high:
        return None
    wanted = first + audio_elapsed - video_elapsed
    begin = min(range(low, high), key=lambda i: (abs(starts[i] - wanted), i))
    need = video_elapsed + (last - first) - audio_elapsed

    def take(start: int) -> tuple[int, Fraction]:
        # the span from the first packet's start to the last packet's end, gaps included
        stop, total = start, Fraction(0)
        while stop < high:
            span = _end(packets[stop]) - starts[start]
            if abs(span - need) >= abs(total - need):
                break
            total = span
            stop += 1
        return stop, total

    stop, total = take(begin)
    # at the end of the range, start earlier rather than run into the removed part
    while begin > low and stop == high and abs(total - need) > packets[begin].duration.seconds / 2:
        begin -= 1
        stop, total = take(begin)
    if stop == begin:
        return None
    output_start = audio_elapsed
    if include_priming:
        # encoder priming before the first frame stays in front of the first kept audio
        while begin > 0 and _end(packets[begin - 1]) <= 0 and packets[begin - 1].skip_samples:
            begin -= 1
            output_start -= packets[begin].duration.seconds
    return TrackSegment(begin, stop, MediaTime.from_seconds(output_start)), total


def plan_audio(
    track: TrackPackets, ranges: list[tuple[Fraction, Fraction]]
) -> tuple[TrackPlan, list[CutIssue], list[CutIssue]]:
    packets = track.packets
    issues: list[CutIssue] = []
    notes: list[CutIssue] = []
    if not packets:
        return (
            TrackPlan(track.index, "audio", track.codec, False, "This audio track is empty."),
            [],
            [],
        )
    longest = max(p.duration.seconds for p in packets)
    if longest > MAX_AUDIO_PACKET:
        issues.append(
            CutIssue(
                "unsupported_stream",
                "This audio is stored in pieces too long to cut without re-encoding. "
                "Turn Include audio off.",
                "include_audio",
            )
        )
        return TrackPlan(track.index, "audio", track.codec, False), issues, notes
    segments = []
    audio_elapsed = video_elapsed = Fraction(0)
    for number, (first, last) in enumerate(ranges):
        chosen = _audio_segment(
            packets, first, last, audio_elapsed, video_elapsed, number == 0 and first == 0
        )
        if chosen is None:
            issues.append(
                CutIssue(
                    "unsupported_stream",
                    "This segment is too short to keep copied audio in sync. "
                    "Widen it or turn Include audio off.",
                    "include_audio",
                )
            )
            return TrackPlan(track.index, "audio", track.codec, False), issues, notes
        segment, total = chosen
        segments.append(segment)
        audio_elapsed += total
        video_elapsed += last - first
        if abs(audio_elapsed - video_elapsed) > longest:
            issues.append(
                CutIssue(
                    "unsupported_stream",
                    "The copied audio would not stay in sync. Turn Include audio off.",
                    "include_audio",
                )
            )
            return TrackPlan(track.index, "audio", track.codec, False), issues, notes
    if track.codec not in CHECKED_AUDIO:
        notes.append(
            CutIssue(
                "unverified_audio",
                "Audio sync at the cuts is not checked for this audio format.",
                "include_audio",
            )
        )
    return TrackPlan(track.index, "audio", track.codec, True, "", tuple(segments)), issues, notes


def plan_subtitles(track: TrackPackets, ranges: list[tuple[Fraction, Fraction]]) -> TrackPlan:
    segments = []
    elapsed = Fraction(0)
    for first, last in ranges:
        chosen = [
            number
            for number, packet in enumerate(track.packets)
            if packet.start.seconds < last
            and (_end(packet) > first if packet.duration.seconds else packet.start.seconds >= first)
        ]
        if chosen:
            segments.append(
                TrackSegment(chosen[0], chosen[-1] + 1, MediaTime.from_seconds(elapsed), True)
            )
        else:
            segments.append(TrackSegment(0, 0, MediaTime.from_seconds(elapsed), True))
        elapsed += last - first
    return TrackPlan(track.index, track.kind, track.codec, True, "", tuple(segments))


def plan_tracks(
    analysis: CutAnalysis, ranges: list[tuple[Fraction, Fraction]], include_audio: bool
) -> tuple[tuple[TrackPlan, ...], list[CutIssue], list[CutIssue]]:
    """Plan every non-video track: kept and cut, kept whole, or dropped with a reason."""
    dispositions = {s.index: s.dispositions for s in analysis.streams}
    plans: list[TrackPlan] = []
    issues: list[CutIssue] = []
    notes: list[CutIssue] = []
    known = {track.index for track in analysis.tracks}
    for stream in analysis.streams:
        if stream.index == analysis.video_index or stream.index in known:
            continue
        if stream.kind == "attachment":
            plans.append(TrackPlan(stream.index, "attachment", stream.codec, True))
    for track in analysis.tracks:
        if track.kind == "audio":
            if not include_audio:
                plans.append(
                    TrackPlan(track.index, "audio", track.codec, False, "Include audio is off.")
                )
                continue
            plan, track_issues, track_notes = plan_audio(track, ranges)
            plans.append(plan)
            issues.extend(track_issues)
            notes.extend(track_notes)
        elif track.kind == "subtitle":
            plans.append(plan_subtitles(track, ranges))
        elif track.kind == "video" and "attached_pic" in dispositions.get(track.index, ()):
            # cover art is a single picture shown for the whole file
            plans.append(
                TrackPlan(
                    track.index,
                    "video",
                    track.codec,
                    True,
                    "",
                    (TrackSegment(0, len(track.packets), MediaTime(0)),),
                )
            )
        elif track.kind == "video":
            plans.append(
                TrackPlan(
                    track.index, "video", track.codec, False, "Only the first video track is cut."
                )
            )
        else:
            plans.append(
                TrackPlan(
                    track.index,
                    track.kind,
                    track.codec,
                    False,
                    "Timecode and data tracks are not kept.",
                )
            )
    return tuple(sorted(plans, key=lambda p: p.index)), issues, notes
