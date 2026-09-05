const TRACK_COLORS = [
  "#0F766E",
  "#B45309",
  "#0369A1",
  "#4D7C0F",
  "#A21CAF",
  "#C2410C",
] as const;

export interface AudioTimeSegment {
  start: number;
  end: number;
}

export interface AudioClip {
  id?: string;
  timelineStart: number;
  timelineDuration: number;
  sourceIn: number;
  sourceOut: number;
  fadeIn: number;
  fadeOut: number;
  loop?: boolean;
  muted?: boolean;
  [key: string]: unknown;
}

export interface SourceRangeDetailState {
  visibleSpan: number;
  viewportStart: number;
  waveformLeftPct: number;
  waveformWidthPct: number;
  waveformPositionPct: number;
  selectionStartPct: number;
  selectionWidthPct: number;
}

export interface SourceRangeState {
  sourceIn: number;
  sourceOut: number;
  sourceSpan: number;
  sourceDuration: number;
  maxSourceIn: number;
  startPct: number;
  widthPct: number;
  canSlip: boolean;
}

export type ImportedDragAction = "move" | "slip" | "trim-start" | "trim-end";

export function trackColor(index: unknown): string {
  const normalized = Math.max(0, Number(index) || 0);
  return TRACK_COLORS[Math.floor(normalized) % TRACK_COLORS.length] ?? TRACK_COLORS[0];
}

export function selectedDuration(
  segments: AudioTimeSegment[] | null | undefined,
): number {
  return (segments || []).reduce((total, segment) => {
    return total + Math.max(0, Number(segment.end) - Number(segment.start));
  }, 0);
}

export function sourceToOutputTime(
  segments: AudioTimeSegment[],
  sourceTime: number,
): number {
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    if (sourceTime < segment.start) return cursor;
    if (sourceTime <= segment.end)
      return cursor + Math.max(0, sourceTime - segment.start);
    cursor += segment.end - segment.start;
  }
  return cursor;
}

export function outputToSourceTime(
  segments: AudioTimeSegment[],
  outputTime: number,
): number {
  let remaining = Math.max(0, Number(outputTime) || 0);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const duration = segment.end - segment.start;
    if (remaining <= duration) return segment.start + remaining;
    remaining -= duration;
  }
  const last = segments[segments.length - 1];
  return last ? last.end : 0;
}

export function splitClip(
  clip: AudioClip,
  timelineTime: number,
  newId: string,
): [AudioClip, AudioClip] | null {
  const local = timelineTime - clip.timelineStart;
  if (local < 0.05 || local > clip.timelineDuration - 0.05) return null;
  const left: AudioClip = {
    ...clip,
    timelineDuration: local,
    fadeOut: 0,
  };
  const right: AudioClip = {
    ...clip,
    id: newId,
    timelineStart: timelineTime,
    timelineDuration: clip.timelineDuration - local,
    fadeIn: 0,
  };
  if (!clip.loop) {
    left.sourceOut = clip.sourceIn + local;
    right.sourceIn = left.sourceOut;
  }
  left.fadeIn = Math.min(Number(left.fadeIn) || 0, left.timelineDuration);
  right.fadeOut = Math.min(Number(right.fadeOut) || 0, right.timelineDuration);
  return [left, right];
}

export function fitClipToTimeline(
  sourceDuration: unknown,
  timelineDuration: unknown,
  playhead: unknown,
  minimumDuration?: unknown,
): {
  timelineStart: number;
  timelineDuration: number;
  sourceIn: number;
  sourceOut: number;
} {
  const source = Math.max(0, Number(sourceDuration) || 0);
  const timeline = Math.max(0, Number(timelineDuration) || 0);
  const minimum = Math.max(0, Number(minimumDuration) || 0.05);
  const maxStart = Math.max(0, timeline - Math.min(minimum, timeline));
  const timelineStart = Math.max(0, Math.min(maxStart, Number(playhead) || 0));
  const duration = Math.min(source, Math.max(0, timeline - timelineStart));
  return {
    timelineStart: timelineStart,
    timelineDuration: duration,
    sourceIn: 0,
    sourceOut: duration,
  };
}

export function sourceRangePointerValue(
  clientX: unknown,
  contentLeft: unknown,
  contentWidth: unknown,
  grabOffset: unknown,
  sourceDuration: unknown,
  maxSourceIn: unknown,
): number {
  const width = Math.max(1, Number(contentWidth) || 0);
  const value =
    ((Number(clientX) - Number(contentLeft) - (Number(grabOffset) || 0)) / width) *
    Math.max(0, Number(sourceDuration) || 0);
  return Math.max(0, Math.min(Math.max(0, Number(maxSourceIn) || 0), value));
}

export function waveformPositionPct(
  sourceIn: unknown,
  sourceSpan: unknown,
  sourceDuration: unknown,
): number {
  const start = Number(sourceIn) || 0;
  const span = Math.max(0, Number(sourceSpan) || 0);
  const total = Math.max(0, Number(sourceDuration) || 0);
  const movableSpan = total - span;
  return Math.abs(movableSpan) > 0.000001 ? (start / movableSpan) * 100 : 0;
}

export function sourceRangeDetailState(
  sourceIn: unknown,
  sourceSpan: unknown,
  sourceDuration: unknown,
): SourceRangeDetailState {
  const start = Math.max(0, Number(sourceIn) || 0);
  const span = Math.max(0, Number(sourceSpan) || 0);
  const total = Math.max(0, Number(sourceDuration) || 0);
  const visibleSpan = span ? Math.min(total, span * 2.5) : total;
  if (!visibleSpan) {
    return {
      visibleSpan: 0,
      viewportStart: 0,
      waveformLeftPct: 0,
      waveformWidthPct: 100,
      waveformPositionPct: 0,
      selectionStartPct: 0,
      selectionWidthPct: 100,
    };
  }
  if (visibleSpan >= total) {
    return {
      visibleSpan: visibleSpan,
      viewportStart: 0,
      waveformLeftPct: 0,
      waveformWidthPct: 100,
      waveformPositionPct: 0,
      selectionStartPct: total ? (start / total) * 100 : 0,
      selectionWidthPct: total ? (span / total) * 100 : 100,
    };
  }
  const context = Math.max(0, (visibleSpan - span) / 2);
  const viewportStart = start - context;
  const waveformLeftPct = (-viewportStart / visibleSpan) * 100;
  const waveformWidthPct = (total / visibleSpan) * 100;
  return {
    visibleSpan: visibleSpan,
    viewportStart: viewportStart,
    waveformLeftPct: waveformLeftPct,
    waveformWidthPct: waveformWidthPct,
    waveformPositionPct: waveformPositionPct(viewportStart, visibleSpan, total),
    selectionStartPct: (context / visibleSpan) * 100,
    selectionWidthPct: (span / visibleSpan) * 100,
  };
}

export function sourceRangeDetailDragValue(
  current: unknown,
  deltaX: unknown,
  visibleSpan: unknown,
  contentWidth: unknown,
  maxSourceIn: unknown,
): number {
  const width = Math.max(1, Number(contentWidth) || 0);
  const value =
    (Number(current) || 0) -
    ((Number(deltaX) || 0) / width) * Math.max(0, Number(visibleSpan) || 0);
  return Math.max(0, Math.min(Math.max(0, Number(maxSourceIn) || 0), value));
}

export function sourceRangeKeyboardValue(
  current: unknown,
  maximum: unknown,
  key: string,
  largeStep: boolean,
): number | null {
  const value = Math.max(0, Number(current) || 0);
  const max = Math.max(0, Number(maximum) || 0);
  if (key === "Home") return 0;
  if (key === "End") return max;
  const direction = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (!direction) return null;
  const step = largeStep ? 1 : 0.1;
  return Math.max(0, Math.min(max, value + direction * step));
}

function sourceSelectionSpan(clip: AudioClip): number {
  const selected = Math.max(
    0,
    (Number(clip.sourceOut) || 0) - (Number(clip.sourceIn) || 0),
  );
  const timeline = Math.max(0, Number(clip.timelineDuration) || 0);
  return clip.loop || !timeline ? selected : timeline;
}

export function trimClipToTimelinePoint(
  clip: AudioClip,
  endpoint: string,
  timelineTime: unknown,
  previousEnd: unknown,
  nextStart: unknown,
  sourceDuration: unknown,
  minimumDuration: unknown,
): AudioClip {
  const result: AudioClip = { ...clip };
  const start = Number(clip.timelineStart) || 0;
  const duration = Math.max(0, Number(clip.timelineDuration) || 0);
  const end = start + duration;
  const minimum = Math.max(0, Number(minimumDuration) || 0.05);
  const point = Number(timelineTime);
  const sourceIn = Math.max(0, Number(clip.sourceIn) || 0);
  const sourceTotal = Math.max(0, Number(sourceDuration) || 0);
  if (endpoint === "start") {
    let earliest = Math.max(0, Number(previousEnd) || 0);
    if (!clip.loop) earliest = Math.max(earliest, start - sourceIn);
    const next = Math.max(earliest, Math.min(point, end - minimum));
    const delta = next - start;
    result.timelineStart = next;
    result.timelineDuration = Math.max(minimum, end - next);
    if (!clip.loop) result.sourceIn = sourceIn + delta;
  } else if (endpoint === "end") {
    let latest = Math.max(start + minimum, Number(nextStart) || 0);
    if (!clip.loop) latest = Math.min(latest, start + sourceTotal - sourceIn);
    const trimmedEnd = Math.min(latest, Math.max(point, start + minimum));
    result.timelineDuration = Math.max(minimum, trimmedEnd - start);
    if (!clip.loop) result.sourceOut = sourceIn + result.timelineDuration;
  } else {
    throw new Error("endpoint must be start or end");
  }
  result.fadeIn = Math.min(Number(result.fadeIn) || 0, result.timelineDuration);
  result.fadeOut = Math.min(
    Number(result.fadeOut) || 0,
    result.timelineDuration - result.fadeIn,
  );
  return result;
}

export function slipClip(
  clip: AudioClip,
  sourceDuration: unknown,
  delta: unknown,
): AudioClip {
  const result: AudioClip = { ...clip };
  const sourceIn = Number(clip.sourceIn) || 0;
  const span = sourceSelectionSpan(clip);
  const total = Math.max(0, Number(sourceDuration) || 0);
  if (!span || total < span) return result;
  let nextIn = sourceIn + (Number(delta) || 0);
  nextIn = Math.max(0, Math.min(total - span, nextIn));
  result.sourceIn = nextIn;
  result.sourceOut = nextIn + span;
  return result;
}

export function resetSlip(clip: AudioClip, sourceDuration: unknown): AudioClip {
  return slipClip(clip, sourceDuration, -(Number(clip.sourceIn) || 0));
}

export function sourceRangeState(
  clip: AudioClip,
  sourceDuration: unknown,
): SourceRangeState {
  const total = Math.max(0, Number(sourceDuration) || 0);
  const rawIn = Math.max(0, Number(clip.sourceIn) || 0);
  const span = Math.min(total, sourceSelectionSpan(clip));
  const maxSourceIn = Math.max(0, total - span);
  const sourceIn = Math.max(0, Math.min(maxSourceIn, rawIn));
  return {
    sourceIn: sourceIn,
    sourceOut: sourceIn + span,
    sourceSpan: span,
    sourceDuration: total,
    maxSourceIn: maxSourceIn,
    startPct: total ? (sourceIn / total) * 100 : 0,
    widthPct: total ? (span / total) * 100 : 0,
    canSlip: maxSourceIn > 0.000001,
  };
}

export function formatSourceTime(seconds: unknown): string {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const milliseconds = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const prefix = hours
    ? hours + ":" + String(minutes).padStart(2, "0")
    : String(minutes);
  return (
    prefix +
    ":" +
    String(secs).padStart(2, "0") +
    "." +
    String(milliseconds).padStart(3, "0")
  );
}

export function importedDragAction(
  edge: string | null | undefined,
  altKey: boolean,
  explicitAction?: string | null,
): ImportedDragAction {
  if (edge === "start") return "trim-start";
  if (edge === "end") return "trim-end";
  if (altKey) return "slip";
  return explicitAction === "slip" ? "slip" : "move";
}

export function timelineSelection(
  trackId: string | null | undefined,
  clipId: string | null | undefined,
): { trackId: string; clipId: string | null } {
  const targetTrackId = !trackId || trackId === "video" ? "source" : trackId;
  return {
    trackId: targetTrackId,
    clipId: targetTrackId === "source" ? null : clipId || null,
  };
}
