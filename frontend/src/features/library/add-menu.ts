import { ariaShortcuts, commandBindings, displayShortcut } from "../shortcuts/shortcuts.ts";

export type AddMenuAction = "files" | "folder" | "paste";

export interface AddMenuHost {
  document: Document;
  window: Window & typeof globalThis;
  run: (action: AddMenuAction) => void;
}

/**
 * The menu under Add videos' arrow: Add videos, Add a folder and Paste videos. It hangs from the
 * button and its arrow at their width, like a field's list.
 */
export function installAddMenu(host: AddMenuHost): { close: (returnFocus?: boolean) => void } {
  const doc = host.document;
  const arrow = doc.getElementById("btn-add-more");
  const menu = doc.getElementById("add-menu");
  const split = arrow?.parentElement;
  if (!arrow || !menu || !split) return { close: () => {} };
  const trigger = arrow;
  const element = menu;
  const anchor = split;

  function items(): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>("[role='menuitem']"));
  }

  function focusItem(index: number): void {
    const list = items();
    if (!list.length) return;
    list[(index + list.length) % list.length]?.focus({ preventScroll: true });
  }

  function isOpen(): boolean {
    return !element.hidden;
  }

  // the keys follow any the user chose in Settings
  function showKeys(): void {
    for (const item of items()) {
      const command = item.dataset.shortcutCommand;
      const keys = item.querySelector<HTMLElement>(".row-menu-keys");
      if (!command || !keys) continue;
      keys.textContent = displayShortcut(commandBindings(command));
      const aria = ariaShortcuts(commandBindings(command));
      if (aria) item.setAttribute("aria-keyshortcuts", aria);
      else item.removeAttribute("aria-keyshortcuts");
    }
  }

  function place(): void {
    const bounds = anchor.getBoundingClientRect();
    element.style.left = Math.round(bounds.left) + "px";
    element.style.top = Math.round(bounds.bottom) + "px";
    element.style.width = Math.round(bounds.width) + "px";
  }

  function open(focusFirst: boolean): void {
    if (isOpen()) return;
    showKeys();
    element.hidden = false;
    if (typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
    place();
    trigger.setAttribute("aria-expanded", "true");
    if (focusFirst) focusItem(0);
    else element.focus({ preventScroll: true });
  }

  function close(returnFocus = false): void {
    if (!isOpen()) return;
    if (typeof element.hidePopover === "function" && element.matches(":popover-open")) element.hidePopover();
    element.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener("click", (event) => {
    if (isOpen()) close(false);
    // a click from the keyboard (Enter or Space) has no pointer, so the first item takes focus
    else open((event as MouseEvent).detail === 0);
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(false);
    focusItem(event.key === "ArrowDown" ? 0 : -1);
  });
  element.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("[data-add-menu]");
    if (!item) return;
    const action = item.dataset.addMenu as AddMenuAction;
    close(false);
    host.run(action);
  });
  element.addEventListener("pointermove", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("[role='menuitem']");
    if (item && doc.activeElement !== item) item.focus({ preventScroll: true });
  });
  element.addEventListener("keydown", (event) => {
    const list = items();
    const current = list.indexOf(doc.activeElement as HTMLElement);
    if (event.key === "ArrowDown") focusItem(current + 1);
    else if (event.key === "ArrowUp") focusItem(current < 0 ? list.length - 1 : current - 1);
    else if (event.key === "Home") focusItem(0);
    else if (event.key === "End") focusItem(list.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") close(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  // anything else the pointer touches, and the window losing focus or changing size, closes it
  doc.addEventListener(
    "pointerdown",
    (event) => {
      if (!isOpen() || !(event.target instanceof Node)) return;
      if (element.contains(event.target) || trigger.contains(event.target)) return;
      close(false);
    },
    true,
  );
  host.window.addEventListener("blur", () => close(false));
  host.window.addEventListener("resize", () => close(false));

  return { close };
}
