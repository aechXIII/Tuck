import type {
  BackendClient,
  FrameExportRequest,
  LutSettingsJSON,
  VideoTransformJSON,
} from "../../backend/types.ts";
import type { ToastAction, ToastOptions } from "../editor/toast.ts";

export interface FrameSnapshot {
  source: string;
  name: string;
  time: number;
  transform?: VideoTransformJSON;
  lut?: LutSettingsJSON;
}

export interface FrameExportState {
  readonly phase: "idle" | "choosing" | "saving" | "success" | "error";
  readonly message: string;
  readonly path: string;
  readonly folderError?: string;
}

interface FrameExportDeps {
  ready: () => boolean;
  capture: () => FrameSnapshot | null;
  client: () => Pick<BackendClient, "pickSaveFile" | "exportFrame" | "openOutputFolder">;
  changed: () => void;
  notify: (message: string, kind?: string, action?: ToastAction, options?: ToastOptions) => void;
}

export function frameFileName(name: string, time: number): string {
  const total = Math.round(time * 1000);
  const stamp = [
    Math.floor(total / 3600000),
    Math.floor(total / 60000) % 60,
    Math.floor(total / 1000) % 60,
  ].map(value => String(value).padStart(2, "0")).join("-")
    + "-" + String(total % 1000).padStart(3, "0");
  const stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "Video";
  return `${stem}-frame-${stamp}.png`;
}

export function frameSavePath(source: string, name: string, time: number): string {
  const separator = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  return source.slice(0, separator + 1) + frameFileName(name, time);
}

export function createFrameExporter(deps: FrameExportDeps) {
  let state: FrameExportState = { phase: "idle", message: "", path: "" };
  const busy = (): boolean => state.phase === "choosing" || state.phase === "saving";

  function set(next: FrameExportState): void {
    state = next;
    deps.changed();
  }

  async function save(): Promise<void> {
    if (busy() || !deps.ready()) return;
    const captured = deps.capture();
    if (!captured) return;
    const snapshot = {
      ...captured,
      ...(captured.transform ? {
        transform: {
          ...captured.transform,
          crop: captured.transform.crop ? { ...captured.transform.crop } : null,
        },
      } : {}),
      ...(captured.lut ? { lut: { ...captured.lut } } : {}),
    };
    const previous = state;
    if (!Number.isFinite(snapshot.time) || snapshot.time < 0) {
      set({
        phase: "error",
        message: "Could not read the playhead time. Seek to a frame and try again.",
        path: "",
      });
      deps.notify(state.message, "err", undefined, { key: "frame-export" });
      return;
    }
    const label = `${snapshot.name} at ${snapshot.time.toFixed(3)} s`;
    set({
      phase: "choosing",
      message: `Choose where to save a frame from ${label}.`,
      path: "",
    });
    try {
      const client = deps.client();
      const selected = await client.pickSaveFile(
        frameSavePath(snapshot.source, snapshot.name, snapshot.time),
        "png",
      );
      if (!selected.ok) throw new Error(selected.error.message);
      if (!selected.value.path) {
        set(previous);
        return;
      }
      set({ phase: "saving", message: `Saving frame from ${label}...`, path: "" });
      const request: FrameExportRequest = {
        source: snapshot.source,
        output: selected.value.path,
        time: snapshot.time,
        ...(snapshot.transform ? { transform: snapshot.transform } : {}),
        ...(snapshot.lut ? { lut: snapshot.lut } : {}),
      };
      const result = await client.exportFrame(request);
      if (!result.ok) throw new Error(result.error.message);
      const warnings = result.value.warnings.length ? ` ${result.value.warnings.join(" ")}` : "";
      set({
        phase: "success",
        message: `Saved frame from ${label} to ${result.value.path}.${warnings}`,
        path: result.value.path,
      });
      const path = result.value.path;
      deps.notify(`Saved frame to ${path}.${warnings}`, "ok", {
        label: "Show in folder",
        run: () => void reveal(path),
      }, { key: "frame-export" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Try again.";
      set({ phase: "error", message: `Could not save frame from ${label}. ${reason}`, path: "" });
      deps.notify(state.message, "err", undefined, { key: "frame-export" });
    }
  }
  function folderFailed(path: string, message: string): void {
    if (state.path === path) set({ ...state, folderError: message });
  }

  async function reveal(path: string): Promise<void> {
    try {
      const result = await deps.client().openOutputFolder(path);
      if (!result.ok) throw new Error(result.error.message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Try opening its folder manually.";
      folderFailed(path, reason);
      deps.notify(`Could not show ${path} in its folder. ${reason}`, "err", undefined, { key: "frame-export-folder" });
    }
  }
  return {
    save,
    busy,
    folderFailed,
    state: () => state,
    available: () => deps.ready() && !busy(),
  };
}

export function installFrameExport(deps: Omit<FrameExportDeps, "changed" | "client"> & {
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  client: () => BackendClient;
}) {
  const exporter = createFrameExporter({ ...deps, changed: sync });

  function sync(): void {
    const button = deps.byId<HTMLButtonElement>("btn-save-frame");
    const description = deps.byId("frame-export-description");
    if (button) {
      // aria-disabled keeps keyboard focus on the trigger while the native picker is open
      button.disabled = !deps.ready() && !exporter.busy();
      button.setAttribute("aria-disabled", String(!exporter.available()));
      button.setAttribute("aria-busy", String(exporter.busy()));
    }
    const state = exporter.state();
    if (description) {
      description.textContent = state.message
        + (state.folderError ? ` Could not show the file. ${state.folderError}` : "");
    }
  }

  sync();
  return { save: exporter.save, available: exporter.available, sync };
}
