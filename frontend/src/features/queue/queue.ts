import type { BackendClient, BackendResult, JsonObject, QueuedIdsPayload } from "../../backend/types.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import { formatBytes, formatTarget, formatTime, withReason } from "../editor/format.ts";
import { exportBarView, passFills, type ExportBarView } from "./export-bar.ts";
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
  /** whether the desktop shell can drag a finished export out of the window as a file */
  canDragOut?: () => boolean;
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
  /** several finished exports' files as one copy, for the bar's Copy files */
  copyResults: (itemIds: readonly string[]) => Promise<void>;
  // where copying this export's file stands, for the Library's Copy file button
  copyResultState: (itemId: string, path: string) => { disabled: boolean; label: string };
  openExportFile: (itemId: string) => Promise<void>;
  dragExportOut: (itemId: string) => Promise<void>;
  dragExportsOut: (itemIds: readonly string[]) => Promise<void>;
  stopAfterCurrent: () => void;
  cancelAll: () => void;
  // completed and canceled exports leave the list; failed ones stay for Retry
  clearFinished: () => Promise<void>;
  retryAll: () => Promise<void>;
  resumeExports: () => Promise<void>;
  copyDiagnostics: (itemId?: string) => Promise<void>;
  /** `fromKeyboard` moves focus into the panel, since the export button sits between them */
  toggleExports: (fromKeyboard?: boolean) => void;
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

  let exportsOpen = false;
  let lastItems: readonly QueueItem[] = [];
  let barView: ExportBarView = { kind: "hidden" };
  // the Exports panel, the Library and the bar all show where a copy stands
  const fileCopy = createExportFileCopy(path => client().copyFile(path), () => {
    renderExports(lastItems);
    deps.renderClips();
    paintExportBar(barView);
  }, paths => client().copyFiles(paths));

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
    // focus inside a closing panel would be lost with it, so it goes back to the status button
    const focusInside = !!panel && panel.contains(panel.ownerDocument.activeElement);
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
    if (!exportsOpen && (returnFocus || focusInside)) status?.focus();
  }

  function toggleExports(fromKeyboard = false): void {
    setExportsOpen(!exportsOpen);
    if (exportsOpen && fromKeyboard) byId("exports-title")?.focus();
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

  function thumbnailFor(path: string): string {
    const clip = session.clips[path] ?? Object.values(session.clips).find((item) => item?.probeData?.path === path);
    return clip && !clip.error ? clip._thumbnail || "" : "";
  }

  const SVG = "http://www.w3.org/2000/svg";
  const PATHS = {
    check: ["m3.5 8.5 3 3 6-7"],
    badge: ["m2.5 6.4 2.3 2.3 4.7-5.4"],
    warn: ["M8 2.5 14 13H2Z", "M8 6.5v3M8 11.3v.2"],
    pause: ["M6 4v8M10 4v8"],
    stop: ["M4.5 4.5l7 7M11.5 4.5l-7 7"],
    copy: [
      "M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5Z",
      "M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5",
    ],
    folder: ["M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z"],
    clear: ["M3 3l6 6M9 3l-6 6"],
  } as const;

  function icon(doc: Document, paths: readonly string[], viewBox = "0 0 16 16"): SVGSVGElement {
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = doc.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function element(doc: Document, tag: string, className: string): HTMLElement {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  // the video's own picture, or an empty frame of the same size so a running export keeps its shape
  function thumbnail(doc: Document, path: string, keepEmpty: boolean): HTMLElement | null {
    const url = thumbnailFor(path);
    if (!url && !keepEmpty) return null;
    const frame = element(doc, "span", "qthumb");
    if (url) {
      const image = doc.createElement("img");
      image.alt = "";
      // the picture drags the file, not the image itself
      image.draggable = false;
      image.src = url;
      frame.append(image);
    }
    return frame;
  }

  function badge(doc: Document): HTMLElement {
    const mark = element(doc, "span", "qbadge good");
    mark.append(icon(doc, PATHS.badge, "0 0 12 12"));
    return mark;
  }

  function mark(doc: Document, tone: "good" | "warn" | "quiet", paths: readonly string[]): HTMLElement {
    const node = element(doc, "span", `qmark ${tone}`);
    node.append(icon(doc, paths));
    return node;
  }

  // the result's actions are icons named by their tooltip; Retry and Resume stay words
  function iconButton(doc: Document, action: string, label: string, paths: readonly string[], data: Record<string, string> = {}, extra = ""): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = extra ? `qicon ${extra}` : "qicon";
    button.dataset.actionClick = action;
    button.dataset.tip = label;
    button.setAttribute("aria-label", label);
    Object.assign(button.dataset, data);
    button.append(icon(doc, paths, action === "queue-clear-finished" ? "0 0 12 12" : "0 0 16 16"));
    return button;
  }

  function wordButton(doc: Document, action: string, label: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "qaction";
    button.dataset.actionClick = action;
    button.textContent = label;
    return button;
  }

  function copyButton(doc: Document, key: string, path: string, idle: string, action: string, data: Record<string, string>): HTMLButtonElement {
    const state = fileCopy.state(key, path);
    const label = state.status === "idle" ? idle : state.label;
    const button = iconButton(doc, action, label, state.status === "copied" ? PATHS.check : PATHS.copy, data, state.status === "copied" ? "done" : "");
    // aria-disabled rather than disabled, so focus stays on the button while the clipboard is busy
    if (state.disabled) button.setAttribute("aria-disabled", "true");
    return button;
  }

  const batchKey = (itemIds: readonly string[]): string => `batch:${itemIds.join(",")}`;

  // every poll repaints the bar; a part that came out the same stays, so a press on the picture or
  // focus on a button lives through the poll, and a changed one keeps focus on the same action
  function replaceIfChanged(shown: HTMLElement, next: HTMLElement): void {
    if (shown.innerHTML === next.innerHTML) return;
    const active = shown.ownerDocument.activeElement;
    const focused = active instanceof HTMLElement && shown.contains(active) ? active.dataset.actionClick : undefined;
    shown.replaceChildren(...next.childNodes);
    if (focused) shown.querySelector<HTMLElement>(`[data-action-click="${focused}"]`)?.focus();
  }

  function paintExportBar(view: ExportBarView): void {
    const bar = byId("qbar");
    const status = byId("qstatus");
    const shownLead = byId("qlead");
    const name = byId("qfname");
    const percent = byId("qpct");
    const shownTrack = byId("qtrack");
    const line = byId("qeta");
    const shownFps = byId("qfps");
    const left = byId("qleft");
    const shownActions = byId("qactions");
    const progress = byId<HTMLProgressElement>("qprog");
    if (!bar || !status || !shownLead || !name || !percent || !shownTrack || !line || !shownFps || !left || !shownActions || !progress) return;
    const doc = bar.ownerDocument;
    bar.dataset.kind = view.kind;
    const lead = doc.createElement("span");
    const track = doc.createElement("span");
    const actions = doc.createElement("span");
    const fps = doc.createElement("span");
    percent.textContent = "";
    left.textContent = "";
    line.className = "";
    let title = "";
    let second = "";
    let label = "";
    const clear = (): HTMLButtonElement => iconButton(doc, "queue-clear-finished", "Clear finished exports", PATHS.clear, {}, "quiet");
    if (view.kind === "running") {
      lead.append(thumbnail(doc, view.sourcePath, true)!);
      title = view.title;
      const waiting = [view.waiting ? `${view.waiting} waiting` : "", view.failed ? `${view.failed} failed` : ""].filter(Boolean).join(" · ");
      if (view.percent !== null) {
        percent.textContent = `${view.percent}%`;
        for (const amount of passFills(view.percent, view.passes)) {
          const fill = element(doc, "span", "qfill");
          fill.style.width = `${amount}%`;
          const segment = element(doc, "span", "qseg");
          segment.append(fill);
          track.append(segment);
        }
        second = view.attempt || waiting;
        progress.value = view.percent;
      } else {
        second = view.attempt || [view.stage, waiting].filter(Boolean).join(" · ");
        progress.removeAttribute("value");
      }
      if (view.fps !== null) {
        const unit = doc.createElement("small");
        unit.textContent = "fps";
        fps.append(`${view.fps < 10 ? view.fps.toFixed(1) : Math.round(view.fps)} `, unit);
      }
      if (view.eta !== null) left.textContent = `${formatTime(view.eta)} left`;
      label = [
        `Exporting ${view.title}`,
        view.percent !== null ? `${view.percent}%` : view.stage,
        view.attempt,
        view.fps !== null ? `${Math.round(view.fps)} frames a second` : "",
        view.eta !== null ? `${formatTime(view.eta)} left` : "",
        waiting,
      ].filter(Boolean).join(", ");
    } else if (view.kind === "one") {
      const picture = thumbnail(doc, view.sourcePath, false);
      if (picture) {
        picture.append(badge(doc));
        if (deps.canDragOut?.()) {
          picture.dataset.dragOut = view.itemId;
          picture.title = "Drag the file into a chat or a folder";
        }
        lead.append(picture);
      }
      lead.append(mark(doc, "good", PATHS.check));
      title = view.title;
      if (view.missedTarget) {
        second = `${formatBytes(view.resultSize)}, over the ${formatTarget(view.missedTarget)} target`;
        line.className = "warn";
      } else if (view.resultSize && view.sourceSize) {
        second = `${formatBytes(view.resultSize)} · was ${formatBytes(view.sourceSize)}`;
      } else {
        second = formatBytes(view.resultSize);
      }
      // a copy that failed stays said here after its toast goes
      const copyError = fileCopy.state(view.itemId, view.resultPath).error;
      if (copyError) {
        second = copyError;
        line.className = "warn";
      }
      actions.append(
        copyButton(doc, view.itemId, view.resultPath, "Copy file", "export-item-copy-file", { itemId: view.itemId }),
        iconButton(doc, "export-item-show", "Show in folder", PATHS.folder, { resultPath: view.resultPath }),
        clear(),
      );
      label = `Exported ${view.title}${second ? `, ${second}` : ""}`;
    } else if (view.kind === "many") {
      const pictures = view.sourcePaths.map(thumbnailFor).filter(Boolean);
      if (pictures.length) {
        const stack = element(doc, "span", "qstack");
        pictures.forEach((url, index) => {
          const frame = element(doc, "span", "qthumb");
          // newest in front and lowest, older ones peeking out above and to the right
          frame.style.left = `${(pictures.length - 1 - index) * 5}px`;
          frame.style.top = `${index * 3}px`;
          frame.style.zIndex = String(index + 1);
          const image = doc.createElement("img");
          image.alt = "";
          image.draggable = false;
          image.src = url;
          frame.append(image);
          stack.append(frame);
        });
        stack.append(badge(doc));
        if (deps.canDragOut?.()) {
          stack.dataset.dragOut = view.itemIds.join(",");
          stack.title = `Drag the ${view.count} files into a chat or a folder`;
        }
        lead.append(stack);
      }
      lead.append(mark(doc, "good", PATHS.check));
      title = `${view.count} videos exported`;
      if (view.missedTarget) {
        second = view.missedTarget === 1 ? "1 is over its target size" : `${view.missedTarget} are over their target size`;
        line.className = "warn";
      } else {
        second = view.saved > 0 ? `${formatBytes(view.saved)} smaller in total` : `${formatBytes(view.total)} in total`;
      }
      const copyError = fileCopy.state(batchKey(view.itemIds), view.resultPaths.join("\n")).error;
      if (copyError) {
        second = copyError;
        line.className = "warn";
      }
      actions.append(
        copyButton(doc, batchKey(view.itemIds), view.resultPaths.join("\n"), `Copy ${view.count} files`, "exports-copy-files", { itemIds: view.itemIds.join(",") }),
        iconButton(doc, "export-item-show", "Show in folder", PATHS.folder, { resultPath: view.resultPath }),
        clear(),
      );
      label = `${title}, ${second}`;
    } else if (view.kind === "failed") {
      lead.append(mark(doc, "warn", PATHS.warn));
      title = view.finished ? `${view.failed} of ${view.failed + view.finished} failed` : view.title;
      second = view.error;
      line.className = "warn";
      actions.append(wordButton(doc, "queue-retry-all", "Retry"));
      label = view.finished ? `${title}. ${view.title}: ${view.error}` : `${view.title} failed: ${view.error}`;
    } else if (view.kind === "canceled") {
      lead.append(mark(doc, "quiet", PATHS.stop));
      title = view.count === 1 ? "1 export canceled" : `${view.count} exports canceled`;
      second = view.count === 1 ? "Retry starts it again" : "Retry starts them again";
      actions.append(wordButton(doc, "queue-retry-all", "Retry"), clear());
      label = title;
    } else if (view.kind === "paused") {
      lead.append(mark(doc, "quiet", PATHS.pause));
      title = view.count === 1 ? "1 export paused" : `${view.count} exports paused`;
      second = view.count === 1 ? "Resume starts it again" : "Resume starts them again";
      actions.append(wordButton(doc, "queue-resume", "Resume"));
      label = title;
    }
    replaceIfChanged(shownLead, lead);
    replaceIfChanged(shownTrack, track);
    replaceIfChanged(shownFps, fps);
    replaceIfChanged(shownActions, actions);
    name.textContent = title;
    name.title = title;
    // a count is never cut; a file name may be
    name.classList.toggle("count", view.kind === "many" || view.kind === "paused" || view.kind === "canceled" || (view.kind === "failed" && view.finished > 0));
    line.textContent = second;
    line.title = second;
    if (view.kind !== "running") progress.value = view.kind === "hidden" ? 0 : 100;
    progress.setAttribute("aria-valuetext", label);
    if (label) status.setAttribute("aria-label", `${label.replace(/[.!?]$/, "")}. Show Exports`);
    else status.removeAttribute("aria-label");
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
    if (row.kind === "failed") {
      // the reason and its next step are read with the row's buttons, and show whole while one has focus
      detail.id = `exports-detail-${row.id}`;
      for (const button of element.querySelectorAll("button")) button.setAttribute("aria-describedby", detail.id);
    }
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
        const copyDetails = link("Copy details", "export-item-copy-details", `Copy details for ${row.name}`);
        copyDetails.setAttribute("aria-describedby", detail.id);
        more.append(copyDetails);
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
      barView = exportBarView(items, queueView, sourceSize);
      paintExportBar(barView);
      if (!items.length) {
        setExportsOpen(false);
        return;
      }
      if (exportsOpen) renderExports(items);
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

  async function copyResults(itemIds: readonly string[]): Promise<void> {
    const finished = itemIds.filter((id) => finishedExport(id));
    if (!finished.length) return;
    if (finished.length === 1) return copyResult(finished[0]!);
    const paths = finished.map((id) => queueItemsById[id]?.result_path ?? "");
    const key = batchKey(finished);
    const result = await fileCopy.copyMany(key, paths);
    if (result === "copied") toast(`${paths.length} files copied to clipboard.`, "ok");
    else if (result === "error") toast(fileCopy.state(key, paths.join("\n")).error, "err");
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

  async function dragExportsOut(itemIds: readonly string[]): Promise<void> {
    const finished = itemIds.filter((id) => finishedExport(id));
    if (finished.length < 2) {
      if (finished[0]) await dragExportOut(finished[0]);
      return;
    }
    try {
      const result = await client().startExportsDrag(finished);
      if (!result.ok) toast(withReason("Couldn’t drag the exports.", result.error.message, "Use Copy files instead."), "err");
    } catch {
      toast("Couldn’t drag the exports. Use Copy files instead.", "err");
    }
  }

  // a press on a result's picture becomes a file drag once it moves as far as a Library drag would;
  // the shell starts the drag while the button is still down
  function installExportDrag(): void {
    const bar = byId("qbar");
    const view = bar?.ownerDocument.defaultView;
    if (!bar || !view) return;
    // the picture sits on the button that opens Exports; a drag that ends over it must not open it
    let dragged = false;
    bar.addEventListener("pointerdown", (event) => {
      dragged = false;
      if (event.button !== 0 || !deps.canDragOut?.()) return;
      const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drag-out]") : null;
      const ids = (handle?.dataset.dragOut ?? "").split(",").filter(Boolean);
      if (!ids.length) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const stop = (): void => {
        view.removeEventListener("pointermove", move, true);
        view.removeEventListener("pointerup", stop, true);
        view.removeEventListener("pointercancel", stop, true);
      };
      const move = (moved: PointerEvent): void => {
        if ((moved.buttons & 1) === 0) {
          stop();
          return;
        }
        const dx = moved.clientX - startX;
        const dy = moved.clientY - startY;
        if (dx * dx + dy * dy < 16) return;
        stop();
        dragged = true;
        void dragExportsOut(ids);
      };
      view.addEventListener("pointermove", move, true);
      view.addEventListener("pointerup", stop, true);
      view.addEventListener("pointercancel", stop, true);
    });
    view.addEventListener("click", (event) => {
      if (!dragged) return;
      dragged = false;
      if (event.target instanceof Node && bar.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
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
    confirmToast("The export in progress finishes. Waiting exports are canceled.", () => {
      void (async (): Promise<void> => {
        const r = await legacyBackendResult(client().stopAfterCurrent());
        if (!r.ok) {
          toast(withReason("Couldn’t stop after this export.", r.error), "err");
        } else {
          toast("Exports stop after this one.", "ok");
          void pollQueue();
        }
      })();
    }, { title: "Stop after this export?", confirmLabel: "Stop after this", cancelLabel: "Keep exporting" });
  }

  function cancelAll(): void {
    confirmToast("The export in progress stops and every waiting export is canceled. Finished exports are kept.", () => {
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
      two_pass: checked("two-pass"),
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
  installExportDrag();

  return {
    pollQueue,
    pollIpc,
    cancelQueueItem,
    retryQueueItem,
    openResult,
    copyResult,
    copyResults,
    copyResultState: (itemId, path) => {
      const state = fileCopy.state(itemId, path);
      return { disabled: state.disabled, label: state.label };
    },
    openExportFile,
    dragExportOut,
    dragExportsOut,
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
