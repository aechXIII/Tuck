import type { BackendClient } from "../../backend/types.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import { errorSummary, formatTime } from "../editor/format.ts";
import { confirmToast, toast } from "../editor/toast.ts";
import type { EditorClip } from "../editor/types.ts";
import type { EditorSession } from "../editor/session.ts";
import {
  emptyQueueView,
  formatQueueStatus,
  reduceQueueSnapshot,
  type QueueItem,
  type QueueViewState,
} from "./queue-view.ts";

export interface QueueDeps {
  session: EditorSession;
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  getBackendClient: () => BackendClient;
  renderClips: () => void;
  removeClip: (path: string) => void;
  isReordering: () => boolean;
  workflow: () => number;
  addFiles: (files: string[]) => void;
  onSendto: (data: Record<string, unknown>) => void;
}

export interface QueueApi {
  pollQueue: () => Promise<void>;
  pollIpc: () => Promise<void>;
  cancelQueueItem: (itemId: string) => Promise<void>;
  retryQueueItem: (itemId: string) => Promise<void>;
  openResult: (path: string) => Promise<void>;
  stopAfterCurrent: () => void;
  cancelAll: () => void;
  clearDone: () => Promise<void>;
  copyDiagnostics: (itemId?: string) => Promise<void>;
}

export function installQueue(deps: QueueDeps): QueueApi {
  const { session, byId, getBackendClient } = deps;
  const client = (): BackendClient => getBackendClient();
  const text = (id: string, value: string): void => {
    const node = byId(id);
    if (node) node.textContent = value;
  };
  const toggleHidden = (id: string, hidden: boolean): void => {
    byId(id)?.classList.toggle("hid", hidden);
  };
  const setDisabled = (id: string, disabled: boolean): void => {
    const node = byId<HTMLButtonElement>(id);
    if (node) node.disabled = disabled;
  };

  let queueItemsById: Record<string, QueueItem> = {};
  const queueActiveItemIds: Record<string, true> = {};
  const retryInFlight: Record<string, true> = {};
  let queueView: QueueViewState = emptyQueueView();

  function mapQueueItems(items: readonly QueueItem[]): void {
    const map: Record<string, QueueItem> = {};
    let completed = false;
    queueItemsById = {};
    for (const item of items) {
      if (item.source_path) map[item.source_path] = item;
      if (item.id) queueItemsById[item.id] = item;
    }
    for (const path of Object.keys(session.clips)) {
      const clip = session.clips[path];
      if (!clip) continue;
      const item = map[path];
      if (item) {
        const previousState = clip._queueState;
        clip._queueState = item.state ?? "";
        clip._queueItemId = item.id ?? "";
        clip._statusText = formatQueueStatus(item);
        clip._progress = item.progress || 0;
        if (item.error) clip._queueError = item.error;
        if (item.state === "completed" && previousState !== "completed") completed = true;
        if (item.state === "failed" && previousState !== "failed") {
          toast(`Failed to process "${clip.name}": ${errorSummary(item.error)}`, "err");
        }
        if (item.result_size) clip._resultSize = Number(item.result_size);
        if (item.result_path) clip._resultPath = item.result_path;
      } else if (
        clip._queueState &&
        ["completed", "failed", "cancelled"].indexOf(clip._queueState) < 0
      ) {
        clip._queueState = "";
        clip._statusText = "";
      }
    }
    if (completed && session.appSettings.clear_completed_automatically) {
      setTimeout(() => void clearDone(), 0);
    }
  }

  async function pollQueue(): Promise<void> {
    try {
      const state = await legacyBackendResult(client().getQueueState());
      const items = (Array.isArray(state.items) ? state.items : []) as QueueItem[];
      mapQueueItems(items);
      if (!deps.isReordering()) deps.renderClips();

      const previous = queueView;
      queueView = reduceQueueSnapshot(previous, { items }, formatTime);
      for (const item of items) if (item.state === "running" && item.id) queueActiveItemIds[item.id] = true;

      if (queueView.finishedToast) {
        toast(queueView.finishedToast.message, queueView.finishedToast.kind);
      }
      if (queueView.outputToOpen && session.appSettings.open_output_folder_after_queue) {
        await openResult(queueView.outputToOpen);
      }
      Object.keys(queueActiveItemIds).forEach((id) => {
        if (!queueView.activeItemIds[id]) delete queueActiveItemIds[id];
      });

      toggleHidden("qbar", !queueView.barVisible);
      toggleHidden("q-active", !queueView.barVisible);
      toggleHidden("qidle", queueView.barVisible);
      setDisabled("btn-stop-after", queueView.stopAfterDisabled);
      setDisabled("btn-cancel", queueView.cancelDisabled);
      setDisabled("btn-clear", queueView.clearDisabled);
      if (!items.length) return;
      text("qcnt", queueView.count);
      const progress = byId<HTMLProgressElement>("qprog");
      if (progress) progress.value = queueView.progress;
      text("qeta", queueView.eta);
      text("qfname", queueView.fname);
    } catch {
      /* polling errors are transient */
    }
  }

  async function cancelQueueItem(itemId: string): Promise<void> {
    if (!itemId) return;
    try {
      const r = await legacyBackendResult(client().cancelItem(itemId));
      if (!r.ok) toast(r.error ?? "Could not cancel item.", "err");
      await pollQueue();
    } catch {
      toast("Could not cancel item.", "err");
    }
  }

  async function retryQueueItem(itemId: string): Promise<void> {
    if (!itemId || retryInFlight[itemId]) return;
    retryInFlight[itemId] = true;
    try {
      const r = await legacyBackendResult(client().retryItem(itemId));
      if (!r.ok) toast(r.error ?? "Could not retry.", "err");
      void pollQueue();
    } finally {
      delete retryInFlight[itemId];
    }
  }

  async function openResult(path: string): Promise<void> {
    if (!path) return;
    try {
      const r = await legacyBackendResult(client().openOutputFolder(path));
      if (!r.ok) toast(r.error ?? "Could not open folder.", "err");
    } catch {
      toast("Could not open folder.", "err");
    }
  }

  function stopAfterCurrent(): void {
    confirmToast("Finish the current job and cancel the rest?", () => {
      void (async (): Promise<void> => {
        const r = await legacyBackendResult(client().stopAfterCurrent());
        if (!r.ok) {
          toast(r.error ?? "Could not stop queue.", "err");
        } else {
          toast("Queue will stop after the current job.", "ok");
          void pollQueue();
        }
      })();
    });
  }

  function cancelAll(): void {
    confirmToast("Cancel all processing?", () => {
      void (async (): Promise<void> => {
        await client().cancelAllItems();
        toggleHidden("q-active", true);
        toggleHidden("qidle", false);
        toast("Processing cancelled.", "ok");
      })();
    });
  }

  async function clearDone(): Promise<void> {
    const r = await legacyBackendResult(client().clearCompleted());
    if (r.ok) {
      for (const path of Object.keys(session.clips)) {
        if (session.clips[path]?._queueState === "completed") deps.removeClip(path);
      }
      const count = Number(r.count) || 0;
      toast(
        count === 1 ? "Cleared 1 completed video." : `Cleared ${count} completed videos.`,
        "ok",
      );
      await pollQueue();
    } else {
      toast(r.error ?? "Could not clear completed videos.", "err");
    }
  }

  function buildDiagnosticsContext(itemId?: string): Record<string, unknown> {
    const value = (id: string): string => byId<HTMLInputElement | HTMLSelectElement>(id)?.value ?? "";
    const number = (id: string): number | undefined => {
      const node = byId<HTMLInputElement>(id);
      if (!node) return undefined;
      const parsed = parseInt(node.value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const checked = (id: string): boolean | undefined => {
      const node = byId<HTMLInputElement>(id);
      return node ? !!node.checked : undefined;
    };
    const profileSelect = byId<HTMLSelectElement>("prof-sel");
    const ctx: Record<string, unknown> = {
      workflow: deps.workflow() === 1 ? "upscale" : "compression",
      selected_encoder: value("enc-sel"),
      profile_name: profileSelect?.selectedOptions[0]?.textContent ?? "",
      target_size_mb: number("sz-slider"),
      resolution:
        byId<HTMLInputElement>("res-mode")?.value === "custom"
          ? `${value("res-w")}x${value("res-h")}`
          : "source",
      fps: checked("use-source-fps") ? "source" : number("fps-val"),
      two_pass: byId<HTMLSelectElement>("two-pass")
        ? byId<HTMLSelectElement>("two-pass")!.value === "on"
        : undefined,
      preset: byId("preset-sel") ? value("preset-sel") : undefined,
      scaler: byId("scaler-sel") ? value("scaler-sel") : undefined,
      keep_audio: checked("keep-audio"),
      audio_bitrate_kbps: number("audio-br"),
      rate_control_method: byId("rc-sel") ? value("rc-sel") : undefined,
    };
    const selPath = session.selPath;
    const clip = selPath ? session.clips[selPath] : undefined;
    if (selPath && clip) {
      ctx.source_name = clip.name || selPath.split(/[\\/]/).pop();
      const full = Number(clip.probeData?.duration) || 0;
      if (full > 0) {
        const segments = SegmentEditing.segmentsForClip(clip, full);
        ctx.segments = segments;
        ctx.segment_count = segments.length;
        ctx.selected_duration = SegmentEditing.selectedDuration(segments);
      }
      const plan = clip.planData;
      if (plan) {
        if (plan.video_encoder) ctx.resolved_encoder = plan.video_encoder;
        if (plan.segments) {
          ctx.segments = plan.segments;
          ctx.segment_count = plan.segment_count;
          ctx.selected_duration = plan.selected_duration;
        }
      }
    }
    if (itemId) {
      ctx.item_id = itemId;
      const item = queueItemsById[itemId];
      if (item?.error) ctx.error = item.error;
      if (item?.error_detail) ctx.stderr = item.error_detail;
    } else {
      const failedId = Object.keys(queueItemsById).find(
        (id) => queueItemsById[id]?.state === "failed",
      );
      if (failedId) {
        ctx.item_id = failedId;
        const failed = queueItemsById[failedId];
        if (failed?.error) ctx.error = failed.error;
        if (failed?.error_detail) ctx.stderr = failed.error_detail;
      }
    }
    return ctx;
  }

  async function copyDiagnostics(itemId?: string): Promise<void> {
    const ctx = buildDiagnosticsContext(itemId);
    try {
      const r = await legacyBackendResult(client().getDiagnostics(ctx as never));
      const diagnosticText = typeof r.text === "string" ? r.text : "";
      if (!r.ok || !diagnosticText) {
        toast(r.error ?? "Could not build diagnostics.", "err");
        return;
      }
      let copied = false;
      const copyResult = await legacyBackendResult(client().copyText(diagnosticText));
      copied = !!copyResult.ok;
      if (!copied) {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(diagnosticText);
            copied = true;
          }
        } catch {
          /* fall through to execCommand */
        }
      }
      if (!copied) {
        const area = document.createElement("textarea");
        area.value = diagnosticText;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        try {
          copied = document.execCommand("copy");
        } catch {
          copied = false;
        }
        document.body.removeChild(area);
      }
      toast(
        copied ? "Diagnostics copied to clipboard." : "Could not copy diagnostics.",
        copied ? "ok" : "err",
      );
    } catch {
      toast("Could not copy diagnostics.", "err");
    }
  }

  async function pollIpc(): Promise<void> {
    try {
      const files = await legacyBackendResult(client().getIpcFiles());
      const metadata = await legacyBackendResult(client().getIpcMetadata());
      const fileList = Array.isArray(files) ? (files as string[]) : [];
      if (fileList.length) deps.addFiles(fileList);
      if (metadata && Object.keys(metadata).length) {
        const payload = { ...metadata, files: fileList } as Record<string, unknown>;
        deps.onSendto(payload);
      }
    } catch {
      /* IPC polling errors are transient */
    }
  }

  return {
    pollQueue,
    pollIpc,
    cancelQueueItem,
    retryQueueItem,
    openResult,
    stopAfterCurrent,
    cancelAll,
    clearDone,
    copyDiagnostics,
  };
}

export type { EditorClip };
