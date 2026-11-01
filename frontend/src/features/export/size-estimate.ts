import type { BackendResult, PlanRequest } from "../../backend/types.ts";
import type { SizeEstimatePayload } from "../../backend/size-estimate-types.ts";

/**
 * How big a Quality export will be. The backend encodes a few short pieces with the export's own
 * settings; this keeps one result per video and settings, waits for the input to settle, starts
 * over on any change and holds off while an export runs.
 */
export type EstimateState = "idle" | "running" | "waiting" | "done" | "failed";

export interface EstimateView {
  readonly state: EstimateState;
  readonly sizeMb: number;
  readonly reason: string;
}

export interface SizeEstimates {
  /** the selected video's Quality request, or null when it has nothing to estimate */
  update(request: PlanRequest | null, exportsRunning: boolean): void;
  view(): EstimateView;
}

export interface SizeEstimateDeps {
  estimate(request: PlanRequest): Promise<BackendResult<SizeEstimatePayload>>;
  cancel(): void;
  paint(): void;
  settleMs?: number;
}

// the level and the encoder move in steps, so this lets a quick run of clicks finish before
// encoding; with the plan's own 120 ms that is about 0.6 s after the last change
export const ESTIMATE_SETTLE_MS = 500;
const KEPT_RESULTS = 64;
const IDLE: EstimateView = { state: "idle", sizeMb: 0, reason: "" };

export function estimateKey(request: PlanRequest): string {
  const { _request_id: _ignored, ...settings } = request as PlanRequest & { _request_id?: unknown };
  return JSON.stringify(settings);
}

/** "About 120 MB", or one decimal under 10 MB. */
export function estimateNumber(sizeMb: number): string {
  return sizeMb < 10 ? String(Math.max(0.1, Math.round(sizeMb * 10) / 10)) : String(Math.round(sizeMb));
}

/** What the Size column says while Quality is chosen. */
export function estimateLabel(view: EstimateView): string {
  switch (view.state) {
    case "running":
      return "Estimating";
    case "waiting":
      return "After export";
    case "failed":
      return "No estimate";
    case "done":
      return `About ${estimateNumber(view.sizeMb)} MB`;
    default:
      return "Auto";
  }
}

export function estimateTip(view: EstimateView): string {
  switch (view.state) {
    case "running":
      return "Encoding a few seconds of the video to estimate the size";
    case "waiting":
      return "Tuck estimates the size once the exports finish";
    case "failed":
      return view.reason ? `No estimate: ${view.reason}` : "No estimate";
    case "done":
      return `Use ${estimateNumber(view.sizeMb)} MB as the size`;
    default:
      return "Use a size instead";
  }
}

export function createSizeEstimates(deps: SizeEstimateDeps): SizeEstimates {
  const settle = deps.settleMs ?? ESTIMATE_SETTLE_MS;
  const results = new Map<string, EstimateView>();
  let current = "";
  let shown: EstimateView = IDLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = "";

  function show(view: EstimateView): void {
    shown = view;
    deps.paint();
  }

  function stopRunning(): void {
    clearTimeout(timer);
    timer = undefined;
    if (running) {
      running = "";
      deps.cancel();
    }
  }

  function keep(key: string, view: EstimateView): void {
    results.delete(key);
    results.set(key, view);
    while (results.size > KEPT_RESULTS) results.delete(results.keys().next().value as string);
  }

  async function run(key: string, request: PlanRequest): Promise<void> {
    timer = undefined;
    running = key;
    const result = await deps.estimate(request);
    if (running === key) running = "";
    // a newer estimate or a change of video took over; the backend stopped this one
    if (key !== current) return;
    if (result.ok) {
      const view: EstimateView = { state: "done", sizeMb: result.value.size_bytes / (1024 * 1024), reason: "" };
      keep(key, view);
      show(view);
      return;
    }
    if (result.error.code === "export_running") {
      show({ state: "waiting", sizeMb: 0, reason: "" });
      return;
    }
    if (result.error.code === "cancelled") {
      show(IDLE);
      return;
    }
    // kept, so a broken setting isn't encoded again until something changes
    const view: EstimateView = { state: "failed", sizeMb: 0, reason: result.error.message };
    keep(key, view);
    show(view);
  }

  return {
    update(request, exportsRunning) {
      if (!request) {
        current = "";
        stopRunning();
        if (shown !== IDLE) show(IDLE);
        return;
      }
      const key = estimateKey(request);
      const stillWaiting = shown.state === "waiting" && exportsRunning;
      if (key === current && (shown.state !== "waiting" || stillWaiting)) return;
      current = key;
      const known = results.get(key);
      if (known) {
        stopRunning();
        show(known);
        return;
      }
      if (exportsRunning) {
        stopRunning();
        show({ state: "waiting", sizeMb: 0, reason: "" });
        return;
      }
      // an estimate for the old settings is no use, so it stops now rather than after the wait
      stopRunning();
      show({ state: "running", sizeMb: 0, reason: "" });
      timer = setTimeout(() => void run(key, request), settle);
    },
    view: () => shown,
  };
}
