import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { hideStatusScreens, showStatusScreen } from "./status-screen.ts";

export type ExitPurpose = "close" | "update" | "restart";

// long enough for a busy queue, short enough that an install or restart never feels stuck
export const QUEUE_CHECK_TIMEOUT_MS = 2_000;

let exiting = false;

/** True once Tuck has started to close or install an update on purpose. */
export function isExiting(): boolean {
  return exiting;
}

export function exitScreenCopy(count: number | null, purpose: ExitPurpose): { title: string; detail: string } {
  if (purpose === "update") {
    return { title: "Installing the update…", detail: "Tuck closes now and opens again when the update is installed." };
  }
  const verb = purpose === "restart" ? "restarts" : "closes";
  if (count !== 0) {
    return {
      title: "Stopping exports…",
      detail: `Tuck ${verb} once the exports have stopped and their unfinished files are removed.`,
    };
  }
  if (purpose === "restart") return { title: "Restarting Tuck…", detail: "Tuck opens again in a moment." };
  return { title: "Closing Tuck…", detail: "This only takes a moment." };
}

/** Covers the window while Tuck stops its work, so the wait is visible and nothing new starts. */
export function showExitScreen(doc: Document, count: number | null, purpose: ExitPurpose): void {
  exiting = true;
  const copy = exitScreenCopy(count, purpose);
  showStatusScreen(doc, { id: "app-closing", tone: "status", ...copy });
}

/** The exit did not happen after all (for example the installer could not start). */
export function cancelExit(doc: Document): void {
  exiting = false;
  if (doc.getElementById("app-closing")) hideStatusScreens(doc);
}

/** Exports that stop when Tuck closes: the one running and the ones waiting. */
export function activeExportCount(queue: unknown): number {
  if (typeof queue !== "object" || queue === null) return 0;
  const items = (queue as { items?: unknown }).items;
  if (!Array.isArray(items)) return 0;
  return items.filter((item: unknown) => {
    const state = typeof item === "object" && item !== null ? (item as { state?: unknown }).state : undefined;
    return state === "running" || state === "pending";
  }).length;
}

export function closeRequestFrom(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const request = (payload as { request?: unknown }).request;
  return typeof request === "number" && Number.isSafeInteger(request) && request > 0 ? request : null;
}

export interface StopExportsQuestion {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

function exportsPhrase(count: number): string {
  return count === 1 ? "1 export" : `${count} exports`;
}

/**
 * What to ask before work is stopped. `count` is null when Tuck could not find out
 * whether anything is running.
 */
export function stopExportsQuestion(count: number | null, purpose: ExitPurpose): StopExportsQuestion {
  const outcome = { close: "close Tuck", update: "install the update", restart: "restart Tuck" }[purpose];
  const cancelLabel = "Keep working";
  const confirmLabel = { close: "Close anyway", update: "Install anyway", restart: "Restart anyway" }[purpose];
  const reopens = {
    close: "",
    update: " Tuck opens again once the update is installed.",
    restart: " Tuck opens again right away.",
  }[purpose];
  if (count === null) {
    return {
      title: { close: "Close Tuck?", update: "Install the update now?", restart: "Restart Tuck?" }[purpose],
      message: `Tuck couldn't check whether exports are running. Any export in progress stops when you ${outcome}.${reopens}`,
      confirmLabel,
      cancelLabel,
    };
  }
  return {
    title: `Stop ${exportsPhrase(count)} and ${outcome}?`,
    message: `Exports that are running or waiting stop now. Finished exports are kept.${reopens}`,
    confirmLabel,
    cancelLabel,
  };
}

export interface CloseGuardHost {
  /** running and waiting exports, or null when the queue could not be read */
  activeExports(): Promise<number | null>;
  confirm(question: StopExportsQuestion, onConfirm: () => void): void;
  /** shown while exports stop and Tuck closes */
  showClosing(activeExports: number | null): void;
}

export interface CloseGuardBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<unknown>;
}

const tauriBridge: CloseGuardBridge = { invoke, listen };

/**
 * Answers the shell's close requests. The shell asks before closing while its
 * backend runs; this acknowledges at once (so the shell keeps waiting) and then
 * closes straight away when nothing would be lost, or asks first when exports
 * are running or waiting.
 */
export async function installCloseGuard(host: CloseGuardHost, bridge: CloseGuardBridge = tauriBridge): Promise<void> {
  const close = (count: number | null): void => {
    host.showClosing(count);
    bridge.invoke("confirm_close").catch((error: unknown) => {
      console.error("Could not close Tuck", error);
    });
  };
  await bridge.listen("close-requested", (event) => {
    const request = closeRequestFrom(event.payload);
    if (request === null) return;
    void (async () => {
      try {
        await bridge.invoke("acknowledge_close_request", { request });
      } catch (error) {
        // the shell closes on its own when it hears nothing back
        console.error("Could not answer the close request", error);
        return;
      }
      const count = await host.activeExports();
      if (count === 0) {
        close(count);
        return;
      }
      host.confirm(stopExportsQuestion(count, "close"), () => close(count));
    })();
  });
}

/** Resolves with `fallback` when `promise` takes longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
