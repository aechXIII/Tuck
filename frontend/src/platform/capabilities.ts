import { invoke } from "@tauri-apps/api/core";

import { hasTauriInvoke } from "../backend/index.ts";
import { encoderSupportedOnPlatform, isSoftwareEncoder } from "../features/export/encoder-options.ts";

export interface PlatformCapabilities {
  platform: "windows" | "linux";
  architecture: "x86_64";
  sendToIntegration: boolean;
  publicCli: boolean;
  automaticUpdater: boolean;
  hardwareAcceleration: boolean;
  customTitleBar: boolean;
  /**
   * whether the player can use the webview's element fullscreen; where it can't (WebKitGTK aborts
   * the app) the window goes full screen instead. Missing means it can
   */
  elementFullscreen?: boolean;
  /** whether a finished export can be dragged out of the window as a file; missing means it can't */
  fileDragOut?: boolean;
  packaged: boolean;
  /**
   * "surface" while this run draws the native preview's test picture below the page, "engine"
   * when the native clock also drives playback, "player" when the native player decodes and
   * draws the video; missing means off
   */
  nativePreview?: "off" | "surface" | "engine" | "player";
}

// Outside a Tauri webview (browser preview, Playwright) the native layer cannot
// be queried. Assume the full Windows desktop surface so capability gating never
// hides controls except in a real Tauri build that reports a reduced platform.
const NON_TAURI_CAPABILITIES: PlatformCapabilities = {
  platform: "windows",
  architecture: "x86_64",
  sendToIntegration: true,
  publicCli: true,
  automaticUpdater: true,
  hardwareAcceleration: true,
  customTitleBar: true,
  fileDragOut: true,
  packaged: false,
};

// A Tauri runtime that fails to answer is genuinely degraded; hide the
// platform-specific integrations rather than promise features we cannot reach.
const DEGRADED_CAPABILITIES: PlatformCapabilities = {
  platform: "linux",
  architecture: "x86_64",
  sendToIntegration: false,
  publicCli: false,
  automaticUpdater: false,
  hardwareAcceleration: false,
  customTitleBar: false,
  elementFullscreen: false,
  fileDragOut: false,
  packaged: false,
};

let cached: PlatformCapabilities | null = null;

function isPlatformCapabilities(value: unknown): value is PlatformCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const caps = value as Record<string, unknown>;
  return (
    (caps.platform === "windows" || caps.platform === "linux") &&
    caps.architecture === "x86_64" &&
    typeof caps.sendToIntegration === "boolean" &&
    typeof caps.publicCli === "boolean" &&
    typeof caps.automaticUpdater === "boolean" &&
    typeof caps.hardwareAcceleration === "boolean" &&
    typeof caps.customTitleBar === "boolean" &&
    (caps.elementFullscreen === undefined || typeof caps.elementFullscreen === "boolean") &&
    (caps.fileDragOut === undefined || typeof caps.fileDragOut === "boolean") &&
    typeof caps.packaged === "boolean" &&
    (caps.nativePreview === undefined ||
      caps.nativePreview === "off" ||
      caps.nativePreview === "surface" ||
      caps.nativePreview === "engine" ||
      caps.nativePreview === "player")
  );
}

export async function fetchPlatformCapabilities(): Promise<PlatformCapabilities> {
  if (cached) return cached;
  if (!hasTauriInvoke(globalThis)) return NON_TAURI_CAPABILITIES;
  try {
    const caps = await invoke("platform_capabilities", {});
    if (isPlatformCapabilities(caps)) {
      cached = caps;
      return caps;
    }
  } catch {
    // fall through to the degraded profile
  }
  return DEGRADED_CAPABILITIES;
}

export function clearPlatformCache(): void {
  cached = null;
}

export function shouldShowSendTo(caps: PlatformCapabilities): boolean {
  return caps.sendToIntegration;
}

export function shouldShowUpdater(caps: PlatformCapabilities): boolean {
  return caps.automaticUpdater;
}

export function usesCustomTitleBar(caps: PlatformCapabilities): boolean {
  return caps.customTitleBar;
}

export function usesElementFullscreen(caps: PlatformCapabilities): boolean {
  return caps.elementFullscreen !== false;
}

export function supportsFileDragOut(caps: PlatformCapabilities): boolean {
  return caps.fileDragOut === true;
}

export function supportsHardwareEncoders(caps: PlatformCapabilities): boolean {
  return caps.hardwareAcceleration;
}

export function encodersForPlatform(
  encoders: readonly string[],
  caps: PlatformCapabilities,
): string[] {
  return supportsHardwareEncoders(caps)
    ? encoders.filter((encoder) => encoderSupportedOnPlatform(encoder, caps.platform))
    : encoders.filter((encoder) => isSoftwareEncoder(encoder));
}

export function encoderForPlatform(encoder: string, caps: PlatformCapabilities): string {
  return (!supportsHardwareEncoders(caps) && !isSoftwareEncoder(encoder)) ||
    !encoderSupportedOnPlatform(encoder, caps.platform) ? "libx264" : encoder;
}
