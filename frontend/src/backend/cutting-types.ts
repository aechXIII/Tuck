import type { DataPayload, JsonObject } from "./types.ts";

export interface MediaTime extends JsonObject {
  readonly ticks: string;
  readonly time_base_num: number;
  readonly time_base_den: number;
}
export interface CutRange extends JsonObject {
  readonly start: MediaTime;
  readonly end: MediaTime;
}
export interface CutPlanRequest extends JsonObject {
  readonly operation: "cut";
  readonly source: string;
  readonly segments: readonly CutRange[];
  readonly precision?: "keyframes" | "exact";
  readonly include_audio?: boolean;
  readonly edits?: readonly string[];
  readonly without_edits?: boolean;
  readonly output_dir?: string;
  readonly output_name?: string;
  readonly _request_id?: number;
}
export interface CutIssue extends JsonObject {
  readonly code: string;
  readonly message: string;
  readonly field: string | null;
}
export interface CutSegment extends JsonObject {
  readonly requested: CutRange;
  readonly resolved: CutRange;
  readonly start_kind: "at_start" | "keyframe" | "moved" | "exact" | "collapsed";
  readonly end_frames_moved: number;
  readonly audio_source: CutRange | null;
  readonly audio_output: CutRange | null;
  readonly audio_packet_count: number;
}
export interface CutPlanPreview extends JsonObject {
  readonly operation: "cut";
  readonly precision: "keyframes" | "exact";
  readonly container: "mp4";
  readonly include_audio: boolean;
  readonly output_path: string;
  readonly exported_duration: MediaTime;
  readonly estimated_bytes: number;
  readonly fingerprint: string;
  readonly issues: readonly CutIssue[];
  readonly exact_available: boolean;
  readonly exact_reason: string;
  readonly segments: readonly CutSegment[];
  readonly source_identity: {
    readonly path: string;
    readonly size: number;
    readonly mtime_ns: string;
    readonly signature: string;
  };
}
export interface CutPlanPayload extends DataPayload {
  readonly data: CutPlanPreview;
}
export interface CutStream extends JsonObject {
  readonly index: number;
  readonly kind: string;
  readonly codec: string;
  readonly properties: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly dispositions: readonly string[];
}
export interface CutAnalysisSummary extends JsonObject {
  readonly duration: MediaTime;
  readonly frame_duration: MediaTime;
  readonly exact_available: boolean;
  readonly exact_reason: string;
  readonly issues: readonly CutIssue[];
  readonly version: string;
  readonly streams: readonly CutStream[];
}
export interface CutAnalysisPayload extends JsonObject {
  readonly work_id: string;
  readonly status: "missing" | "pending" | "reading" | "ready" | "cancelled" | "failed";
  readonly progress: number | null;
  readonly coverage_end: MediaTime;
  readonly keyframes: readonly MediaTime[];
  readonly issue: CutIssue | null;
  readonly analysis: CutAnalysisSummary | null;
}
export interface CutCancellation extends JsonObject {
  readonly cancelled: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function strings(value: unknown): boolean {
  return object(value) && Object.values(value).every(v => typeof v === "string");
}
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
export function isMediaTime(value: unknown): value is MediaTime {
  if (!object(value) || typeof value.ticks !== "string" || !/^-?\d{1,19}$/.test(value.ticks)) return false;
  const ticks = BigInt(value.ticks);
  return (
    ticks > -(2n ** 63n)
    && ticks < 2n ** 63n
    && integer(value.time_base_num)
    && value.time_base_num > 0
    && value.time_base_num < 2 ** 31
    && integer(value.time_base_den)
    && value.time_base_den > 0
    && value.time_base_den < 2 ** 31
  );
}
function range(value: unknown): value is CutRange {
  return object(value) && isMediaTime(value.start) && isMediaTime(value.end);
}
function issue(value: unknown): value is CutIssue {
  return (
    object(value)
    && typeof value.code === "string"
    && typeof value.message === "string"
    && (value.field === null || typeof value.field === "string")
  );
}
function issues(value: unknown): value is readonly CutIssue[] {
  return Array.isArray(value) && value.every(issue);
}
function segment(value: unknown): value is CutSegment {
  return (
    object(value)
    && range(value.requested)
    && range(value.resolved)
    && oneOf(value.start_kind, ["at_start", "keyframe", "moved", "exact", "collapsed"])
    && integer(value.end_frames_moved)
    && integer(value.audio_packet_count)
    && (value.audio_source === null || range(value.audio_source))
    && (value.audio_output === null || range(value.audio_output))
  );
}
function stream(value: unknown): value is CutStream {
  return (
    object(value)
    && integer(value.index)
    && typeof value.kind === "string"
    && typeof value.codec === "string"
    && strings(value.properties)
    && strings(value.metadata)
    && Array.isArray(value.dispositions)
    && value.dispositions.every(v => typeof v === "string")
  );
}
function summary(value: unknown): value is CutAnalysisSummary {
  return (
    object(value)
    && isMediaTime(value.duration)
    && isMediaTime(value.frame_duration)
    && typeof value.exact_available === "boolean"
    && typeof value.exact_reason === "string"
    && issues(value.issues)
    && typeof value.version === "string"
    && Array.isArray(value.streams)
    && value.streams.every(stream)
  );
}
export function isCutAnalysisPayload(value: unknown): value is CutAnalysisPayload {
  return (
    object(value)
    && typeof value.work_id === "string"
    && oneOf(value.status, ["missing", "pending", "reading", "ready", "cancelled", "failed"])
    && (value.progress === null || (
      typeof value.progress === "number"
      && Number.isFinite(value.progress)
      && value.progress >= 0
      && value.progress <= 1
    ))
    && isMediaTime(value.coverage_end)
    && Array.isArray(value.keyframes)
    && value.keyframes.every(isMediaTime)
    && (value.issue === null || issue(value.issue))
    && (value.analysis === null || summary(value.analysis))
    && (value.status !== "ready" || summary(value.analysis))
  );
}
export function isCutCancellation(value: unknown): value is CutCancellation {
  return object(value) && typeof value.cancelled === "boolean";
}
export function isCutPlanPayload(value: unknown): value is CutPlanPayload {
  if (!object(value) || !object(value.data) || value._request_id !== undefined && !integer(value._request_id)) return false;
  const plan = value.data;
  const identity = plan.source_identity;
  return (
    plan.operation === "cut"
    && oneOf(plan.precision, ["keyframes", "exact"])
    && plan.container === "mp4"
    && typeof plan.include_audio === "boolean"
    && typeof plan.output_path === "string"
    && isMediaTime(plan.exported_duration)
    && integer(plan.estimated_bytes)
    && typeof plan.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(plan.fingerprint)
    && issues(plan.issues)
    && typeof plan.exact_available === "boolean"
    && typeof plan.exact_reason === "string"
    && Array.isArray(plan.segments)
    && plan.segments.every(segment)
    && object(identity)
    && typeof identity.path === "string"
    && integer(identity.size)
    && typeof identity.mtime_ns === "string"
    && /^\d+$/.test(identity.mtime_ns)
    && typeof identity.signature === "string"
    && /^[a-f0-9]{64}$/.test(identity.signature)
  );
}
