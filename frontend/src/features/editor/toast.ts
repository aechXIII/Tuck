import {
  createNotificationMessage,
  notificationPresentation,
} from "../../ui/notifications.ts";
import { byId } from "./session.ts";

interface ToastQueueItem {
  message: string;
  kind: string;
}

interface ActiveToast {
  element: HTMLElement;
  id: string;
  remaining: number;
  started: number;
  timer: ReturnType<typeof setTimeout> | 0;
  closing?: boolean;
}

let toastId = 0;
const toastQueue: ToastQueueItem[] = [];
let activeToast: ActiveToast | null = null;
let pendingConfirm: (() => void) | null = null;

export type PrepareModalBox = (className: string) => HTMLElement;
export type CloseModal = () => void;

let prepareModalBoxImpl: PrepareModalBox = defaultPrepareModalBox;
let closeModImpl: CloseModal = defaultCloseMod;
let confirmReturnFocus: HTMLElement | null = null;

export function configureModalHandlers(options: {
  prepareModalBox?: PrepareModalBox;
  closeMod?: CloseModal;
}): void {
  if (options.prepareModalBox) prepareModalBoxImpl = options.prepareModalBox;
  if (options.closeMod) closeModImpl = options.closeMod;
}

function defaultPrepareModalBox(className: string): HTMLElement {
  const reset = (
    globalThis as { resetKeyboardShortcutsDialog?: (force: boolean) => void }
  ).resetKeyboardShortcutsDialog;
  if (typeof reset === "function") reset(false);
  const box = byId("mod-box");
  if (!box) throw new Error("Missing #mod-box");
  box.className = className;
  return box;
}

function defaultCloseMod(): void {
  byId("mod-overlay")?.classList.remove("open");
  const reset = (
    globalThis as { resetKeyboardShortcutsDialog?: (force: boolean) => void }
  ).resetKeyboardShortcutsDialog;
  if (typeof reset === "function") reset(true);
  pendingConfirm = null;
}

export function prepareModalBox(className: string): HTMLElement {
  return prepareModalBoxImpl(className);
}

export function closeMod(): void {
  closeModImpl();
  if (confirmReturnFocus?.isConnected) confirmReturnFocus.focus();
  confirmReturnFocus = null;
}

export function showMod(html: string): void {
  const box = prepareModalBox("mod-box");
  box.innerHTML = html;
  byId("mod-overlay")?.classList.add("open");
}

export function closeActiveModal(): void {
  closeMod();
}

export function toast(msg: string, kind = ""): void {
  toastQueue.push({ message: msg, kind: kind || "" });
  showNextToast();
}

function showNextToast(): void {
  if (activeToast || !toastQueue.length) return;
  const item = toastQueue.shift();
  if (!item) return;
  const presentation = notificationPresentation(item.kind);
  const id = `t${++toastId}`;
  const ct = byId("toast-ct");
  if (!ct) return;
  const div = document.createElement("div");
  div.className = `toast ${presentation.kind}`;
  div.id = id;
  div.setAttribute("role", presentation.role);
  div.setAttribute("aria-live", presentation.live);
  div.setAttribute("aria-atomic", "true");
  div.appendChild(createNotificationMessage(document, item.message));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tcls";
  close.setAttribute("aria-label", "Dismiss notification");
  close.addEventListener("click", () => {
    dismissToast(id);
  });
  div.appendChild(close);
  ct.appendChild(div);
  activeToast = {
    element: div,
    id,
    remaining: presentation.duration,
    started: 0,
    timer: 0,
  };
  div.addEventListener("mouseenter", pauseToastTimer);
  div.addEventListener("mouseleave", resumeToastTimer);
  div.addEventListener("focusin", pauseToastTimer);
  div.addEventListener("focusout", resumeToastTimer);
  resumeToastTimer();
}

function pauseToastTimer(): void {
  if (!activeToast || !activeToast.timer) return;
  clearTimeout(activeToast.timer);
  activeToast.timer = 0;
  activeToast.remaining -= Date.now() - activeToast.started;
}

function resumeToastTimer(): void {
  if (!activeToast || activeToast.timer || activeToast.closing) return;
  activeToast.started = Date.now();
  const current = activeToast;
  activeToast.timer = setTimeout(() => {
    dismissToast(current.id);
  }, Math.max(0, current.remaining));
}

function dismissToast(id: string): void {
  if (!activeToast || activeToast.id !== id || activeToast.closing) return;
  clearTimeout(activeToast.timer);
  activeToast.closing = true;
  const closing = activeToast;
  closing.element.classList.add("leaving");
  setTimeout(() => {
    if (closing.element.parentNode) {
      closing.element.parentNode.removeChild(closing.element);
    }
    if (activeToast === closing) activeToast = null;
    showNextToast();
  }, 140);
}

export function confirmToast(msg: string, cb: () => void): void {
  confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const lower = msg.toLowerCase();
  const discard = lower.includes("discard");
  const remove =
    lower.includes("remove") || lower.includes("delete") || lower.includes("cancel");
  const install = lower.includes("install");
  const title = discard
    ? "Unsaved changes"
    : install
      ? "Install update"
      : remove
        ? "Confirm removal"
        : "Confirm action";
  const confirmLabel = discard
    ? "Discard changes"
    : install
      ? "Install update"
      : lower.includes("delete")
        ? "Delete"
        : lower.includes("remove")
          ? "Remove"
          : lower.includes("cancel")
            ? "Cancel processing"
            : "Continue";
  const cancelLabel = discard ? "Keep editing" : "Go back";
  pendingConfirm = cb;
  const box = prepareModalBox("mod-box confirm-dialog");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "confirm-title");
  box.innerHTML = `<h2 id="confirm-title"></h2>
    <p class="confirm-copy" id="confirm-copy"></p>
    <div class="confirm-actions">
      <button type="button" class="btn2" id="confirm-cancel"></button>
      <button type="button" class="btn1" id="confirm-accept"></button>
    </div>`;
  const titleEl = byId("confirm-title");
  const copyEl = byId("confirm-copy");
  if (titleEl) titleEl.textContent = title;
  if (copyEl) copyEl.textContent = msg;
  const cancelButton = byId("confirm-cancel");
  const acceptButton = byId("confirm-accept");
  if (cancelButton) {
    cancelButton.textContent = cancelLabel;
    cancelButton.addEventListener("click", closeMod);
  }
  if (acceptButton) {
    acceptButton.textContent = confirmLabel;
    acceptButton.classList.toggle("danger", discard || remove);
    acceptButton.addEventListener("click", acceptConfirm);
  }
  byId("mod-overlay")?.classList.add("open");
  cancelButton?.focus();
}

function acceptConfirm(): void {
  const cb = pendingConfirm;
  closeMod();
  if (cb) cb();
}
