import { getBackendClient } from "../../backend/client.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import type { EditorClip } from "../editor/types.ts";

// the stage's video element announces which video it shows (its path, or null when it shows none),
// so a player that doesn't decode through the element can follow the selection without waiting
// for the webview to read the file
export const SOURCE_EVENT = "tuck-source";
// that player's answer for the announced video: its first frame is showing, or it can't show it
export const SOURCE_READY_EVENT = "tuck-source-ready";
export const SOURCE_FAILED_EVENT = "tuck-source-failed";

export interface PreviewMedia {
  // the new video's own picture, or nothing, while its preview is fetched; never the last video
  showLoading(picture: string | null): void;
  showUrl(url: string): void;
  showThumbnail(source: string): void;
  // the video can't be played here; a picture may still be showing
  showUnavailable(hasPicture: boolean): void;
  clear(): void;
  seek(seconds: number): void;
}

// WebView2 plays the sound of a video whose picture it can't decode, such as HEVC without
// Microsoft's extension, and reports no error, so the stage has to say why it stays still
export function missingPictureMessage(
  videoCodec: string | undefined,
  platform: "windows" | "linux" | null,
): string {
  if (videoCodec === "hevc" && platform === "windows")
    return "Previewing HEVC needs the HEVC Video Extensions from the Microsoft Store. Export still works.";
  return "This video’s picture can’t be shown here. Export still works.";
}

export interface PreviewCoordinatorHost {
  clip(path: string): EditorClip | undefined;
  selectedPath(): string | null;
  media: PreviewMedia;
}

export interface PreviewController {
  select(path: string | null): void;
  seek(seconds: number): void;
  dispose(): Promise<void>;
}

export function createPreviewController(host: PreviewCoordinatorHost): PreviewController {
  let generation = 0;
  let selectedClip: EditorClip | undefined;

  async function releaseValue(token: string | null | undefined): Promise<void> {
    if (!token) return;
    try {
      await getBackendClient().releaseMediaToken(token);
    } catch {
      // token release is best-effort, matching the previous fire-and-forget path
    }
  }

  async function releaseToken(clip: EditorClip | undefined): Promise<void> {
    const token = clip?.mediaToken;
    if (clip) clip.mediaToken = null;
    await releaseValue(token);
  }

  async function load(path: string, requestId: number): Promise<void> {
    const clip = host.clip(path);
    try {
      const response = await legacyBackendResult(getBackendClient().getMediaUrl(path));
      if (requestId !== generation || host.selectedPath() !== path || host.clip(path) !== clip) {
        await releaseValue(typeof response.token === "string" ? response.token : null);
        return;
      }
      if (response.ok && typeof response.url === "string" && response.url) {
        host.media.showUrl(response.url);
        if (clip && typeof response.token === "string") clip.mediaToken = response.token;
        return;
      }
      await releaseValue(typeof response.token === "string" ? response.token : null);
      if (typeof response.thumbnail === "string" && response.thumbnail) {
        host.media.showThumbnail(response.thumbnail);
        host.media.showUnavailable(true);
        return;
      }
      await loadThumbnail(path, requestId);
    } catch {
      if (requestId !== generation || host.selectedPath() !== path) return;
      await loadThumbnail(path, requestId);
    }
  }

  async function loadThumbnail(path: string, requestId: number): Promise<void> {
    let shown = false;
    try {
      const response = await legacyBackendResult(getBackendClient().getThumbnail(path));
      if (requestId !== generation || host.selectedPath() !== path) return;
      if (response.ok && typeof response.thumbnail === "string" && response.thumbnail) {
        host.media.showThumbnail(response.thumbnail);
        shown = true;
      }
    } catch {
      // a failed picture request leaves the stage without a picture
      if (requestId !== generation || host.selectedPath() !== path) return;
    }
    host.media.showUnavailable(shown);
  }

  return {
    select(path) {
      const previous = selectedClip;
      selectedClip = path ? host.clip(path) : undefined;
      generation += 1;
      const requestId = generation;
      // the old video leaves the stage before its media link is given back
      if (!path) host.media.clear();
      else host.media.showLoading(host.clip(path)?._thumbnail || null);
      if (previous) void releaseToken(previous);
      if (path) void load(path, requestId);
    },
    seek(seconds) {
      host.media.seek(seconds);
    },
    async dispose() {
      generation += 1;
      const clip = selectedClip;
      selectedClip = undefined;
      host.media.clear();
      await releaseToken(clip);
    },
  };
}
