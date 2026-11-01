import type { JsonObject } from "./types.ts";

/** About how big a Quality export will be, from a few short pieces encoded with its settings. */
export interface SizeEstimatePayload extends JsonObject {
  readonly size_bytes: number;
  readonly video_bytes: number;
  readonly audio_bytes: number;
  /** the seconds of video that were encoded; the whole export when it is that short */
  readonly sampled_seconds: number;
  /** the encoder that ran, after Auto picked one */
  readonly encoder: string;
}

export interface SizeEstimateCancellation extends JsonObject {
  readonly cancelled: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isSizeEstimatePayload(value: unknown): value is SizeEstimatePayload {
  return record(value)
    && count(value.size_bytes) && count(value.video_bytes) && count(value.audio_bytes)
    && count(value.sampled_seconds) && typeof value.encoder === "string";
}

export function isSizeEstimateCancellation(value: unknown): value is SizeEstimateCancellation {
  return record(value) && typeof value.cancelled === "boolean";
}
