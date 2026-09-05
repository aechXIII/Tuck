import { getBackendClient } from "../../backend/client.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import type { EditorClip } from "../editor/types.ts";

export interface PreviewMedia {
  showUrl(url: string): void;
  showThumbnail(source: string): void;
  clear(): void;
  seek(seconds: number): void;
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
  let selectedPath: string | null = null;

  async function releaseToken(clip: EditorClip | undefined): Promise<void> {
    const token = clip?.mediaToken;
    if (!token) return;
    clip.mediaToken = null;
    try {
      await getBackendClient().releaseMediaToken(token);
    } catch {
      // token release is best-effort, matching the previous fire-and-forget path
    }
  }

  async function load(path: string, requestId: number): Promise<void> {
    const clip = host.clip(path);
    try {
      const response = await legacyBackendResult(getBackendClient().getMediaUrl(path));
      if (requestId !== generation || host.selectedPath() !== path) return;
      if (response.ok && typeof response.url === "string" && response.url) {
        host.media.showUrl(response.url);
        if (clip && typeof response.token === "string") clip.mediaToken = response.token;
        return;
      }
      if (typeof response.thumbnail === "string" && response.thumbnail) {
        host.media.showThumbnail(response.thumbnail);
        return;
      }
      await loadThumbnail(path, requestId);
    } catch {
      if (requestId !== generation || host.selectedPath() !== path) return;
      await loadThumbnail(path, requestId);
    }
  }

  async function loadThumbnail(path: string, requestId: number): Promise<void> {
    try {
      const response = await legacyBackendResult(getBackendClient().getThumbnail(path));
      if (requestId !== generation || host.selectedPath() !== path) return;
      if (response.ok && typeof response.thumbnail === "string" && response.thumbnail) {
        host.media.showThumbnail(response.thumbnail);
      }
    } catch {
      // preview fallback remains empty when both media and thumbnail fail
    }
  }

  return {
    select(path) {
      const previous = selectedPath !== path ? host.clip(selectedPath ?? "") : undefined;
      if (previous) void releaseToken(previous);
      selectedPath = path;
      generation += 1;
      const requestId = generation;
      if (!path) {
        host.media.clear();
        return;
      }
      void load(path, requestId);
    },
    seek(seconds) {
      host.media.seek(seconds);
    },
    async dispose() {
      generation += 1;
      const clip = selectedPath ? host.clip(selectedPath) : undefined;
      selectedPath = null;
      host.media.clear();
      await releaseToken(clip);
    },
  };
}
