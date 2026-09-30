export interface QueueItem {
  readonly id?: string;
  readonly source?: string;
  readonly source_path?: string;
  readonly state?: string;
  readonly progress?: number;
  readonly progress_info?: { readonly speed?: number; readonly eta_seconds?: number | null; readonly indeterminate?: boolean };
  readonly status_text?: string;
  readonly result_path?: string;
  readonly finished_at?: string;
  readonly segment_count?: number;
  readonly duration?: number;
  readonly error?: string;
  readonly error_detail?: string;
  readonly [key: string]: unknown;
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
  readonly progress: number;
  readonly indeterminate: boolean;
  readonly barVisible: boolean;
  readonly active: boolean;
  readonly stopAfterDisabled: boolean;
  readonly cancelDisabled: boolean;
  readonly clearDisabled: boolean;
  /** The export running now, or how many exported once nothing is left. */
  readonly fname: string;
  /** Nothing is running or waiting, but finished exports are still listed. */
  readonly finished: boolean;
  /** How far the running export is, e.g. "42% · 1:23 left". */
  readonly detail: string;
  readonly waiting: number;
  readonly failed: number;
  /** Non-empty when a batch just finished and the toast should fire. */
  readonly finishedToast: { readonly message: string; readonly kind: "ok" | "err" } | null;
  /** Result path to reveal when the automatic show-export setting is on. */
  readonly outputToOpen: string;
}

export function emptyQueueView(): QueueViewState {
  return {
    hadActive: false,
    activeItemIds: {},
    runningItemId: "",
    progress: 0,
    indeterminate: false,
    barVisible: false,
    active: false,
    stopAfterDisabled: true,
    cancelDisabled: true,
    clearDisabled: true,
    fname: "",
    finished: false,
    detail: "",
    waiting: 0,
    failed: 0,
    finishedToast: null,
    outputToOpen: "",
  };
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

export function formatQueueStatus(item: QueueItem | null | undefined): string {
  if (!item) return "";
  // a finished cut Tuck could not fully check stays marked; the Inspector lists why
  if (item.state === "completed" && Array.isArray(item.unverified) && item.unverified.length) {
    return `${item.status_text || "Completed"} · Not checked`;
  }
  if (item.status_text) {
    const parts = [item.status_text];
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
  if (item.state === "cancelled") return "Cancelled";
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

export type ExportRowKind = "running" | "waiting" | "failed" | "cancelled" | "completed";

export interface ExportRow {
  readonly id: string;
  readonly name: string;
  readonly kind: ExportRowKind;
  readonly detail: string;
  /** Source and result sizes, shown when both are known. */
  readonly sizes: { readonly from: number; readonly to: number } | null;
  readonly progress: number | null;
  readonly action: "cancel" | "retry" | "show" | null;
  readonly resultPath: string;
}

export interface ExportRows {
  readonly running: readonly ExportRow[];
  readonly waiting: readonly ExportRow[];
  readonly finished: readonly ExportRow[];
  /** Bytes saved by finished exports whose sizes are both known. */
  readonly saved: number;
}

// every export this session, grouped the way the Exports panel lists them
export function exportRows(
  items: readonly QueueItem[],
  sourceSize: (path: string) => number,
  formatDuration: (seconds: number) => string = String,
): ExportRows {
  const running: ExportRow[] = [];
  const waiting: ExportRow[] = [];
  const finished: ExportRow[] = [];
  let saved = 0;
  for (const item of items) {
    const base = {
      id: item.id ?? "",
      name: item.source ?? item.source_path?.split(/[\/]/).pop() ?? "?",
      resultPath: item.result_path ?? "",
    };
    if (item.state === "running") {
      const progress = Math.round(item.progress ?? 0);
      running.push({...base, kind: "running", detail: runningDetail(item, progress, formatDuration), sizes: null,
        progress: item.progress_info?.indeterminate ? null : progress, action: "cancel"});
    } else if (item.state === "pending") {
      waiting.push({...base, kind: "waiting", detail: "Waiting", sizes: null, progress: null, action: "cancel"});
    } else if (item.state === "failed") {
      finished.push({...base, kind: "failed", detail: item.error ? `Failed: ${item.error}` : "Failed", sizes: null, progress: null, action: "retry"});
    } else if (item.state === "cancelled") {
      finished.push({...base, kind: "cancelled", detail: "Cancelled", sizes: null, progress: null, action: "retry"});
    } else if (item.state === "completed") {
      const from = item.source_path ? sourceSize(item.source_path) : 0;
      const to = Number(item.result_size) || 0;
      const sizes = from > 0 && to > 0 ? {from, to} : null;
      if (sizes && from > to) saved += from - to;
      finished.push({...base, kind: "completed", detail: sizes ? "" : "Done", sizes, progress: null, action: base.resultPath ? "show" : null});
    }
  }
  return {running, waiting, finished, saved};
}

// plain encoding needs no verb; other steps such as a second pass or a cut's joining say theirs
function runningDetail(item: QueueItem, progress: number, formatDuration: (seconds: number) => string): string {
  const info = item.progress_info ?? {};
  const parts: string[] = [];
  if (item.status_text && item.status_text !== "Encoding") parts.push(item.status_text);
  if (!info.indeterminate) {
    if (progress > 0) parts.push(`${progress}%`);
    if (info.eta_seconds != null && info.eta_seconds >= 0) parts.push(`${formatDuration(info.eta_seconds)} left`);
  }
  return parts.join(" · ") || "Starting";
}

/**
 * Pure reducer from a backend queue snapshot to the queue-bar view model.
 * `previous` carries forward the had-active flag, the active-id set, and the
 * running-item progress so the displayed progress never regresses mid-job.
 */
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
  const active = running.length + pending.length;

  const activeItemIds: Record<string, true> = { ...previous.activeItemIds };
  for (const item of [...running, ...pending]) if (item.id) activeItemIds[item.id] = true;

  const outputToOpen = queueCompletionOutput(items, previous.hadActive, active > 0, activeItemIds);
  const queueFinished = previous.hadActive && active === 0;

  const finishedToast = queueFinished
    ? failed
      ? {
          message: `Processing finished with ${failed} failure${failed === 1 ? "" : "s"}.`,
          kind: "err" as const,
        }
      : { message: "Processing completed.", kind: "ok" as const }
    : null;

  const nextActiveItemIds = queueFinished ? {} : activeItemIds;

  let progress = 0;
  let indeterminate = false;
  let detail = "";
  let fname = "";
  let runningItemId = "";

  const first = running[0];
  if (first) {
    runningItemId = first.id ?? "";
    const raw = Math.round(first.progress ?? 0);
    progress =
      runningItemId && runningItemId === previous.runningItemId
        ? Math.max(raw, previous.progress)
        : raw;
    const pi = first.progress_info ?? {};
    indeterminate = pi.indeterminate === true;
    fname = first.source ?? "?";
    detail = runningDetail(first, progress, formatDuration);
  } else if (!pending.length && items.length) {
    progress = 100;
    fname = completedCount ? `${completedCount} exported` : "Done";
  }

  return {
    hadActive: active > 0,
    activeItemIds: nextActiveItemIds,
    runningItemId,
    progress,
    indeterminate,
    barVisible: items.length > 0,
    active: active > 0,
    stopAfterDisabled: active === 0,
    cancelDisabled: active === 0,
    clearDisabled: completedCount === 0,
    fname,
    finished: items.length > 0 && active === 0,
    detail,
    waiting: pending.length,
    failed,
    finishedToast,
    outputToOpen,
  };
}
