// Save as GIF's settings as the dialog holds them, and the words it shows for a preview
import type { GifPreviewPayload, GifSettingsPayload } from "../../backend/gif-types.ts";
import type { JsonObject } from "../../backend/types.ts";

const MB = 1024 * 1024;

export interface GifChoices {
  width: number;
  fps: number;
  colors: number;
  speed: number;
  backAndForth: boolean;
  /** how many times it plays; 0 is forever */
  plays: number;
  /** MB; 0 sets no limit */
  limit: number;
  dither: "soft" | "pattern" | "off";
  palette: "whole" | "frame";
  sharp: boolean;
  dropRepeats: boolean;
}

export const GIF_DEFAULTS: Readonly<GifChoices> = Object.freeze({
  width: 480,
  fps: 15,
  colors: 256,
  speed: 1,
  backAndForth: false,
  plays: 0,
  limit: 0,
  dither: "soft",
  palette: "whole",
  sharp: false,
  dropRepeats: false,
});

/** The rows that take any number in their last cell, with the range a GIF allows. */
export type NumberChoice = "width" | "fps" | "colors" | "speed" | "plays" | "limit";

interface Range {
  readonly low: number;
  readonly high: number;
  readonly over: string;
  readonly under: string;
  readonly whole: boolean;
}

const RANGES: Readonly<Record<NumberChoice, Range>> = {
  width: { low: 16, high: 3840, over: "Up to 3840 wide.", under: "At least 16 wide.", whole: true },
  fps: { low: 1, high: 50, over: "A GIF plays at most 50 fps.", under: "At least 1 fps.", whole: false },
  colors: { low: 2, high: 256, over: "A GIF has at most 256 colors.", under: "At least 2 colors.", whole: true },
  speed: { low: 0.25, high: 4, over: "Up to 4×.", under: "At least 0.25×.", whole: false },
  plays: { low: 2, high: 100, over: "Up to 100 times.", under: "At least 2 times.", whole: true },
  limit: { low: 0.1, high: 4096, over: "Up to 4096 MB.", under: "At least 0.1 MB.", whole: false },
};

/** A typed value brought into the range a GIF allows, and why when it was moved. */
export function customValue(key: NumberChoice, raw: string): { value: number; note: string } | null {
  const typed = Number(raw.trim().replace(",", "."));
  if (!raw.trim() || !Number.isFinite(typed)) return null;
  const range = RANGES[key];
  let value = range.whole ? Math.round(typed) : Math.round(typed * 100) / 100;
  let note = "";
  if (value > range.high) { value = range.high; note = range.over; }
  else if (value < range.low) { value = range.low; note = range.under; }
  if (key === "width") value = Math.max(16, Math.round(value / 2) * 2);
  return { value, note };
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && (choices as readonly string[]).includes(value) ? value as T : fallback;
}

/** The settings last saved with, or the defaults for anything missing or out of range. */
export function savedChoices(saved: JsonObject | undefined): GifChoices {
  if (!saved) return { ...GIF_DEFAULTS };
  const clamp = (key: NumberChoice, value: number, fallback: number): number => {
    const range = RANGES[key];
    return value >= range.low && value <= range.high ? value : fallback;
  };
  const plays = number(saved.plays, 0);
  const limit = number(saved.size_limit, 0) / MB;
  return {
    width: clamp("width", number(saved.width, GIF_DEFAULTS.width), GIF_DEFAULTS.width),
    fps: clamp("fps", number(saved.fps, GIF_DEFAULTS.fps), GIF_DEFAULTS.fps),
    colors: clamp("colors", number(saved.colors, GIF_DEFAULTS.colors), GIF_DEFAULTS.colors),
    speed: clamp("speed", number(saved.speed, GIF_DEFAULTS.speed), GIF_DEFAULTS.speed),
    backAndForth: saved.back_and_forth === true,
    plays: plays === 1 ? 1 : clamp("plays", plays, 0),
    limit: limit ? clamp("limit", Math.round(limit * 100) / 100, 0) : 0,
    dither: oneOf(saved.dither, ["soft", "pattern", "off"] as const, "soft"),
    palette: oneOf(saved.palette, ["whole", "frame"] as const, "whole"),
    sharp: saved.sharp_pixels === true,
    dropRepeats: saved.drop_repeated_frames === true,
  };
}

export function gifSettingsPayload(choices: GifChoices): GifSettingsPayload {
  return {
    width: choices.width,
    fps: choices.fps,
    colors: choices.colors,
    speed: choices.speed,
    back_and_forth: choices.backAndForth,
    plays: choices.plays,
    size_limit: choices.limit ? Math.round(choices.limit * MB) : 0,
    dither: choices.dither,
    palette: choices.palette,
    sharp_pixels: choices.sharp,
    drop_repeated_frames: choices.dropRepeats,
  };
}

/** The big number and its unit, as the Export card's size estimate shows them. */
export function sizeParts(bytes: number): [string, string] {
  if (bytes >= MB) {
    const mb = bytes / MB;
    return [mb >= 10 ? mb.toFixed(0) : mb.toFixed(1), "MB"];
  }
  return [String(Math.max(1, Math.round(bytes / 1024))), "KB"];
}

export function formatLength(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function formatMb(mb: number): string {
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export interface GifResultText {
  /** "Timeline · 2.4 s": what the GIF is made of */
  readonly from: string;
  /** the picture's size, rate and frames, or what a size limit changed */
  readonly detail: string;
  readonly warn: boolean;
}

/** The lines under the size for a finished preview. */
export function gifResultText(preview: GifPreviewPayload, choices: GifChoices): GifResultText {
  // the timeline plays for the GIF's length at 1×, forward once
  const timeline = preview.seconds * choices.speed / (choices.backAndForth ? 2 : 1);
  const from = `Timeline · ${formatLength(timeline)}`;
  if (choices.limit && !preview.fits) {
    return { from, detail: `Can’t fit ${formatMb(choices.limit)}. Try fewer colors or a shorter timeline.`, warn: true };
  }
  if (preview.lowered) {
    const changes = [
      preview.fps < preview.start_fps ? `${preview.fps} fps` : "",
      preview.width < preview.start_width ? `${preview.width} wide` : "",
    ].filter(Boolean).join(" and ");
    return { from, detail: `Lowered to ${changes} to fit ${formatMb(choices.limit)}`, warn: false };
  }
  const plays = Math.abs(preview.seconds - timeline) > 0.05 ? ` · plays ${formatLength(preview.seconds)}` : "";
  return {
    from,
    detail: `${preview.width} × ${preview.height} · ${preview.fps} fps · ${preview.frames} frames${plays}`,
    warn: false,
  };
}
