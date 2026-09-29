"""Where kept frames land on the joined timeline, and how times become ticks."""

from __future__ import annotations

from bisect import bisect_left
from fractions import Fraction

from ..models.cutting import CutAnalysis, CutPlan


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
        # one addition per frame: a long video has hundreds of thousands
        offset = elapsed - first
        times.extend(frame + offset for frame in frames[low:high])
        elapsed += last - first
    return times


def output_frame_count(plan: CutPlan, analysis: CutAnalysis) -> int:
    """How many video frames the joined output keeps."""
    frames = analysis.frames
    return sum(
        max(
            0,
            bisect_left(frames, s.resolved.end.seconds)
            - bisect_left(frames, s.resolved.start.seconds),
        )
        for s in plan.segments
        if s.start_kind != "collapsed"
    )


def decode_times(presented: list[Fraction], reorder: int) -> list[Fraction]:
    """One decode timeline for any frame timing.

    The k-th decoded picture takes the (k - reorder)-th presentation time, so decode times
    rise steadily and never pass the presentation time of a picture the decoder holds back.
    The first pictures decode ahead by as long as the last `reorder` frames show, so with
    the last picture lasting as long as the last frame, decoding spans exactly as long as
    presentation: MP4 takes the video's length from its decode times.
    """
    count = min(reorder, len(presented) - 1)
    if count <= 0:
        return presented[:]
    lead = presented[-1] - presented[-1 - count]
    ahead = [presented[0] - (count - k) * lead / count for k in range(count)]
    return ahead + presented[: len(presented) - count]


def round_div(numerator: int, denominator: int) -> int:
    """numerator / denominator for a positive denominator, rounded half away from zero."""
    whole, rest = divmod(abs(numerator), denominator)
    if 2 * rest >= denominator:
        whole += 1
    return whole if numerator >= 0 else -whole


def to_ticks(time: Fraction, base: Fraction) -> int:
    # containers with coarse time bases round; round half away from zero, like FFmpeg.
    # whole numbers only: this runs for every copied packet
    return round_div(time.numerator * base.denominator, time.denominator * base.numerator)


def ticks_from(time: Fraction, base: Fraction) -> int:
    """The first tick of `base` at or after `time`."""
    return -((-time.numerator * base.denominator) // (time.denominator * base.numerator))
