import type { DataPayload, JsonObject } from "./types.ts";

export interface MediaTime extends JsonObject {
  readonly ticks: string;
  readonly time_base_num: number;
  readonly time_base_den: number;
}
export interface CutRange extends JsonObject {
  readonly start: MediaTime;
  readonly end: MediaTime;
  readonly timeline_start?: MediaTime;
}
export interface CutPlanRequest extends JsonObject {
  readonly operation: "cut";
  readonly source: string;
  readonly segments: readonly CutRange[];
  readonly precision?: "keyframes" | "exact";
  readonly include_audio?: boolean;
  readonly output_dir?: string;
  readonly output_name?: string;
  readonly _request_id?: number;
}
export interface CutIssue extends JsonObject {
  readonly code: string;
  readonly message: string;
  readonly field: string | null;
}
export interface CutEnqueueRequest extends CutPlanRequest {
  readonly plan_fingerprint: string;
}
export interface CutSegment extends JsonObject {
  readonly requested: CutRange;
  readonly resolved: CutRange;
  readonly start_kind: "at_start" | "keyframe" | "moved" | "exact" | "collapsed";
  readonly end_frames_moved: number;
  readonly audio_source: CutRange | null;
  readonly audio_output: CutRange | null;
  readonly audio_packet_count: number;
  // in Exact plans, the copied part between encoded edges, or null when all of it is encoded
  readonly copied: CutRange | null;
}
export interface CutTrack extends JsonObject {
  readonly index: number;
  readonly kind: string;
  readonly codec: string;
  readonly keep: boolean;
  readonly reason: string;
}
export interface CutPlanPreview extends JsonObject {
  readonly operation: "cut";
  readonly precision: "keyframes" | "exact";
  // the output keeps the source container, named by its extension
  readonly container: string;
  readonly include_audio: boolean;
  readonly output_path: string;
  readonly exported_duration: MediaTime;
  readonly estimated_bytes: number;
  readonly fingerprint: string;
  readonly issues: readonly CutIssue[];
  readonly exact_available: boolean;
  readonly exact_reason: string;
  // checks Tuck cannot make for this file; the export still goes ahead
  readonly unverified: readonly CutIssue[];
  readonly tracks: readonly CutTrack[];
  readonly chapter_count: number;
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
  // one page of keyframes, starting at `keyframes_from` in the list `keyframes_revision` names;
  // the backend sends what the poller lacks, and `mergeKeyframePage` puts the list back together
  readonly keyframes: readonly MediaTime[];
  readonly keyframes_revision?: number;
  readonly keyframes_from?: number;
  readonly keyframe_count?: number;
  readonly issue: CutIssue | null;
  readonly analysis: CutAnalysisSummary | null;
}
// how much of which keyframe list the poller already holds
export interface KeyframeCursor {
  readonly revision: number;
  readonly from: number;
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
    && (value.copied === null || range(value.copied))
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
function track(value: unknown): value is CutTrack {
  return (
    object(value)
    && integer(value.index)
    && typeof value.kind === "string"
    && typeof value.codec === "string"
    && typeof value.keep === "boolean"
    && typeof value.reason === "string"
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
    && (value.keyframes_revision === undefined || integer(value.keyframes_revision))
    && (value.keyframes_from === undefined || integer(value.keyframes_from))
    && (value.keyframe_count === undefined || (
      integer(value.keyframe_count)
      && value.keyframe_count >= (integer(value.keyframes_from) ? value.keyframes_from : 0) + value.keyframes.length
    ))
    && (value.issue === null || issue(value.issue))
    && (value.analysis === null || summary(value.analysis))
    && (value.status !== "ready" || summary(value.analysis))
  );
}
/**
 * Joins a page of keyframes onto the list already held. The result holds the whole list from
 * the start, so the timeline reads it like a single answer. A page for another scan or a
 * replaced list starts over from what the page carries.
 */
export function mergeKeyframePage(
  held: CutAnalysisPayload | null | undefined,
  page: CutAnalysisPayload,
): CutAnalysisPayload {
  const from = page.keyframes_from ?? 0;
  const sameList = !!held && held.work_id === page.work_id
    && held.keyframes_revision !== undefined && held.keyframes_revision === page.keyframes_revision;
  const base = sameList && from <= held.keyframes.length ? held.keyframes.slice(0, from) : null;
  // a page that starts past what is held cannot be joined; the next read asks from the start
  const keyframes = base ? base.concat(page.keyframes) : from === 0 ? page.keyframes : [];
  return {...page, keyframes, keyframes_from: 0};
}

// where the next status read should start, or nothing when the list came without a revision
export function keyframeCursor(analysis: CutAnalysisPayload | null | undefined): KeyframeCursor | undefined {
  if (analysis?.keyframes_revision === undefined) return undefined;
  return {revision: analysis.keyframes_revision, from: analysis.keyframes.length};
}

/**
 * Whether to read the next page straight away: the backend holds more keyframes and the last
 * page added some. A page that adds nothing means the cursor did not reach the backend, so the
 * list read so far stands rather than asking for the same page forever.
 */
export function moreKeyframesToRead(
  held: CutAnalysisPayload | null | undefined,
  merged: CutAnalysisPayload,
): boolean {
  if (merged.keyframe_count === undefined || merged.keyframes.length >= merged.keyframe_count) return false;
  const sameList = !!held && held.work_id === merged.work_id && held.keyframes_revision === merged.keyframes_revision;
  return merged.keyframes.length > (sameList && held ? held.keyframes.length : 0);
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
    && typeof plan.container === "string"
    && /^[a-z0-9]+$/.test(plan.container)
    && typeof plan.include_audio === "boolean"
    && typeof plan.output_path === "string"
    && isMediaTime(plan.exported_duration)
    && integer(plan.estimated_bytes)
    && typeof plan.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(plan.fingerprint)
    && issues(plan.issues)
    && typeof plan.exact_available === "boolean"
    && typeof plan.exact_reason === "string"
    && issues(plan.unverified)
    && Array.isArray(plan.tracks)
    && plan.tracks.every(track)
    && integer(plan.chapter_count)
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
