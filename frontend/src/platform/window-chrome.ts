import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { hasTauriInvoke } from "../backend/index.ts";
import { fetchPlatformCapabilities, usesCustomTitleBar } from "./capabilities.ts";

/** Where the maximize button sits, in CSS pixels, measured from the window's right edge. */
export interface CaptionArea {
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export function captionAreaFor(button: Box, viewportWidth: number): CaptionArea | null {
  if (button.width <= 0 || button.height <= 0) return null;
  return {
    right: Math.round(viewportWidth - button.right),
    width: Math.round(button.width),
    height: Math.round(button.height),
  };
}

export function sameArea(a: CaptionArea | null, b: CaptionArea | null): boolean {
  if (!a || !b) return a === b;
  return a.right === b.right && a.width === b.width && a.height === b.height;
}

// the window menu opens under the logo, like it does under a native title bar's icon
export function windowMenuPoint(logo: Box): { x: number; y: number } {
  return { x: Math.max(0, Math.round(logo.left)), y: Math.max(0, Math.round(logo.bottom)) };
}

export function maximizedFrom(payload: unknown): boolean | null {
  if (typeof payload !== "object" || payload === null) return null;
  const maximized = (payload as { maximized?: unknown }).maximized;
  return typeof maximized === "boolean" ? maximized : null;
}

export function captionButtonFrom(payload: unknown): { hovered: boolean; pressed: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { hovered, pressed } = payload as { hovered?: unknown; pressed?: unknown };
  return typeof hovered === "boolean" && typeof pressed === "boolean" ? { hovered, pressed } : null;
}

function isAltSpace(event: KeyboardEvent): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "Space";
}

/**
 * Shows Tuck's own title bar where the platform asks for it (Windows) and connects it to the
 * native window. Elsewhere the desktop keeps its frame and the bar stays a plain toolbar.
 */
export async function installWindowChrome(win: Window): Promise<void> {
  const doc = win.document;
  const caps = await fetchPlatformCapabilities();
  if (!usesCustomTitleBar(caps)) return;

  const bar = doc.getElementById("tb");
  const menuButton = doc.getElementById("window-menu");
  const caption = doc.getElementById("window-caption");
  const maximize = doc.getElementById("window-maximize");
  if (!bar || !menuButton || !caption || !maximize) return;

  doc.body.classList.add("custom-titlebar");
  menuButton.hidden = false;
  caption.hidden = false;
  // empty parts of the bar move the window and maximize it on double-click
  for (const region of [bar, ...bar.querySelectorAll(".tb-flex-spacer")]) {
    region.setAttribute("data-tauri-drag-region", "");
  }

  const setInactive = (): void => {
    doc.body.classList.toggle("window-inactive", !doc.hasFocus());
  };
  win.addEventListener("focus", setInactive);
  win.addEventListener("blur", setInactive);
  setInactive();

  const setMaximized = (maximized: boolean): void => {
    doc.body.classList.toggle("window-maximized", maximized);
    const label = maximized ? "Restore" : "Maximize";
    maximize.setAttribute("aria-label", label);
    maximize.dataset.tip = label;
  };

  if (!hasTauriInvoke(win)) return;

  const run = (command: string, args: Record<string, unknown> = {}): void => {
    invoke(command, args).catch((error: unknown) => {
      console.error(`Window command ${command} failed`, error);
    });
  };
  const openMenuAt = (x: number, y: number): void => run("show_window_menu", { x, y });
  const openMenuUnderLogo = (): void => {
    const point = windowMenuPoint(menuButton.getBoundingClientRect());
    openMenuAt(point.x, point.y);
  };

  doc.getElementById("window-minimize")?.addEventListener("click", () => run("minimize_window"));
  // the native overlay handles pointer clicks on maximize; this covers the keyboard
  maximize.addEventListener("click", () => run("toggle_maximize_window"));
  doc.getElementById("window-close")?.addEventListener("click", () => run("close_window"));
  menuButton.addEventListener("click", openMenuUnderLogo);
  bar.addEventListener("contextmenu", (event) => {
    if (event.target instanceof Element && event.target.closest("button, input, select, a")) return;
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY);
  });
  doc.addEventListener(
    "keydown",
    (event) => {
      if (!isAltSpace(event)) return;
      event.preventDefault();
      openMenuUnderLogo();
    },
    true,
  );

  void listen<unknown>("window-maximized", (event) => {
    const maximized = maximizedFrom(event.payload);
    if (maximized !== null) setMaximized(maximized);
  });
  void listen<unknown>("caption-maximize", (event) => {
    const state = captionButtonFrom(event.payload);
    if (!state) return;
    maximize.classList.toggle("hover", state.hovered);
    maximize.classList.toggle("pressed", state.pressed);
  });

  // Windows only offers Snap Layouts over a native maximize button, so Rust places one over ours
  let placed: CaptionArea | null | undefined;
  const placeMaximizeTarget = (): void => {
    const area = doc.fullscreenElement ? null : captionAreaFor(maximize.getBoundingClientRect(), win.innerWidth);
    if (placed !== undefined && sameArea(placed, area)) return;
    placed = area;
    invoke("set_caption_maximize_area", { area })
      .then((state) => {
        const maximized = maximizedFrom(state);
        if (maximized !== null) setMaximized(maximized);
      })
      .catch((error: unknown) => {
        placed = undefined;
        console.error("Could not place the Snap Layouts target", error);
      });
  };
  win.addEventListener("resize", placeMaximizeTarget);
  doc.addEventListener("fullscreenchange", placeMaximizeTarget);
  placeMaximizeTarget();
}
