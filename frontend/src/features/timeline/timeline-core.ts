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

export function clampZoom(level: unknown): number {
  const numeric = Number(level);
  if (!Number.isFinite(numeric)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, numeric));
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
  const left = Math.round(percent * 1000) / 1000 + "%";
  if (playhead.style.left !== left) playhead.style.left = left;
}
