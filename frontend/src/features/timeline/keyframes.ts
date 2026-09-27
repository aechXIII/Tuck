import type { CutAnalysisPayload, CutSegment } from "../../backend/cutting-types.ts";
import { mediaSeconds } from "../export/cut-state.ts";

// Keyframe feedback for the lossless cut task. These helpers only draw Python's analysis and
// plan; which keyframe is safe to start on is decided by the backend planner.

export interface KeyframeStrip {
  times: readonly number[];
  // share of the source that has been scanned, or null when nothing is known yet
  coverage: number | null;
}

export interface CutSliver {
  index: number;
  requestedStart: number;
  // where copying starts: the next keyframe, or the segment end when all of it is encoded
  exportedStart: number;
  delta: number;
  kind: "moved" | "exact";
  whole?: boolean;
}

// requested times travel as microseconds or rational frames, so allow for float rounding
const MATCH_EPSILON = 0.0005;

// average on-screen gap, in pixels, below which keyframe hairlines are left out
const MIN_LINE_SPACING = 6;

// timeline paints run on every drag frame; analysis payloads are replaced, never mutated
const sortedTimes = new WeakMap<CutAnalysisPayload, number[]>();

export function keyframeStrip(
  analysis: CutAnalysisPayload | null | undefined,
  duration: number,
): KeyframeStrip {
  if (!analysis || !(duration > 0)) return { times: [], coverage: null };
  let times = sortedTimes.get(analysis);
  if (!times) {
    times = analysis.keyframes.map(mediaSeconds).filter(Number.isFinite).sort((a, b) => a - b);
    sortedTimes.set(analysis, times);
  }
  if (analysis.status === "ready") return { times, coverage: 1 };
  if (analysis.status !== "reading" && analysis.status !== "pending") {
    return { times, coverage: times.length ? Math.min(1, mediaSeconds(analysis.coverage_end) / duration) : null };
  }
  const scanned = mediaSeconds(analysis.coverage_end) / duration;
  const coverage = Number.isFinite(scanned) && scanned > 0 ? scanned : analysis.progress;
  return { times, coverage: coverage == null ? null : Math.max(0, Math.min(1, coverage)) };
}

// first index whose time is at or after `time`
function lowerBound(times: readonly number[], time: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? Infinity) < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

// strictly before or after `time`; `tolerance` skips the keyframe the playhead already sits on
export function adjacentKeyframe(
  times: readonly number[],
  time: number,
  direction: -1 | 1,
  tolerance = 0.001,
): number | null {
  if (!times.length || !Number.isFinite(time)) return null;
  if (direction > 0) return times[lowerBound(times, time + tolerance)] ?? null;
  return times[lowerBound(times, time - tolerance) - 1] ?? null;
}

// the keyframes either side of `time`; a nearest-neighbour search keeps snapping cheap on
// long sources with thousands of keyframes
export function keyframeSnapCandidates(times: readonly number[], time: number): number[] {
  if (!times.length || !Number.isFinite(time)) return [];
  const index = lowerBound(times, time);
  const around = [times[index - 1], times[index]];
  return around.filter((value): value is number => value !== undefined);
}

// a plan made before the latest edit must not decorate the edited segment. The last end is
// the analysed stream duration, which can differ from the probed container duration.
export function planMatches(
  segment: { start: number; end: number },
  planSegment: CutSegment | null | undefined,
): planSegment is CutSegment {
  return !!planSegment && Math.abs(mediaSeconds(planSegment.requested.start) - segment.start) <= MATCH_EPSILON;
}

export function sliverFor(
  index: number,
  segment: { start: number; end: number },
  planSegment: CutSegment | null | undefined,
): CutSliver | null {
  if (!planSegment || !planMatches(segment, planSegment)) return null;
  if (planSegment.start_kind === "exact") {
    const start = mediaSeconds(planSegment.resolved.start);
    const whole = !planSegment.copied;
    const copyStart = whole ? mediaSeconds(planSegment.resolved.end) : mediaSeconds(planSegment.copied!.start);
    return copyStart > start ? {index,requestedStart:start,exportedStart:copyStart,delta:copyStart-start,kind:"exact",whole} : null;
  }
  if (planSegment.start_kind !== "moved") return null;
  const requestedStart = mediaSeconds(planSegment.requested.start);
  const exportedStart = mediaSeconds(planSegment.resolved.start);
  const delta = exportedStart - requestedStart;
  if (!(delta > 0) || exportedStart >= segment.end) return null;
  return { index, requestedStart, exportedStart, delta, kind: "moved" };
}

export function deltaText(seconds: number): string {
  const value = Math.max(0, seconds);
  return `${value > 0 && value < 0.1 ? value.toFixed(2) : value.toFixed(1)} s`;
}

export function chipText(kind: "moved" | "exact", delta: number): string {
  return kind === "exact" ? `${deltaText(delta)} re-encoded` : `+${deltaText(delta)}`;
}

// 0:44.000 or 1:02:03.250; the handles and chips need millisecond precision
export function preciseTime(seconds: number): string {
  const millis = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor(millis / 60_000) % 60;
  const rest = String(Math.floor(millis / 1000) % 60).padStart(2, "0") + "." + String(millis % 1000).padStart(3, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function chipLabel(sliver: CutSliver): string {
  if (sliver.kind === "exact") {
    return sliver.whole
      ? "This segment is re-encoded"
      : `Starts exactly at ${preciseTime(sliver.requestedStart)}. ${deltaText(sliver.delta)} near the start is re-encoded`;
  }
  return `Starts at ${preciseTime(sliver.exportedStart)}, the next keyframe, ${deltaText(sliver.delta)} later than where you cut`;
}

export function handleValueText(
  endpoint: "start" | "end",
  requested: number,
  planSegment: CutSegment | null,
): string {
  const base = preciseTime(requested);
  if (!planSegment || planSegment.start_kind === "collapsed") return base;
  if (endpoint === "start") {
    const exported = mediaSeconds(planSegment.resolved.start);
    return exported - requested > MATCH_EPSILON ? `${base}, exported from ${preciseTime(exported)}` : base;
  }
  const exported = mediaSeconds(planSegment.resolved.end);
  return requested - exported > MATCH_EPSILON ? `${base}, exported to ${preciseTime(exported)}` : base;
}

function percent(time: number, duration: number): string {
  return `${Math.max(0, Math.min(100, (time / duration) * 100))}%`;
}

// ticks are only rebuilt when the analysis changes; drags repaint the guides alone
export function renderKeyframeStrip(
  lane: HTMLElement,
  strip: KeyframeStrip,
  duration: number,
  near: readonly number[] = [],
): void {
  const doc = lane.ownerDocument;
  const key = `${duration}|${strip.coverage}|${strip.times.length}|${strip.times[0]}|${strip.times[strip.times.length - 1]}`;
  if (lane.dataset.stripKey !== key) {
    lane.dataset.stripKey = key;
    const ticks = doc.createDocumentFragment();
    for (const time of strip.times) {
      const tick = doc.createElement("i");
      tick.className = "kf";
      tick.style.left = percent(time, duration);
      ticks.append(tick);
    }
    const coverage = strip.coverage ?? 0;
    if (coverage > 0 && coverage < 1) {
      const scanned = doc.createElement("i");
      scanned.className = "kf-scan";
      scanned.style.width = percent(coverage * duration, duration);
      ticks.append(scanned);
    }
    if (coverage < 1) {
      // unread time must never look like a stretch without keyframes
      const unread = doc.createElement("i");
      unread.className = "kf-unread";
      unread.style.left = percent(coverage * duration, duration);
      ticks.append(unread);
    }
    lane.replaceChildren(ticks);
  }
  // hairlines only help while they stay apart; a dense comb would hide the video
  const width = lane.getBoundingClientRect().width;
  lane.classList.toggle("lines", strip.times.length > 0 && width / strip.times.length >= MIN_LINE_SPACING);
  for (const old of lane.querySelectorAll(".kf.near")) old.remove();
  for (const time of near) {
    const tick = doc.createElement("i");
    tick.className = "kf near";
    tick.style.left = percent(time, duration);
    lane.append(tick);
  }
}
