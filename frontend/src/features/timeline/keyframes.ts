import type { CutAnalysisPayload, CutSegment } from "../../backend/cutting-types.ts";
import { mediaSeconds } from "../export/cut-state.ts";

// keyframe feedback for the lossless cut task: these helpers only draw Python's analysis and
// plan, and the backend planner decides which keyframe is safe to start on

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

// average on-screen gap, in pixels, below which keyframe notches fade to a texture
const MIN_NOTCH_SPACING = 4;

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

// the keyframe the playhead sits on, or the two either side of it
export function keyframesAround(
  times: readonly number[],
  time: number,
  tolerance = 0.001,
): number[] {
  if (!times.length || !Number.isFinite(time)) return [];
  const index = lowerBound(times, time - tolerance);
  const on = times[index];
  if (on !== undefined && on <= time + tolerance) return [on];
  return [times[index - 1], on].filter((value): value is number => value !== undefined);
}

// where copying begins for a start at `time`: that keyframe, or the next one
export function landingKeyframe(
  times: readonly number[],
  time: number,
  tolerance = 0.001,
): number | null {
  if (!Number.isFinite(time)) return null;
  return times[lowerBound(times, time - tolerance)] ?? null;
}

// a plan made before the latest edit must not decorate the edited segment. The last end is
// the analysed stream duration, which can differ from the probed container duration.
export function planMatches(
  segment: { start: number; end: number; sourceStart?: number },
  planSegment: CutSegment | null | undefined,
): planSegment is CutSegment {
  return !!planSegment && Math.abs(mediaSeconds(planSegment.requested.start) - (segment.sourceStart ?? segment.start)) <= MATCH_EPSILON;
}

export function sliverFor(
  index: number,
  segment: { start: number; end: number; sourceStart?: number },
  planSegment: CutSegment | null | undefined,
): CutSliver | null {
  if (!planSegment || !planMatches(segment, planSegment)) return null;
  const offset = segment.start - (segment.sourceStart ?? segment.start);
  if (planSegment.start_kind === "exact") {
    const start = mediaSeconds(planSegment.resolved.start);
    const whole = !planSegment.copied;
    const copyStart = whole ? mediaSeconds(planSegment.resolved.end) : mediaSeconds(planSegment.copied!.start);
    return copyStart > start ? {index,requestedStart:start + offset,exportedStart:copyStart + offset,delta:copyStart-start,kind:"exact",whole} : null;
  }
  if (planSegment.start_kind !== "moved") return null;
  const requestedStart = mediaSeconds(planSegment.requested.start);
  const exportedStart = mediaSeconds(planSegment.resolved.start);
  const delta = exportedStart - requestedStart;
  if (!(delta > 0) || exportedStart + offset >= segment.end) return null;
  return { index, requestedStart: requestedStart + offset, exportedStart: exportedStart + offset, delta, kind: "moved" };
}

export function deltaText(seconds: number): string {
  const value = Math.max(0, seconds);
  return `${value > 0 && value < 0.1 ? value.toFixed(2) : value.toFixed(1)} s`;
}

export function chipText(kind: "moved" | "exact", delta: number): string {
  return kind === "exact" ? `${deltaText(delta)} re-encoded` : `starts ${deltaText(delta)} later`;
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

function markNode<K extends "div" | "button">(layer: HTMLElement, tag: K, className: string, key: string): HTMLElementTagNameMap[K] {
  const found = layer.querySelector<HTMLElementTagNameMap[K]>(`${tag}.${className}[data-cut-mark="${key}"]`);
  if (found) return found;
  const node = layer.ownerDocument.createElement(tag);
  node.className = className;
  node.dataset.cutMark = key;
  layer.append(node);
  return node;
}

// nodes are kept per segment, so repaints during a drag neither flicker nor drop chip focus
// `inClip` lists segments whose own time line already says this; their chip only shows on focus
export function renderCutMarks(
  layer: HTMLElement,
  slivers: readonly CutSliver[],
  duration: number,
  inClip: ReadonlySet<number> = new Set(),
): void {
  const wanted = new Set(slivers.map((sliver) => String(sliver.index)));
  for (const node of layer.querySelectorAll<HTMLElement>("[data-cut-mark]")) {
    if (!wanted.has(node.dataset.cutMark ?? "")) node.remove();
  }
  for (const sliver of slivers) {
    const key = String(sliver.index);
    const exact = sliver.kind === "exact";
    const hatch = markNode(layer, "div", "tl-sliver", key);
    hatch.classList.toggle("exact", exact);
    hatch.setAttribute("aria-hidden", "true");
    hatch.style.left = percent(sliver.requestedStart, duration);
    hatch.style.width = `${(sliver.delta / duration) * 100}%`;
    const chip = markNode(layer, "button", "edge-chip", key);
    chip.type = "button";
    chip.classList.toggle("exact", exact);
    chip.classList.toggle("in-clip", inClip.has(sliver.index));
    chip.dataset.cutChip = key;
    chip.style.left = percent(sliver.exportedStart, duration);
    const label = chipLabel(sliver);
    const text = chipText(sliver.kind, sliver.delta);
    if (chip.title !== label || chip.textContent !== text) {
      chip.title = label;
      chip.setAttribute("aria-label", `Segment ${sliver.index + 1}. ${label}`);
      chip.textContent = text;
    }
  }
}

function percent(time: number, duration: number): string {
  return `${Math.max(0, Math.min(100, (time / duration) * 100))}%`;
}

// the dividers are drawn strong enough to read on every clip, so the mask lets them through in
// full over the kept segments and only faintly over the removed parts between them
export function keyframeLaneMask(
  segments: readonly { start: number; end: number }[],
  duration: number,
): string {
  if (!(duration > 0)) return "none";
  const faint = "rgb(0 0 0 / 0.3)";
  const stops: string[] = [];
  let from = 0;
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const start = Math.max(from, Math.min(duration, segment.start));
    const end = Math.max(start, Math.min(duration, segment.end));
    if (end <= start) continue;
    const a = (from / duration) * 100;
    const b = (start / duration) * 100;
    const c = (end / duration) * 100;
    if (b > a) stops.push(`${faint} ${a}% ${b}%`);
    stops.push(`#000 ${b}% ${c}%`);
    from = end;
  }
  if (from < duration) stops.push(`${faint} ${(from / duration) * 100}% 100%`);
  if (stops.length === 1) stops.push(stops[0]!);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

// ticks are only rebuilt when the analysis changes; drags repaint the guides alone
export function renderKeyframeStrip(
  lane: HTMLElement,
  strip: KeyframeStrip,
  duration: number,
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
    // the first keyframes a video shows fade in together; later updates while reading, and every
    // redraw after that, appear at once so the lane never flickers
    const first = strip.times.length > 0 && !lane.querySelector("i.kf");
    lane.classList.toggle("kf-arriving", first);
    lane.replaceChildren(ticks);
  }
  const width = lane.getBoundingClientRect().width;
  lane.classList.toggle("dense", strip.times.length > 0 && width / strip.times.length < MIN_NOTCH_SPACING);
}

// the highlighted keyframes sit in their own layer, since the strip is blended into the clip
export function renderKeyframeGuides(
  layer: HTMLElement,
  near: readonly number[],
  landing: number | null,
  duration: number,
  lateBy = 0,
): void {
  const key = `${duration}|${near.join(",")}|${landing}|${lateBy}`;
  if (layer.dataset.guideKey === key) return;
  layer.dataset.guideKey = key;
  const doc = layer.ownerDocument;
  const guides = doc.createDocumentFragment();
  for (const time of near) {
    if (time === landing) continue;
    const guide = doc.createElement("i");
    guide.className = "kf-guide";
    guide.style.left = percent(time, duration);
    guides.append(guide);
  }
  if (landing != null) {
    const guide = doc.createElement("i");
    guide.className = "kf-guide landing";
    guide.style.left = percent(landing, duration);
    // the dragged edge shows the time asked for; the export starts here, so say so here
    if (lateBy > 0) {
      const note = doc.createElement("span");
      note.className = "kf-landing-note";
      note.textContent = chipText("moved", lateBy);
      guide.append(note);
    }
    guides.append(guide);
  }
  layer.replaceChildren(guides);
}
