import { attemptStatus, exportRows, itemName, targetFit, type QueueItem, type QueueViewState } from "./queue-view.ts";

/**
 * What the bottom bar says about exports. A running export keeps one shape, so the numbers that
 * change on every poll never move anything; a result takes the shape its content needs.
 */
export type ExportBarView =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "running";
      readonly itemId: string;
      readonly sourcePath: string;
      readonly title: string;
      /** The whole export's percent, or null while a step runs that has no measured amount. */
      readonly percent: number | null;
      /** Two-pass exports draw their track in two halves, the way the percent counts them. */
      readonly passes: 1 | 2;
      /** What the step is called when there is no percent to show, such as "Preparing". */
      readonly stage: string;
      /** A size retry's try, such as "Second try · adjusting bitrate". */
      readonly attempt: string;
      readonly fps: number | null;
      readonly eta: number | null;
      readonly waiting: number;
      /** Exports of this batch that already failed, so a failure shows before the batch ends. */
      readonly failed: number;
    }
  | {
      readonly kind: "one";
      readonly itemId: string;
      readonly sourcePath: string;
      readonly title: string;
      readonly resultPath: string;
      readonly resultSize: number;
      readonly sourceSize: number;
      /** The size it aimed for, only when the file came out bigger than that. */
      readonly missedTarget: number;
    }
  | {
      readonly kind: "many";
      readonly itemIds: readonly string[];
      readonly resultPaths: readonly string[];
      /** The newest exports' sources, oldest first, for the stack of their pictures. */
      readonly sourcePaths: readonly string[];
      readonly resultPath: string;
      readonly count: number;
      readonly saved: number;
      readonly total: number;
      /** How many came out bigger than the size they aimed for. */
      readonly missedTarget: number;
    }
  | {
      readonly kind: "failed";
      readonly itemId: string;
      readonly sourcePath: string;
      readonly title: string;
      readonly error: string;
      readonly failed: number;
      readonly finished: number;
    }
  | { readonly kind: "canceled"; readonly count: number }
  | { readonly kind: "paused"; readonly count: number };

// stages whose percent measures the export itself; the rest are named instead
const MEASURED_STAGES = new Set(["encoding", "pass_1", "pass_2", "copying", "joining", "encoding_edges"]);

// the phase the backend names, without the numbers runningDetail would add
function stageName(item: QueueItem): string {
  const phase = (item.status_text ?? "").split(" · ")[0]?.trim() ?? "";
  return phase && phase !== "Encoding" ? phase : "Preparing";
}

function runningView(item: QueueItem, view: QueueViewState, waiting: number, failed: number): ExportBarView {
  const info = item.progress_info ?? {};
  const running = item.state === "running";
  const stage = info.stage ?? "";
  const measured = running && !view.indeterminate && !info.indeterminate && (stage ? MEASURED_STAGES.has(stage) : view.progress > 0);
  const fps = Number(info.fps);
  const eta = Number(info.eta_seconds);
  return {
    kind: "running",
    itemId: item.id ?? "",
    sourcePath: item.source_path ?? "",
    title: itemName(item),
    percent: measured ? Math.max(0, Math.min(100, Math.round(view.progress))) : null,
    passes: item.two_pass ? 2 : 1,
    stage: running ? stageName(item) : "Waiting",
    attempt: (running && attemptStatus(item, view.attempt)) || "",
    fps: running && info.fps != null && fps > 0 ? fps : null,
    eta: running && info.eta_seconds != null && eta >= 0 ? eta : null,
    waiting,
    failed,
  };
}

export function exportBarView(
  items: readonly QueueItem[],
  view: QueueViewState,
  sourceSize: (path: string) => number,
): ExportBarView {
  if (!items.length) return { kind: "hidden" };
  const pending = items.filter((item) => item.state === "pending");
  const failed = items.filter((item) => item.state === "failed");
  const current = items.find((item) => item.state === "running" && (!view.runningItemId || item.id === view.runningItemId))
    ?? items.find((item) => item.state === "running");
  if (current) return runningView(current, view, pending.length, failed.length);
  if (pending[0]) return runningView(pending[0], view, pending.length - 1, failed.length);
  const paused = items.filter((item) => item.state === "paused").length;
  if (paused) return { kind: "paused", count: paused };
  // the result's buttons need the file, so only exports that name one are shown as results
  const completed = items.filter((item) => item.state === "completed" && item.result_path);
  const last = failed[failed.length - 1];
  if (last) {
    return {
      kind: "failed",
      itemId: last.id ?? "",
      sourcePath: last.source_path ?? "",
      title: itemName(last),
      error: last.error || "The export didn’t finish.",
      failed: failed.length,
      finished: items.filter((item) => item.state === "completed").length,
    };
  }
  const only = completed.length === 1 ? completed[0] : undefined;
  if (only) {
    const fit = targetFit(only);
    return {
      kind: "one",
      itemId: only.id ?? "",
      sourcePath: only.source_path ?? "",
      title: only.output || itemName(only),
      resultPath: only.result_path ?? "",
      resultSize: Number(only.result_size) || 0,
      sourceSize: only.source_path ? sourceSize(only.source_path) : 0,
      missedTarget: fit && !fit.fits ? fit.target : 0,
    };
  }
  if (completed.length) {
    const newest = completed[completed.length - 1]!;
    return {
      kind: "many",
      itemIds: completed.map((item) => item.id ?? ""),
      resultPaths: completed.map((item) => item.result_path ?? ""),
      sourcePaths: completed.slice(-3).map((item) => item.source_path ?? ""),
      resultPath: newest.result_path ?? "",
      count: completed.length,
      saved: exportRows(completed, sourceSize).saved,
      total: completed.reduce((sum, item) => sum + (Number(item.result_size) || 0), 0),
      missedTarget: completed.filter((item) => targetFit(item)?.fits === false).length,
    };
  }
  const canceled = items.filter((item) => item.state === "cancelled").length;
  return canceled ? { kind: "canceled", count: canceled } : { kind: "hidden" };
}

/** How full each half of the track is, given the whole export's percent: the first pass is 0 to 50%. */
export function passFills(percent: number, passes: 1 | 2): readonly number[] {
  const value = Math.max(0, Math.min(100, percent));
  if (passes === 1) return [value];
  return [Math.min(100, value * 2), Math.max(0, (value - 50) * 2)];
}
