// What a ripple does to a video's timeline: a stretch is taken out and the gap closes, and the
// markers and added audio after it slide left with the picture they were placed against.

import type { AudioTimelineState, MuteRange } from "../editor/types.ts";
import { hasPlacement, removeStretch, stretchBounds, timelineGaps, type SegmentRange } from "./segments.ts";

/** Where a moment after the stretch lands once the stretch is gone; inside it, its start. */
export function rippleTime(time: number, from: number, to: number): number {
  if (time >= to) return time - (to - from);
  return time > from ? from : time;
}

/**
 * The markers once the stretch is gone. Markers on removed footage go with it; a marker in an
 * empty gap has nothing to go with, so it stays at the gap's start.
 */
export function rippleMarkers(markers: readonly number[], from: number, to: number, removesFootage: boolean): number[] {
  const kept = markers.filter((time) => !removesFootage || time < from || time >= to);
  const moved = kept.map((time) => rippleTime(time, from, to)).sort((a, b) => a - b);
  return moved.filter((time, index) => index === 0 || time - (moved[index - 1] ?? -1) >= 0.01);
}

/**
 * Added audio once the stretch is gone. A clip that starts after it slides left by the stretch's
 * length, one that starts inside it moves to its start, and one already playing across it stays
 * put. A clip never slides into the one before it on its track. Muted stretches on a track move
 * with the clip they are on.
 */
export function rippleAudio(state: AudioTimelineState | null, from: number, to: number): void {
  if (!state) return;
  for (const track of state.tracks) {
    const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    const shifts = new Map<string, number>();
    let cursor = 0;
    for (const clip of clips) {
      const before = clip.timelineStart;
      const wanted = before >= from ? rippleTime(before, from, to) : before;
      clip.timelineStart = Math.max(cursor, Math.min(before, wanted));
      shifts.set(clip.id, clip.timelineStart - before);
      cursor = clip.timelineStart + clip.timelineDuration;
    }
    track.clips = clips;
    if (track.muteRanges?.length) {
      track.muteRanges = track.muteRanges.map((range): MuteRange => {
        const owner = clips.find((clip) => {
          const start = clip.timelineStart - (shifts.get(clip.id) ?? 0);
          return range.start >= start && range.start < start + clip.timelineDuration;
        });
        const shift = owner ? (shifts.get(owner.id) ?? 0) : rippleTime(range.start, from, to) - range.start;
        return { start: range.start + shift, end: range.end + shift };
      });
    }
  }
}

export interface TimelineParts {
  segments: SegmentRange[];
  markers: number[];
  audio: AudioTimelineState | null;
}

export interface TakeOut {
  parts: TimelineParts;
  // the stretch as it was really taken out, and where its start is on the new timeline
  from: number;
  to: number;
  at: number;
  // gaps of a never placed timeline that closed with it, in the old timeline's time
  closedGaps: { start: number; end: number }[];
}

function closeStretch(parts: TimelineParts, from: number, to: number, removesFootage: boolean, duration: number): TimelineParts {
  const audio = parts.audio ? (JSON.parse(JSON.stringify(parts.audio)) as AudioTimelineState) : null;
  rippleAudio(audio, from, to);
  return {
    segments: removeStretch(parts.segments, from, to, duration),
    markers: rippleMarkers(parts.markers, from, to, removesFootage),
    audio,
  };
}

/**
 * The timeline with the stretch from `from` to `to` taken out and closed up. A timeline that was
 * never placed already exports its segments back to back, so its gaps close too: left open, they
 * would turn into black in the export once the timeline is placed. Null when no segment is left.
 */
export function takeOut(parts: TimelineParts, from: number, to: number, removesFootage: boolean, duration: number): TakeOut | null {
  const [start, end] = stretchBounds(parts.segments, from, to, duration);
  const closedGaps = hasPlacement(parts.segments)
    ? []
    : timelineGaps(parts.segments, duration).filter((gap) => gap.end <= start || gap.start >= end);
  let current = parts;
  let at = start;
  let until = end;
  // the last gap first, so the earlier ones are still where they were
  for (const gap of [...closedGaps].reverse()) {
    current = closeStretch(current, gap.start, gap.end, false, duration);
    at = rippleTime(at, gap.start, gap.end);
    until = rippleTime(until, gap.start, gap.end);
  }
  if (until - at > 0) current = closeStretch(current, at, until, removesFootage, duration);
  if (!current.segments.length) return null;
  return { parts: current, from: start, to: end, at, closedGaps };
}
