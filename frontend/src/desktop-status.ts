import { invoke } from "@tauri-apps/api/core";

import { UPDATE_BACKEND_STOPPED } from "./backend/errors.ts";
import { hasTauriInvoke } from "./backend/index.ts";
import type { BackendError } from "./backend/types.ts";
import type { StatusAction, StatusScreen } from "./platform/status-screen.ts";

export function hasDesktopBackend(host: unknown): boolean {
  return hasTauriInvoke(host);
}

/**
 * "start": Tuck never became ready. "stopped": it was working, then quit. "update": it
 * stopped its work for the update installer, which then didn't start.
 */
export type BackendFailureKind = "start" | "stopped" | "update";

export interface BackendFailureCopy {
  readonly title: string;
  readonly message: string;
}

// people read this, so it says what happened and what to do, without internal names
export function backendFailureCopy(kind: BackendFailureKind): BackendFailureCopy {
  if (kind === "update") {
    return {
      title: "The update couldn't start",
      message:
        "Tuck stopped its work to install the update, but the installer didn't open. " +
        "Your original videos are untouched. Restart Tuck to keep working, then try the update again.",
    };
  }
  if (kind === "stopped") {
    return {
      title: "Tuck stopped working",
      message:
        "Part of Tuck stopped unexpectedly, so any exports in progress were stopped. " +
        "Your original videos are untouched. Restart Tuck to keep working.",
    };
  }
  return {
    title: "Tuck couldn't start",
    message:
      "Something went wrong while Tuck was getting ready. Restart Tuck to try again. " +
      "If this keeps happening, copy the details and include them when you report the problem.",
  };
}

/** One screen for every way the backend can be gone; while it shows, later failures leave it alone. */
export function backendUnavailableScreen(
  kind: BackendFailureKind,
  actions: readonly StatusAction[],
): StatusScreen {
  const copy = backendFailureCopy(kind);
  return {
    id: "backend-unavailable",
    tone: "alert",
    title: copy.title,
    detail: copy.message,
    actions,
  };
}

/** The update installer failed after the shell had already stopped the backend for it. */
export function updateStoppedTuck(error: BackendError): boolean {
  return error.code === UPDATE_BACKEND_STOPPED;
}

/** Restarts the whole app; the shell only allows it once the backend has stopped. */
export function restartTuckAction(
  restart: () => Promise<unknown> = () => invoke("restart_app"),
): StatusAction {
  return {
    label: "Restart Tuck",
    primary: true,
    run: (button, note) => {
      button.disabled = true;
      button.textContent = "Restarting…";
      note.textContent = "";
      restart().catch((cause: unknown) => {
        console.error("Could not restart Tuck", cause);
        button.disabled = false;
        button.textContent = "Restart Tuck";
        note.textContent = "Tuck couldn't restart itself. Close it and open it again.";
      });
    },
  };
}

/** Plain-text detail for a bug report: the error and the last output Tuck kept. */
export function backendFailureDetails(error: BackendError | undefined): string {
  if (!error) return "Tuck could not reach its desktop shell.";
  const lines = [`${error.code}: ${error.message}`];
  const stderr = error.details.stderr;
  if (typeof stderr === "string" && stderr.trim()) lines.push("", stderr.trimEnd());
  return lines.join("\n");
}

/** Shown in the console only, for someone running the page without the desktop shell. */
export const DEVELOPER_SHELL_HINT =
  "Tuck's page needs the desktop shell. Start it with npm run tauri dev.";
