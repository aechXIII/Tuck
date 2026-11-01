import { isSoftwareEncoder } from "./encoder-options.ts";

/** What a Compress export aims for: a file size, or a quality level the encoder keeps. */
export type ExportGoal = "size" | "quality";

export type QualityMethod = "CRF" | "CQ";

// the slider's ends; levels outside them can still be typed or come from a profile
export const QUALITY_SLIDER_MIN = 10;
export const QUALITY_SLIDER_MAX = 45;

/**
 * CRF in software, CQ on a GPU. Auto best compression tries the CPU first; the other Auto
 * choices try the GPU first, and the runner turns one into the other when they fall back.
 * Python's `quality_method_for_encoder` makes the same choice for the command line.
 */
export function qualityMethod(encoder: string): QualityMethod {
  return isSoftwareEncoder(encoder) || encoder === "auto_compression" ? "CRF" : "CQ";
}

function isHevc(encoder: string): boolean {
  return encoder === "libx265" || encoder.startsWith("hevc_");
}

/** Where a level starts for an encoder: H.265 reaches the same look at a higher number. */
export function defaultQualityLevel(encoder: string): number {
  return isHevc(encoder) ? 28 : 23;
}

/** Quick picks in slider order: lower levels look better, and better is to the right. */
export function qualityPicks(encoder: string): number[] {
  return isHevc(encoder) ? [32, 28, 24, 20] : [33, 28, 23, 18];
}

/** The slider runs right for a better picture, the way Size runs right for a bigger file. */
export function qualitySliderValue(level: number): number {
  const clamped = Math.min(QUALITY_SLIDER_MAX, Math.max(QUALITY_SLIDER_MIN, level));
  return QUALITY_SLIDER_MIN + QUALITY_SLIDER_MAX - clamped;
}

export function qualityFromSlider(value: number): number {
  return QUALITY_SLIDER_MIN + QUALITY_SLIDER_MAX - Math.round(value);
}

export function clampQuality(level: number): number {
  return Math.min(51, Math.max(0, Math.round(level)));
}

export function qualityText(encoder: string, level: number): string {
  return `${qualityMethod(encoder)} ${level}`;
}

export interface TypedGoal {
  readonly goal: ExportGoal | "bitrate" | null;
  readonly value: number;
}

/** A unit typed with the number picks the goal: "crf 20", "cq 24", "25mb" or "8 mbps". */
export function parseTypedGoal(text: string): TypedGoal {
  const typed = text.trim().toLowerCase().replace(",", ".");
  const match = /\d+(\.\d+)?|\.\d+/.exec(typed);
  const value = match ? Number(match[0]) : NaN;
  if (/mbps|mbit|mb\/s/.test(typed)) return { goal: "bitrate", value };
  if (/mb|m\b/.test(typed)) return { goal: "size", value };
  if (/crf|cq|qp/.test(typed)) return { goal: "quality", value };
  return { goal: null, value };
}

/**
 * The size that gives a video bitrate. With a plan for a size it scales from that plan, so the
 * planner's margins come along and it lands within a few percent; a Quality plan has no bitrate,
 * so the size comes from the duration alone. The card then shows the bitrate the new plan gives.
 */
export function sizeForBitrate(
  mbps: number,
  plan: {
    readonly targetSizeMb: number;
    readonly videoKbps: number;
    readonly audioKbps: number;
    readonly durationS: number;
  },
): number | null {
  if (!(mbps > 0)) return null;
  const wanted = mbps * 1000 + Math.max(0, plan.audioKbps);
  const now = plan.videoKbps + Math.max(0, plan.audioKbps);
  if (plan.videoKbps > 0 && plan.targetSizeMb > 0) {
    return Math.max(2, Math.round((plan.targetSizeMb * wanted) / now));
  }
  if (!(plan.durationS > 0)) return null;
  return Math.max(2, Math.round((wanted * 1000 * plan.durationS) / 8 / (1024 * 1024)));
}

/** "1.1 Mbps", "850 kbps": the bitrate a size works out to, for the card's detail line. */
export function bitrateText(kbps: number): string {
  if (!(kbps > 0)) return "";
  if (kbps < 1000) return `${Math.round(kbps)} kbps`;
  const mbps = kbps / 1000;
  return `${mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10} Mbps`;
}
