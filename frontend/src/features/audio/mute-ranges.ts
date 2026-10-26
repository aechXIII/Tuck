import type { SegmentRange } from "../timeline/segments.ts";
import type { MuteRange } from "../editor/types.ts";

/** shorter than this is a click, not a stretch to mute */
export const MIN_MUTE = 0.05;
const EPSILON = 0.000001;

function sorted(ranges: readonly MuteRange[]): MuteRange[] {
  return ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map((range) => ({ start: Math.max(0, range.start), end: range.end }))
    .sort((a, b) => a.start - b.start);
}

/** Ranges in order, with overlapping or touching ones joined. */
export function normalizeMuteRanges(ranges: readonly MuteRange[]): MuteRange[] {
  const result: MuteRange[] = [];
  for (const range of sorted(ranges)) {
    const last = result.at(-1);
    if (last && range.start <= last.end + EPSILON) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result.filter((range) => range.end - range.start >= MIN_MUTE - EPSILON);
}

/** `ranges` with [start, end) muted too, or null when that stretch is too short. */
export function addMuteRanges(ranges: readonly MuteRange[], added: readonly MuteRange[]): MuteRange[] | null {
  const usable = added.filter((range) => range.end - range.start >= MIN_MUTE - EPSILON);
  if (!usable.length) return null;
  return normalizeMuteRanges([...ranges, ...usable]);
}

export function removeMuteRange(ranges: readonly MuteRange[], index: number): MuteRange[] {
  return ranges.filter((_, at) => at !== index).map((range) => ({ ...range }));
}

/**
 * The range with one edge moved to `at`, or null when that would leave it shorter than a
 * stretch. Its neighbors are joined if it now reaches them.
 */
export function setMuteRangeEdge(
  ranges: readonly MuteRange[],
  index: number,
  edge: "start" | "end",
  at: number,
): MuteRange[] | null {
  const range = ranges[index];
  if (!range || !Number.isFinite(at)) return null;
  const moved = edge === "start" ? { start: Math.max(0, at), end: range.end } : { start: range.start, end: at };
  if (moved.end - moved.start < MIN_MUTE - EPSILON) return null;
  return normalizeMuteRanges(ranges.map((item, position) => (position === index ? moved : item)));
}

export function muteRangeIndexAt(ranges: readonly MuteRange[] | undefined, time: number): number {
  if (!ranges) return -1;
  return ranges.findIndex((range) => time >= range.start - EPSILON && time < range.end - EPSILON);
}

export function isMutedAt(ranges: readonly MuteRange[] | undefined, time: number): boolean {
  return muteRangeIndexAt(ranges, time) >= 0;
}

/**
 * A stretch drawn on a source audio lane, in the source's own time. On a timeline of moved
 * clips each part of it comes from the clip it covers; elsewhere the lane is source time.
 */
export function laneToSourceRanges(segments: readonly SegmentRange[], start: number, end: number): MuteRange[] {
  if (!segments.some((segment) => segment.sourceStart != null)) return [{ start, end }];
  const result: MuteRange[] = [];
  for (const segment of segments) {
    const from = Math.max(start, segment.start);
    const to = Math.min(end, segment.end);
    if (to - from <= EPSILON) continue;
    const offset = (segment.sourceStart ?? segment.start) - segment.start;
    result.push({ start: from + offset, end: to + offset });
  }
  return result;
}

/** Where a source-time range shows on the lane: one stretch for each clip that holds it. */
export function sourceToLaneRanges(segments: readonly SegmentRange[], range: MuteRange): MuteRange[] {
  if (!segments.some((segment) => segment.sourceStart != null)) return [{ ...range }];
  const result: MuteRange[] = [];
  for (const segment of segments) {
    const sourceStart = segment.sourceStart ?? segment.start;
    const sourceEnd = sourceStart + segment.end - segment.start;
    const from = Math.max(range.start, sourceStart);
    const to = Math.min(range.end, sourceEnd);
    if (to - from <= EPSILON) continue;
    result.push({ start: segment.start + from - sourceStart, end: segment.start + to - sourceStart });
  }
  return result;
}

/** How many source audio tracks an export keeps: the first unless muted, and each other one not muted. */
export function keptSourceTrackCount(
  hasAudio: boolean,
  firstMuted: boolean,
  others: readonly { muted: boolean }[],
): number {
  if (!hasAudio) return 0;
  return (firstMuted ? 0 : 1) + others.filter((track) => !track.muted).length;
}
