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

export function rulerMajorEvery(
  step: unknown,
  pixelsPerSecond: unknown,
): number {
  const minor = Number(step);
  const pps = Number(pixelsPerSecond);
  if (!Number.isFinite(minor) || minor <= 0) return 1;
  if (!Number.isFinite(pps) || pps <= 0) return 5;
  return Math.max(1, Math.ceil(170 / (minor * pps)));
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
  if (muted) return "#22222B";
  if (kind === "source") return "#4C3A86";
  if (kind === "imported") return segmentColor || "#115E56";
  return selected ? "#6D28D9" : segmentColor || "#6D28D9";
}

export function videoSegmentSelected(
  index: number,
  activeIndex: number,
  sourceGroupSelected: unknown,
): boolean {
  return index === activeIndex && !!sourceGroupSelected;
}
