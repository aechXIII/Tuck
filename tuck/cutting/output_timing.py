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
