import { filterSelectOptions, nextSelectIndex, nextSelectMatch, selectPopupPlacement, selectSearchThreshold, selectTypeaheadPrefix, type SelectOption } from "./select-state.ts";

export interface SelectControls {
  sync(root: ParentNode): void;
}

interface SelectControl {
  readonly host: HTMLElement;
  sync(): void;
  position(): void;
  close(restoreFocus?: boolean): void;
  destroy(): void;
}

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(svg.namespaceURI, "path");
  line.setAttribute("d", path);
  svg.append(line);
  return svg;
}

export function installSelectControls(
  doc: Document,
  describe: (id: string, value: string) => string = () => "",
): SelectControls {
  const controls = new Map<HTMLSelectElement, SelectControl>();
  let openControl: SelectControl | null = null;

  function create(select: HTMLSelectElement): SelectControl {
    const id = select.id;
    const host = doc.createElement("div");
    host.className = "custom-select";
    select.before(host);
    host.append(select);
    select.hidden = true;
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.id = `${id}-trigger`;
    trigger.className = "select-trigger";
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${id}-options`);
    for (const name of ["aria-label", "aria-labelledby", "aria-describedby", "aria-invalid", "aria-required", "title"]) {
      const value = select.getAttribute(name);
      if (value) trigger.setAttribute(name, value);
    }
    select.removeAttribute("aria-label");
    select.removeAttribute("aria-labelledby");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;
    const labels = Array.from(select.labels ?? []);
    labels.forEach(label => { label.htmlFor = trigger.id; });
    if (!trigger.hasAttribute("aria-label") && !trigger.hasAttribute("aria-labelledby") && !labels.length) {
      trigger.setAttribute("aria-label", id);
    }
    const valueText = doc.createElement("span");
    trigger.append(valueText, icon("m3 4.5 3 3 3-3"));

    const popup = doc.createElement("div");
    popup.id = `${id}-popup`;
    popup.className = "select-popup";
    popup.setAttribute("popover", "auto");
    const searchRow = doc.createElement("div");
    searchRow.className = "select-search";
    const search = doc.createElement("input");
    search.type = "search";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.placeholder = select.dataset.search || "Search options";
    search.setAttribute("aria-label", search.placeholder);
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-autocomplete", "list");
    search.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-controls", `${id}-options`);
    searchRow.append(icon("M8 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-.5 2.5L11 11"), search);
    const list = doc.createElement("div");
    list.className = "select-options";
    list.id = `${id}-options`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", trigger.id);
    const empty = doc.createElement("p");
    empty.className = "select-empty";
    empty.setAttribute("role", "status");
    empty.textContent = "No matches. Try another name.";
    empty.hidden = true;
    popup.append(searchRow, list, empty);
    host.append(trigger, popup);

    let options: SelectOption[] = [];
    let visible: SelectOption[] = [];
    let active = -1;
    let signature = "";
    let searchable = false;
    let typed = "";
    let lastTyped = 0;
    const isOpen = () => popup.matches(":popover-open");
    const focusOwner = () => searchable ? search : trigger;

    function markActive(index: number, scroll = true): void {
      active = index;
      const rows = list.querySelectorAll<HTMLElement>("[role=option]");
      rows.forEach((row, i) => row.toggleAttribute("data-active", i === active));
      const row = rows[active];
      const owner = focusOwner();
      if (row && isOpen()) {
        owner.setAttribute("aria-activedescendant", row.id);
        if (scroll && isOpen()) {
          const bounds = row.getBoundingClientRect();
          const viewport = popup.getBoundingClientRect();
          const top = viewport.top + (searchable ? searchRow.offsetHeight : 0) + 6;
          if (bounds.top < top) popup.scrollTop -= top - bounds.top;
          else if (bounds.bottom > viewport.bottom - 6) popup.scrollTop += bounds.bottom - viewport.bottom + 6;
        }
      } else owner.removeAttribute("aria-activedescendant");
    }

    function render(): void {
      const previous = visible[active]?.value;
      visible = filterSelectOptions(options, searchable ? search.value : "");
      list.replaceChildren();
      visible.forEach((option, index) => {
        const row = doc.createElement("div");
        row.className = "select-option";
        row.id = `${id}-option-${index}`;
        row.dataset.index = String(index);
        row.dataset.value = option.value;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(option.value === select.value));
        row.setAttribute("aria-disabled", String(option.disabled));
        const title = doc.createElement("span");
        title.className = "select-option-title";
        title.textContent = option.label;
        row.title = option.detail ? `${option.label}: ${option.detail}` : option.label;
        row.append(title, icon("m2 6 2.5 2.5L10 3"));
        list.append(row);
      });
      empty.hidden = visible.length > 0;
      const preferred = visible.findIndex(option => option.value === (previous ?? select.value) && !option.disabled);
      markActive(preferred >= 0 ? preferred : nextSelectIndex(visible, -1, 1), false);
    }

    function position(): void {
      const view = doc.defaultView;
      if (!view) return;
      if (!trigger.getClientRects().length) { close(); return; }
      const anchor = trigger.getBoundingClientRect();
      if (anchor.bottom < 8 || anchor.top > view.innerHeight - 8) { close(); return; }
      popup.style.width = `${anchor.width}px`;
      const placement = selectPopupPlacement(anchor,
        Math.min(popup.scrollHeight, 380), view.innerWidth, view.innerHeight);
      popup.style.width = `${placement.width}px`;
      popup.style.maxHeight = `${placement.maxHeight}px`;
      popup.style.left = `${placement.left}px`;
      popup.style.top = `${placement.top}px`;
    }

    function close(restoreFocus = false): void {
      if (isOpen()) popup.hidePopover();
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      search.removeAttribute("aria-activedescendant");
      if (openControl === control) openControl = null;
      if (restoreFocus && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }

    function open(): void {
      control.sync();
      if (trigger.disabled) return;
      openControl?.close();
      openControl = control;
      search.value = "";
      typed = "";
      lastTyped = 0;
      visible = [];
      active = -1;
      render();
      popup.showPopover();
      trigger.setAttribute("aria-expanded", "true");
      position();
      focusOwner().focus({ preventScroll: true });
      markActive(active);
    }

    function choose(index: number): void {
      const option = visible[index];
      if (!option || option.disabled || select.matches(":disabled")) return;
      close(true);
      if (select.value === option.value) return;
      select.value = option.value;
      control.sync();
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function keydown(event: KeyboardEvent): void {
      if (event.key === "Tab") { close(); return; }
      if (event.key === "Escape") {
        if (isOpen()) { event.preventDefault(); event.stopPropagation(); close(true); }
        return;
      }
      const typing = event.target === search;
      const keys = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "];
      const character = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (typing && (event.key === " " || event.key === "Home" || event.key === "End")) return;
      if (!keys.includes(event.key) && (typing || !character)) return;
      event.stopPropagation();
      event.preventDefault();
      const wasOpen = isOpen();
      if (!wasOpen) open();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (wasOpen) markActive(nextSelectIndex(visible, active, event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Home" || event.key === "End") {
        markActive(nextSelectIndex(visible, -1, event.key === "Home" ? 1 : -1));
      } else if (event.key === "Enter" || event.key === " ") {
        if (wasOpen) choose(active);
      } else if (character) {
        typed = selectTypeaheadPrefix(typed, lastTyped, event.key, event.timeStamp, !searchable);
        lastTyped = event.timeStamp;
        if (searchable) { search.value = typed; render(); position(); }
        else {
          markActive(nextSelectMatch(visible, active, typed, typed.length === 1));
        }
      }
    }

    trigger.addEventListener("click", () => { if (isOpen()) close(); else open(); });
    trigger.addEventListener("keydown", keydown);
    popup.addEventListener("keydown", keydown);
    popup.addEventListener("toggle", () => { if (!isOpen()) close(); });
    search.addEventListener("input", () => { visible = []; active = -1; render(); position(); });
    list.addEventListener("pointerdown", event => event.preventDefault());
    list.addEventListener("pointermove", event => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null;
      if (row && row.getAttribute("aria-disabled") !== "true") markActive(Number(row.dataset.index), false);
    });
    list.addEventListener("click", event => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null;
      if (row) choose(Number(row.dataset.index));
    });
    host.addEventListener("focusout", event => {
      if (event.relatedTarget instanceof Node && !host.contains(event.relatedTarget)) close();
    });
    const onChange = () => control.sync();
    select.addEventListener("change", onChange);

    const control: SelectControl = {
      host, close, position,
      sync() {
        trigger.dataset.value = select.value;
        const updated = Array.from(select.options).filter(option => !option.hidden).map(option => ({
          value: option.value, label: option.textContent ?? "", detail: option.dataset.detail ?? describe(id, option.value),
          disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
        }));
        trigger.disabled = select.matches(":disabled") || updated.length === 0;
        valueText.textContent = select.selectedOptions[0]?.textContent ??
          (updated.length ? "Choose an option" : select.dataset.emptyLabel || "No options available");
        searchable = updated.length >= selectSearchThreshold;
        searchRow.hidden = !searchable;
        trigger.setAttribute("role", searchable ? "button" : "combobox");
        trigger.setAttribute("aria-haspopup", searchable ? "dialog" : "listbox");
        if (searchable) {
          popup.setAttribute("role", "dialog");
          popup.setAttribute("aria-labelledby", trigger.id);
          trigger.setAttribute("aria-controls", popup.id);
        } else {
          popup.removeAttribute("role");
          popup.removeAttribute("aria-labelledby");
          trigger.setAttribute("aria-controls", list.id);
        }
        const nextSignature = JSON.stringify([updated, select.value]);
        if (nextSignature !== signature) { options = updated; signature = nextSignature; render(); }
        if (isOpen()) {
          if (trigger.disabled) close();
          else position();
        }
      },
      destroy() {
        close();
        select.removeEventListener("change", onChange);
        host.remove();
      },
    };
    control.sync();
    return control;
  }

  doc.addEventListener("pointerdown", event => {
    if (openControl && event.target instanceof Node && !openControl.host.contains(event.target)) openControl.close();
  }, true);
  doc.addEventListener("scroll", event => {
    if (openControl && event.target instanceof Node && !openControl.host.contains(event.target)) openControl.position();
  }, true);
  doc.defaultView?.addEventListener("resize", () => openControl?.close());

  return {
    sync(root) {
      for (const [select, control] of controls) {
        if (!select.isConnected) { control.destroy(); controls.delete(select); }
      }
      for (const select of root.querySelectorAll<HTMLSelectElement>("select")) {
        const existing = controls.get(select);
        if (existing) existing.sync();
        else if (!select.hidden && select.id) controls.set(select, create(select));
      }
    },
  };
}
