import type { BackendClient, BackendResult, JsonObject, QueuedIdsPayload } from "../../backend/types.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import { formatBytes, formatTime, withReason } from "../editor/format.ts";
import { announce, confirmToast, toast } from "../editor/toast.ts";
import { EASE_OUT, motionEnabled } from "../../ui/motion.ts";
import { createExportFileCopy } from "./export-file-copy.ts";
import type { EditorClip } from "../editor/types.ts";
import type { EditorSession } from "../editor/session.ts";
import {
  emptyQueueView,
  exportRows,
  finishedNotification,
  formatQueueStatus,
  isQueueActive,
  queueItemsFromSnapshot,
  reduceQueueSnapshot,
  resultNote,
  resultNoteDetail,
  targetFit,
  taskbarProgress,
  TASKBAR_IDLE,
  videosToRemoveAfterExport,
  watchExports,
  type ExportRow,
  type QueueItem,
  type QueueViewState,
  type TaskbarProgress,
  type WatchedExport,
} from "./queue-view.ts";

export interface QueueDeps {
  session: EditorSession;
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  getBackendClient: () => BackendClient;
  renderClips: () => void;
  isReordering: () => boolean;
  workflow: () => number;
  addFiles: (files: string[]) => void;
  // the Library's own removal, with its Undo
  removeClip: (path: string) => void;
  editCount: (path: string) => number;
  onSendto: (data: Record<string, unknown>) => void;
  /** the desktop shell's report on the preview, for the diagnostic report */
  previewReport?: () => Promise<JsonObject | null>;
}

export interface QueueApi {
  pollQueue: () => Promise<void>;
  pollIpc: () => Promise<void>;
  cancelQueueItem: (itemId: string) => Promise<void>;
  retryQueueItem: (itemId: string) => Promise<void>;
  openResult: (path: string) => Promise<void>;
  copyResult: (itemId: string) => Promise<void>;
  // where copying this export's file stands, for the Library's Copy file button
  copyResultState: (itemId: string, path: string) => { disabled: boolean; label: string };
  openExportFile: (itemId: string) => Promise<void>;
  dragExportOut: (itemId: string) => Promise<void>;
  stopAfterCurrent: () => void;
  cancelAll: () => void;
  // completed and canceled exports leave the list; failed ones stay for Retry
  clearFinished: () => Promise<void>;
  retryAll: () => Promise<void>;
  resumeExports: () => Promise<void>;
  copyDiagnostics: (itemId?: string) => Promise<void>;
  toggleExports: () => void;
  // opens Exports with focus on this export's row
  showExport: (itemId: string) => void;
  removeQueueItem: (itemId: string) => Promise<void>;
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

  // "1 waiting · 2 paused · 1 failed · saved 1.1 GB", with the failures in warning colour
  const paintQueueCounts = (waiting: number, paused: number, failed: number, saved: number): void => {
    const counts = byId("qcnt");
    if (!counts) return;
    const doc = counts.ownerDocument;
    const parts: Node[] = [];
    const add = (text: string, className = ""): void => {
      if (parts.length) {
        const sep = doc.createElement("span");
        sep.textContent = " · ";
        if (className === "q-saved") sep.className = "q-saved-sep";
        parts.push(sep);
      }
      const part = doc.createElement("span");
      if (className) part.className = className;
      part.textContent = text;
      parts.push(part);
    };
    if (waiting) add(`${waiting} waiting`);
    if (paused) add(`${paused} paused`);
    if (failed) add(`${failed} failed`, "q-failed");
    if (saved > 0) add(`saved ${formatBytes(saved)}`, "q-saved");
    counts.replaceChildren(...parts);
  };

  let exportsOpen = false;
  let lastItems: readonly QueueItem[] = [];
  // the Exports panel and the Library both show where a copy stands
  const fileCopy = createExportFileCopy(path => client().copyFile(path), () => {
    renderExports(lastItems);
    deps.renderClips();
  });

  let closeTicket = 0;

  // the panel stays in place while it animates away; opening it again in the meantime keeps it
  function closeExportsPanel(panel: HTMLElement): void {
    if (panel.hidden) return;
    const ticket = ++closeTicket;
    panel.classList.add("closing");
    const finish = (): void => {
      if (ticket !== closeTicket) return;
      panel.classList.remove("closing");
      panel.hidden = true;
    };
    const animations = typeof panel.getAnimations === "function" ? panel.getAnimations() : [];
    if (!animations.length) {
      finish();
      return;
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
  }

  function setExportsOpen(open: boolean, returnFocus = false): void {
    const panel = byId("exports-panel");
    const status = byId("qstatus");
    exportsOpen = open && lastItems.length > 0;
    // the panel's own opening motion covers its first paint, so its rows don't each animate too
    if (!exportsOpen) shownRowIds = null;
    if (panel && exportsOpen) {
      closeTicket += 1;
      panel.classList.remove("closing");
      panel.hidden = false;
    } else if (panel) {
      closeExportsPanel(panel);
    }
    status?.setAttribute("aria-expanded", String(exportsOpen));
    if (exportsOpen) renderExports(lastItems);
    if (!exportsOpen && returnFocus) status?.focus();
  }

  function toggleExports(): void {
    setExportsOpen(!exportsOpen);
  }

  // the batch toast's Show opens the list at the first failed export, ready to retry
  function showFailures(itemIds: readonly string[]): void {
    setExportsOpen(true);
    const buttons = Array.from(byId("exports-list")?.querySelectorAll<HTMLElement>("button") ?? []);
    const retry = buttons.find(
      (button) => button.dataset.itemId === itemIds[0] && button.dataset.actionClick === "export-item-retry",
    );
    (retry ?? byId("qstatus"))?.focus();
  }

  // a video's export button opens the list at that export, so its Cancel is one key away
  function showExport(itemId: string): void {
    setExportsOpen(true);
    const buttons = Array.from(byId("exports-list")?.querySelectorAll<HTMLElement>("button") ?? []);
    const row = buttons.find((button) => button.dataset.itemId === itemId);
    (row ?? byId("qstatus"))?.focus();
  }

  function sourceSize(path: string): number {
    const clip = session.clips[path] ?? Object.values(session.clips).find((item) => item?.probeData?.path === path);
    return Number(clip?._fileSize) || 0;
  }

  function exportRowElement(doc: Document, row: ExportRow): HTMLElement {
    const element = doc.createElement("div");
    element.className = `exports-row ${row.kind}`;
    element.dataset.exportId = row.id;
    const name = doc.createElement("span");
    name.className = "exports-name";
    name.textContent = row.name;
    name.title = row.name;
    element.append(name);
    if (row.action) {
      const labels = { cancel: "Cancel", retry: "Retry", show: "Show" } as const;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "exports-btn";
      button.textContent = labels[row.action];
      button.setAttribute("aria-label", `${labels[row.action]} ${row.name}`);
      // aria-disabled rather than disabled, so a keyboard user's focus stays on the row while it waits
      const pending = rowRequests[row.id];
      if (pending && pending === row.action) {
        button.textContent = pending === "cancel" ? "Canceling…" : "Retrying…";
        button.setAttribute("aria-disabled", "true");
      }
      button.dataset.actionClick = `export-item-${row.action}`;
      button.dataset.itemId = row.id;
      if (row.action === "show") button.dataset.resultPath = row.resultPath;
      if (row.action === "show") {
        const actions = doc.createElement("span");
        actions.className = "exports-actions";
        const open = doc.createElement("button");
        open.type = "button";
        open.className = "exports-btn";
        open.textContent = "Open";
        open.setAttribute("aria-label", `Open ${row.name}`);
        open.dataset.actionClick = "export-item-open";
        open.dataset.itemId = row.id;
        const copy = doc.createElement("button");
        const state = fileCopy.state(row.id, row.resultPath);
        copy.type = "button";
        copy.className = "exports-btn exports-copy";
        copy.textContent = state.label;
        copy.setAttribute("aria-label", `Copy file for ${row.name}`);
        if (state.disabled) copy.setAttribute("aria-disabled", "true");
        copy.dataset.actionClick = "export-item-copy-file";
        copy.dataset.itemId = row.id;
        actions.append(open, copy, button);
        element.append(actions);
      } else {
        element.append(button);
      }
    }
    const detail = doc.createElement("span");
    detail.className = row.kind === "failed" ? "exports-detail failed" : "exports-detail";
    if (row.sizes) {
      const sizes = doc.createElement("span");
      sizes.className = "exports-sizes";
      const smaller = doc.createElement("span");
      smaller.className = "exports-smaller";
      smaller.textContent = formatBytes(row.sizes.to);
      sizes.append(`${formatBytes(row.sizes.from)} → `, smaller);
      detail.append(sizes);
      if (row.sizes.from > row.sizes.to) {
        detail.append(` · saved ${Math.round((1 - row.sizes.to / row.sizes.from) * 100)}%`);
      }
      if (row.note) detail.append(` · ${row.note}`);
    } else {
      detail.textContent = row.note && row.detail ? `${row.detail} · ${row.note}` : row.note || row.detail;
    }
    detail.title = detail.textContent ?? "";
    element.append(detail);
    const copyError = fileCopy.state(row.id, row.resultPath).error;
    if (copyError) {
      const error = doc.createElement("span");
      error.className = "exports-copy-error";
      error.textContent = `${copyError} Use Show to find the file.`;
      element.append(error);
    }
    // a failed export can hand over its log; failed, cancelled and paused ones can leave the list
    if (row.kind === "failed" || row.kind === "cancelled" || row.kind === "paused") {
      const more = doc.createElement("span");
      more.className = "exports-more";
      const link = (label: string, action: string, name: string): HTMLButtonElement => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "exports-link";
        button.textContent = label;
        button.setAttribute("aria-label", name);
        button.dataset.actionClick = action;
        button.dataset.itemId = row.id;
        return button;
      };
      if (row.kind === "failed") {
        more.append(link("Copy details", "export-item-copy-details", `Copy details for ${row.name}`));
      }
      more.append(link("Remove", "export-item-remove", `Remove ${row.name} from Exports`));
      element.append(more);
    }
    if (row.kind === "running" && row.progress !== null) {
      const bar = doc.createElement("span");
      bar.className = "exports-bar";
      const fill = doc.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, row.progress))}%`;
      bar.append(fill);
      element.append(bar);
    }
    return element;
  }

  // the exports already listed while the panel is open; null until the panel's first paint
  let shownRowIds: Set<string> | null = null;

  function renderExports(items: readonly QueueItem[]): void {
    const list = byId("exports-list");
    if (!list) return;
    const doc = list.ownerDocument;
    const rows = exportRows(items, sourceSize, formatTime, queueView);
    // polling repaints the list; keep the focused button focused
    const active = doc.activeElement;
    const focused = active instanceof HTMLElement && list.contains(active)
      ? { id: active.dataset.itemId ?? "", action: active.dataset.actionClick ?? "" }
      : null;
    const nodes: HTMLElement[] = [];
    const group = (label: string, groupRows: readonly ExportRow[]): void => {
      if (!groupRows.length) return;
      if (label) {
        const heading = doc.createElement("div");
        heading.className = "exports-group";
        heading.textContent = label;
        nodes.push(heading);
      }
      for (const row of groupRows) nodes.push(exportRowElement(doc, row));
    };
    group("", rows.running);
    group("Waiting", rows.waiting);
    if (rows.paused.length) nodes.push(pausedHeading(doc, rows.paused.length));
    group("", rows.paused);
    group("Finished", rows.finished);
    list.replaceChildren(...nodes);
    // an export added while the list is open fades into its place, once; polls never replay it
    const listed = new Set([...rows.running, ...rows.waiting, ...rows.paused, ...rows.finished].map((row) => row.id));
    if (shownRowIds && motionEnabled(doc)) {
      for (const element of list.querySelectorAll<HTMLElement>(".exports-row")) {
        const id = element.dataset.exportId ?? "";
        if (!id || shownRowIds.has(id) || typeof element.animate !== "function") continue;
        element.animate(
          [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
          { duration: 160, easing: EASE_OUT },
        );
      }
    }
    shownRowIds = listed;
    if (focused?.id || focused?.action === "queue-resume") {
      const match = Array.from(list.querySelectorAll<HTMLElement>("button")).find(
        (button) => (button.dataset.itemId ?? "") === focused.id && button.dataset.actionClick === focused.action,
      );
      match?.focus();
    }
    const retry = byId<HTMLButtonElement>("btn-retry-all");
    if (retry) {
      const count = queueView.retryable;
      retry.hidden = count === 0;
      retry.textContent = `Retry all (${count})`;
    }
    text("exports-count", `${items.length} this session`);
    const saved = byId("exports-saved");
    if (saved) {
      if (rows.saved > 0) {
        const amount = doc.createElement("b");
        amount.textContent = formatBytes(rows.saved);
        saved.replaceChildren("Saved ", amount, " so far");
      } else {
        saved.replaceChildren();
      }
    }
  }

  // exports from before Tuck closed say why they wait, with the one control that starts them
  function pausedHeading(doc: Document, count: number): HTMLElement {
    const heading = doc.createElement("div");
    heading.className = "exports-group exports-group-paused";
    const label = doc.createElement("span");
    label.textContent = "Paused when Tuck closed";
    const resume = doc.createElement("button");
    resume.type = "button";
    resume.className = "exports-btn exports-resume";
    resume.textContent = headerRequest === "resume" ? "Resuming…" : "Resume";
    resume.setAttribute("aria-label", count === 1 ? "Resume 1 paused export" : `Resume ${count} paused exports`);
    if (headerRequest === "resume") resume.setAttribute("aria-disabled", "true");
    resume.dataset.actionClick = "queue-resume";
    heading.append(label, resume);
    return heading;
  }

  function installExportsDismissal(): void {
    const panel = byId("exports-panel");
    const status = byId("qstatus");
    if (!panel || !status) return;
    const doc = panel.ownerDocument;
    doc.addEventListener("pointerdown", (event) => {
      if (!exportsOpen) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && (panel.contains(target) || status.contains(target))) return;
      // confirming Stop after this or Cancel all happens in a dialog above; the panel stays open for it
      if (target instanceof Element && target.closest("#mod-overlay, #toast-ct")) return;
      setExportsOpen(false);
    });
    // Escape closes the panel before any editor shortcut sees it
    doc.addEventListener("keydown", (event) => {
      if (!exportsOpen || event.key !== "Escape") return;
      // a confirmation dialog above the panel takes Escape first
      if (doc.getElementById("mod-overlay")?.classList.contains("open")) return;
      event.preventDefault();
      event.stopPropagation();
      setExportsOpen(false, true);
    }, true);
  }

  let queueItemsById: Record<string, QueueItem> = {};
  const queueActiveItemIds: Record<string, true> = {};
  // a Cancel or Retry the backend hasn't answered yet; rows are rebuilt on every poll, so it lives here
  const rowRequests: Record<string, "cancel" | "retry"> = {};
  // a Retry all or Resume the backend hasn't answered yet
  let headerRequest: "" | "retry-all" | "resume" = "";
  let queueView: QueueViewState = emptyQueueView();
  let watchedExports: Record<string, WatchedExport> = {};
  // failures already told to screen reader users while the rest of their batch kept going
  const announcedFailures = new Set<string>();
  let pollingQueue = false;
  let taskbar: TaskbarProgress = TASKBAR_IDLE;

  function showTaskbar(next: TaskbarProgress): void {
    if (!next.flash && next.state === taskbar.state && next.progress === taskbar.progress) return;
    taskbar = next;
    // the taskbar only mirrors the queue bar, so a desktop without support loses nothing
    void client().setTaskbarProgress(next.state, next.progress, next.flash);
  }

  // the red button has done its job once the user is back in Tuck
  window.addEventListener("focus", () => {
    if (taskbar.state === "error") showTaskbar(TASKBAR_IDLE);
  });

  function libraryPath(sourcePath: string): string | null {
    if (session.clips[sourcePath]) return sourcePath;
    return Object.keys(session.clips).find((path) => session.clips[path]?.probeData?.path === sourcePath) ?? null;
  }

  function mapQueueItems(items: readonly QueueItem[], view: QueueViewState): void {
    const map: Record<string, QueueItem> = {};
    queueItemsById = {};
    for (const item of items) {
      // an export from before Tuck last closed was planned from edits that are gone, so it
      // never speaks for a video added to the Library since
      if (item.source_path && !item.restored) map[item.source_path] = item;
      if (item.id) queueItemsById[item.id] = item;
    }
    for (const path of Object.keys(session.clips)) {
      const clip = session.clips[path];
      if (!clip) continue;
      const resolvedPath = clip.probeData?.path;
      const item = map[path] ?? (typeof resolvedPath === "string" ? map[resolvedPath] : undefined);
      if (item) {
        // failures are told once per batch, when it finishes, rather than one toast each
        clip._queueState = item.state ?? "";
        clip._queueItemId = item.id ?? "";
        // the card and the queue bar name the same try of a size retry
        clip._statusText = formatQueueStatus(item, item.id && item.id === view.runningItemId ? view.attempt : 1);
        clip._progress = item.progress || 0;
        clip._progressIndeterminate = item.progress_info?.indeterminate === true;
        if (item.error) clip._queueError = item.error;
        if (item.result_size) clip._resultSize = Number(item.result_size);
        if (item.result_path) clip._resultPath = item.result_path;
        const fit = targetFit(item);
        clip._resultTarget = fit?.target ?? 0;
        clip._resultFits = fit?.fits ?? false;
        clip._resultNote = resultNote(item);
        clip._resultNoteDetail = resultNoteDetail(item);
      } else if (isQueueActive(clip._queueState)) {
        clip._queueState = "";
        clip._statusText = "";
      }
    }
  }

  // clearing a finished export keeps its video and edits in the Library; only the result goes
  function forgetFinishedExport(clip: EditorClip): void {
    clip._queueState = "";
    clip._queueItemId = "";
    clip._statusText = "";
    clip._progress = 0;
    clip._progressIndeterminate = false;
    delete clip._resultPath;
    delete clip._resultSize;
    delete clip._resultTarget;
    delete clip._resultFits;
    delete clip._resultNote;
    delete clip._resultNoteDetail;
  }

  // the queue bar's own text isn't read out, so starting and failing exports are said here;
  // the end of a batch is said by its toast
  function announceQueueChanges(previous: QueueViewState, items: readonly QueueItem[]): void {
    const active = items.filter((item) => isQueueActive(item.state));
    if (!previous.hadActive && active.length) {
      const first = active[0]!;
      announce(active.length === 1
        ? `Exporting “${first.source ?? "video"}”.`
        : `Exporting ${active.length} videos.`);
    }
    if (!active.length) {
      announcedFailures.clear();
      return;
    }
    for (const item of items) {
      if (item.state !== "failed" || !item.id || announcedFailures.has(item.id) || !queueActiveItemIds[item.id]) continue;
      announcedFailures.add(item.id);
      announce(`Couldn’t export “${item.source ?? "a video"}”.`);
    }
  }

  async function pollQueue(): Promise<void> {
    if (pollingQueue) return;
    pollingQueue = true;
    let clearFinished = false;
    let removeVideos: string[] = [];
    try {
      const state = await legacyBackendResult(client().getQueueState());
      if (!state.ok || !Array.isArray(state.items)) return;
      const items = queueItemsFromSnapshot(state.items);
      const previous = queueView;
      queueView = reduceQueueSnapshot(previous, { items }, formatTime);
      mapQueueItems(items, queueView);
      watchedExports = watchExports(items, watchedExports, libraryPath, deps.editCount);
      if (!deps.isReordering()) deps.renderClips();

      for (const item of items) if (item.state === "running" && item.id) queueActiveItemIds[item.id] = true;

      announceQueueChanges(previous, items);
      const nextTaskbar = taskbarProgress(items, queueView, taskbar);
      showTaskbar(
        nextTaskbar.flash && session.appSettings.notify_when_done === false ? { ...nextTaskbar, flash: false } : nextTaskbar,
      );

      const summary = queueView.finishedToast;
      const bar = byId("qbar");
      // a batch with any failure shows a warning instead of the success check
      bar?.classList.toggle("has-failed", queueView.finished && queueView.failed > 0);
      if (bar && (summary || !queueView.finished)) bar.classList.remove("just-finished");
      if (bar && summary?.kind === "ok") {
        // restart the one-shot finish animation for this batch
        void bar.offsetWidth;
        bar.classList.add("just-finished");
      }
      if (summary) {
        const failedIds = summary.failedIds;
        toast(
          summary.message,
          summary.kind,
          failedIds.length ? { label: "Show", run: () => showFailures(failedIds) } : undefined,
        );
        // Settings promises this when the queue finishes; failed and cancelled exports stay
        clearFinished = session.appSettings.clear_completed_automatically === true;
        // the whole batch goes at once, so one Undo message covers every video
        if (session.appSettings.remove_after_export === true) {
          removeVideos = videosToRemoveAfterExport(items, previous.activeItemIds, watchedExports, deps.editCount);
        }
        if (session.appSettings.notify_when_done !== false) {
          const note = finishedNotification(items, previous.activeItemIds);
          // the system notification only shows while Tuck is in the background
          if (note) void client().notifyWhenUnfocused(note.title, note.body);
        }
      }
      if (queueView.outputToOpen && session.appSettings.open_output_folder_after_queue) {
        await openResult(queueView.outputToOpen);
      }
      Object.keys(queueActiveItemIds).forEach((id) => {
        if (!queueView.activeItemIds[id]) delete queueActiveItemIds[id];
      });

      toggleHidden("qbar", !queueView.barVisible);
      byId("qbar")?.classList.toggle("finished", queueView.finished);
      byId("qbar")?.classList.toggle("paused", !queueView.active && queueView.paused > 0);
      setDisabled("btn-stop-after", queueView.stopAfterDisabled);
      setDisabled("btn-cancel", queueView.cancelDisabled);
      setDisabled("btn-clear", queueView.clearDisabled);
      lastItems = items;
      if (!items.length) {
        setExportsOpen(false);
        return;
      }
      if (exportsOpen) renderExports(items);
      const saved = queueView.finished ? exportRows(items, sourceSize).saved : 0;
      // with nothing running the bar's own label already counts the paused exports
      paintQueueCounts(queueView.waiting, queueView.active ? queueView.paused : 0, queueView.failed, saved);
      const progress = byId<HTMLProgressElement>("qprog");
      if (progress) {
        if (queueView.indeterminate) progress.removeAttribute("value");
        else progress.value = queueView.progress;
        progress.setAttribute("aria-valuetext", [queueView.fname, queueView.detail].filter(Boolean).join(" · "));
      }
      text("qeta", queueView.detail);
      text("qfname", queueView.fname);
      const filename = byId("qfname");
      if (filename) filename.title = queueView.fname;
    } catch {
      /* polling errors are transient */
    } finally {
      pollingQueue = false;
    }
    for (const path of removeVideos) deps.removeClip(path);
    if (clearFinished) await clearCompletedAutomatically();
  }

  function startRowRequest(itemId: string, action: "cancel" | "retry"): boolean {
    if (!itemId || rowRequests[itemId]) return false;
    rowRequests[itemId] = action;
    if (exportsOpen) renderExports(lastItems);
    return true;
  }

  function endRowRequest(itemId: string): void {
    delete rowRequests[itemId];
    if (exportsOpen) renderExports(lastItems);
  }

  async function cancelQueueItem(itemId: string): Promise<void> {
    if (!startRowRequest(itemId, "cancel")) return;
    // the row keeps its pending label until the queue state after the request is painted
    try {
      const r = await legacyBackendResult(client().cancelItem(itemId));
      if (!r.ok) toast(withReason("Couldn’t cancel that export.", r.error), "err");
      await pollQueue();
    } catch {
      toast("Couldn’t cancel that export. Try again.", "err");
    } finally {
      endRowRequest(itemId);
    }
  }

  async function retryQueueItem(itemId: string): Promise<void> {
    if (!startRowRequest(itemId, "retry")) return;
    try {
      const r = await legacyBackendResult(client().retryItem(itemId));
      if (!r.ok) toast(withReason("Couldn’t retry that export.", r.error), "err");
      await pollQueue();
    } finally {
      endRowRequest(itemId);
    }
  }

  // takes a finished, failed or cancelled export off the list; focus moves to the row that takes its place
  async function removeQueueItem(itemId: string): Promise<void> {
    if (!itemId) return;
    const rows = Array.from(byId("exports-list")?.querySelectorAll<HTMLElement>(".exports-row") ?? []);
    const index = rows.findIndex((row) => row.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`));
    const r = await legacyBackendResult(client().removeItem(itemId));
    if (!r.ok) {
      toast(withReason("Couldn’t remove that export.", r.error), "err");
      return;
    }
    await pollQueue();
    const after = Array.from(byId("exports-list")?.querySelectorAll<HTMLElement>(".exports-row") ?? []);
    const next = after[Math.min(Math.max(index, 0), after.length - 1)]?.querySelector<HTMLElement>("button");
    (next ?? byId("qstatus"))?.focus();
  }

  async function copyResult(itemId: string): Promise<void> {
    const item = queueItemsById[itemId];
    if (item?.state !== "completed" || !item.result_path) return;
    const path = item.result_path;
    const result = await fileCopy.copy(itemId, path);
    if (result === "copied") toast("File copied to clipboard.", "ok");
    else if (result === "error") toast(fileCopy.state(itemId, path).error, "err");
  }

  function finishedExport(itemId: string): QueueItem | null {
    const item = queueItemsById[itemId];
    return item?.state === "completed" && item.result_path ? item : null;
  }

  async function openExportFile(itemId: string): Promise<void> {
    if (!finishedExport(itemId)) return;
    try {
      const result = await client().openExportFile(itemId);
      if (!result.ok) toast(withReason("Couldn’t open the export.", result.error.message), "err");
    } catch {
      toast("Couldn’t open the export. Try again.", "err");
    }
  }

  async function dragExportOut(itemId: string): Promise<void> {
    if (!finishedExport(itemId)) return;
    try {
      const result = await client().startExportDrag(itemId);
      if (!result.ok) toast(withReason("Couldn’t drag the export.", result.error.message, "Use Copy file instead."), "err");
    } catch {
      toast("Couldn’t drag the export. Use Copy file instead.", "err");
    }
  }

  async function openResult(path: string): Promise<void> {
    if (!path) return;
    try {
      const r = await legacyBackendResult(client().openOutputFolder(path));
      if (!r.ok) toast(withReason("Couldn’t show the export in its folder.", r.error), "err");
    } catch {
      toast("Couldn’t show the export in its folder. Try again.", "err");
    }
  }

  function stopAfterCurrent(): void {
    confirmToast("The export in progress finishes. Exports still waiting in the queue are canceled.", () => {
      void (async (): Promise<void> => {
        const r = await legacyBackendResult(client().stopAfterCurrent());
        if (!r.ok) {
          toast(withReason("Couldn’t stop the queue.", r.error), "err");
        } else {
          toast("The queue stops after this export.", "ok");
          void pollQueue();
        }
      })();
    }, { title: "Stop after this export?", confirmLabel: "Stop after this", cancelLabel: "Keep exporting" });
  }

  function cancelAll(): void {
    confirmToast("The export in progress stops and everything waiting in the queue is canceled. Finished exports are kept.", () => {
      void (async (): Promise<void> => {
        try {
          const r = await legacyBackendResult(client().cancelAllItems());
          // once the queue settles, the batch message says what was cancelled
          if (!r.ok) toast(withReason("Couldn’t cancel the exports.", r.error), "err");
        } catch {
          toast("Couldn’t cancel the exports. Try again.", "err");
        }
        await pollQueue();
      })();
    }, { title: "Cancel all exports?", confirmLabel: "Cancel exports", cancelLabel: "Keep exporting", danger: true });
  }

  // the export the backend just queued again, or the first one still listed, so focus never
  // falls out of the panel when the button that was pressed goes away
  function focusInExports(itemId = ""): void {
    const buttons = Array.from(byId("exports-list")?.querySelectorAll<HTMLElement>("button") ?? []);
    const next = buttons.find((button) => itemId && button.dataset.itemId === itemId) ?? buttons[0];
    const status = byId("qstatus");
    (next ?? (byId("qbar")?.classList.contains("hid") ? null : status))?.focus();
  }

  async function runHeaderRequest(
    kind: "retry-all" | "resume",
    request: () => Promise<BackendResult<QueuedIdsPayload>>,
    failure: string,
  ): Promise<void> {
    if (headerRequest) return;
    headerRequest = kind;
    if (exportsOpen) renderExports(lastItems);
    let firstId = "";
    try {
      const result = await request();
      if (!result.ok) {
        toast(withReason(failure, result.error.message), "err");
        return;
      }
      firstId = result.value.item_ids[0] ?? "";
    } catch {
      toast(`${failure} Try again.`, "err");
      return;
    } finally {
      headerRequest = "";
    }
    await pollQueue();
    focusInExports(firstId);
  }

  // every failed and canceled export goes back to the queue in list order, each in its own row
  function retryAll(): Promise<void> {
    return runHeaderRequest("retry-all", () => client().retryAllItems(), "Couldn’t retry the exports.");
  }

  function resumeExports(): Promise<void> {
    return runHeaderRequest("resume", () => client().resumeExports(), "Couldn’t resume the exports.");
  }

  // "Clear finished jobs" in Settings; canceled exports stay so Retry all can still reach them
  async function clearCompletedAutomatically(): Promise<void> {
    const r = await legacyBackendResult(client().clearCompleted());
    if (!r.ok) {
      toast(withReason("Couldn’t clear finished exports.", r.error), "err");
      return;
    }
    for (const clip of Object.values(session.clips)) {
      if (clip?._queueState === "completed") forgetFinishedExport(clip);
    }
    await pollQueue();
    deps.renderClips();
  }

  async function clearFinished(): Promise<void> {
    const r = await legacyBackendResult(client().clearFinished());
    if (!r.ok) {
      toast(withReason("Couldn’t clear finished exports.", r.error), "err");
      return;
    }
    for (const clip of Object.values(session.clips)) {
      if (clip?._queueState === "completed" || clip?._queueState === "cancelled") forgetFinishedExport(clip);
    }
    const count = Number(r.count) || 0;
    toast(count === 1 ? "Cleared 1 finished export." : `Cleared ${count} finished exports.`, "ok");
    const clear = byId("btn-clear");
    const hadFocus = clear !== null && clear.ownerDocument.activeElement === clear;
    await pollQueue();
    deps.renderClips();
    // the button is disabled now that nothing is left to clear
    if (hadFocus) focusInExports();
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
          : byId<HTMLInputElement>("res-mode")?.value === "short_side"
            ? `${value("res-short")}p`
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
    const preview = await deps.previewReport?.();
    if (preview) ctx.preview = preview;
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

  installExportsDismissal();

  return {
    pollQueue,
    pollIpc,
    cancelQueueItem,
    retryQueueItem,
    openResult,
    copyResult,
    copyResultState: (itemId, path) => {
      const state = fileCopy.state(itemId, path);
      return { disabled: state.disabled, label: state.label };
    },
    openExportFile,
    dragExportOut,
    stopAfterCurrent,
    cancelAll,
    clearFinished,
    retryAll,
    resumeExports,
    copyDiagnostics,
    toggleExports,
    showExport,
    removeQueueItem,
  };
}

export type { EditorClip };
