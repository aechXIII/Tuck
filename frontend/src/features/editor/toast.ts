import {
  createNotificationMessage,
  notificationPresentation,
} from "../../ui/notifications.ts";
import { byId } from "./session.ts";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  // a later toast with the same key replaces this one instead of waiting behind it
  readonly key?: string;
  // runs once the toast goes away without its action being used
  readonly onDismiss?: () => void;
}

interface ToastQueueItem {
  message: string;
  kind: string;
  action?: ToastAction | undefined;
  options: ToastOptions;
}

interface ActiveToast {
  element: HTMLElement;
  id: string;
  item: ToastQueueItem;
  remaining: number;
  started: number;
  timer: ReturnType<typeof setTimeout> | 0;
  closing?: boolean;
  acted?: boolean;
}

/** What a confirmation asks; every caller says it, nothing is guessed from the message. */
export interface ConfirmIntent {
  readonly title: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  // the confirm button is styled as destructive
  readonly danger?: boolean;
}

export const discardChangesIntent: ConfirmIntent = {
  title: "Unsaved changes",
  confirmLabel: "Discard changes",
  cancelLabel: "Keep editing",
  danger: true,
};

export interface ModalOptions {
  // the box's class; "mod-box" when not given
  readonly className?: string;
  // the id of the dialog's heading; the first heading in the box when not given
  readonly labelledBy?: string;
  readonly describedBy?: string;
  // the first focusable control when not given
  readonly initialFocus?: HTMLElement | null;
  // runs however the dialog closes: a button, Escape, or a click outside it
  readonly onClose?: () => void;
}

let toastId = 0;
const toastQueue: ToastQueueItem[] = [];
let activeToast: ActiveToast | null = null;
let pendingConfirm: (() => void) | null = null;

export type PrepareModalBox = (className: string) => HTMLElement;
export type CloseModal = () => void;

let prepareModalBoxImpl: PrepareModalBox = defaultPrepareModalBox;
let closeModImpl: CloseModal = defaultCloseMod;
let modalReturnFocus: HTMLElement | null = null;
let modalInert: HTMLElement[] = [];
let modalOnClose: (() => void) | null = null;
let modalTrapInstalled = false;

export function configureModalHandlers(options: {
  prepareModalBox?: PrepareModalBox;
  closeMod?: CloseModal;
}): void {
  if (options.prepareModalBox) prepareModalBoxImpl = options.prepareModalBox;
  if (options.closeMod) closeModImpl = options.closeMod;
}

function defaultPrepareModalBox(className: string): HTMLElement {
  const box = byId("mod-box");
  if (!box) throw new Error("Missing #mod-box");
  box.className = className;
  return box;
}

function defaultCloseMod(): void {
  byId("mod-overlay")?.classList.remove("open");
}

export function prepareModalBox(className: string): HTMLElement {
  return prepareModalBoxImpl(className);
}

function focusableIn(box: HTMLElement): HTMLElement[] {
  return Array.from(
    box.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
}

// Tab stays inside the open dialog
function trapModalFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const box = byId("mod-box");
  if (!box || !byId("mod-overlay")?.classList.contains("open")) return;
  const focusable = focusableIn(box);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !box.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !box.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

// everything behind the dialog goes inert except notifications and the window's own title bar
// controls, so the window can still be moved and closed
function setBackgroundInert(overlay: HTMLElement): void {
  const bar = byId("tb");
  const toasts = byId("toast-ct");
  const candidates = [
    ...Array.from(document.body.children).filter(
      (element) => element !== overlay && element !== bar && element !== toasts,
    ),
    ...Array.from(bar?.querySelectorAll(".tb-editor") ?? []),
  ];
  for (const element of candidates) {
    // leave what something else made inert, such as the editor behind Settings, to its owner
    if (!(element instanceof HTMLElement) || element.inert) continue;
    element.inert = true;
    modalInert.push(element);
  }
}

function releaseBackground(): void {
  for (const element of modalInert) element.inert = false;
  modalInert = [];
}

/** Shows #mod-box as a modal dialog: labelled, focus kept inside, the rest of the app inert. */
function openModal(box: HTMLElement, options: ModalOptions): void {
  const overlay = byId("mod-overlay");
  if (!overlay) return;
  if (!overlay.classList.contains("open")) {
    const active = document.activeElement;
    modalReturnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  modalOnClose = options.onClose ?? null;
  const heading = options.labelledBy ? null : box.querySelector<HTMLElement>("h1, h2, h3");
  if (heading && !heading.id) heading.id = "mod-title";
  const labelledBy = options.labelledBy ?? heading?.id;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  if (labelledBy) box.setAttribute("aria-labelledby", labelledBy);
  else box.removeAttribute("aria-labelledby");
  if (options.describedBy) box.setAttribute("aria-describedby", options.describedBy);
  else box.removeAttribute("aria-describedby");
  if (!modalTrapInstalled) {
    overlay.addEventListener("keydown", trapModalFocus);
    modalTrapInstalled = true;
  }
  overlay.classList.add("open");
  releaseBackground();
  setBackgroundInert(overlay);
  (options.initialFocus ?? focusableIn(box)[0])?.focus();
}

export function closeMod(): void {
  byId("mod-box")?.removeAttribute("aria-describedby");
  closeModImpl();
  releaseBackground();
  pendingConfirm = null;
  const onClose = modalOnClose;
  modalOnClose = null;
  onClose?.();
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

/** Shows static dialog markup; the first heading names the dialog unless options say otherwise. */
export function showMod(html: string, options: ModalOptions = {}): HTMLElement {
  const box = prepareModalBox(options.className ?? "mod-box");
  box.innerHTML = html;
  openModal(box, options);
  return box;
}

export function closeActiveModal(): void {
  closeMod();
}

export function toast(msg: string, kind = "", action?: ToastAction, options: ToastOptions = {}): void {
  const item: ToastQueueItem = { message: msg, kind: kind || "", action, options };
  const key = options.key;
  if (key && activeToast?.item.options.key === key && !activeToast.closing) {
    replaceActiveToast(item);
    return;
  }
  const queued = key ? toastQueue.findIndex((entry) => entry.options.key === key) : -1;
  if (queued >= 0) toastQueue[queued] = item;
  else toastQueue.push(item);
  yieldActionToast();
  showNextToast();
}

// a message with a button, such as Undo, stays long enough to reach it by keyboard,
// but only while nothing is waiting behind it; then it keeps the usual time at most
const ACTION_TOAST_MS = 10000;

function toastDuration(item: ToastQueueItem): number {
  const usual = notificationPresentation(item.kind).duration;
  return item.action && !toastQueue.length ? ACTION_TOAST_MS : usual;
}

function yieldActionToast(): void {
  const current = activeToast;
  if (!current || !current.item.action || current.closing) return;
  const usual = notificationPresentation(current.item.kind).duration;
  const running = !!current.timer;
  if (running) pauseToastTimer();
  current.remaining = Math.min(current.remaining, usual);
  if (running) resumeToastTimer();
}

// a live region added along with its text is often not read out, so messages go through the two
// regions in #toast-ct, cleared first so that a repeated message is still announced
function speak(region: "status" | "alert", message: string): void {
  const target = byId(region === "alert" ? "live-alert" : "live-status");
  if (!target) return;
  target.textContent = "";
  setTimeout(() => {
    target.textContent = message;
  }, 50);
}

function quiet(message: string): void {
  for (const id of ["live-status", "live-alert"]) {
    const region = byId(id);
    if (region && region.textContent === message) region.textContent = "";
  }
}

/** Says something to screen reader users without showing a notification, e.g. that exports started. */
export function announce(message: string): void {
  speak("status", message);
}

function fillToast(element: HTMLElement, id: string, item: ToastQueueItem): void {
  const presentation = notificationPresentation(item.kind);
  element.className = `toast ${presentation.kind}`;
  speak(presentation.role === "alert" ? "alert" : "status", item.message);
  const parts: HTMLElement[] = [createNotificationMessage(document, item.message)];
  const action = item.action;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tact";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      if (activeToast?.id === id) activeToast.acted = true;
      dismissToast(id);
      action.run();
    });
    parts.push(button);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tcls";
  close.setAttribute("aria-label", "Dismiss notification");
  close.addEventListener("click", () => {
    dismissToast(id);
  });
  parts.push(close);
  element.replaceChildren(...parts);
}

function replaceActiveToast(item: ToastQueueItem): void {
  const current = activeToast;
  if (!current) return;
  const hadFocus = current.element.contains(document.activeElement);
  current.item = item;
  fillToast(current.element, current.id, item);
  if (hadFocus) current.element.querySelector<HTMLElement>(".tact, .tcls")?.focus();
  // the new message gets its full time on screen
  current.remaining = toastDuration(item);
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = 0;
    resumeToastTimer();
  }
}

function showNextToast(): void {
  if (activeToast || !toastQueue.length) return;
  const ct = byId("toast-ct");
  if (!ct) return;
  const item = toastQueue.shift();
  if (!item) return;
  const id = `t${++toastId}`;
  const div = document.createElement("div");
  div.id = id;
  fillToast(div, id, item);
  ct.appendChild(div);
  activeToast = {
    element: div,
    id,
    item,
    remaining: toastDuration(item),
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

// a notice must not run out while nobody can see it, such as when Tuck is minimised
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseToastTimer();
    else resumeToastTimer();
  });
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
  if (!closing.acted) closing.item.options.onDismiss?.();
  quiet(closing.item.message);
  closing.element.classList.add("leaving");
  setTimeout(() => {
    if (closing.element.parentNode) {
      closing.element.parentNode.removeChild(closing.element);
    }
    if (activeToast === closing) activeToast = null;
    showNextToast();
  }, 140);
}

export function confirmToast(msg: string, cb: () => void, intent: ConfirmIntent): void {
  const box = prepareModalBox("mod-box confirm-dialog");
  const title = document.createElement("h2");
  title.id = "confirm-title";
  title.textContent = intent.title;
  const copy = document.createElement("p");
  copy.className = "confirm-copy";
  copy.id = "confirm-copy";
  copy.textContent = msg;
  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn2";
  cancelButton.id = "confirm-cancel";
  cancelButton.textContent = intent.cancelLabel;
  cancelButton.addEventListener("click", closeMod);
  const acceptButton = document.createElement("button");
  acceptButton.type = "button";
  acceptButton.className = intent.danger ? "btn1 danger" : "btn1";
  acceptButton.id = "confirm-accept";
  acceptButton.textContent = intent.confirmLabel;
  acceptButton.addEventListener("click", acceptConfirm);
  actions.append(cancelButton, acceptButton);
  box.replaceChildren(title, copy, actions);
  openModal(box, { labelledBy: "confirm-title", describedBy: "confirm-copy", initialFocus: cancelButton });
  pendingConfirm = cb;
}

function acceptConfirm(): void {
  const cb = pendingConfirm;
  closeMod();
  if (cb) cb();
}
