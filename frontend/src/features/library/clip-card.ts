import { queuedVideoLabel, type QueueItemState } from "../queue/queue-view.ts";

export interface ClipCardElement {
  className: string;
  textContent: string | null;
  type?: string;
  dataset: { [key: string]: string | undefined };
  parentElement: ClipCardElement | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: ClipCardEvent) => void): void;
  appendChild(child: ClipCardElement): ClipCardElement;
}

export interface ClipCardDocument {
  createElement(tagName: string): ClipCardElement;
}

export interface ClipCardEvent {
  target?: ClipCardElement | EventTarget | null;
  key?: string;
  stopPropagation?(): void;
  preventDefault?(): void;
}

export interface ClipCardModel {
  path: string;
  name?: string;
  selected?: boolean | undefined;
  queueItemId?: string | undefined;
  queueState?: QueueItemState | "" | undefined;
  resultPath?: string | undefined;
  statusLabel?: string | undefined;
  // the full reason behind a failed export or unreadable file, shown on hover
  detail?: string | undefined;
  progress?: number | undefined;
  progressIndeterminate?: boolean | undefined;
  probeError?: unknown;
  // the media tool that has to be set up before this video can be read, e.g. "FFprobe"
  setupTool?: string | undefined;
  fileSize?: number | undefined;
  meta?: { text?: unknown } | null | undefined;
  // a frame from the video, or "" while none is available
  thumbnail?: string | undefined;
  duration?: string | undefined;
  // what the current task makes of this video, e.g. "1.2 GB" to "10 MB"
  result?: ClipResult | null | undefined;
  // the exported file's size once it is done
  resultSize?: string | undefined;
  // the size it aimed for, e.g. "10 MB", and whether it came in under it
  resultTarget?: string | undefined;
  resultFits?: boolean | undefined;
  // a short note the finished export keeps, with its whole reason for the tooltip
  resultNote?: string | undefined;
  resultNoteDetail?: string | undefined;
}

export interface ClipResult {
  from?: string | undefined;
  to?: string | undefined;
  // the estimate is over the target size
  over?: boolean | undefined;
}

export interface ClipCardCallbacks {
  select(path: string): void;
  togglePlay(path: string): void;
  remove(path: string): void;
  openResult(path: string): void;
  retry(id: string): void;
  retryProbe?(path: string): void;
  openToolSettings?(): void;
  beginReorder(event: ClipCardEvent, path: string, card: ClipCardElement): void;
}

export interface ClipGroup {
  key: string;
  label: string;
  items: ClipCardModel[];
}

function createElement<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  tagName: string,
  className?: string,
  text?: unknown,
): T {
  const element = documentRef.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function createActionButton<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  action: string,
  label: string,
  className: string,
): T {
  const button = createElement(documentRef, "button", className, label);
  button.type = "button";
  button.dataset.clipAction = action;
  button.dataset.noReorder = "1";
  button.setAttribute("title", label);
  button.setAttribute("aria-label", label);
  return button;
}

function actionFromTarget(
  target: ClipCardElement | EventTarget | null | undefined,
  card: ClipCardElement,
): string {
  let current =
    target && typeof target === "object" && "dataset" in target
      ? (target as ClipCardElement)
      : null;
  while (current && current !== card) {
    if (current.dataset && current.dataset.clipAction) {
      return current.dataset.clipAction;
    }
    current = current.parentElement;
  }
  return "";
}

function isExporting(model: ClipCardModel): boolean {
  return model.queueState === "running";
}

function exportProgress(model: ClipCardModel): number {
  return Math.max(0, Math.min(100, Number(model.progress) || 0));
}

// the picture and its length; while exporting, the progress runs along its bottom edge
function appendThumbnail<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  card: T,
  model: ClipCardModel,
): void {
  const frame = createElement(documentRef, "span", model.probeError ? "c-thumb unreadable" : "c-thumb");
  if (model.thumbnail) {
    const image = createElement(documentRef, "img");
    image.setAttribute("src", model.thumbnail);
    image.setAttribute("alt", "");
    image.setAttribute("draggable", "false");
    frame.appendChild(image);
  }
  if (model.duration) frame.appendChild(createElement(documentRef, "span", "c-dur", model.duration));
  if (isExporting(model)) {
    const track = createElement(documentRef, "span", model.progressIndeterminate ? "c-progress is-indeterminate" : "c-progress");
    const fill = createElement(documentRef, "span", "c-progress-fill");
    if (!model.progressIndeterminate) fill.setAttribute("style", "width:" + exportProgress(model) + "%");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Export progress");
    if (model.statusLabel) track.setAttribute("aria-valuetext", model.statusLabel);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    if (!model.progressIndeterminate) track.setAttribute("aria-valuenow", String(Math.round(exportProgress(model))));
    track.appendChild(fill);
    frame.appendChild(track);
  }
  card.appendChild(frame);
}

// one line under the name: where the export is, or what the current task makes of the video
function appendLine<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  main: T,
  model: ClipCardModel,
): void {
  const state = model.queueState || "";
  const line = createElement(documentRef, "div", "c-line");
  const text = (className: string, value: string): T => {
    const span = createElement(documentRef, "span", className, value);
    line.appendChild(span);
    return span;
  };
  if (isExporting(model)) {
    // the row names the phase, like "Pass 1 of 2"; speed and time left stay in the bottom bar
    line.className = "c-line run";
    text("c-status", queuedVideoLabel("running", model.statusLabel, exportProgress(model), model.progressIndeterminate));
  } else if (state === "pending") {
    line.className = "c-line queued";
    text("c-status", "Queued");
  } else if (state === "failed" || state === "cancelled" || model.probeError) {
    const attention = libraryGroup(model) === "attention";
    if (attention) line.className = "c-line attention";
    const status = text(attention ? "c-status attention" : "c-status", model.statusLabel || "");
    if (model.detail) status.dataset.tip = model.detail;
    if (model.setupTool) {
      const setup = createActionButton(documentRef, "open-tool-settings", "Set up " + model.setupTool + " in Settings", "c-act");
      setup.textContent = "Set up";
      line.appendChild(setup);
    } else if (model.probeError) {
      const retry = createActionButton(documentRef, "retry-probe", "Retry reading " + (model.name || ""), "c-act");
      retry.textContent = "Retry";
      line.appendChild(retry);
    } else if (model.queueItemId) {
      line.appendChild(createActionButton(documentRef, "retry", "Retry", "c-act"));
    }
  } else if (state === "completed") {
    line.className = "c-line done";
    text("c-status", model.resultSize || model.statusLabel || "Exported");
    if (model.resultSize && model.resultTarget) {
      text("c-sep", "·");
      text(model.resultFits ? "c-fit" : "c-fit over", `${model.resultFits ? "fits" : "over"} ${model.resultTarget}`);
    }
    if (model.resultPath) line.appendChild(createActionButton(documentRef, "open-result", "Show", "c-act"));
    if (model.resultNote) {
      main.appendChild(line);
      const note = createElement(documentRef, "div", "c-note", model.resultNote);
      if (model.resultNoteDetail) {
        note.dataset.tip = model.resultNoteDetail;
        note.setAttribute("aria-description", model.resultNoteDetail);
      }
      main.appendChild(note);
      return;
    }
  } else if (model.result && (model.result.from || model.result.to)) {
    const result = model.result;
    if (result.from) text("c-from", result.from);
    if (result.from && result.to) text("c-arrow", "→");
    if (result.to) text(result.over ? "c-to over" : "c-to", result.to);
    if (result.over) line.setAttribute("title", "The estimate is over the target size");
  } else {
    text("c-status", model.meta ? String(model.meta.text) : "");
  }
  main.appendChild(line);
}

function libraryGroup(model: ClipCardModel): string {
  if (model.queueState === "failed" || model.probeError) return "attention";
  return "videos";
}

// problems come first; everything else keeps the order the user gave it
export function groupClipModels(models: ClipCardModel[]): ClipGroup[] {
  const definitions = [
    { key: "attention", label: "Needs attention" },
    { key: "videos", label: "Videos" },
  ];
  return definitions
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      items: models.filter((model) => libraryGroup(model) === definition.key),
    }))
    .filter((group) => group.items.length > 0);
}

export function groupHeading(group: ClipGroup | null | undefined): string {
  return group ? group.label + " · " + group.items.length : "";
}

export function groupedClipPaths(models: ClipCardModel[]): string[] {
  return groupClipModels(models).reduce<string[]>((paths, group) => {
    return paths.concat(group.items.map((model) => model.path));
  }, []);
}

function formatLibrarySize(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

export function librarySummary(models: ClipCardModel[]): {
  countLabel: string;
  sizeLabel: string;
} {
  const bytes = models.reduce((total, model) => {
    return total + (Number(model.fileSize) || 0);
  }, 0);
  return {
    countLabel: models.length + (models.length === 1 ? " video" : " videos"),
    sizeLabel: formatLibrarySize(bytes),
  };
}

export function createClipCard<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  model: ClipCardModel,
  callbacks: ClipCardCallbacks,
): T {
  const name = model.name || "";
  const card = createElement(
    documentRef,
    "div",
    "clip clip-drag" + (model.selected ? " sel" : ""),
  );
  card.setAttribute("tabindex", "0");
  card.setAttribute("role", "option");
  card.setAttribute("aria-selected", model.selected ? "true" : "false");
  card.setAttribute("aria-keyshortcuts", "Enter Space Delete ArrowUp ArrowDown");
  // the row shows the name and one line; the full details sit on hover
  const meta = model.meta ? String(model.meta.text) : "";
  card.setAttribute("title", meta && meta !== "…" ? name + " · " + meta : name);
  card.dataset.clipPath = model.path;
  card.dataset.queueState = model.queueState || "ready";
  if (model.detail) card.setAttribute("aria-description", model.detail);
  if (model.queueItemId) card.dataset.queueItemId = model.queueItemId;

  const drag = createElement(documentRef, "span", "c-drag", "⋮⋮");
  drag.dataset.dragHandle = "1";
  drag.setAttribute("title", "Drag to reorder");
  drag.setAttribute("aria-label", "Drag to reorder");
  card.appendChild(drag);

  appendThumbnail(documentRef, card, model);
  const main = createElement(documentRef, "div", "c1");
  main.appendChild(createElement(documentRef, "div", "c2", name));
  appendLine(documentRef, main, model);
  card.appendChild(main);

  // a video in the queue is removed from the Exports panel instead
  if (!isExporting(model) && model.queueState !== "pending") {
    const remove = createActionButton(documentRef, "remove", "Remove " + name, "c4");
    remove.textContent = "✕";
    remove.setAttribute("tabindex", "0");
    card.appendChild(remove);
  }

  card.addEventListener("click", (event) => {
    const action = actionFromTarget(event.target, card);
    if (!action) {
      callbacks.select(model.path);
      return;
    }
    event.stopPropagation?.();
    if (action === "open-result") {
      const resultPath = model.resultPath;
      if (resultPath) callbacks.openResult(resultPath);
    } else if (action === "retry") {
      const queueItemId = model.queueItemId;
      if (queueItemId) callbacks.retry(queueItemId);
    } else if (action === "retry-probe") callbacks.retryProbe?.(model.path);
    else if (action === "open-tool-settings") callbacks.openToolSettings?.();
    else if (action === "remove") callbacks.remove(model.path);
  });
  card.addEventListener("dblclick", () => {
    callbacks.select(model.path);
    callbacks.togglePlay(model.path);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault?.();
      callbacks.select(model.path);
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault?.();
      callbacks.remove(model.path);
    }
  });
  card.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (
      target &&
      typeof target === "object" &&
      "dataset" in target &&
      (target as ClipCardElement).dataset.dragHandle
    ) {
      callbacks.beginReorder(event, model.path, card);
    }
  });
  return card;
}
