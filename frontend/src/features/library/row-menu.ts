import {
  clipSize,
  copyEdits,
  pasteEdits,
  type CopiedEdits,
  type PasteResult,
} from "../editor/edit-transfer.ts";
import type { EditorClip } from "../editor/types.ts";
import { ariaShortcuts, commandBindings, displayShortcut } from "../shortcuts/shortcuts.ts";

export interface RowMenuHost {
  document: Document;
  window: Window & typeof globalThis;
  clips: () => Readonly<Record<string, EditorClip>>;
  // the Library's videos in their order
  order: () => readonly string[];
  selectedPath: () => string | null;
  // every selected video, the shown one included, in Library order
  selectedPaths: () => readonly string[];
  history?: { action: <T>(path: string | null, fn: () => T, label?: string) => T } | null;
  shortcuts?: {
    registerAction: (
      id: string,
      action: { enabled?: () => boolean; execute: () => void },
    ) => void;
  };
  toast: (message: string, kind?: string) => void;
  // these videos' edits changed, so their rows and, when one is on screen, the editor redraw
  edited: (paths: readonly string[]) => void;
}

export interface RowMenuApi {
  copy: (path: string) => void;
  paste: (paths: readonly string[]) => void;
  copied: () => CopiedEdits | null;
  open: (path: string, at?: { x: number; y: number }) => void;
  close: (returnFocus?: boolean) => void;
}

type MenuAction = "copy" | "paste" | "paste-all";

interface MenuItem {
  action: MenuAction;
  label: string;
  detail?: string;
  keys?: string;
  ariaKeys?: string;
  disabled: boolean;
}

function videos(count: number): string {
  return `${count} ${count === 1 ? "video" : "videos"}`;
}

/**
 * What a paste says. Every changed video shows its new edits, so this mostly explains the ones
 * that came out differently: shorter videos and videos that were still loading.
 */
export function pasteSummary(
  results: readonly { name: string; result: PasteResult | null }[],
): { message: string; kind: string } {
  const pasted = results.filter((entry) => entry.result);
  const loading = results.filter((entry) => !entry.result);
  const shortened = pasted.filter((entry) => entry.result?.shortened);
  const skipped = pasted.filter((entry) => entry.result?.segmentsSkipped);
  const parts: string[] = [];
  if (pasted.length === 1 && pasted[0]) parts.push(`Pasted edits to ${pasted[0].name}.`);
  else if (pasted.length) parts.push(`Pasted edits to ${videos(pasted.length)}.`);
  if (shortened.length === 1 && shortened[0]) {
    parts.push(`${shortened[0].name} is shorter, so segments past its end were cut there.`);
  } else if (shortened.length) {
    parts.push(`${videos(shortened.length)} are shorter, so segments past their end were cut there.`);
  }
  if (skipped.length === 1 && skipped[0]) {
    parts.push(`${skipped[0].name} is too short for any of the copied segments, so it keeps its own.`);
  } else if (skipped.length) {
    parts.push(`${videos(skipped.length)} are too short for any of the copied segments, so they keep their own.`);
  }
  if (loading.length === 1 && loading[0]) {
    parts.push(`${loading[0].name} is still loading, so it was skipped.`);
  } else if (loading.length) {
    parts.push(`${videos(loading.length)} are still loading, so they were skipped.`);
  }
  const kind = !pasted.length ? "err" : shortened.length || skipped.length || loading.length ? "info" : "ok";
  return { message: parts.join(" "), kind };
}

export function installRowMenu(host: RowMenuHost): RowMenuApi {
  const doc = host.document;
  let clipboard: CopiedEdits | null = null;
  let menu: HTMLElement | null = null;
  let menuPath: string | null = null;
  // a right click opens the menu at the pointer; the keyboard opens it under the row
  let pointerOpen = 0;

  function ready(path: string | null): boolean {
    return !!path && !!clipSize(host.clips()[path]);
  }

  function copy(path: string): void {
    const clip = host.clips()[path];
    const edits = clip ? copyEdits(clip) : null;
    if (!clip || !edits) return;
    clipboard = edits;
    host.toast(`Copied edits from ${clip.name}.`, "ok");
  }

  function paste(paths: readonly string[]): void {
    const edits = clipboard;
    if (!edits || !paths.length) return;
    const results: { name: string; result: PasteResult | null }[] = [];
    const changed: string[] = [];
    for (const path of paths) {
      const clip = host.clips()[path];
      if (!clip) continue;
      // each video gets its own undo step, named for the Undo button
      const result = host.history
        ? host.history.action(path, () => pasteEdits(edits, clip), "paste edits")
        : pasteEdits(edits, clip);
      results.push({ name: clip.name, result });
      if (result) changed.push(path);
    }
    if (!results.length) return;
    if (changed.length) host.edited(changed);
    const summary = pasteSummary(results);
    host.toast(summary.message, summary.kind);
  }

  function rowFor(path: string | null): HTMLElement | null {
    if (!path) return null;
    for (const card of doc.querySelectorAll<HTMLElement>("#clips .clip[data-clip-path]")) {
      if (card.dataset.clipPath === path) return card;
    }
    return null;
  }

  // with several videos selected, a paste onto one of them goes to all of them
  function pasteTargets(path: string): readonly string[] {
    const selected = host.selectedPaths();
    return selected.length > 1 && selected.includes(path) ? selected : [path];
  }

  function items(path: string): MenuItem[] {
    // the keys follow any the user chose in Settings
    const keys = (id: string) => ({
      keys: displayShortcut(commandBindings(id)),
      ariaKeys: ariaShortcuts(commandBindings(id)),
    });
    const targets = pasteTargets(path);
    const list: MenuItem[] = [
      { action: "copy", label: "Copy edits", ...keys("edit.copy-edits"), disabled: !ready(path) },
      {
        action: "paste",
        label: targets.length > 1 ? `Paste edits to ${videos(targets.length)}` : "Paste edits",
        ...keys("edit.paste-edits"),
        disabled: !clipboard || !targets.some((target) => ready(target)),
        ...(clipboard ? { detail: `From ${clipboard.name}` } : {}),
      },
    ];
    if (host.order().length > 1) {
      list.push({
        action: "paste-all",
        label: "Paste edits to all videos",
        disabled: !clipboard || !host.order().some((other) => ready(other)),
      });
    }
    return list;
  }

  function menuItems(): HTMLElement[] {
    return menu ? Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']")) : [];
  }

  function focusItem(index: number): void {
    const list = menuItems();
    if (!list.length) return;
    const wrapped = (index + list.length) % list.length;
    list[wrapped]?.focus();
  }

  // a popover sits above the Library and Inspector drawers, and they leave its Escape to it
  function isOpen(): boolean {
    return !!menu && !menu.hidden;
  }

  function show(element: HTMLElement): void {
    element.hidden = false;
    if (typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
  }

  function close(returnFocus = false): void {
    if (!menu || !isOpen()) return;
    if (typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
    menu.hidden = true;
    menu.replaceChildren();
    const row = rowFor(menuPath);
    row?.classList.remove("menu-target");
    menuPath = null;
    if (returnFocus) row?.focus({ preventScroll: true });
  }

  function run(action: MenuAction, path: string): void {
    if (action === "copy") copy(path);
    else if (action === "paste") paste(pasteTargets(path));
    else paste(host.order());
  }

  function ensureMenu(): HTMLElement {
    if (menu) return menu;
    const element = doc.createElement("div");
    element.id = "library-menu";
    element.className = "row-menu";
    element.setAttribute("role", "menu");
    element.setAttribute("popover", "manual");
    element.tabIndex = -1;
    element.hidden = true;
    element.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[data-row-menu-action]");
      if (!item || item.getAttribute("aria-disabled") === "true" || !menuPath) return;
      const action = item.dataset.rowMenuAction as MenuAction;
      const path = menuPath;
      close(true);
      run(action, path);
    });
    element.addEventListener("pointermove", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[role='menuitem']");
      if (item && doc.activeElement !== item) item.focus({ preventScroll: true });
    });
    element.addEventListener("keydown", (event) => {
      const list = menuItems();
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
    doc.body.appendChild(element);
    menu = element;
    return element;
  }

  function place(element: HTMLElement, row: HTMLElement, at?: { x: number; y: number }): void {
    const view = doc.documentElement;
    const edge = 8;
    element.style.left = "0px";
    element.style.top = "0px";
    const bounds = row.getBoundingClientRect();
    element.classList.toggle("at-pointer", !!at);
    element.style.width = at ? "" : Math.round(bounds.width) + "px";
    const size = element.getBoundingClientRect();
    let left = at ? at.x : bounds.left;
    let top = at ? at.y : bounds.bottom + 4;
    // a menu that would run off the bottom opens upward from the row or pointer instead
    if (top + size.height > view.clientHeight - edge) {
      top = (at ? at.y : bounds.top - 4) - size.height;
      element.classList.add("opens-up");
    } else {
      element.classList.remove("opens-up");
    }
    left = Math.max(edge, Math.min(left, view.clientWidth - size.width - edge));
    top = Math.max(edge, top);
    element.style.left = Math.round(left) + "px";
    element.style.top = Math.round(top) + "px";
  }

  function open(path: string, at?: { x: number; y: number }): void {
    const row = rowFor(path);
    const clip = host.clips()[path];
    if (!row || !clip) return;
    // the menu key can also fire a contextmenu event; the menu that is open stays as it is
    if (isOpen() && menuPath === path && !at) return;
    close(false);
    const element = ensureMenu();
    element.setAttribute("aria-label", `Edits for ${clip.name}`);
    for (const item of items(path)) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "row-menu-item";
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      button.dataset.rowMenuAction = item.action;
      // the name is the action; where the edits come from and the keys are told separately
      button.setAttribute("aria-label", item.label);
      if (item.detail) button.setAttribute("aria-description", item.detail);
      if (item.disabled) button.setAttribute("aria-disabled", "true");
      const text = doc.createElement("span");
      text.className = "row-menu-text";
      const label = doc.createElement("span");
      label.className = "row-menu-label";
      label.textContent = item.label;
      text.append(label);
      if (item.detail) {
        const detail = doc.createElement("span");
        detail.className = "row-menu-detail";
        detail.textContent = item.detail;
        // a long name is cut short in a narrow menu; hovering shows all of it
        detail.title = item.detail;
        text.append(detail);
      }
      button.append(text);
      if (item.keys) {
        const keys = doc.createElement("span");
        keys.className = "row-menu-keys";
        keys.textContent = item.keys;
        button.append(keys);
        if (item.ariaKeys) button.setAttribute("aria-keyshortcuts", item.ariaKeys);
      }
      element.append(button);
    }
    menuPath = path;
    row.classList.add("menu-target");
    show(element);
    place(element, row, at);
    // from the keyboard the first action is ready for Enter; a right click lights nothing until
    // the pointer or an arrow key picks an item
    if (at) {
      element.focus({ preventScroll: true });
    } else {
      const first = menuItems().findIndex((item) => item.getAttribute("aria-disabled") !== "true");
      focusItem(Math.max(0, first));
    }
  }

  function cardPath(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>("#clips .clip[data-clip-path]")?.dataset.clipPath ?? null;
  }

  const list = doc.getElementById("clips");
  list?.addEventListener("pointerdown", (event) => {
    if (event.button === 2) pointerOpen = Date.now();
  });
  list?.addEventListener("contextmenu", (event) => {
    const path = cardPath(event.target);
    if (!path) return;
    event.preventDefault();
    const fromPointer = Date.now() - pointerOpen < 1000;
    pointerOpen = 0;
    open(path, fromPointer ? { x: event.clientX, y: event.clientY } : undefined);
  });
  list?.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    const path = cardPath(event.target);
    if (!path) return;
    event.preventDefault();
    open(path);
  });
  // anything else the pointer touches, and the window losing focus, closes the menu
  doc.addEventListener("pointerdown", (event) => {
    if (menu && isOpen() && !(event.target instanceof Node && menu.contains(event.target))) close(false);
  }, true);
  host.window.addEventListener("blur", () => close(false));
  host.window.addEventListener("resize", () => close(false));
  list?.addEventListener("scroll", () => close(false), { passive: true });

  host.shortcuts?.registerAction("edit.copy-edits", {
    enabled: () => ready(host.selectedPath()),
    execute: () => {
      const path = host.selectedPath();
      if (path) copy(path);
    },
  });
  host.shortcuts?.registerAction("edit.paste-edits", {
    enabled: () => !!clipboard && host.selectedPaths().some((path) => ready(path)),
    execute: () => paste(host.selectedPaths()),
  });

  return { copy, paste, copied: () => clipboard, open, close };
}
