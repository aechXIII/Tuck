export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

const RULER_STEPS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
] as const;

export interface EditKeyTarget {
  id?: string;
  classList?: { contains(name: string): boolean };
  dataset?: { segmentIndex?: string };
}

export type EditKeyIntent =
  | {
      type: "segment";
      index: number;
      delta: number;
      snap: boolean;
    }
  | {
      type: "trim";
      endpoint: "start" | "end";
      delta: number;
      snap: boolean;
    };

export function trackActions(kind: string): string[] {
  if (kind === "source") return ["mute"];
  if (kind === "imported") return ["mute", "remove"];
  return [];
}

// the deepest zoom shows about this much of a long video, so single frames stay a few pixels apart
export const DEEPEST_VIEW_SECONDS = 2;
// a zoomed timeline is one wide element; past about a million pixels browsers lose precision and
// WebKitGTK's memory use grows, so a very long recording stops a little short of 2 seconds
export const MAX_TIMELINE_PX = 1_000_000;

/**
 * The deepest zoom for a video: short videos keep the 8x they always had, longer ones zoom until a
 * screen shows about two seconds.
 */
export function maxZoom(duration: unknown, viewportWidth: unknown): number {
  const seconds = Number(duration);
  const width = Number(viewportWidth);
  if (!Number.isFinite(seconds) || seconds <= 0) return ZOOM_MAX;
  let deepest = seconds / DEEPEST_VIEW_SECONDS;
  if (Number.isFinite(width) && width > 0) deepest = Math.min(deepest, MAX_TIMELINE_PX / width);
  return Math.max(ZOOM_MAX, deepest);
}

export function clampZoom(level: unknown, maximum: number = ZOOM_MAX): number {
  const numeric = Number(level);
  if (!Number.isFinite(numeric)) return ZOOM_MIN;
  return Math.min(Math.max(ZOOM_MIN, maximum), Math.max(ZOOM_MIN, numeric));
}

// the zoom slider moves in doublings, so one stretch of it means as much at 2x as at 500x
export function zoomSliderValue(level: number): number {
  return Math.log2(Math.max(ZOOM_MIN, level));
}

export function zoomFromSlider(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? 2 ** numeric : ZOOM_MIN;
}

// one wheel notch (100 px) zooms by about a fifth; a touchpad's small steps zoom smoothly
const WHEEL_ZOOM_RATE = 0.0018;

/** The zoom after a Ctrl+wheel turn; deltaMode 1 counts lines and 2 pages, as WheelEvent does. */
export function wheelZoom(level: number, deltaY: number, deltaMode: number, maximum: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  if (!Number.isFinite(pixels) || pixels === 0) return clampZoom(level, maximum);
  return clampZoom(level * Math.exp(-pixels * WHEEL_ZOOM_RATE), maximum);
}

/**
 * Where to scroll so the time under the pointer stays under it after a zoom. The track starts
 * trackOffset px into the scrolled content and is trackWidth px wide once zoomed; ratio is how far
 * along the track the pointer was, and pointerX is the pointer's distance from the frame's left edge.
 */
export function pointerAnchoredScroll(
  trackOffset: number,
  trackWidth: number,
  ratio: number,
  pointerX: number,
  viewportWidth: number,
  contentWidth: number,
): number {
  const maximum = Math.max(0, contentWidth - viewportWidth);
  const wanted = trackOffset + Math.min(1, Math.max(0, ratio)) * trackWidth - pointerX;
  return Math.min(maximum, Math.max(0, Number.isFinite(wanted) ? wanted : 0));
}

/** The first and last tick indexes worth drawing between two times, one step past each side. */
export function rulerTickRange(
  duration: number,
  step: number,
  visibleStart: number,
  visibleEnd: number,
): { first: number; last: number } {
  const lastTick = Math.floor(duration / step + 1e-6);
  if (!(step > 0) || !(duration > 0)) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(visibleStart / step) - 1);
  const last = Math.min(lastTick, Math.ceil(visibleEnd / step) + 1);
  return { first, last };
}

// "2.5 seconds", "7 min 30 s", "1 h 05 min", for the zoom slider's spoken value
export function visibleSpanText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) {
    const rounded = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds);
    return `${rounded} ${rounded === 1 ? "second" : "seconds"}`;
  }
  const total = Math.round(seconds);
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes ? `${hours} h ${String(minutes).padStart(2, "0")} min` : `${hours} h`;
}

export function anchorScrollLeft(
  viewportWidth: unknown,
  contentWidth: unknown,
  anchorRatio: unknown,
): number {
  const viewport = Math.max(0, Number(viewportWidth) || 0);
  const content = Math.max(0, Number(contentWidth) || 0);
  const ratio = Math.min(1, Math.max(0, Number(anchorRatio) || 0));
  const maximum = Math.max(0, content - viewport);
  return Math.min(maximum, Math.max(0, content * ratio - viewport / 2));
}

export function rulerStep(duration: unknown, pixelsPerSecond: unknown): number {
  const pps = Number(pixelsPerSecond);
  if (Number.isFinite(pps) && pps > 0) {
    const desiredSeconds = 32 / pps;
    for (let index = 0; index < RULER_STEPS.length; index += 1) {
      const step = RULER_STEPS[index];
      if (step !== undefined && step >= desiredSeconds) return step;
    }
    return RULER_STEPS[RULER_STEPS.length - 1] ?? 600;
  }

  const full = Math.max(0, Number(duration) || 0);
  if (full <= 30) return 2;
  if (full <= 90) return 5;
  if (full <= 180) return 10;
  if (full <= 420) return 15;
  return 30;
}

// labels only land on round seconds, so a ruler never reads 0:02, 0:05, 0:07
const RULER_LABEL_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600] as const;

/** How many ticks apart the labelled ticks are: at least 170 px, on a round number of seconds. */
export function rulerMajorEvery(
  step: unknown,
  pixelsPerSecond: unknown,
): number {
  const minor = Number(step);
  const pps = Number(pixelsPerSecond);
  if (!Number.isFinite(minor) || minor <= 0) return 1;
  if (!Number.isFinite(pps) || pps <= 0) return 5;
  const wanted = 170 / pps;
  const fits = (seconds: number): boolean =>
    seconds >= minor && Math.abs(seconds / minor - Math.round(seconds / minor)) < 1e-6;
  const label =
    RULER_LABEL_STEPS.find((seconds) => seconds >= wanted && fits(seconds)) ??
    [...RULER_LABEL_STEPS].reverse().find(fits) ??
    minor;
  return Math.max(1, Math.round(label / minor));
}

export function editKeyIntent(
  target: EditKeyTarget | null | undefined,
  key: string,
  largeStep: boolean,
): EditKeyIntent | null {
  const direction = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (!direction || !target) return null;
  const delta = (largeStep ? 0.1 : 0.01) * direction;
  if (
    target.classList &&
    typeof target.classList.contains === "function" &&
    target.classList.contains("tl-segment")
  ) {
    return {
      type: "segment",
      index: parseInt(String(target.dataset?.segmentIndex), 10),
      delta: delta,
      snap: false,
    };
  }
  if (target.id === "tl-in" || target.id === "tl-out") {
    return {
      type: "trim",
      endpoint: target.id === "tl-in" ? "start" : "end",
      delta: delta,
      snap: false,
    };
  }
  return null;
}

export function segmentPresentationState(
  index: number,
  activeIndex: number,
): { className: string } {
  return {
    className: "tl-segment" + (index === activeIndex ? " active" : ""),
  };
}

export function clipFill(
  kind: string,
  selected: boolean,
  muted: boolean,
  segmentColor?: string | null,
): string {
  if (muted) return "var(--raised)";
  if (kind === "source") return "var(--audio-clip-fill)";
  if (kind === "imported") return segmentColor || "var(--audio-clip-fill)";
  return selected ? "var(--seg-fill-active)" : segmentColor || "var(--seg-fill)";
}

export function videoSegmentSelected(
  index: number,
  activeIndex: number,
  sourceGroupSelected: unknown,
): boolean {
  return index === activeIndex && !!sourceGroupSelected;
}

// the playhead moves every display frame while playing; a custom property on its layer made
// WebKitGTK restyle the whole layer each frame and keep that style data, so memory grew for as
// long as a video played. Rounding lets an unchanged position skip the write
export function placePlayhead(playhead: { style: { left: string } } | null, percent: number): void {
  if (!playhead) return;
  // a deep zoom makes the track a million pixels wide, so the position keeps a hundredth of a pixel
  const left = Math.round(percent * 1e6) / 1e6 + "%";
  if (playhead.style.left !== left) playhead.style.left = left;
}
