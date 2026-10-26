import type { JsonObject } from "./types.ts";

export type JoinState = "running" | "done" | "failed" | "cancelled" | "missing";
export type JoinStage = "checking" | "copying" | "encoding" | "saving" | "";

/** Where a join of Library videos stands, as the backend measured it. */
export interface JoinStatus extends JsonObject {
  readonly work_id: string;
  readonly status: JoinState;
  readonly stage: JoinStage;
  /** the measured share of copying or encoding, or null while it can't be measured */
  readonly progress: number | null;
  readonly output_path: string;
  /** whether the streams were copied as they are; null until the videos are checked */
  readonly lossless: boolean | null;
  /** why the videos had to be re-encoded, e.g. "the picture sizes differ (...)" */
  readonly reason: string;
  readonly encoder: string;
  /** set when the first choice of encoder couldn't be used */
  readonly fallback: string;
  readonly code: string;
  readonly message: string;
}

export interface JoinCancellation extends JsonObject {
  readonly cancelled: boolean;
}

const STATES = new Set(["running", "done", "failed", "cancelled", "missing"]);
const STAGES = new Set(["checking", "copying", "encoding", "saving", ""]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJoinStatus(value: unknown): value is JoinStatus {
  if (!record(value)) return false;
  const progress = value.progress;
  return typeof value.work_id === "string"
    && typeof value.status === "string" && STATES.has(value.status)
    && typeof value.stage === "string" && STAGES.has(value.stage)
    && (progress === null || typeof progress === "number" && progress >= 0 && progress <= 1)
    && typeof value.output_path === "string"
    && (value.lossless === null || typeof value.lossless === "boolean")
    && ["reason", "encoder", "fallback", "code", "message"].every(key => typeof value[key] === "string")
    // a finished join always names its file
    && (value.status !== "done" || value.output_path.length > 0);
}

export function isJoinCancellation(value: unknown): value is JoinCancellation {
  return record(value) && typeof value.cancelled === "boolean";
}
