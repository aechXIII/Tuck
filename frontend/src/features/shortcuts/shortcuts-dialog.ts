import {
  bindingMarkup,
  cleanupDialog,
  escapeMarkup,
  keyboardRowsMarkup,
  registerAction,
  resultLabel,
  search,
  sectionColumns,
  sections,
  shouldUseSingleColumn,
  spokenBindingText,
  tabbableControls,
  updateClearButton,
  dispatch,
  type ClearButtonLike,
  type CommandState,
  type KeyboardEventLike,
  type TabbableControl,
} from "./shortcuts.ts";

export interface FocusTarget {
  focus: () => void;
  matches?: (selectors: string) => boolean;
  isContentEditable?: boolean;
}

export interface ShortcutDialogDocument {
  body:
    | (FocusTarget & {
        classList: { contains: (name: string) => boolean };
      })
    | null;
  activeElement: FocusTarget | null;
  getElementById: (id: string) => (HTMLElement & ClearButtonLike) | null;
  querySelectorAll: (
    selectors: string,
  ) => NodeListOf<Element> | ArrayLike<Element>;
}

export interface ShortcutDialogHost {
  document: ShortcutDialogDocument;
  addEventListener: (
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
  ) => void;
  prepareModalBox: (className: string) => HTMLElement;
  closeMod: () => void;
}

export interface ShortcutDialogApi {
  openDialog: () => void;
  resetDialog: (restoreFocus?: boolean) => void;
}

export function installShortcutDialog(host: ShortcutDialogHost): ShortcutDialogApi {
  let returnFocus: FocusTarget | null = null;

  function byId(id: string): HTMLElement | null {
    return host.document.getElementById(id);
  }

  function commandState(event: KeyboardEventLike | null | undefined): CommandState {
    const target =
      ((event as { target?: FocusTarget | null } | null | undefined)?.target) ||
      (host.document.activeElement as FocusTarget | null);
    const textEntryFocused = !!(
      target &&
      ((typeof target.matches === "function" &&
        target.matches("input, select, textarea")) ||
        target.isContentEditable)
    );
    const formControlFocused = !!(
      target &&
      ((typeof target.matches === "function" &&
        target.matches("input, select, textarea, button")) ||
        target.isContentEditable)
    );
    const overlay = byId("mod-overlay");
    return {
      modalOpen: !!(
        overlay &&
        overlay.classList &&
        overlay.classList.contains("open")
      ),
      settingsOpen: !!(
        host.document.body &&
        host.document.body.classList.contains("settings-open")
      ),
      formControlFocused,
      textEntryFocused,
    };
  }

  function dispatchCommand(event: KeyboardEvent): void {
    dispatch(event, commandState(event));
  }

  function dialogMarkup(): string {
    return `<div class="kbs-dialog-header">
      <div>
        <h2 id="kbs-dialog-title">Keyboard shortcuts</h2>
        <p>Browse the keyboard or search by action and key.</p>
      </div>
      <button type="button" class="kbs-close" id="kbs-dialog-close" aria-label="Close keyboard shortcuts">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"></path></svg>
      </button>
    </div>
    <div class="kbs-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5"></circle><line x1="10" y1="10" x2="14" y2="14"></line></svg>
      <input type="search" id="kbs-search-input" aria-label="Search keyboard shortcuts" placeholder="Search actions or keys…" autocomplete="off" spellcheck="false" />
      <button type="button" class="kbs-clear is-hidden" id="kbs-search-clear" aria-label="Clear search" aria-hidden="true" disabled tabindex="-1">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>
      </button>
      <span id="kbs-match-count" aria-live="polite"></span>
    </div>
    <div class="kbs-keyboard" aria-hidden="true">${keyboardRowsMarkup()}</div>
    <div class="kbs-grid" id="kbs-grid"></div>`;
  }

  function renderResults(query: string): void {
    const grid = byId("kbs-grid");
    if (!grid) return;

    const result = search(sections, query);
    const sourceColumns = sectionColumns(result.sections, false);
    const singleColumn = shouldUseSingleColumn(
      result.query,
      result.matched,
      sourceColumns.length,
    );
    let html = "";
    const lit: Record<string, boolean> = {};

    result.keyIds.forEach((id) => {
      lit[id] = true;
    });
    sectionColumns(result.sections, singleColumn).forEach((column) => {
      html += '<div class="kbs-column">';
      column.forEach((section) => {
        html +=
          '<section class="kbs-section"><h3 class="kbs-cat">' +
          escapeMarkup(section.cat) +
          "</h3>";
        section.items.forEach((item) => {
          const note = item.note
            ? '<span class="kbs-note">' + escapeMarkup(item.note) + "</span>"
            : "";
          html +=
            '<div class="kbs-row"><span class="kbs-action"><span>' +
            escapeMarkup(item.label) +
            "</span>" +
            note +
            '</span><span class="kbs-keys"><span class="kbs-sr-label">' +
            escapeMarkup(spokenBindingText(item.keys)) +
            '</span><span class="kbs-bindings" aria-hidden="true">' +
            bindingMarkup(item.keys) +
            "</span></span></div>";
        });
        html += "</section>";
      });
      html += "</div>";
    });

    grid.innerHTML =
      html ||
      '<div class="kbs-empty"><strong>No shortcuts found</strong><span>Try another action or key.</span></div>';
    const count = byId("kbs-match-count");
    if (count)
      count.textContent = resultLabel(
        result.query,
        result.matched,
        result.total,
      );
    updateClearButton(
      byId("kbs-search-clear") as ClearButtonLike | null,
      !!result.query,
    );
    const box = byId("mod-box");
    if (box) box.classList.toggle("is-single-column", singleColumn);
    const keys = host.document.querySelectorAll(".kbs-key[data-k]");
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as HTMLElement | undefined;
      if (!key) continue;
      key.classList.toggle("lit", !!lit[key.dataset.k || ""]);
    }
  }

  function clearSearch(): void {
    const input = byId("kbs-search-input") as HTMLInputElement | null;
    if (!input) return;
    input.value = "";
    renderResults("");
    input.focus();
  }

  function trapFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const focusable = tabbableControls(byId("mod-box")) as Array<
      TabbableControl & FocusTarget
    >;
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && host.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && host.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function resetDialog(restoreFocus?: boolean): void {
    returnFocus = cleanupDialog(
      byId("mod-box"),
      trapFocus,
      returnFocus,
      !!restoreFocus,
    );
  }

  function openDialog(): void {
    const box = host.prepareModalBox("mod-box shortcuts-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "kbs-dialog-title");
    box.innerHTML = dialogMarkup();
    box.removeEventListener("keydown", trapFocus);
    box.addEventListener("keydown", trapFocus);
    byId("kbs-dialog-close")!.addEventListener("click", host.closeMod);
    byId("kbs-search-clear")!.addEventListener("click", clearSearch);
    const input = byId("kbs-search-input") as HTMLInputElement | null;
    input!.addEventListener("input", () => {
      renderResults(input!.value);
    });
    returnFocus =
      host.document.activeElement &&
      host.document.activeElement !== host.document.body
        ? host.document.activeElement
        : (byId("shortcuts-toggle") as FocusTarget | null);
    byId("mod-overlay")!.classList.add("open");
    renderResults("");
    if (input) input.focus();
  }

  registerAction("help.shortcuts", openDialog);
  host.addEventListener("keydown", dispatchCommand);

  return {
    openDialog,
    resetDialog,
  };
}
