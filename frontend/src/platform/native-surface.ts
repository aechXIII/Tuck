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

/** The scale, turn and mirror part of a CSS transform: x' = a·x + c·y, y' = b·x + d·y. */
export interface PictureMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

/**
 * Which part of the picture fills the box and how it is turned, as the shell's `PictureView` takes
 * it: shares of the picture the editor crops, quarter turns to the right, and mirrors after the turn.
 */
export interface PictureView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly quarterTurns: number;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  readonly stretch: boolean;
}

export const WHOLE_PICTURE: PictureView = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  quarterTurns: 0,
  flipHorizontal: false,
  flipVertical: false,
  stretch: false,
};

export interface PlacedPicture {
  readonly rect: PictureRect;
  readonly view: PictureView;
}

export function sameView(a: PictureView, b: PictureView): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) < 1e-6;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height) &&
    a.quarterTurns === b.quarterTurns && a.flipHorizontal === b.flipHorizontal &&
    a.flipVertical === b.flipVertical && a.stretch === b.stretch;
}

/** The matrix of a computed CSS `transform`, or null for none. */
export function transformMatrix(value: string): PictureMatrix | null {
  const match = /^matrix\(([^)]+)\)$/.exec(value.trim());
  if (!match) return null;
  const [a, b, c, d] = match[1]!.split(",").map(Number);
  return [a, b, c, d].every((part) => Number.isFinite(part)) ? { a: a!, b: b!, c: c!, d: d! } : null;
}

/**
 * Where the picture is and which part of it shows, for a video the editor's crop, turn and flips
 * place with a CSS transform: `video` is its box on the page after the transform, `matrix` the
 * transform, `clip` the viewport. The editor turns only by quarter turns, so the box stays upright
 * and the part shown is an upright rectangle of the picture.
 */
export function placePicture(
  video: Box,
  matrix: PictureMatrix | null,
  videoWidth: number,
  videoHeight: number,
  clip: Box,
): PlacedPicture {
  const scale = matrix
    ? Math.max(Math.abs(matrix.a), Math.abs(matrix.b), Math.abs(matrix.c), Math.abs(matrix.d))
    : 0;
  const near = (p: number, q: number) => Math.abs(p - q) <= scale * 1e-3;
  const inside = video.left >= clip.left - 0.5 && video.top >= clip.top - 0.5 &&
    video.left + video.width <= clip.left + clip.width + 0.5 &&
    video.top + video.height <= clip.top + clip.height + 0.5;
  const onlyScaled = !!matrix && matrix.a > 0 && matrix.d > 0 && near(matrix.b, 0) && near(matrix.c, 0) &&
    near(matrix.a, matrix.d);
  // an untransformed or only scaled video keeps the letterboxed picture it always had
  if (!matrix || (onlyScaled && inside)) {
    return { rect: pictureRect(video, videoWidth, videoHeight, clip), view: WHOLE_PICTURE };
  }
  const left = Math.max(video.left, clip.left);
  const top = Math.max(video.top, clip.top);
  const right = Math.min(video.left + video.width, clip.left + clip.width);
  const bottom = Math.min(video.top + video.height, clip.top + clip.height);
  if (right - left < 1 || bottom - top < 1 || !(video.width > 0 && video.height > 0)) {
    return { rect: NO_PICTURE, view: WHOLE_PICTURE };
  }
  // one quarter turn to the right, then the mirrors, covers every way the editor places a picture
  const sideways = Math.abs(matrix.b) > Math.abs(matrix.a);
  const flipHorizontal = sideways ? matrix.c > 0 : matrix.a < 0;
  const flipVertical = sideways ? matrix.b < 0 : matrix.d < 0;
  const across = sideways ? Math.abs(matrix.b) : Math.abs(matrix.a);
  const down = sideways ? Math.abs(matrix.c) : Math.abs(matrix.d);
  // the shown part in shares of the box as drawn, then back through the mirrors and the turn
  let x0 = (left - video.left) / video.width;
  let x1 = (right - video.left) / video.width;
  let y0 = (top - video.top) / video.height;
  let y1 = (bottom - video.top) / video.height;
  if (flipHorizontal) [x0, x1] = [1 - x1, 1 - x0];
  if (flipVertical) [y0, y1] = [1 - y1, 1 - y0];
  // a right turn draws the picture's point (u, v) at (1 - v, u)
  const [u0, u1, v0, v1] = sideways ? [y0, y1, 1 - x1, 1 - x0] : [x0, x1, y0, y1];
  const x = Math.max(0, u0);
  const y = Math.max(0, v0);
  return {
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    view: {
      x,
      y,
      width: Math.min(1, u1) - x,
      height: Math.min(1, v1) - y,
      quarterTurns: sideways ? 1 : 0,
      flipHorizontal,
      flipVertical,
      stretch: !near(across, down),
    },
  };
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

  let sent: PlacedPicture | null = null;
  let frame = 0;
  const measure = (): PlacedPicture => {
    // the editor turns the native preview off for a video it plays in the built-in player
    const off = !root.classList.contains("native-preview") || stage.classList.contains("timeline-gap");
    if (off) return { rect: NO_PICTURE, view: WHOLE_PICTURE };
    // the probed size stands in while the webview hasn't read the file, or can't
    const width = video.videoWidth || Number(video.dataset.pictureWidth) || 0;
    const height = video.videoHeight || Number(video.dataset.pictureHeight) || 0;
    // the HTML player's crop, turn and flips are this transform, so the native picture follows it
    const matrix = transformMatrix(win.getComputedStyle(video).transform);
    const box = video.getBoundingClientRect();
    return placePicture(box, matrix, width, height, viewport.getBoundingClientRect());
  };
  const update = (): void => {
    frame = 0;
    const next = measure();
    if (sent && sameRect(sent.rect, next.rect) && sameView(sent.view, next.view)) return;
    sent = next;
    for (const [name, value] of holeProperties(next.rect)) root.style.setProperty(name, value);
    const request = { viewport: next.rect, view: next.view };
    void invoke("preview_surface_viewport", request).catch((error: unknown) => {
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
  changed.observe(root, { attributes: true, attributeFilter: ["class"] });
  changed.observe(stage, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
  changed.observe(video, {
    attributes: true,
    attributeFilter: ["class", "style", "src", "data-picture-width", "data-picture-height"],
  });
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
