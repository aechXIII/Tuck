import type { LutEntry } from "../../backend/types.ts";

export function createLutPicker(root: HTMLElement, select: (path: string) => void, clearHistory: () => void) {
  const trigger = root.querySelector<HTMLButtonElement>("#lut-name")!;
  const current = root.querySelector<HTMLElement>("#lut-current-name")!;
  const popup = root.querySelector<HTMLElement>("#lut-picker-popup")!;
  const search = root.querySelector<HTMLInputElement>("#lut-search")!;
  const list = root.querySelector<HTMLElement>("#lut-options")!;
  const empty = root.querySelector<HTMLElement>("#lut-empty")!;
  const clear = root.querySelector<HTMLButtonElement>("#lut-clear-history")!;
  const remove = root.querySelector<HTMLButtonElement>("#lut-remove")!;
  const feedback = root.querySelector<HTMLElement>("#lut-history-status")!;
  const importButton = root.querySelector<HTMLButtonElement>("#lut-import")!;
  const row = trigger.parentElement!;
  const head = popup.querySelector<HTMLElement>(".lut-picker-head")!;
  const options = new Map<string, HTMLElement>();
  let selectedPath = "";
  let activePath: string | null = null;
  // a row lit by the pointer goes dark when the pointer leaves; one lit by the keyboard stays
  let pointerActive = false;
  let pointerX = NaN;
  let pointerY = NaN;
  let nextId = 0;
  let historyCount = 0;
  let locked = false;
  let returnAfterLoad = false;

  function visibleOptions(): HTMLElement[] { return Array.from(list.children).filter((option): option is HTMLElement => option instanceof HTMLElement && !option.hidden); }
  function activate(path: string | null): void {
    activePath = path;
    for (const [value, option] of options) option.dataset.active = String(value === path);
    const option = path === null ? undefined : options.get(path);
    if (option && !option.hidden) {
      search.setAttribute("aria-activedescendant", option.id);
      if (popup.matches(":popover-open")) {
        const top = option.offsetTop - list.offsetTop;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
      }
    } else search.removeAttribute("aria-activedescendant");
  }
  function filter(): void {
    pointerActive = false;
    const query = search.value.trim().toLocaleLowerCase();
    for (const option of options.values()) option.hidden = !(option.textContent ?? "").toLocaleLowerCase().includes(query);
    const visible = visibleOptions();
    empty.textContent = query ? "No LUTs found." : "No saved LUTs.";
    empty.hidden = query ? visible.length > 0 : historyCount > 0;
    const chosen = visible.find(option => option.dataset.path === selectedPath) ?? visible[0];
    activate(chosen?.dataset.path ?? null);
    if (popup.matches(":popover-open")) position();
  }
  function close(returnFocus = false): void {
    if (popup.matches(":popover-open")) popup.hidePopover();
    if (importButton.parentElement !== row) row.append(importButton);
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) {
      if (trigger.disabled) returnAfterLoad = true;
      else trigger.focus();
    }
  }
  function position(): void {
    const bounds = row.getBoundingClientRect();
    // the menu opens over the file row, so it takes the row's width like the other dropdowns
    popup.style.width = `${Math.min(window.innerWidth - 16, bounds.width)}px`;
    const top = Math.max(8, bounds.top);
    const available = Math.max(80, window.innerHeight - top - 8);
    popup.style.maxHeight = `${available}px`;
    list.style.maxHeight = `${Math.max(32, Math.min(208, available - head.offsetHeight - 48))}px`;
    popup.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${top}px`;
  }
  function open(byPointer = false): void {
    if (trigger.disabled) return;
    search.value = "";
    head.append(importButton);
    popup.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    filter();
    // a click opens with nothing lit, the keyboard opens on the chosen LUT
    if (byPointer) activate(null);
    search.focus({preventScroll:true});
  }
  trigger.addEventListener("click", () => popup.matches(":popover-open") ? close() : open(true));
  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
  });
  popup.addEventListener("toggle", () => {
    const opened = popup.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(opened));
    if (!opened && importButton.parentElement !== row) row.append(importButton);
  });
  importButton.addEventListener("click", () => { close(); importButton.focus({preventScroll:true}); });
  popup.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  popup.addEventListener("focusout", event => {
    if (event.relatedTarget instanceof Node && !popup.contains(event.relatedTarget)) close();
  });
  search.addEventListener("input", filter);
  list.addEventListener("pointermove", event => {
    // only a real move counts, so a list scrolling under a resting pointer keeps the keyboard's row
    if (event.clientX === pointerX && event.clientY === pointerY) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[role=option]") : null;
    if (!option || option.hidden) return;
    if (option.dataset.path !== activePath) activate(option.dataset.path ?? null);
    pointerActive = true;
  });
  list.addEventListener("pointerleave", () => {
    if (!pointerActive) return;
    pointerActive = false;
    activate(null);
  });
  search.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      pointerActive = false;
      const visible = visibleOptions();
      const index = visible.findIndex(option => option.dataset.path === activePath);
      const chosen = visible.findIndex(option => option.dataset.path === selectedPath);
      const next = index < 0 && chosen >= 0 ? chosen
        : event.key === "ArrowDown" ? Math.min(visible.length - 1, index + 1) : Math.max(0, index - 1);
      activate(visible[next]?.dataset.path ?? null);
    } else if (event.key === "Enter" && activePath !== null && !locked) {
      event.preventDefault();
      const value = activePath;
      close(true);
      select(value);
    }
  });
  list.addEventListener("click", event => {
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[role=option]") : null;
    if (!option || option.hidden || locked) return;
    close(true);
    select(option.dataset.path ?? "");
  });
  remove.addEventListener("click", () => {
    if (locked) return;
    close(true);
    select("");
  });
  clear.addEventListener("click", () => { search.focus(); clearHistory(); });
  window.addEventListener("resize", () => close());
  root.ownerDocument.addEventListener("scroll", event => {
    if (event.target instanceof Node && !popup.contains(event.target) && popup.matches(":popover-open")) position();
  }, true);

  return {
    sync(entries: readonly LutEntry[], selected: LutEntry, busy: boolean, clearing: boolean): void {
      selectedPath = selected.path;
      remove.hidden = !selected.path;
      remove.disabled = busy || clearing;
      locked = busy || clearing;
      current.textContent = selected.name || "No LUT selected";
      trigger.title = selected.name;
      if (busy && root.ownerDocument.activeElement === trigger) returnAfterLoad = true;
      trigger.disabled = busy || clearing;
      search.disabled = busy;
      clear.disabled = busy || clearing || entries.length === 0;
      clear.textContent = clearing ? "Clearing…" : "Clear history";
      historyCount = entries.length;
      const choices = entries;
      const paths = new Set(choices.map(entry => entry.path));
      for (const [path, option] of options) if (!paths.has(path)) { option.remove(); options.delete(path); }
      choices.forEach((entry, index) => {
        let option = options.get(entry.path);
        if (!option) {
          option = root.ownerDocument.createElement("div");
          option.id = `lut-option-${nextId++}`;
          option.className = "lut-option";
          option.setAttribute("role", "option");
          option.dataset.path = entry.path;
          option.innerHTML = '<span></span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.5 6 2.2 2.2 4.8-4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          options.set(entry.path, option);
        }
        option.querySelector("span")!.textContent = entry.name;
        option.title = entry.name;
        option.setAttribute("aria-selected", String(entry.path === selectedPath));
        if (list.children[index] !== option) list.insertBefore(option, list.children[index] ?? null);
      });
      filter();
      if (!busy && !clearing && returnAfterLoad) {
        if (root.ownerDocument.activeElement === root.ownerDocument.body) trigger.focus();
        returnAfterLoad = false;
      }
    },
    feedback(message: string): void {
      feedback.textContent = message;
      feedback.hidden = !message;
      if (popup.matches(":popover-open")) position();
    },
  };
}
