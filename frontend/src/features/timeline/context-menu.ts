// The right-click menus on the timeline (markers, segments, gaps, added audio): one look and one
// set of keys, opened over a given spot, at the pointer or, from the keyboard, under the thing it
// acts on.

export interface ContextMenuItem {
  action: string;
  label: string;
  keys?: string;
  disabled?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | "separator";

export interface ContextMenuOptions {
  label: string;
  items: readonly ContextMenuEntry[];
  // placed under it from the keyboard, and focus goes back to it on close
  anchor: HTMLElement;
  at?: { x: number; y: number } | undefined;
  // opens with its left edge at x and its bottom at bottom, so what is under that spot stays in
  // sight; at the pointer or under the anchor when there is no room
  over?: { x: number; bottom: number } | undefined;
  run: (action: string) => void;
  // the item the pointer or the keys light, or null; disabled items light without an action
  lit?: (action: string | null) => void;
  closed?: () => void;
}

export interface ContextMenu {
  open: (options: ContextMenuOptions) => void;
  close: (returnFocus?: boolean) => void;
  isOpen: () => boolean;
}

export function createContextMenu(doc: Document, win: Window, id: string): ContextMenu {
  let menu: HTMLElement | null = null;
  let current: ContextMenuOptions | null = null;

  function items(): HTMLElement[] {
    return menu ? Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']")) : [];
  }

  function focusItem(index: number): void {
    const list = items();
    if (!list.length) return;
    list[(index + list.length) % list.length]?.focus();
  }

  function isOpen(): boolean {
    return !!menu && !menu.hidden;
  }

  function close(returnFocus = false): void {
    if (!menu || !isOpen()) return;
    const options = current;
    current = null;
    if (typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
    menu.hidden = true;
    menu.replaceChildren();
    options?.lit?.(null);
    options?.closed?.();
    if (returnFocus) options?.anchor.focus({ preventScroll: true });
  }

  function ensure(): HTMLElement {
    if (menu) return menu;
    const element = doc.createElement("div");
    element.id = id;
    element.className = "row-menu";
    element.setAttribute("role", "menu");
    element.setAttribute("popover", "manual");
    element.tabIndex = -1;
    element.hidden = true;
    element.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[data-menu-action]");
      if (!item || item.getAttribute("aria-disabled") === "true" || !current) return;
      const run = current.run;
      close(true);
      run(item.dataset.menuAction ?? "");
    });
    element.addEventListener("pointermove", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[role='menuitem']");
      if (item && doc.activeElement !== item) item.focus({ preventScroll: true });
    });
    // leaving the menu puts out the lit item, so its preview goes too
    element.addEventListener("pointerleave", () => {
      if (isOpen() && element.contains(doc.activeElement) && doc.activeElement !== element) element.focus({ preventScroll: true });
    });
    element.addEventListener("focusin", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[role='menuitem']");
      current?.lit?.(!item || item.getAttribute("aria-disabled") === "true" ? null : (item.dataset.menuAction ?? null));
    });
    element.addEventListener("keydown", (event) => {
      const list = items();
      const at = list.indexOf(doc.activeElement as HTMLElement);
      if (event.key === "ArrowDown") focusItem(at + 1);
      else if (event.key === "ArrowUp") focusItem(at < 0 ? list.length - 1 : at - 1);
      else if (event.key === "Home") focusItem(0);
      else if (event.key === "End") focusItem(list.length - 1);
      else if (event.key === "Escape" || event.key === "Tab") close(true);
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
    doc.body.appendChild(element);
    menu = element;
    return element;
  }

  function place(element: HTMLElement, options: ContextMenuOptions): void {
    const { anchor, at, over } = options;
    const view = doc.documentElement;
    const edge = 8;
    element.style.left = "0px";
    element.style.top = "0px";
    element.classList.add("at-pointer");
    const bounds = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    if (over && over.bottom - size.height >= edge) {
      element.classList.add("opens-up");
      element.style.left = Math.round(Math.max(edge, Math.min(over.x, view.clientWidth - size.width - edge))) + "px";
      element.style.top = Math.round(over.bottom - size.height) + "px";
      return;
    }
    let left = at ? at.x : bounds.left;
    let top = at ? at.y : bounds.bottom + 4;
    if (top + size.height > view.clientHeight - edge) {
      top = (at ? at.y : bounds.top - 4) - size.height;
      element.classList.add("opens-up");
    } else {
      element.classList.remove("opens-up");
    }
    left = Math.max(edge, Math.min(left, view.clientWidth - size.width - edge));
    element.style.left = Math.round(left) + "px";
    element.style.top = Math.round(Math.max(edge, top)) + "px";
  }

  function open(options: ContextMenuOptions): void {
    close(false);
    const element = ensure();
    element.setAttribute("aria-label", options.label);
    for (const entry of options.items) {
      if (entry === "separator") {
        const line = doc.createElement("div");
        line.className = "row-menu-sep";
        line.setAttribute("role", "separator");
        element.append(line);
        continue;
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "row-menu-item";
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      button.dataset.menuAction = entry.action;
      button.setAttribute("aria-label", entry.label);
      if (entry.disabled) button.setAttribute("aria-disabled", "true");
      const text = doc.createElement("span");
      text.className = "row-menu-text";
      const label = doc.createElement("span");
      label.className = "row-menu-label";
      label.textContent = entry.label;
      text.append(label);
      button.append(text);
      if (entry.keys) {
        const keys = doc.createElement("span");
        keys.className = "row-menu-keys";
        keys.textContent = entry.keys;
        button.append(keys);
        button.setAttribute("aria-keyshortcuts", entry.keys);
      }
      element.append(button);
    }
    current = options;
    element.hidden = false;
    if (typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
    place(element, options);
    if (options.at) {
      element.focus({ preventScroll: true });
    } else {
      const first = items().findIndex((item) => item.getAttribute("aria-disabled") !== "true");
      focusItem(Math.max(0, first));
    }
  }

  doc.addEventListener("pointerdown", (event) => {
    if (menu && isOpen() && !(event.target instanceof Node && menu.contains(event.target))) close(false);
  }, true);
  win.addEventListener("blur", () => close(false));
  win.addEventListener("resize", () => close(false));

  return { open, close, isOpen };
}
