import type { TimeFormat } from "../../backend/types.ts";
import { formatTime } from "./format.ts";

export const TIME_FORMATS: readonly TimeFormat[] = ["seconds", "timecode", "frames"];

export function timeFormat(value: unknown): TimeFormat {
  return TIME_FORMATS.includes(value as TimeFormat) ? (value as TimeFormat) : "seconds";
}

function frameRate(fps: number | undefined): number {
  return fps && Number.isFinite(fps) && fps > 0 ? fps : 30;
}

// the frame shown at this time; the small allowance keeps 1/30 s from reading as frame 0
function frameIndex(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-4);
}

/**
 * A precise time for the player and timeline: 1:03.40, 00:01:03:12, or 1902 f.
 * Frames and timecode use the video's frame rate, or 30 when it isn't known yet.
 */
export function formatClockTime(seconds: number, format: TimeFormat, fps?: number): string {
  const value = Math.max(0, Number(seconds) || 0);
  const rate = frameRate(fps);
  if (format === "frames") return `${frameIndex(value, rate)} f`;
  if (format === "timecode") {
    // non-drop-frame: the frame number is counted out in whole-second groups of the nominal
    // rate, so 29.97 fps counts 30 frames per timecode second like other editors
    const nominal = Math.max(1, Math.round(rate));
    const frames = frameIndex(value, rate);
    const pad = (part: number): string => String(part).padStart(2, "0");
    const totalSeconds = Math.floor(frames / nominal);
    return [
      pad(Math.floor(totalSeconds / 3600)),
      pad(Math.floor(totalSeconds / 60) % 60),
      pad(totalSeconds % 60),
      pad(frames % nominal),
    ].join(":");
  }
  const centiseconds = Math.round(value * 100);
  return `${formatTime(Math.floor(centiseconds / 100))}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * When something last happened, in local time: "today at 14:05", "yesterday at 9:30", or
 * "on Oct 3 at 14:05". Empty for a stored value that isn't a time, so callers can say "never".
 */
export function checkedAtText(value: unknown, now: Date = new Date(), locale?: string): string {
  // Python saves an ISO time; Date would read loose text such as "1" as a year
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "";
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return "";
  const time = moment.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(moment, now)) return `today at ${time}`;
  if (sameDay(moment, yesterday)) return `yesterday at ${time}`;
  const date = moment.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(moment.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `on ${date} at ${time}`;
}
