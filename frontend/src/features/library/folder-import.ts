import type { ConfirmIntent } from "../editor/toast.ts";
import type { BackendResult, FolderVideos } from "../../backend/types.ts";
import { routeDroppedPaths, skippedDropMessage } from "../editor/drop-routing.ts";

// the shell's only failure here is its worker stopping, which has no reason worth showing
export const FOLDER_READ_ERROR = "Couldn’t read the folder. Try again.";

/** More videos than this from folders, and Tuck asks before adding them. */
export const ASK_ABOVE = 50;

export interface ImportDeps {
  /** the videos in whichever of these paths are folders */
  listFolders(paths: readonly string[]): Promise<BackendResult<FolderVideos>>;
  addVideos(paths: readonly string[]): void;
  addAudio(paths: readonly string[]): void;
  confirm(message: string, accept: () => void, intent: ConfirmIntent): void;
  toast(message: string, kind?: string): void;
}

function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

const count = (value: number): string => value.toLocaleString("en-US");

/** What Tuck asks before adding a lot of videos from folders. */
export function folderAsk(found: FolderVideos): { message: string; intent: ConfirmIntent } {
  const total = found.videos.length;
  const from = found.folders.length === 1 ? `From ${folderName(found.folders[0] ?? "")}.` : `From ${found.folders.length} folders.`;
  const more = found.truncated ? ` There are more, so Tuck stops at the first ${count(total)}.` : "";
  return {
    message: from + more,
    intent: { title: `Add ${count(total)} videos?`, confirmLabel: "Add videos", cancelLabel: "Cancel", danger: false },
  };
}

/** Adds the videos found in folders, asking first when there are a lot of them. */
export function addFolderVideos(found: FolderVideos, deps: ImportDeps): void {
  if (!found.folders.length) return;
  if (!found.videos.length) {
    const where = found.folders.length === 1 ? folderName(found.folders[0] ?? "") : "those folders";
    deps.toast(`No videos in ${where}.`, "info");
    return;
  }
  if (found.videos.length <= ASK_ABOVE) {
    deps.addVideos(found.videos);
    return;
  }
  const ask = folderAsk(found);
  deps.confirm(ask.message, () => deps.addVideos(found.videos), ask.intent);
}

/**
 * Dropped and pasted paths go to the same places: audio to the audio panel, videos to the
 * Library, folders' videos to the Library too, and anything else is left out with a word about it.
 */
export async function importPaths(paths: readonly string[], deps: ImportDeps): Promise<void> {
  const { videoPaths, audioPaths, skippedPaths } = routeDroppedPaths(paths);
  if (videoPaths.length) deps.addVideos(videoPaths);
  if (audioPaths.length) deps.addAudio(audioPaths);
  let leftOut = skippedPaths;
  // a path with a media extension is taken as a file, so most drops never ask the shell
  if (skippedPaths.length) {
    const listed = await deps.listFolders(skippedPaths);
    if (!listed.ok) {
      deps.toast(FOLDER_READ_ERROR, "err");
      return;
    }
    const folders = new Set(listed.value.folders);
    leftOut = skippedPaths.filter((path) => !folders.has(path));
    addFolderVideos(listed.value, deps);
  }
  const skipped = skippedDropMessage(leftOut);
  if (skipped) deps.toast(skipped);
}
