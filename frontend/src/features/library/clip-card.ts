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

export interface ClipBadge {
  className: string;
  label: string;
  icon: string;
}

export interface ClipCardModel {
  path: string;
  name?: string;
  selected?: boolean | undefined;
  queueItemId?: string | undefined;
  queueState?: string | undefined;
  resultPath?: string | undefined;
  statusLabel?: string | undefined;
  progress?: number | undefined;
  probeError?: unknown;
  fileSize?: number | undefined;
  meta?: { text?: unknown; error?: boolean | undefined } | null | undefined;
  badge?: ClipBadge | null | undefined;
  projectedMb?: number | undefined;
  overBudget?: boolean | undefined;
}

export interface ClipCardCallbacks {
  select(path: string): void;
  togglePlay(path: string): void;
  remove(path: string): void;
  openResult(path: string): void;
  cancel(id: string): void;
  retry(id: string): void;
  retryProbe?(path: string): void;
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

function appendStatus<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  cardMain: T,
  model: ClipCardModel,
): void {
  const state = model.queueState || "";
  if (state === "pending") return;
  const hasOpen = state === "completed" && !!model.resultPath;
  const hasCancel =
    (state === "running" || state === "processing") && !!model.queueItemId;
  const hasRetry =
    (state === "failed" || state === "cancelled") && !!model.queueItemId;
  const hasProbeRetry = !!model.probeError;
  if (
    !model.statusLabel &&
    !hasOpen &&
    !hasCancel &&
    !hasRetry &&
    !hasProbeRetry
  )
    return;

  const row = createElement(documentRef, "div", "c-status-row");
  row.appendChild(
    createElement(documentRef, "span", "c-status", model.statusLabel || ""),
  );
  if (hasOpen) {
    row.appendChild(
      createActionButton(documentRef, "open-result", "Show", "c-act link"),
    );
  }
  if (hasCancel) {
    row.appendChild(
      createActionButton(documentRef, "cancel", "Cancel", "c-act danger"),
    );
  }
  if (hasRetry) {
    row.appendChild(createActionButton(documentRef, "retry", "Retry", "c-act"));
  }
  if (hasProbeRetry) {
    row.appendChild(
      createActionButton(
        documentRef,
        "retry-probe",
        "Retry reading " + (model.name || ""),
        "c-act",
      ),
    );
  }
  cardMain.appendChild(row);
}

function appendBadge<T extends ClipCardElement>(
  documentRef: { createElement(tagName: string): T },
  card: T,
  badge: ClipBadge | null | undefined,
): void {
  if (!badge) return;
  const element = createElement(
    documentRef,
    "span",
    "c-st " + badge.className,
    badge.icon,
  );
  element.setAttribute("role", "img");
  element.setAttribute("title", badge.label);
  element.setAttribute("aria-label", badge.label);
  card.appendChild(element);
}

function libraryGroup(model: ClipCardModel): string {
  const state = model.queueState || "";
  if (state === "running" || state === "processing") return "encoding";
  if (state === "pending") return "queued";
  return "ready";
}

export function groupClipModels(models: ClipCardModel[]): ClipGroup[] {
  const definitions = [
    { key: "encoding", label: "Encoding" },
    { key: "queued", label: "Queued" },
    { key: "ready", label: "Ready" },
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
  if (!group || group.key === "encoding") return group ? group.label : "";
  return group.label + " · " + group.items.length;
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
  card.setAttribute("title", name + " - drag handle to reorder");
  card.dataset.clipPath = model.path;
  card.dataset.queueState = model.queueState || "ready";
  if (model.queueItemId) card.dataset.queueItemId = model.queueItemId;

  const drag = createElement(documentRef, "span", "c-drag", "⋮⋮");
  drag.dataset.dragHandle = "1";
  drag.setAttribute("title", "Drag to reorder");
  drag.setAttribute("aria-label", "Drag to reorder");
  card.appendChild(drag);

  const main = createElement(documentRef, "div", "c1");
  const titleRow = createElement(documentRef, "div", "c-title-row");
  titleRow.appendChild(createElement(documentRef, "div", "c2", name));
  main.appendChild(titleRow);
  const metadata = createElement(documentRef, "div", "c3");
  const metadataText = createElement(documentRef, "span", "c-meta");
  if (model.meta && model.meta.error) {
    metadataText.appendChild(
      createElement(documentRef, "span", "c-error", model.meta.text),
    );
  } else {
    metadataText.textContent = model.meta ? String(model.meta.text) : "";
  }
  metadata.appendChild(metadataText);
  main.appendChild(metadata);
  if (model.queueState === "running" || model.queueState === "processing") {
    const progress = Math.max(0, Math.min(100, Number(model.progress) || 0));
    const progressTrack = createElement(documentRef, "div", "c-progress");
    const progressFill = createElement(documentRef, "span", "c-progress-fill");
    progressFill.setAttribute("style", "width:" + progress + "%");
    progressTrack.setAttribute("role", "progressbar");
    progressTrack.setAttribute("aria-label", "Encoding progress");
    progressTrack.setAttribute("aria-valuemin", "0");
    progressTrack.setAttribute("aria-valuemax", "100");
    progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
    progressTrack.appendChild(progressFill);
    main.appendChild(progressTrack);
  }
  appendStatus(documentRef, main, model);
  card.appendChild(main);
  const encodingState =
    model.queueState === "running" || model.queueState === "processing";
  if (
    model.projectedMb != null &&
    Number.isFinite(model.projectedMb) &&
    !encodingState &&
    model.queueState !== "pending"
  ) {
    const projected = createElement(
      documentRef,
      "span",
      "c-proj" + (model.overBudget ? " over" : ""),
      "→ " + (model.projectedMb as number).toFixed(1) + " MB",
    );
    projected.setAttribute(
      "title",
      model.overBudget
        ? "Projected output is over the target size"
        : "Projected output size",
    );
    titleRow.appendChild(projected);
  }
  if (model.queueState === "pending") {
    const queued = createActionButton(
      documentRef,
      "cancel",
      "Cancel queued export",
      "c-queue-badge",
    );
    queued.textContent = "QUEUED";
    card.appendChild(queued);
  } else if (
    model.queueState !== "running" &&
    model.queueState !== "processing"
  ) {
    appendBadge(documentRef, card, model.badge);
  }

  const remove = createActionButton(
    documentRef,
    "remove",
    "Remove " + name,
    "c4",
  );
  remove.textContent = "✕";
  remove.setAttribute("tabindex", "0");
  card.appendChild(remove);

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
    } else if (action === "cancel") {
      const queueItemId = model.queueItemId;
      if (queueItemId) callbacks.cancel(queueItemId);
    } else if (action === "retry") {
      const queueItemId = model.queueItemId;
      if (queueItemId) callbacks.retry(queueItemId);
    } else if (action === "retry-probe") callbacks.retryProbe?.(model.path);
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
