export interface QueueItem {
  readonly id?: string;
  readonly source?: string;
  readonly source_path?: string;
  readonly state?: string;
  readonly progress?: number;
  readonly progress_info?: { readonly speed?: number; readonly eta_seconds?: number | null };
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
  readonly barVisible: boolean;
  readonly active: boolean;
  readonly stopAfterDisabled: boolean;
  readonly cancelDisabled: boolean;
  readonly clearDisabled: boolean;
  readonly count: string;
  readonly eta: string;
  readonly fname: string;
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
    barVisible: false,
    active: false,
    stopAfterDisabled: true,
    cancelDisabled: true,
    clearDisabled: true,
    count: "0/0",
    eta: "ETA --",
    fname: "",
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
  if (item.status_text) {
    const parts = [item.status_text];
    if (item.state === "running") {
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
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const done = items.filter((item) => terminal.has(item.state ?? "")).length;
  const completedCount = items.filter((item) => item.state === "completed").length;
  const failed = items.filter((item) => item.state === "failed").length;
  const active = running.length + pending.length;
  const total = done + active;

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

  let count = "0/0";
  let progress = 0;
  let eta = "ETA --";
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
    count = `${done + 1}/${total}`;
    eta = pi.eta_seconds != null ? `ETA ${formatEta(pi.eta_seconds)}` : "ETA --";
    const segmentCount = first.segment_count || 1;
    const selection =
      `${segmentCount}${segmentCount === 1 ? " segment" : " segments"}` +
      (first.duration ? ` · ${formatDuration(first.duration)}` : "");
    const status = formatQueueStatus(first);
    fname = `${first.source ?? "?"} · ${selection}${status ? ` · ${status}` : ""}`;
  } else if (pending.length) {
    count = `${done}/${total}`;
    progress = 0;
    eta = "ETA --";
    fname = `${pending.length} pending`;
  } else if (items.length) {
    count = `${done}/${total}`;
    progress = 100;
    eta = "";
    fname = "Queue idle";
  }

  return {
    hadActive: active > 0,
    activeItemIds: nextActiveItemIds,
    runningItemId,
    progress,
    barVisible: items.length > 0,
    active: active > 0,
    stopAfterDisabled: active === 0,
    cancelDisabled: active === 0,
    clearDisabled: completedCount === 0,
    count,
    eta,
    fname,
    finishedToast,
    outputToOpen,
  };
}
