import { invoke } from "@tauri-apps/api/core";

import { hasTauriInvoke } from "../backend/index.ts";
import { fetchPlatformCapabilities } from "./capabilities.ts";

/** A rectangle in CSS pixels from the page's top left corner. */
export interface PictureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const NO_PICTURE: PictureRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Where the picture is inside a video box drawn with `object-fit: contain`, clipped to what the
 * viewport shows.
 */
export function pictureRect(
  video: Box,
  videoWidth: number,
  videoHeight: number,
  clip: Box,
): PictureRect {
  if (!(videoWidth > 0 && videoHeight > 0 && video.width > 0 && video.height > 0)) return NO_PICTURE;
  const scale = Math.min(video.width / videoWidth, video.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  const left = Math.max(video.left + (video.width - width) / 2, clip.left);
  const top = Math.max(video.top + (video.height - height) / 2, clip.top);
  const right = Math.min(video.left + (video.width + width) / 2, clip.left + clip.width);
  const bottom = Math.min(video.top + (video.height + height) / 2, clip.top + clip.height);
  if (right - left < 1 || bottom - top < 1) return NO_PICTURE;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function sameRect(a: PictureRect, b: PictureRect): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) < 0.01;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height);
}

/** The hole the page's backgrounds leave for the picture, as CSS custom properties. */
export function holeProperties(rect: PictureRect): ReadonlyArray<readonly [string, string]> {
  return [
    ["--native-hole-x", `${rect.x}px`],
    ["--native-hole-y", `${rect.y}px`],
    ["--native-hole-w", `${rect.width}px`],
    ["--native-hole-h", `${rect.height}px`],
  ];
}

/**
 * Lets the desktop shell draw the preview picture below the page, when this run turns the native
 * preview on. The page keeps a transparent hole where the picture is and tells the shell where
 * that is whenever the layout changes; nothing here runs per frame.
 */
export async function installNativeSurface(win: Window): Promise<void> {
  const caps = await fetchPlatformCapabilities();
  const mode = caps.nativePreview;
  if ((mode !== "surface" && mode !== "engine" && mode !== "player") || !hasTauriInvoke(win)) return;
  const doc = win.document;
  const root = doc.documentElement;
  const video = doc.getElementById("vid");
  const viewport = doc.getElementById("media-viewport");
  const stage = doc.getElementById("stage");
  if (!(video instanceof HTMLVideoElement) || !viewport || !stage) return;

  await invoke("preview_surface_open", {});
  root.classList.add("native-preview");

  let sent: PictureRect | null = null;
  let frame = 0;
  const measure = (): PictureRect => {
    if (stage.classList.contains("timeline-gap")) return NO_PICTURE;
    return pictureRect(
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
      viewport.getBoundingClientRect(),
    );
  };
  const update = (): void => {
    frame = 0;
    const next = measure();
    if (sent && sameRect(sent, next)) return;
    sent = next;
    for (const [name, value] of holeProperties(next)) root.style.setProperty(name, value);
    void invoke("preview_surface_viewport", { viewport: next }).catch((error: unknown) => {
      console.error("Could not move the native preview", error);
    });
  };
  const schedule = (): void => {
    if (!frame) frame = win.requestAnimationFrame(update);
  };

  const resized = new ResizeObserver(schedule);
  for (const element of [doc.body, stage, viewport, video]) resized.observe(element);
  // showing a video, the timeline gap and the crop/zoom transform all change attributes here
  const changed = new MutationObserver(schedule);
  changed.observe(stage, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
  changed.observe(video, { attributes: true, attributeFilter: ["class", "style", "src"] });
  video.addEventListener("loadedmetadata", schedule);
  video.addEventListener("resize", schedule);
  win.addEventListener("resize", schedule);
  // the CSS rectangle stays the same when the window moves to a display with another scale,
  // but its device pixels do not, so the shell needs it again
  const watchScale = (): void => {
    win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        sent = null;
        schedule();
        watchScale();
      },
      { once: true },
    );
  };
  watchScale();
  schedule();
}
