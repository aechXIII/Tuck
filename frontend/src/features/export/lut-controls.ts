import type { BackendClient, LutEntry } from "../../backend/types.ts";
import { createLutPreview } from "../preview/lut-preview.ts";
import { createLutPicker } from "./lut-picker.ts";

export interface LutSettings {
  enabled: boolean;
  strength: number;
  path: string;
  name: string;
}

export function lutSettings(raw: unknown): LutSettings {
  const data = raw && typeof raw === "object" ? raw as Partial<LutSettings> : {};
  return {enabled:data.enabled === true, strength:typeof data.strength === "number" ? data.strength : 1,
    path:typeof data.path === "string" ? data.path : "", name:typeof data.name === "string" ? data.name : ""};
}

export function installLutControls(root: HTMLElement, video: HTMLVideoElement,
  client: () => BackendClient, changed: (planChanged?: boolean) => void) {
  const enabled = root.querySelector<HTMLInputElement>("#lut-enabled")!;
  const strength = root.querySelector<HTMLInputElement>("#lut-strength")!;
  const importButton = root.querySelector<HTMLButtonElement>("#lut-import")!;
  const errorNode = root.querySelector<HTMLElement>("#lut-error")!;
  const status = root.querySelector<HTMLElement>("#lut-status")!;
  let settings = lutSettings(null);
  let library: readonly LutEntry[] = [];
  let table: Float32Array | null = null;
  let size = 0;
  let generation = 0;
  let busy = false;
  let clearing = false;
  let libraryGeneration = 0;
  let pendingPath = "";
  let download: AbortController | null = null;
  let error = "";
  let backendError = "";
  let previewError = "";
  const picker = createLutPicker(root, selectLut, () => { void clearHistory(); });
  const preview = createLutPreview(video, message => { previewError = message; showError(); });
  function showError(): void {
    errorNode.textContent = error || (settings.enabled ? backendError || previewError : "");
    errorNode.hidden = !errorNode.textContent;
  }
  function sync(): void {
    const selected = busy ? library.find(entry => entry.path === pendingPath) ?? settings : settings;
    picker.sync(library, {path:selected.path, name:selected.name}, busy, clearing);
    const hasSelection = !!settings.path;
    root.querySelector<HTMLElement>("#lut-adjustments")!.hidden = !hasSelection;
    root.querySelector<HTMLElement>("#lut-apply-help")!.textContent = settings.enabled
      ? "Applies to the preview and export."
      : "Off in preview and export.";
    enabled.checked = settings.enabled;
    enabled.disabled = busy || !settings.path;
    strength.disabled = busy || !settings.enabled || !table;
    strength.value = String(Math.round(settings.strength * 100));
    root.querySelector<HTMLOutputElement>("#lut-strength-value")!.value = `${strength.value}%`;
    root.querySelector<HTMLElement>("#lut-summary")!.textContent = busy ? "Loading…" : !hasSelection ? "Not selected" : settings.enabled ? `${strength.value}%` : "Off";
    importButton.disabled = busy || clearing;
    importButton.textContent = "Import";
    status.textContent = busy ? "Loading LUT…" : "";
    status.hidden = !busy;
    root.setAttribute("aria-busy", String(busy));
    if (settings.enabled && table && !backendError) {
      previewError = "";
      preview.set(table, size, settings.strength);
    }
    else preview.clear();
    showError();
  }
  async function load(path: string, requested: LutSettings, imported: boolean): Promise<void> {
    const request = ++generation;
    download?.abort();
    const controller = new AbortController();
    download = controller;
    busy = true;
    pendingPath = path;
    error = "";
    sync();
    changed();
    let token = "";
    try {
      const result = await client().loadLut(path);
      if (!result.ok) throw new Error(result.error.message);
      token = result.value.token;
      if (request !== generation) return;
      const response = await fetch(result.value.table_url, {signal:controller.signal});
      if (!response.ok) throw new Error("Could not load the LUT preview. Import the LUT again.");
      const data = await response.arrayBuffer();
      const expected = result.value.size ** 3 * 3 * 4;
      if (result.value.size < 2 || result.value.size > 65 || data.byteLength !== expected) throw new Error("The LUT preview data is invalid.");
      const values = new Float32Array(data);
      if (!values.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("The LUT preview contains invalid colors.");
      if (request !== generation) return;
      table = values;
      size = result.value.size;
      settings = {...requested, path:result.value.path, name:imported ? result.value.name : requested.name || result.value.name};
      if (imported) libraryGeneration += 1;
      const entries = new Map(library.map(entry => [entry.path, entry]));
      if (imported || entries.has(settings.path)) entries.set(settings.path, {path:settings.path,name:settings.name});
      library = [...entries.values()];
      previewError = "";
      backendError = "";
    } catch (reason) {
      if (request === generation) error = reason instanceof Error ? reason.message : "Could not load the LUT. Try importing it again.";
    } finally {
      if (token) void client().releaseMediaToken(token);
      if (request === generation) { busy = false; pendingPath = ""; sync(); changed(); }
    }
  }
  async function refreshLibrary(): Promise<void> {
    if (clearing) return;
    const request = ++libraryGeneration;
    const result = await client().listLuts();
    if (request !== libraryGeneration) return;
    if (result.ok) library = [...new Map(result.value.luts.map(entry => [entry.path, entry])).values()];
    else error = result.error.message;
    sync();
  }
  async function clearHistory(): Promise<void> {
    if (busy || clearing || !library.length) return;
    clearing = true;
    libraryGeneration += 1;
    picker.feedback("");
    sync();
    try {
      const result = await client().clearLutHistory();
      if (!result.ok) throw new Error(result.error.message);
      if (!result.value.cleared) throw new Error("LUT history could not be cleared. Try again.");
      libraryGeneration += 1;
      library = [];
      picker.feedback(settings.path ? "History cleared. Your current LUT stays selected." : "History cleared.");
    } catch (reason) {
      picker.feedback(reason instanceof Error ? reason.message : "LUT history could not be cleared. Try again.");
    } finally {
      clearing = false;
      sync();
    }
  }
  function selectLut(path: string): void {
    if (busy || clearing) return;
    const selected = library.find(entry => entry.path === path);
    if (selected && selected.path === settings.path && table) {
      if (!settings.enabled) {
        settings.enabled = true;
        sync(); changed();
      }
      return;
    }
    if (selected) void load(selected.path, {...settings,...selected,enabled:true}, false);
    else if (!path) {
      generation += 1;
      download?.abort();
      settings = lutSettings(null);
      table = null;
      error = backendError = previewError = "";
      sync(); changed();
    }
  }
  async function importLut(): Promise<void> {
    const result = await client().pickLutFile();
    if (!result.ok) { error = result.error.message; showError(); return; }
    if (result.value.path) await load(result.value.path, {...settings, enabled:true}, true);
  }
  importButton.addEventListener("click", () => { void importLut(); });
  enabled.addEventListener("change", () => {
    settings.enabled = enabled.checked;
    backendError = "";
    if (settings.enabled && !table) { void load(settings.path, settings, false); return; }
    sync(); changed();
  });
  strength.addEventListener("input", () => {
    settings.strength = strength.valueAsNumber / 100;
    backendError = "";
    sync(); changed(false);
  });
  strength.addEventListener("change", () => changed());
  sync();
  return {
    refreshLibrary,
    read: (): LutSettings => ({...settings}),
    valid: (): boolean => !busy && (!settings.enabled || (!!table && !!settings.path && Number.isFinite(settings.strength))),
    apply(raw: unknown): void {
      generation += 1;
      download?.abort();
      settings = lutSettings(raw);
      table = null;
      busy = false;
      pendingPath = "";
      error = backendError = previewError = "";
      sync();
      if (settings.path) void load(settings.path, settings, false);
    },
    setBackendError(message: string): void { backendError = message; sync(); },
  };
}
