import type { TaskbarProgressState } from "../../backend/types.ts";

// the states tuck/models QueueState sends; anything else is treated as unknown
export const QUEUE_ITEM_STATES = ["pending", "running", "completed", "failed", "cancelled", "paused"] as const;
export type QueueItemState = (typeof QUEUE_ITEM_STATES)[number];

export function queueItemState(value: unknown): QueueItemState | "" {
  return QUEUE_ITEM_STATES.find((state) => state === value) ?? "";
}

/** Waiting or running, so the same video should not be exported again yet. */
export function isQueueActive(state: QueueItemState | "" | undefined): boolean {
  return state === "pending" || state === "running";
}

/**
 * What a video in the queue says about its export: "Queued", "Exporting · 40%", or the step the
 * backend names, such as "Pass 1 of 2 · 12%" or "Second try · 4%".
 */
export function queuedVideoLabel(
  state: QueueItemState | "" | undefined,
  statusText: string | undefined,
  progress: number | undefined,
  indeterminate: boolean | undefined,
): string {
  if (state === "pending") return "Queued";
  if (state === "paused") return "Paused";
  const phase = (statusText || "").split(" · ")[0] || "";
  const label = phase && phase !== "Encoding" && phase !== "Pending" ? phase : "Exporting";
  const percent = Math.round(Math.max(0, Math.min(100, progress || 0)));
  return indeterminate || !percent ? label : `${label} · ${percent}%`;
}

export interface QueueItem {
  readonly id?: string;
  readonly source?: string;
  readonly source_path?: string;
  readonly state?: QueueItemState;
  readonly progress?: number;
  readonly progress_info?: {
    readonly speed?: number;
    // pictures a second, sent only while frames are blended
    readonly fps?: number | null;
    readonly eta_seconds?: number | null;
    readonly indeterminate?: boolean;
    readonly stage?: string;
    // set while a size retry starts and while its result is checked
    readonly retry_number?: number | null;
  };
  readonly status_text?: string;
  readonly result_path?: string;
  readonly finished_at?: string;
  readonly segment_count?: number;
  readonly duration?: number;
  readonly error?: string;
  readonly error_detail?: string;
  /** Why Auto finished on a different encoder, in plain words; empty when it didn't. */
  readonly encoder_fallback?: string;
  /** The size the export aimed for, in bytes; 0 when it had none. */
  readonly target_size?: number;
  /** Came back from before Tuck last closed, so no video in the Library stands for it. */
  readonly restored?: boolean;
  readonly [key: string]: unknown;
}

/** Queue items from the backend, with any state Tuck doesn't know left unset. */
export function queueItemsFromSnapshot(raw: readonly unknown[]): QueueItem[] {
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item: Record<string, unknown> = { ...entry };
    const state = queueItemState(item.state);
    if (state) item.state = state;
    else delete item.state;
    return [item as QueueItem];
  });
}

export interface QueueSnapshot {
  readonly items?: readonly QueueItem[];
}

export interface QueueViewState {
  /** True when the previous snapshot still had running/pending work. */
  readonly hadActive: boolean;
  /** Item ids seen running or pending since the last completed batch. */
  readonly activeItemIds: Readonly<Record<string, true>>;
  readonly runningItemId: string;
  /** Which try the running export is on; a size retry starts the next one from zero. */
  readonly attempt: number;
  readonly progress: number;
  readonly indeterminate: boolean;
  readonly barVisible: boolean;
  readonly active: boolean;
  readonly stopAfterDisabled: boolean;
  readonly cancelDisabled: boolean;
  readonly clearDisabled: boolean;
  /** Failed and canceled exports, which Retry all sends back to the queue. */
  readonly retryable: number;
  /** Exports brought back after Tuck closed mid-batch, waiting for Resume. */
  readonly paused: number;
  /** The export running now, how many exported once nothing is left, or how many are paused. */
  readonly fname: string;
  /** Nothing is running, waiting or paused, but finished exports are still listed. */
  readonly finished: boolean;
  /** How far the running export is, e.g. "42% · 1:23 left". */
  readonly detail: string;
  readonly waiting: number;
  readonly failed: number;
  /** Non-empty when a batch just finished and the toast should fire. */
  readonly finishedToast: BatchSummary | null;
  /** Result path to reveal when the automatic show-export setting is on. */
  readonly outputToOpen: string;
}

export function emptyQueueView(): QueueViewState {
  return {
    hadActive: false,
    activeItemIds: {},
    runningItemId: "",
    attempt: 1,
    progress: 0,
    indeterminate: false,
    barVisible: false,
    active: false,
    stopAfterDisabled: true,
    cancelDisabled: true,
    clearDisabled: true,
    retryable: 0,
    paused: 0,
    fname: "",
    finished: false,
    detail: "",
    waiting: 0,
    failed: 0,
    finishedToast: null,
    outputToOpen: "",
  };
}

export interface BatchSummary {
  readonly message: string;
  readonly kind: "ok" | "err" | "info";
  /** Failed items of this batch, first one first, so the toast can show them. */
  readonly failedIds: readonly string[];
}

function itemName(item: QueueItem): string {
  return item.source ?? item.source_path?.split(/[\\/]/).pop() ?? "video";
}

/** The short note a finished export keeps: the encoder it fell back to, or checks Tuck couldn't make. */
export function resultNote(item: QueueItem): string {
  if (item.state !== "completed") return "";
  if (item.encoder_fallback) return item.encoder_fallback;
  if (Array.isArray(item.unverified) && item.unverified.length) return "Not fully checked";
  return "";
}

/** The whole reason behind a result note, for its tooltip. */
export function resultNoteDetail(item: QueueItem): string {
  if (item.state !== "completed") return "";
  if (item.encoder_fallback) return item.encoder_fallback;
  if (Array.isArray(item.unverified)) return item.unverified.filter((entry) => typeof entry === "string").join(" ");
  return "";
}

/** Whether a finished export came in under the size it aimed for; null when it had no target. */
export function targetFit(item: QueueItem): { readonly fits: boolean; readonly target: number } | null {
  const size = Number(item.result_size) || 0;
  const target = Number(item.target_size) || 0;
  if (item.state !== "completed" || size <= 0 || target <= 0) return null;
  return { fits: size <= target, target };
}

// "Used software encoding because …" reads as its own sentence after the main message
function sentence(note: string): string {
  const trimmed = note.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One message for a finished batch, counted from that batch's items only. */
export function batchSummary(
  items: readonly QueueItem[],
  batchIds: Readonly<Record<string, true>>,
): BatchSummary {
  const batch = items.filter((item) => item.id && batchIds[item.id]);
  const completed = batch.filter((item) => item.state === "completed");
  const failed = batch.filter((item) => item.state === "failed");
  const cancelled = batch.filter((item) => item.state === "cancelled").length;
  const failedIds = failed.map((item) => item.id ?? "");
  if (failed.length) {
    const message = batch.length === 1
      ? `Couldn’t export “${itemName(failed[0]!)}”.`
      : `${failed.length} of ${batch.length} exports failed.`;
    return { message, kind: "err", failedIds };
  }
  if (cancelled) {
    const message = completed.length
      ? `${completed.length} exported, ${cancelled} canceled.`
      : cancelled === 1 ? "Export canceled." : "Exports canceled.";
    return { message, kind: "info", failedIds };
  }
  if (completed.length === 1) {
    const note = resultNote(completed[0]!);
    const message = `Exported “${itemName(completed[0]!)}”.` + (note ? ` ${sentence(note)}` : "");
    return { message, kind: "ok", failedIds };
  }
  if (completed.length) {
    const noted = completed.filter((item) => resultNote(item)).length;
    const message = `${completed.length} videos exported.` +
      (noted ? ` ${noted} ${noted === 1 ? "has a note" : "have notes"} in Exports.` : "");
    return { message, kind: "ok", failedIds };
  }
  return { message: "Exports finished.", kind: "ok", failedIds };
}

/** What the system notification says when a batch finishes. */
export function finishedNotification(
  items: readonly QueueItem[],
  batchIds: Readonly<Record<string, true>>,
): { readonly title: string; readonly body: string } | null {
  const batch = items.filter((item) => item.id && batchIds[item.id]);
  const saved = batch.filter((item) => item.state === "completed").length;
  const failed = batch.filter((item) => item.state === "failed").length;
  const videos = (count: number): string => `${count} ${count === 1 ? "video" : "videos"}`;
  if (failed) {
    return {
      title: "Exports finished with problems",
      body: saved ? `${videos(saved)} saved, ${failed} failed.` : `${videos(failed)} failed.`,
    };
  }
  // a batch that was cancelled has nothing to report
  if (!saved) return null;
  return { title: "Exports finished", body: `${videos(saved)} saved.` };
}

/** The Library video an export came from, and how many edits it had when it was queued. */
export interface WatchedExport {
  readonly path: string;
  readonly edits: number;
}

/**
 * Notes each export the first time it is seen waiting or running. Failed and cancelled ones are
 * kept so a retry is still compared with the video as it was queued; cleared ones are dropped.
 */
export function watchExports(
  items: readonly QueueItem[],
  watched: Readonly<Record<string, WatchedExport>>,
  libraryPath: (sourcePath: string) => string | null,
  editCount: (path: string) => number,
): Record<string, WatchedExport> {
  const next: Record<string, WatchedExport> = {};
  for (const item of items) {
    if (!item.id) continue;
    const known = watched[item.id];
    if (known) {
      next[item.id] = known;
      continue;
    }
    // an export from before Tuck last closed was planned from edits that are gone
    if (!isQueueActive(item.state) || !item.source_path || item.restored) continue;
    const path = libraryPath(item.source_path);
    if (path) next[item.id] = { path, edits: editCount(path) };
  }
  return next;
}

/**
 * Videos to take out of the Library once a batch finishes, for "Remove videos after they export".
 * A video stays when any of its exports in the batch failed or was cancelled, or when it was
 * edited after its latest export was queued, since that export doesn't have the new edits.
 */
export function videosToRemoveAfterExport(
  items: readonly QueueItem[],
  batchIds: Readonly<Record<string, true>>,
  watched: Readonly<Record<string, WatchedExport>>,
  editCount: (path: string) => number,
): string[] {
  const queuedEdits = new Map<string, number>();
  const unfinished = new Set<string>();
  for (const item of items) {
    const watch = item.id && batchIds[item.id] ? watched[item.id] : undefined;
    if (!watch) continue;
    if (item.state !== "completed") unfinished.add(watch.path);
    // edit counts only go up, so the highest one belongs to the export queued last
    queuedEdits.set(watch.path, Math.max(queuedEdits.get(watch.path) ?? 0, watch.edits));
  }
  return Array.from(queuedEdits)
    .filter(([path, edits]) => !unfinished.has(path) && editCount(path) === edits)
    .map(([path]) => path);
}

/**
 * The Library order with its waiting videos put back in the order the queue will run them.
 * Waiting videos keep the places they hold in the Library and only swap among themselves;
 * everything else stays where the person left it.
 */
export function alignToQueueOrder(order: readonly string[], waitingInQueueOrder: readonly string[]): string[] {
  const waiting = new Set(waitingInQueueOrder);
  const queued = waitingInQueueOrder.filter((path) => order.includes(path));
  let next = 0;
  return order.map((path) => (waiting.has(path) ? queued[next++] ?? path : path));
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !(seconds >= 0)) return "--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number): string => (value < 10 ? "0" : "") + value;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

// a size retry names its try instead of the stage the backend repeats for every pass
export function attemptStatus(item: QueueItem, attempt: number): string | null {
  if (attempt < 2 || item.state !== "running") return null;
  const word = attempt === 2 ? "Second try" : attempt === 3 ? "Third try" : `Try ${attempt}`;
  return item.progress_info?.stage === "verifying" ? `${word} · checking the size` : `${word} · adjusting bitrate`;
}

/** Which try a running export is on, given what was known about it before this snapshot. */
export function runningAttempt(item: QueueItem, previous: Pick<QueueViewState, "runningItemId" | "attempt">): number {
  const reported = item.progress_info?.retry_number;
  if (typeof reported === "number" && reported > 0) return reported;
  return item.id && item.id === previous.runningItemId ? previous.attempt : 1;
}

export function formatQueueStatus(item: QueueItem | null | undefined, attempt = 1): string {
  if (!item) return "";
  // a finished cut Tuck could not fully check stays marked; the Inspector lists why
  if (item.state === "completed" && Array.isArray(item.unverified) && item.unverified.length) {
    return `${item.status_text || "Completed"} · Not checked`;
  }
  if (item.state === "completed" && item.encoder_fallback) {
    return `${item.status_text || "Completed"} · ${item.encoder_fallback}`;
  }
  const retrying = attemptStatus(item, attempt);
  if (item.status_text || retrying) {
    const parts = [retrying ?? item.status_text ?? ""];
    if (item.state === "running" && !item.progress_info?.indeterminate) {
      if ((item.progress ?? 0) > 0) parts.push(`${Math.round(item.progress ?? 0)}%`);
      const pi = item.progress_info ?? {};
      if (pi.speed) parts.push(`${pi.speed.toFixed(1)}x`);
      if (pi.eta_seconds != null) parts.push(`ETA ${formatEta(pi.eta_seconds)}`);
    }
    return parts.join(" · ");
  }
  if (item.state === "pending") return "Pending";
  if (item.state === "running") return `Encoding · ${Math.round(item.progress ?? 0)}%`;
  if (item.state === "completed") return "Completed";
  if (item.state === "failed") return "Failed";
  if (item.state === "cancelled") return "Canceled";
  if (item.state === "paused") return "Paused";
  return item.state ?? "";
}

export function queueCompletionOutput(
  items: readonly QueueItem[],
  hadActive: boolean,
  active: boolean,
  activeItemIds: Readonly<Record<string, true>>,
): string {
  if (!hadActive || active) return "";
  let latest: QueueItem | null = null;
  let latestTime = "";
  for (const item of items) {
    const finishedAt = item.finished_at ?? "";
    if (
      item.state === "completed" &&
      item.result_path &&
      (item.id ? activeItemIds[item.id] : false) &&
      (!latest || finishedAt >= latestTime)
    ) {
      latest = item;
      latestTime = finishedAt;
    }
  }
  return latest?.result_path ?? "";
}

export type ExportRowKind = "running" | "waiting" | "paused" | "failed" | "cancelled" | "completed";

export interface ExportRow {
  readonly id: string;
  readonly name: string;
  readonly kind: ExportRowKind;
  readonly detail: string;
  /** What a finished export should still say, such as the encoder it fell back to. */
  readonly note: string;
  /** Source and result sizes, shown when both are known. */
  readonly sizes: { readonly from: number; readonly to: number } | null;
  readonly progress: number | null;
  readonly action: "cancel" | "retry" | "show" | null;
  readonly resultPath: string;
}

export interface ExportRows {
  readonly running: readonly ExportRow[];
  readonly waiting: readonly ExportRow[];
  /** Brought back after Tuck closed; one Resume queues them all. */
  readonly paused: readonly ExportRow[];
  readonly finished: readonly ExportRow[];
  /** Bytes saved by finished exports whose sizes are both known. */
  readonly saved: number;
}

// every export this session, grouped the way the Exports panel lists them
export function exportRows(
  items: readonly QueueItem[],
  sourceSize: (path: string) => number,
  formatDuration: (seconds: number) => string = String,
  view: Pick<QueueViewState, "runningItemId" | "attempt"> | null = null,
): ExportRows {
  const running: ExportRow[] = [];
  const waiting: ExportRow[] = [];
  const paused: ExportRow[] = [];
  const finished: ExportRow[] = [];
  let saved = 0;
  for (const item of items) {
    const base = {
      id: item.id ?? "",
      name: itemName(item),
      resultPath: item.result_path ?? "",
      note: resultNote(item),
    };
    if (item.state === "running") {
      const progress = Math.round(item.progress ?? 0);
      const attempt = view && item.id === view.runningItemId ? view.attempt : 1;
      running.push({...base, kind: "running", detail: runningDetail(item, progress, formatDuration, attempt), sizes: null,
        progress: item.progress_info?.indeterminate ? null : progress, action: "cancel"});
    } else if (item.state === "pending") {
      waiting.push({...base, kind: "waiting", detail: "Waiting", sizes: null, progress: null, action: "cancel"});
    } else if (item.state === "paused") {
      paused.push({...base, kind: "paused", detail: "Paused", sizes: null, progress: null, action: null});
    } else if (item.state === "failed") {
      finished.push({...base, kind: "failed", detail: item.error ? `Failed: ${item.error}` : "Failed", sizes: null, progress: null, action: "retry"});
    } else if (item.state === "cancelled") {
      finished.push({...base, kind: "cancelled", detail: "Canceled", sizes: null, progress: null, action: "retry"});
    } else if (item.state === "completed") {
      const from = item.source_path ? sourceSize(item.source_path) : 0;
      const to = Number(item.result_size) || 0;
      const sizes = from > 0 && to > 0 ? {from, to} : null;
      if (sizes && from > to) saved += from - to;
      finished.push({...base, kind: "completed", detail: sizes ? "" : "Done", sizes, progress: null, action: base.resultPath ? "show" : null});
    }
  }
  return {running, waiting, paused, finished, saved};
}

// whole numbers once it is fast enough that a tenth no longer matters
function formatFps(fps: number): string {
  return `${fps < 10 ? fps.toFixed(1) : Math.round(fps)} fps`;
}

// plain encoding needs no verb; other steps such as a second pass or a cut's joining say theirs
function runningDetail(
  item: QueueItem,
  progress: number,
  formatDuration: (seconds: number) => string,
  attempt = 1,
): string {
  const info = item.progress_info ?? {};
  const parts: string[] = [];
  const retrying = attemptStatus(item, attempt);
  if (retrying) parts.push(retrying);
  else if (item.status_text && item.status_text !== "Encoding") parts.push(item.status_text);
  if (!info.indeterminate) {
    if (progress > 0) parts.push(`${progress}%`);
    if (info.fps != null && info.fps > 0) parts.push(formatFps(info.fps));
    if (info.eta_seconds != null && info.eta_seconds >= 0) parts.push(`${formatDuration(info.eta_seconds)} left`);
  }
  return parts.join(" · ") || "Starting";
}

/**
 * Pure reducer from a backend queue snapshot to the queue-bar view model.
 * `previous` carries forward the had-active flag, the active-id set, and the
 * running-item progress so the displayed progress never regresses mid-job.
 */
export interface TaskbarProgress {
  readonly state: TaskbarProgressState;
  /** Whole-batch percent; null when nothing is measured. */
  readonly progress: number | null;
  /** Ask for attention once, when a batch has just finished with failures. */
  readonly flash: boolean;
}

export const TASKBAR_IDLE: TaskbarProgress = { state: "none", progress: null, flash: false };

/**
 * What the taskbar button shows for a reduced snapshot: the batch's measured progress while it
 * runs, and red after a batch with failures until the window is looked at again.
 */
export function taskbarProgress(
  items: readonly QueueItem[],
  view: QueueViewState,
  previous: TaskbarProgress,
): TaskbarProgress {
  if (view.finishedToast) {
    return view.finishedToast.failedIds.length ? { state: "error", progress: 100, flash: true } : TASKBAR_IDLE;
  }
  if (!view.active) return previous.state === "error" ? { ...previous, flash: false } : TASKBAR_IDLE;
  if (view.indeterminate) return { state: "indeterminate", progress: null, flash: false };
  // each export in the batch counts once, so the bar crosses the whole batch instead of restarting per video
  const batch = items.filter((item) => item.id && view.activeItemIds[item.id]);
  if (!batch.length) return { state: "normal", progress: 0, flash: false };
  let done = 0;
  for (const item of batch) {
    if (item.state === "pending") continue;
    if (item.state === "running") done += (item.id === view.runningItemId ? view.progress : Math.round(item.progress ?? 0)) / 100;
    else done += 1;
  }
  return { state: "normal", progress: Math.min(100, Math.floor((done / batch.length) * 100)), flash: false };
}

export function reduceQueueSnapshot(
  previous: QueueViewState,
  snapshot: QueueSnapshot,
  formatDuration: (seconds: number) => string = String,
): QueueViewState {
  const items = snapshot.items ?? [];
  const running = items.filter((item) => item.state === "running");
  const pending = items.filter((item) => item.state === "pending");
  const completedCount = items.filter((item) => item.state === "completed").length;
  const failed = items.filter((item) => item.state === "failed").length;
  const cancelled = items.filter((item) => item.state === "cancelled").length;
  const paused = items.filter((item) => item.state === "paused").length;
  const active = running.length + pending.length;

  const activeItemIds: Record<string, true> = { ...previous.activeItemIds };
  for (const item of [...running, ...pending]) if (item.id) activeItemIds[item.id] = true;

  const outputToOpen = queueCompletionOutput(items, previous.hadActive, active > 0, activeItemIds);
  const queueFinished = previous.hadActive && active === 0;

  const finishedToast = queueFinished ? batchSummary(items, activeItemIds) : null;

  const nextActiveItemIds = queueFinished ? {} : activeItemIds;

  let progress = 0;
  let indeterminate = false;
  let detail = "";
  let fname = "";
  let runningItemId = "";
  let attempt = 1;

  const first = running[0];
  if (first) {
    runningItemId = first.id ?? "";
    attempt = runningAttempt(first, previous);
    const raw = Math.round(first.progress ?? 0);
    // progress never slips back within one try; a new try starts again from its own zero
    progress =
      runningItemId && runningItemId === previous.runningItemId && attempt === previous.attempt
        ? Math.max(raw, previous.progress)
        : raw;
    const pi = first.progress_info ?? {};
    indeterminate = pi.indeterminate === true;
    fname = first.source ?? "?";
    detail = runningDetail(first, progress, formatDuration, attempt);
  } else if (!pending.length && paused) {
    // nothing runs until Resume, so the bar says what is waiting for it rather than "Done"
    fname = paused === 1 ? "1 export paused" : `${paused} exports paused`;
  } else if (!pending.length && items.length) {
    progress = 100;
    fname = completedCount ? `${completedCount} exported` : "Done";
  }

  return {
    hadActive: active > 0,
    activeItemIds: nextActiveItemIds,
    runningItemId,
    attempt,
    progress,
    indeterminate,
    barVisible: items.length > 0,
    active: active > 0,
    stopAfterDisabled: active === 0,
    cancelDisabled: active === 0,
    clearDisabled: completedCount + cancelled === 0,
    retryable: failed + cancelled,
    paused,
    fname,
    finished: items.length > 0 && active === 0 && paused === 0,
    detail,
    waiting: pending.length,
    failed,
    finishedToast,
    outputToOpen,
  };
}
