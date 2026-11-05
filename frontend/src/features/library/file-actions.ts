// Moving videos to the Trash (the Recycle Bin on Windows) and renaming them. The shell does the
// file work and never deletes for good; this decides what to ask first and says what happened.

import type { BackendClient, TrashResult } from "../../backend/types.ts";
import type { EditorClip } from "../editor/types.ts";
import { isQueueActive } from "../queue/queue-view.ts";

export type TrashPlatform = "windows" | "linux" | null;

export function trashName(platform: TrashPlatform): string {
  return platform === "windows" ? "Recycle Bin" : "Trash";
}

/** Why the video's file can't be renamed or moved now, or "" when it can. */
export function fileBusyReason(clip: EditorClip | undefined): string {
  if (!clip) return "";
  return isQueueActive(clip._queueState) ? "Wait for its export to finish" : "";
}

/** Rename also waits for the video to load: its read in flight would land on the old name. */
export function renameBusyReason(clip: EditorClip | undefined): string {
  if (!clip) return "";
  return fileBusyReason(clip) || (!clip.probed && !clip.error ? "Wait for the video to load" : "");
}

function videoName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface TrashSummary {
  /** the files the shell moved or found already gone, which leave the Library */
  gone: string[];
  /** the files still where they were */
  stayed: string[];
  title: string;
  message: string;
}

/**
 * What a move to the Trash says. Everything moved is a short confirmation; anything that stayed
 * gets a dialog naming it, so the outcome isn't only a passing message.
 */
export function trashSummary(results: readonly TrashResult[], bin: string, noun = "videos"): TrashSummary {
  const gone = results.filter((r) => r.outcome === "moved" || r.outcome === "missing").map((r) => r.path);
  const noTrash = results.filter((r) => r.outcome === "no_trash").map((r) => videoName(r.path));
  const failed = results.filter((r) => r.outcome === "failed").map((r) => videoName(r.path));
  const stayed = results.filter((r) => r.outcome === "no_trash" || r.outcome === "failed").map((r) => r.path);
  const total = results.length;
  if (!stayed.length) {
    const first = results[0];
    const title = total === 1 && first ? `Moved ${videoName(first.path)} to the ${bin}.` : `Moved ${total} ${noun} to the ${bin}.`;
    return { gone, stayed, title, message: "" };
  }
  const parts: string[] = [];
  if (noTrash.length === 1) parts.push(`${noTrash[0]} is on a drive with no ${bin}, so it stayed where it is.`);
  else if (noTrash.length) parts.push(`${noTrash.length} are on a drive with no ${bin}, so they stayed where they are: ${list(noTrash)}.`);
  if (failed.length === 1) parts.push(`${failed[0]} couldn't be moved. Another program may have it open.`);
  else if (failed.length) parts.push(`${list(failed)} couldn't be moved. Another program may have them open.`);
  const title = gone.length
    ? `${gone.length} of ${total} moved to the ${bin}`
    : total === 1 ? `Couldn't move it to the ${bin}` : `Couldn't move them to the ${bin}`;
  return { gone, stayed, title, message: parts.join(" ") };
}

/** The name selected when Rename opens: everything up to the extension, as file managers do. */
export function nameStemEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

export interface FileActionsHost {
  client: () => BackendClient | null;
  platform: () => TrashPlatform;
  clips: () => Readonly<Record<string, EditorClip>>;
  selectedPath: () => string | null;
  forgetClips: (paths: readonly string[]) => void;
  releaseFiles: (paths: readonly string[]) => boolean;
  renameClip: (from: string, to: string) => void;
  selectClip: (path: string) => void;
  // the row that had focus can be gone with the dialog or the file, so focus lands on a row
  focusRow: (path: string) => void;
  confirm: (
    message: string,
    run: () => void,
    intent: { title: string; confirmLabel: string; cancelLabel: string; danger?: boolean },
  ) => void;
  dialog: (html: string, options?: { labelledBy?: string; onClose?: () => void }) => HTMLElement;
  closeDialog: () => void;
  toast: (message: string, kind?: string) => void;
  showInFolder: (path: string) => void;
  formatBytes: (bytes: number) => string;
}

export interface FileActionsApi {
  trashName: () => string;
  /** One video moves at once; several ask first. Busy videos are left out. */
  moveToTrash: (paths: readonly string[]) => void;
  /** The originals of finished exports, asked once; their exports stay. */
  moveOriginals: (originals: readonly { path: string; size: number }[]) => void;
  rename: (path: string) => void;
}

export function installFileActions(host: FileActionsHost): FileActionsApi {
  const bin = () => trashName(host.platform());

  function totalSize(sizes: readonly number[]): string {
    const total = sizes.reduce((sum, size) => sum + (size > 0 ? size : 0), 0);
    return total > 0 ? host.formatBytes(total) : "";
  }

  // the dialog's text is set as text, since file names come from the disk
  function showStayed(summary: TrashSummary): void {
    const box = host.dialog(
      `<h2 id="trash-title"></h2>
      <p class="confirm-copy" id="trash-copy"></p>
      <div class="confirm-actions">
        <button type="button" class="btn2" id="trash-show">Show in folder</button>
        <button type="button" class="btn1" id="trash-ok">OK</button>
      </div>`,
      { labelledBy: "trash-title" },
    );
    const title = box.querySelector("#trash-title");
    const copy = box.querySelector("#trash-copy");
    if (title) title.textContent = summary.title;
    if (copy) copy.textContent = summary.message;
    box.querySelector("#trash-ok")?.addEventListener("click", () => {
      host.closeDialog();
      const shown = host.selectedPath();
      if (shown) host.focusRow(shown);
    });
    box.querySelector("#trash-show")?.addEventListener("click", () => {
      const first = summary.stayed[0];
      host.closeDialog();
      if (first) host.showInFolder(first);
    });
    box.querySelector<HTMLElement>("#trash-ok")?.focus();
  }

  async function trash(paths: readonly string[], noun: string): Promise<void> {
    const client = host.client();
    if (!client || !paths.length) return;
    // a file the preview has open can't be moved on Windows
    const shown = host.selectedPath();
    const released = host.releaseFiles(paths);
    const result = await client.moveVideosToTrash(paths);
    if (!result.ok) {
      if (released && shown) host.selectClip(shown);
      host.toast(result.error.message, "err");
      return;
    }
    const summary = trashSummary(result.value, bin(), noun);
    host.forgetClips(summary.gone);
    if (released && shown && summary.stayed.includes(shown) && host.clips()[shown]) host.selectClip(shown);
    if (summary.stayed.length) showStayed(summary);
    else host.toast(summary.title, "ok");
    const shownNow = host.selectedPath();
    if (shownNow && !summary.stayed.length) host.focusRow(shownNow);
  }

  function moveToTrash(paths: readonly string[]): void {
    const clips = host.clips();
    const free = paths.filter((path) => clips[path] && !fileBusyReason(clips[path]));
    if (!free.length) return;
    if (free.length === 1) {
      void trash(free, "videos");
      return;
    }
    const size = totalSize(free.map((path) => Number(clips[path]?._fileSize) || 0));
    host.confirm(size ? `${size}.` : "", () => void trash(free, "videos"), {
      title: `Move ${free.length} videos to the ${bin()}?`,
      confirmLabel: "Move",
      cancelLabel: "Cancel",
    });
  }

  function moveOriginals(originals: readonly { path: string; size: number }[]): void {
    if (!originals.length) return;
    const size = totalSize(originals.map((original) => original.size));
    const count = originals.length;
    host.confirm(`${size ? `${size}. ` : ""}The exports stay.`, () => void trash(originals.map((o) => o.path), "originals"), {
      title: count === 1 ? `Move the original to the ${bin()}?` : `Move ${count} originals to the ${bin()}?`,
      confirmLabel: "Move",
      cancelLabel: "Cancel",
    });
  }

  function rename(path: string): void {
    const clip = host.clips()[path];
    if (!clip || renameBusyReason(clip)) return;
    // however the dialog closes, focus goes back to the video's row, under its new name if renamed
    let current = path;
    const box = host.dialog(
      `<h2 id="rn-title">Rename</h2>
      <div>
        <label for="rn-name">Name</label>
        <input type="text" id="rn-name" autocomplete="off" spellcheck="false" aria-describedby="rn-error">
        <p class="mod-field-error" id="rn-error" hidden></p>
      </div>
      <div class="confirm-actions">
        <button type="button" class="btn2" id="rn-cancel">Cancel</button>
        <button type="button" class="btn1" id="rn-save">Rename</button>
      </div>`,
      { labelledBy: "rn-title", onClose: () => host.focusRow(current) },
    );
    const field = box.querySelector<HTMLInputElement>("#rn-name");
    const error = box.querySelector<HTMLElement>("#rn-error");
    const save = box.querySelector<HTMLButtonElement>("#rn-save");
    if (!field || !error || !save) return;
    field.value = clip.name;
    field.focus();
    field.setSelectionRange(0, nameStemEnd(clip.name));
    const showError = (message: string) => {
      error.textContent = message;
      error.hidden = !message;
      field.toggleAttribute("aria-invalid", !!message);
    };
    let saving = false;
    const submit = async () => {
      const name = field.value.trim();
      if (saving) return;
      if (!name || name === clip.name) {
        if (!name) showError("Type a name for the video.");
        else host.closeDialog();
        return;
      }
      const client = host.client();
      if (!client) return;
      saving = true;
      save.disabled = true;
      // the preview lets go of the file first, which Windows needs to rename it
      const released = host.releaseFiles([path]);
      const result = await client.renameVideo(path, name);
      saving = false;
      save.disabled = false;
      if (!result.ok) {
        if (released && host.clips()[path]) host.selectClip(path);
        showError(result.error.message);
        field.focus();
        return;
      }
      host.renameClip(path, result.value.path);
      current = result.value.path;
      if (released) host.selectClip(result.value.path);
      host.closeDialog();
    };
    field.addEventListener("input", () => showError(""));
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
    save.addEventListener("click", () => void submit());
    box.querySelector("#rn-cancel")?.addEventListener("click", () => host.closeDialog());
  }

  return { trashName: bin, moveToTrash, moveOriginals, rename };
}
