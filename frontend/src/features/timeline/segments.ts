export const MIN_DURATION = 0.05;

export interface SegmentRange {
  start: number;
  end: number;
  muted?: boolean;
}

export type MutableSegment = SegmentRange;

export interface TimelineViewItem {
  index: number;
  badge: string;
  start: number;
  end: number;
  muted?: boolean;
}

export interface TimelineViewState {
  status: "empty" | "loading" | "ready";
  items: TimelineViewItem[];
}

export interface SegmentGap {
  start: number;
  end: number;
  insertAt: number;
}

export interface ClipSegmentSource {
  segments?: SegmentRange[] | null;
  trimStart?: number | null;
  trimEnd?: number | null;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(name + " must be a finite number");
  return value;
}

function copySegment(
  item: SegmentRange,
  start?: number | null,
  end?: number | null,
): SegmentRange {
  const out: SegmentRange = {
    start: start != null ? start : item.start,
    end: end != null ? end : item.end,
  };
  if (item.muted) out.muted = true;
  return out;
}

export function fullSegment(duration: number): SegmentRange[] {
  const resolved = finiteNumber(duration, "duration");
  if (resolved <= 0) return [];
  return [{ start: 0, end: resolved }];
}

export function normalizeSegments(
  value: unknown,
  duration: number,
): SegmentRange[] {
  const resolvedDuration = finiteNumber(duration, "duration");
  if (resolvedDuration <= 0) return [];
  if (value == null) return fullSegment(resolvedDuration);
  if (!Array.isArray(value) || !value.length)
    throw new Error("segments must contain at least one segment");

  const normalized: SegmentRange[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== "object")
      throw new Error("segment " + (i + 1) + " must be an object");
    const record = item as SegmentRange;
    const start = finiteNumber(record.start, "segment start");
    let end = finiteNumber(record.end, "segment end");
    if (start < 0) throw new Error("segment start must be at least zero");
    if (end > resolvedDuration + 0.000001)
      throw new Error("segment end exceeds source duration");
    end = Math.min(end, resolvedDuration);
    if (end <= start) throw new Error("segment end must be after segment start");
    if (end - start < MIN_DURATION - 0.000001)
      throw new Error("segments must be at least 0.05 seconds");
    const previous = normalized[normalized.length - 1];
    if (previous && start < previous.end - 0.000001)
      throw new Error("segments must be ordered and must not overlap");
    normalized.push(copySegment(record, start, end));
  }
  return normalized;
}

export function segmentsForClip(
  clip: ClipSegmentSource | null | undefined,
  duration: number,
): SegmentRange[] {
  if (clip && Array.isArray(clip.segments) && clip.segments.length)
    return normalizeSegments(clip.segments, duration);
  if (clip && (clip.trimStart != null || clip.trimEnd != null)) {
    return normalizeSegments(
      [
        {
          start: clip.trimStart != null ? clip.trimStart : 0,
          end: clip.trimEnd != null ? clip.trimEnd : duration,
        },
      ],
      duration,
    );
  }
  return fullSegment(duration);
}

export function timelineViewState(
  clip: ClipSegmentSource | null | undefined,
  duration: number,
): TimelineViewState {
  if (!clip) return { status: "empty", items: [] };
  if (!Number.isFinite(duration) || duration <= 0)
    return { status: "loading", items: [] };
  return {
    status: "ready",
    items: segmentsForClip(clip, duration).map((segment, index) => {
      const item: TimelineViewItem = {
        index: index,
        badge: "S" + (index + 1),
        start: segment.start,
        end: segment.end,
      };
      if (segment.muted) item.muted = true;
      return item;
    }),
  };
}

export function selectedDuration(segments: SegmentRange[]): number {
  let total = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    total += Math.max(0, segment.end - segment.start);
  }
  return total;
}

export function isFullSource(
  segments: SegmentRange[],
  duration: number,
): boolean {
  const first = segments[0];
  return (
    segments.length === 1 &&
    !!first &&
    first.start <= 0.001 &&
    first.end >= duration - 0.001
  );
}

export function editEndpoint(
  segments: SegmentRange[],
  index: number,
  endpoint: string,
  value: number,
  duration: number,
): SegmentRange[] {
  const result = normalizeSegments(segments, duration);
  if (index < 0 || index >= result.length) throw new Error("invalid active segment");
  const resolved = finiteNumber(value, endpoint);
  const current = result[index];
  if (!current) throw new Error("invalid active segment");
  const previous = result[index - 1];
  const next = result[index + 1];
  const previousEnd = previous ? previous.end : 0;
  const nextStart = next ? next.start : duration;
  if (endpoint === "start") {
    current.start = Math.max(previousEnd, Math.min(resolved, current.end - MIN_DURATION));
  } else if (endpoint === "end") {
    current.end = Math.min(nextStart, Math.max(resolved, current.start + MIN_DURATION));
  } else {
    throw new Error("endpoint must be start or end");
  }
  return result;
}

export function availableGaps(
  segments: SegmentRange[],
  duration: number,
): SegmentGap[] {
  const result = normalizeSegments(segments, duration);
  const gaps: SegmentGap[] = [];
  let cursor = 0;
  for (let i = 0; i < result.length; i++) {
    const segment = result[i];
    if (!segment) continue;
    if (segment.start - cursor >= MIN_DURATION - 0.000001)
      gaps.push({ start: cursor, end: segment.start, insertAt: i });
    cursor = segment.end;
  }
  if (duration - cursor >= MIN_DURATION - 0.000001)
    gaps.push({ start: cursor, end: duration, insertAt: result.length });
  return gaps;
}

export function canAddSegment(
  segments: SegmentRange[],
  duration: number,
): boolean {
  return availableGaps(segments, duration).length > 0;
}

export function addSegment(
  segments: SegmentRange[],
  duration: number,
  preferredTime?: number,
  preferredDuration?: number,
): { segments: SegmentRange[]; index: number } {
  const result = normalizeSegments(segments, duration);
  let at =
    typeof preferredTime === "number" && Number.isFinite(preferredTime)
      ? preferredTime
      : duration / 2;
  at = Math.max(0, Math.min(duration, at));
  const gaps = availableGaps(result, duration);
  const firstGap = gaps[0];
  if (!firstGap)
    throw new Error("Shorten a segment to create a gap before adding another one");

  let gap = firstGap;
  let gapDistance = Math.max(gap.start - at, at - gap.end, 0);
  for (let g = 0; g < gaps.length; g++) {
    const candidate = gaps[g];
    if (!candidate) continue;
    if (at >= candidate.start && at <= candidate.end) {
      gap = candidate;
      break;
    }
    const distance = Math.max(candidate.start - at, at - candidate.end, 0);
    if (distance < gapDistance) {
      gap = candidate;
      gapDistance = distance;
    }
  }
  const requestedDuration =
    typeof preferredDuration === "number" && Number.isFinite(preferredDuration)
      ? Math.max(MIN_DURATION, preferredDuration)
      : 1;
  const length = Math.min(requestedDuration, gap.end - gap.start);
  const start = Math.max(gap.start, Math.min(at - length / 2, gap.end - length));
  const added: SegmentRange = { start: start, end: start + length };
  result.splice(gap.insertAt, 0, added);
  return { segments: result, index: gap.insertAt };
}

export function moveSegment(
  segments: SegmentRange[],
  index: number,
  start: number,
  duration: number,
): SegmentRange[] {
  const result = normalizeSegments(segments, duration);
  if (index < 0 || index >= result.length) throw new Error("invalid active segment");
  const resolvedStart = finiteNumber(start, "segment start");
  const current = result[index];
  if (!current) throw new Error("invalid active segment");
  const length = current.end - current.start;
  const previous = result[index - 1];
  const next = result[index + 1];
  const minimum = previous ? previous.end : 0;
  const maximum = (next ? next.start : duration) - length;
  current.start = Math.max(minimum, Math.min(resolvedStart, maximum));
  current.end = current.start + length;
  return result;
}

export function removeSegment(
  segments: SegmentRange[],
  index: number,
  duration: number,
): SegmentRange[] {
  const result = normalizeSegments(segments, duration);
  if (result.length <= 1) return fullSegment(duration);
  if (index < 0 || index >= result.length) throw new Error("invalid active segment");
  result.splice(index, 1);
  return result;
}

export function cloneSegments(segments: SegmentRange[]): SegmentRange[] {
  return segments.map((segment) => copySegment(segment));
}

export function splitAt(
  segments: SegmentRange[],
  time: number,
  duration: number,
): { segments: SegmentRange[]; index: number } | null {
  const result = normalizeSegments(segments, duration);
  const resolvedTime = finiteNumber(time, "split time");
  for (let i = 0; i < result.length; i++) {
    const segment = result[i];
    if (!segment) continue;
    if (
      resolvedTime >= segment.start + MIN_DURATION &&
      resolvedTime <= segment.end - MIN_DURATION
    ) {
      const end = segment.end;
      segment.end = resolvedTime;
      result.splice(i + 1, 0, copySegment(segment, resolvedTime, end));
      return { segments: result, index: i + 1 };
    }
  }
  return null;
}

export function audioSegmentsForClip(
  clip: ClipSegmentSource | null | undefined,
  duration: number,
): SegmentRange[] {
  const pieces: SegmentRange[] = [];
  const segs = segmentsForClip(clip, duration);
  for (let i = 0; i < segs.length; i++) {
    const segment = segs[i];
    if (!segment) continue;
    if (!segment.muted) pieces.push({ start: segment.start, end: segment.end });
  }
  return pieces;
}

export function segmentIndexAtTime(
  segments: SegmentRange[],
  time: number,
  tolerance?: number,
): number {
  const resolvedTolerance = tolerance == null ? 0 : tolerance;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    if (
      time >= segment.start - resolvedTolerance &&
      time < segment.end - resolvedTolerance
    )
      return i;
  }
  return -1;
}

export function playbackTarget(
  segments: SegmentRange[],
  time: number,
  tolerance?: number,
): number | null {
  const resolvedTolerance = tolerance == null ? 0.04 : tolerance;
  if (!segments.length) return null;
  if (segmentIndexAtTime(segments, time, resolvedTolerance) >= 0) return null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    if (time < segment.start - resolvedTolerance) return segment.start;
  }
  const first = segments[0];
  return first ? first.start : null;
}

export const SegmentEditing = {
  MIN_DURATION,
  fullSegment,
  normalizeSegments,
  segmentsForClip,
  timelineViewState,
  selectedDuration,
  isFullSource,
  editEndpoint,
  availableGaps,
  canAddSegment,
  addSegment,
  moveSegment,
  removeSegment,
  splitAt,
  audioSegmentsForClip,
  cloneSegments,
  segmentIndexAtTime,
  playbackTarget,
};

export default SegmentEditing;
