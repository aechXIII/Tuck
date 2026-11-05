// Max bitrate, 10-bit color and Keyframe every: when each applies and what it says when it can't.
// Python checks the same rules when it plans, so these only decide what the rows show.

import type { ExportGoal } from "./goal.ts";
import type { RateControlDisplay, Workflow } from "./encoder-options.ts";

export const KEYFRAME_CHOICES: readonly number[] = [0, 1, 2, 5, 10];
export const MAX_BITRATE_MIN_MBPS = 0.1;
export const MAX_BITRATE_MAX_MBPS = 1000;

const HEVC_ENCODERS = new Set(["libx265", "hevc_nvenc", "hevc_amf", "hevc_vaapi"]);
// AMD and Intel keep a quality level with constant QP, which has no peak; Auto moves past them
const CAPPING_ENCODERS = new Set(["libx264", "libx265", "h264_nvenc", "hevc_nvenc"]);

export function keyframeLabel(seconds: number): string {
  if (!(seconds > 0)) return "Auto";
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

export interface RowState {
  enabled: boolean;
  /** shown in the field while it's empty or can't be used */
  placeholder: string;
  /** why the row can't be used, under it; empty when it can */
  note: string;
}

export function maxBitrateRow(state: {
  workflow: Workflow;
  goal: ExportGoal;
  rateControl: RateControlDisplay;
  encoder: string;
}): RowState {
  // a size or bitrate goal already sets the bitrate
  if (state.workflow === "compression" && state.goal !== "quality") {
    return { enabled: false, placeholder: "Set by Size", note: "" };
  }
  if (state.workflow === "upscale" && (state.rateControl === "CBR" || state.rateControl === "VBR")) {
    return { enabled: false, placeholder: "Set by Bitrate", note: "" };
  }
  if (!state.encoder.startsWith("auto") && !CAPPING_ENCODERS.has(state.encoder)) {
    return { enabled: false, placeholder: "No limit", note: "Needs software or NVIDIA." };
  }
  return { enabled: true, placeholder: "No limit", note: "" };
}

/** support: what the encoder answered when asked, or undefined before it's been asked. */
export function tenBitRow(encoder: string, support: boolean | undefined): RowState {
  // Auto starts on H.264, and almost nothing plays 10-bit H.264
  if (!HEVC_ENCODERS.has(encoder)) return { enabled: false, placeholder: "", note: "10-bit needs H.265." };
  if (support === false) {
    return {
      enabled: false,
      placeholder: "",
      // Tuck's Linux FFmpeg has the 8-bit x265 only
      note: encoder === "libx265" ? "10-bit needs a GPU encoder here." : "This encoder can't make 10-bit.",
    };
  }
  return { enabled: true, placeholder: "", note: "" };
}

/** The typed cap in Mbps, or 0 for none or anything that isn't a usable number. */
export function parseMaxBitrate(text: string): number {
  const value = Number(String(text).trim().replace(",", "."));
  if (!text.trim() || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_BITRATE_MAX_MBPS, Math.max(MAX_BITRATE_MIN_MBPS, Math.round(value * 10) / 10));
}

export function formatMbps(mbps: number): string {
  return mbps > 0 ? String(Math.round(mbps * 10) / 10) : "";
}
