// Save as GIF: the selected video's timeline as Compress would export it, written as a GIF. The
// dialog makes the real GIF as the settings change, so the size it shows is the file's size
import type { GifPreviewPayload, GifRequest, GifSettingsPayload } from "../../backend/gif-types.ts";
import type { BackendClient, JsonObject, PlanRequest } from "../../backend/types.ts";
import type { ModalOptions } from "../editor/toast.ts";
import {
  GIF_DEFAULTS,
  customValue,
  gifResultText,
  gifSettingsPayload,
  savedChoices,
  sizeParts,
  type GifChoices,
  type NumberChoice,
} from "./gif-settings.ts";

// as the Quality estimate does: start once the settings have stopped changing
const PREVIEW_SETTLE_MS = 500;

export interface GifDialogDeps {
  readonly document: Document;
  readonly client: () => BackendClient;
  /** the request Compress would send for this video: its segments, crop and colors */
  readonly planRequest: (path: string) => PlanRequest;
  readonly savedSettings: () => JsonObject | undefined;
  readonly rememberSettings: (settings: GifSettingsPayload) => void;
  readonly exportsRunning: () => boolean;
  /** the GIF is in Exports; the bar follows it */
  readonly queued: (itemId: string) => void;
  readonly showDialog: (html: string, options: ModalOptions) => HTMLElement;
  readonly closeDialog: () => void;
}

export interface GifDialogApi {
  open(path: string): void;
  /** the queue changed: a preview that waited for the exports starts once they finish */
  queueChanged(): void;
}

type ChoiceKey = keyof GifChoices;
type Cell = readonly [value: number | string, label: string];

interface Row {
  readonly key: ChoiceKey;
  readonly label: string;
  readonly cells: readonly Cell[];
  readonly custom?: { readonly unit: string; readonly name: string };
}

const PICTURE: readonly Row[] = [
  { key: "width", label: "Width", cells: [[320, "320"], [480, "480"], [640, "640"], [720, "720"]], custom: { unit: "px", name: "Custom width in pixels" } },
  { key: "fps", label: "Frame rate", cells: [[10, "10"], [15, "15"], [24, "24"], [30, "30"]], custom: { unit: "fps", name: "Custom frame rate" } },
  { key: "colors", label: "Colors", cells: [[32, "32"], [64, "64"], [128, "128"], [256, "256"]], custom: { unit: "", name: "Custom number of colors" } },
];
const PLAYBACK: readonly Row[] = [
  { key: "speed", label: "Speed", cells: [[0.5, "0.5×"], [1, "1×"], [1.5, "1.5×"], [2, "2×"]], custom: { unit: "×", name: "Custom speed" } },
  { key: "backAndForth", label: "Plays", cells: [[0, "Forward"], [1, "Back and forth"]] },
  { key: "plays", label: "Repeat", cells: [[0, "Forever"], [1, "Once"]], custom: { unit: "times", name: "Number of times it plays" } },
];
const FILE: readonly Row[] = [
  { key: "limit", label: "Size limit", cells: [[0, "None"], [5, "5 MB"], [10, "10 MB"], [25, "25 MB"]], custom: { unit: "MB", name: "Custom size limit in MB" } },
];
const ADVANCED: readonly Row[] = [
  { key: "dither", label: "Dithering", cells: [["soft", "Soft"], ["pattern", "Pattern"], ["off", "Off"]] },
  { key: "palette", label: "Palette", cells: [["whole", "Whole GIF"], ["frame", "Each frame"]] },
  { key: "sharp", label: "Scaling", cells: [[0, "Smooth"], [1, "Sharp pixels"]] },
];

const TIPS: Partial<Record<ChoiceKey, string>> = {
  dither: "Soft keeps gradients smooth. Pattern is a still dot pattern. Off is flat color and smallest.",
  palette: "Each frame gets its own colors, for scenes whose colors change a lot.",
  sharp: "Sharp pixels keeps hard edges, for pixel-art games.",
  limit: "Tuck lowers the frame rate, then the width, until the GIF fits.",
};

function rowMarkup(row: Row): string {
  const label = `gif-l-${row.key}`;
  const cells = row.cells.map(([value, text]) =>
    `<button type="button" data-gif-key="${row.key}" data-gif-value="${value}" aria-pressed="false">${text}</button>`,
  );
  if (row.custom) {
    cells.push(
      `<label class="gif-custom"><input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-gif-custom="${row.key}" placeholder="Custom" aria-label="${row.custom.name}">` +
      `<span class="gif-unit" aria-hidden="true">${row.custom.unit}</span></label>`,
    );
  }
  const tip = TIPS[row.key] ? ` title="${TIPS[row.key]}"` : "";
  return `<div class="gif-field"><span class="gif-label" id="${label}"${tip}>${row.label}</span>` +
    `<div class="gif-cells" role="group" aria-labelledby="${label}" style="--cells:${cells.length}">${cells.join("")}</div></div>`;
}

function groupMarkup(title: string, rows: readonly Row[]): string {
  return `<section class="gif-group"><h3 class="gif-group-head">${title}</h3><div class="gif-rows">${rows.map(rowMarkup).join("")}</div></section>`;
}

// built from the constants above only; everything that changes is written with textContent
function dialogMarkup(): string {
  return `<header class="gif-head"><h2 id="gif-title">Save as GIF</h2>` +
    `<button type="button" class="inspector-reset" id="gif-reset">Reset all</button>` +
    `<button type="button" class="gif-close" id="gif-close" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"></path></svg></button></header>` +
    `<div class="gif-body"><div class="gif-view" id="gif-view">` +
    `<div class="gif-stage" id="gif-stage"><img id="gif-pic" alt="The GIF as it will be saved, playing" hidden></div>` +
    `<div class="gif-result" aria-live="polite">` +
    `<span class="gif-size" id="gif-size" hidden><span class="gif-about" id="gif-about" hidden>About</span><span class="gif-n" id="gif-n"></span><span class="gif-u" id="gif-u"></span></span>` +
    `<span class="gif-state" id="gif-state">Making preview</span>` +
    `<span class="gif-facts"><span class="gif-from" id="gif-from"></span><span class="gif-detail" id="gif-detail"></span></span>` +
    `</div></div>` +
    `<div class="gif-settings" id="gif-settings">` +
    groupMarkup("Picture", PICTURE) + groupMarkup("Playback", PLAYBACK) + groupMarkup("File", FILE) +
    `<section class="gif-group"><button type="button" class="gif-adv-toggle" id="gif-more" aria-expanded="false" aria-controls="gif-adv"><span>Advanced</span>` +
    `<svg class="gif-adv-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"></path></svg></button>` +
    `<div class="gif-rows" id="gif-adv" hidden>${ADVANCED.map(rowMarkup).join("")}` +
    `<label class="toggle-row gif-switch" title="Leaves out frames that are the same as the one before, which shrinks screen recordings"><span>Drop repeated frames</span>` +
    `<input type="checkbox" role="switch" id="gif-dup"><span class="toggle-track" aria-hidden="true"></span></label></div></section>` +
    `</div></div>` +
    `<footer class="gif-foot"><span class="gif-name" id="gif-name"></span>` +
    `<button type="button" class="btn2" id="gif-cancel">Cancel</button>` +
    `<button type="button" class="btn1" id="gif-save">Save GIF</button></footer>`;
}

function choiceValue(choices: GifChoices, key: ChoiceKey): number | string {
  const value = choices[key];
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

function withChoice(choices: GifChoices, key: ChoiceKey, raw: string): GifChoices {
  const current = choices[key];
  if (typeof current === "boolean") return { ...choices, [key]: raw === "1" };
  if (typeof current === "number") return { ...choices, [key]: Number(raw) };
  return { ...choices, [key]: raw };
}

const NUMBER_KEYS: ReadonlySet<string> = new Set<NumberChoice>(["width", "fps", "colors", "speed", "plays", "limit"]);

export function installGifDialog(deps: GifDialogDeps): GifDialogApi {
  const doc = deps.document;
  let path: string | null = null;
  let box: HTMLElement | null = null;
  let choices: GifChoices = { ...GIF_DEFAULTS };
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  let saving = false;
  // every dialog reuses the same box, so its listeners go when it closes
  let listening: AbortController | null = null;
  // a value Tuck pulled back says why until the next change
  let hint = "";

  const part = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = box?.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing #${id}`);
    return element;
  };

  function paintChoices(): void {
    if (!box) return;
    for (const group of box.querySelectorAll<HTMLElement>(".gif-cells")) {
      let chosen = false;
      for (const button of group.querySelectorAll<HTMLButtonElement>("button[data-gif-key]")) {
        const key = button.dataset.gifKey as ChoiceKey;
        const on = String(choiceValue(choices, key)) === button.dataset.gifValue;
        chosen ||= on;
        button.classList.toggle("on", on);
        button.setAttribute("aria-pressed", String(on));
      }
      const input = group.querySelector<HTMLInputElement>("input[data-gif-custom]");
      if (!input) continue;
      // the last cell shows a value no quick pick has, so it never shows twice
      if (doc.activeElement !== input) input.value = chosen ? "" : String(choiceValue(choices, input.dataset.gifCustom as ChoiceKey));
      input.closest(".gif-custom")?.classList.toggle("on", !chosen);
    }
    part<HTMLInputElement>("gif-dup").checked = choices.dropRepeats;
  }

  function showState(text: string): void {
    part("gif-size").hidden = true;
    const state = part("gif-state");
    state.hidden = false;
    state.textContent = text;
    part("gif-stage").classList.add("making");
  }

  function setDetail(text: string, warn: boolean): void {
    const detail = part("gif-detail");
    detail.textContent = text;
    detail.classList.toggle("warn", warn);
  }

  function paintPreview(preview: GifPreviewPayload): void {
    const [count, unit] = sizeParts(preview.size_bytes);
    const text = gifResultText(preview, choices);
    part("gif-state").hidden = true;
    const size = part("gif-size");
    size.hidden = false;
    size.classList.toggle("warn", text.warn);
    part("gif-about").hidden = !preview.estimated;
    part("gif-n").textContent = count;
    part("gif-u").textContent = unit;
    part("gif-from").textContent = text.from;
    setDetail(hint || text.detail, Boolean(hint) || text.warn);
    const name = part("gif-name");
    name.textContent = preview.name;
    name.title = preview.name;
    part("gif-stage").classList.remove("making");
  }

  function makeSoon(delay = PREVIEW_SETTLE_MS): void {
    clearTimeout(timer);
    request += 1;
    waiting = false;
    showState("Making preview");
    timer = setTimeout(() => void make(), delay);
  }

  async function make(): Promise<void> {
    if (!path) return;
    const id = request;
    if (deps.exportsRunning()) {
      waiting = true;
      showState("After export");
      return;
    }
    const gifRequest: GifRequest = { plan: deps.planRequest(path), gif: gifSettingsPayload(choices), _request_id: id };
    const result = await deps.client().makeGifPreview(gifRequest);
    if (id !== request || !box) return;
    if (result.ok) {
      const preview = result.value;
      const picture = part<HTMLImageElement>("gif-pic");
      // decoded before it is shown, so the old GIF stays until the new one can play
      const next = new Image();
      next.src = preview.url;
      try { await next.decode(); } catch { /* shown anyway; the size is still right */ }
      if (id !== request || !box) return;
      picture.src = preview.url;
      picture.hidden = false;
      paintPreview(preview);
      return;
    }
    if (result.error.code === "cancelled") return;
    if (result.error.code === "export_running") {
      waiting = true;
      showState("After export");
      return;
    }
    showState("No preview");
    setDetail(result.error.message, true);
  }

  function choose(key: ChoiceKey, raw: string): void {
    hint = "";
    const next = withChoice(choices, key, raw);
    if (choiceValue(next, key) === choiceValue(choices, key)) return;
    choices = next;
    paintChoices();
    makeSoon();
  }

  function commitCustom(input: HTMLInputElement): void {
    const key = input.dataset.gifCustom as NumberChoice;
    if (!NUMBER_KEYS.has(key)) return;
    const typed = customValue(key, input.value);
    // a cleared or unreadable field keeps the value it had
    if (!typed) { paintChoices(); return; }
    const changed = typed.value !== choices[key];
    choices = { ...choices, [key]: typed.value };
    hint = typed.note;
    paintChoices();
    if (typed.note) setDetail(typed.note, true);
    if (changed) makeSoon();
  }

  function fitColumns(): void {
    if (!box) return;
    // the settings scroll inside their column only once Advanced opens, so the picture's side is
    // at least as tall as the settings with Advanced closed
    const view = part("gif-view");
    const settings = part("gif-settings");
    const advanced = part("gif-adv");
    view.style.minHeight = "";
    const open = !advanced.hidden;
    advanced.hidden = true;
    const groups = [...settings.children].filter((child) => child instanceof HTMLElement) as HTMLElement[];
    const gap = Number.parseFloat(getComputedStyle(settings).rowGap) || 0;
    const closed = groups.reduce((sum, group) => sum + group.getBoundingClientRect().height, 0) + gap * (groups.length - 1);
    advanced.hidden = !open;
    view.style.minHeight = `${Math.ceil(closed)}px`;
  }

  async function save(): Promise<void> {
    if (!path || saving) return;
    saving = true;
    const button = part<HTMLButtonElement>("gif-save");
    button.disabled = true;
    const settings = gifSettingsPayload(choices);
    const result = await deps.client().enqueueGif({ plan: deps.planRequest(path), gif: settings });
    saving = false;
    if (!box) return;
    button.disabled = false;
    if (!result.ok) {
      setDetail(`Couldn’t add the GIF to Exports. ${result.error.message}`, true);
      return;
    }
    deps.rememberSettings(settings);
    const itemId = result.value.item_id;
    deps.closeDialog();
    if (typeof itemId === "string") deps.queued(itemId);
  }

  function closed(): void {
    clearTimeout(timer);
    request += 1;
    path = null;
    box = null;
    waiting = false;
    hint = "";
    listening?.abort();
    listening = null;
    // stops a preview being made and removes the one shown
    void deps.client().cancelGifPreview();
  }

  function open(source: string): void {
    path = source;
    choices = savedChoices(deps.savedSettings());
    hint = "";
    saving = false;
    box = deps.showDialog(dialogMarkup(), {
      className: "mod-box gif-dialog",
      labelledBy: "gif-title",
      onClose: closed,
    });
    listening?.abort();
    listening = new AbortController();
    const signal = listening.signal;
    box.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const cell = target?.closest<HTMLButtonElement>("button[data-gif-key]");
      if (cell) { choose(cell.dataset.gifKey as ChoiceKey, cell.dataset.gifValue ?? ""); return; }
      const id = target?.closest<HTMLElement>("button[id]")?.id;
      if (id === "gif-close" || id === "gif-cancel") deps.closeDialog();
      else if (id === "gif-save") void save();
      else if (id === "gif-reset") {
        choices = { ...GIF_DEFAULTS };
        hint = "";
        paintChoices();
        makeSoon();
      } else if (id === "gif-more") {
        const more = part("gif-more");
        const expanded = more.getAttribute("aria-expanded") !== "true";
        more.setAttribute("aria-expanded", String(expanded));
        part("gif-adv").hidden = !expanded;
        if (expanded) {
          const settings = part("gif-settings");
          settings.scrollTo({ top: settings.scrollHeight });
        }
      }
    }, { signal });
    box.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.id === "gif-dup") {
        choices = { ...choices, dropRepeats: target.checked };
        makeSoon();
      } else if (target.dataset.gifCustom) commitCustom(target);
    }, { signal });
    box.addEventListener("keydown", (event) => {
      const target = event.target;
      if (event.key === "Enter" && target instanceof HTMLInputElement && target.dataset.gifCustom) {
        event.preventDefault();
        commitCustom(target);
      }
    }, { signal });
    globalThis.addEventListener("resize", fitColumns, { signal });
    paintChoices();
    fitColumns();
    makeSoon(0);
  }

  return {
    open,
    queueChanged: () => {
      if (box && waiting && !deps.exportsRunning()) makeSoon(0);
    },
  };
}
