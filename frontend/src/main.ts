import {
  createTauriBackendClientFromWindow,
  setBackendClient,
} from "./backend/index.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BackendClient, BackendError } from "./backend/types.ts";
import type { TauriBackendClient } from "./backend/index.ts";
import {
  installEditorRuntime,
  type EditorRuntime,
} from "./features/editor/runtime.ts";
import { confirmToast } from "./features/editor/toast.ts";
import {
  backendFailureDetails,
  backendUnavailableScreen,
  DEVELOPER_SHELL_HINT,
  hasDesktopBackend,
  restartTuckAction,
  type BackendFailureKind,
} from "./desktop-status.ts";
import {
  activeExportCount,
  installCloseGuard,
  isExiting,
  showExitScreen,
  withTimeout,
} from "./platform/app-exit.ts";
import {
  createSecondInstanceLaunchQueue,
  launchFromPayload,
  mergeLaunches,
  type StartupLaunch,
} from "./platform/second-instance.ts";
import { hideStatusScreens, showStatusScreen, type StatusAction } from "./platform/status-screen.ts";
import { installNativeSurface } from "./platform/native-surface.ts";
import { installWindowChrome } from "./platform/window-chrome.ts";
import "./styles/index.ts";

export { hasDesktopBackend };

const BACKEND_GRACE_PERIOD_MS = 2_000;
// long enough for a busy queue, short enough that closing never feels stuck
const QUEUE_CHECK_TIMEOUT_MS = 2_000;
let backendTimer: number | undefined;
let tauriStartupStarted = false;
let editorRuntime: EditorRuntime | undefined;
let backendAttached = false;

function showBackendLoading(): void {
  if (document.getElementById("backend-connecting")) return;
  showStatusScreen(document, {
    id: "backend-connecting",
    tone: "status",
    title: "Starting Tuck…",
    detail: "This usually takes a few seconds.",
  });
}

function failureActions(error: BackendError | undefined): StatusAction[] {
  if (!hasDesktopBackend(window)) return [];
  const restart = restartTuckAction();
  const copy: StatusAction = {
    label: "Copy details",
    run: (_button, note) => {
      invoke("copy_text", { text: backendFailureDetails(error) })
        .then(() => {
          note.textContent = "Details copied.";
        })
        .catch((cause: unknown) => {
          console.error("Could not copy the details", cause);
          note.textContent = "The details couldn't be copied.";
        });
    },
  };
  // the primary action sits last, as in Tuck's other dialogs
  return [copy, restart];
}

function showBackendUnavailable(kind: BackendFailureKind, error?: BackendError): void {
  // a backend that stops because Tuck is closing is not a failure
  if (isExiting() || document.getElementById("backend-unavailable")) return;
  if (error) console.error("Tuck's backend is unavailable", error);
  else console.info(DEVELOPER_SHELL_HINT);
  showStatusScreen(document, backendUnavailableScreen(kind, failureActions(error)));
}

function markDesktopBackendReady(): void {
  if (backendTimer !== undefined) {
    window.clearTimeout(backendTimer);
    backendTimer = undefined;
  }
  hideStatusScreens(document);
}

function attachDesktopBackend(client: BackendClient): void {
  if (backendAttached) return;
  backendAttached = true;
  setBackendClient(client);
  window.tuckBackendClient = client;
  editorRuntime?.attachBackendClient();
  markDesktopBackendReady();
}

function installTauriCloseGuard(client: TauriBackendClient): void {
  void installCloseGuard({
    activeExports: async () => {
      // nothing can have been exported before the editor was connected
      if (!backendAttached) return 0;
      const result = await withTimeout(client.getQueueState(), QUEUE_CHECK_TIMEOUT_MS, null);
      return result?.ok ? activeExportCount(result.value) : null;
    },
    confirm: (question, onConfirm) => {
      confirmToast(question.message, onConfirm, {
        title: question.title,
        confirmLabel: question.confirmLabel,
        cancelLabel: question.cancelLabel,
        danger: true,
      });
    },
    showClosing: (count) => showExitScreen(document, count, "close"),
  }).catch((error: unknown) => {
    console.error("Could not listen for close requests", error);
  });
}

function startTauriBackend(client: TauriBackendClient): void {
  if (tauriStartupStarted) return;
  tauriStartupStarted = true;
  client.onFatal((error) => showBackendUnavailable(backendAttached ? "stopped" : "start", error));
  installTauriCloseGuard(client);
  showBackendLoading();

  // Rust keeps forwarded paths buffered until this listener has completed the
  // startup request; later forwards arrive only through this event.
  const secondInstanceLaunches = createSecondInstanceLaunchQueue((launch) => {
    editorRuntime?.initApp({ files: launch.files, sendto: null, task: launch.task });
  });
  const listenerReady = listen<unknown>("second-instance", (event) => {
    secondInstanceLaunches.enqueue(event.payload);
  }).catch(() => undefined);

  // the shell answers health once its backend has finished starting
  void listenerReady.then(() => client.health()).then(async (result) => {
    if (!result.ok) {
      showBackendUnavailable("start", result.error);
      return;
    }
    // Fetch startup files after backend is ready (normalized in Rust, validated in Python)
    let startup: StartupLaunch = { files: [], task: null };
    try {
      startup = launchFromPayload(await invoke("get_startup_files", {}));
    } catch {
      // the backend health result remains authoritative if launch-file delivery fails
    }
    const launch = mergeLaunches([startup, secondInstanceLaunches.drain()]);
    editorRuntime?.initApp({ files: launch.files, sendto: null, task: launch.task });
    attachDesktopBackend(client);
    secondInstanceLaunches.markReadyAndFlush();
  });
}

function installDesktopBackend(): boolean {
  if (window.tuckBackendClient) {
    attachDesktopBackend(window.tuckBackendClient);
    return true;
  }
  const tauriClient = createTauriBackendClientFromWindow(window);
  if (!tauriClient) return false;
  startTauriBackend(tauriClient);
  return true;
}

function waitForDesktopBackend(): void {
  if (installDesktopBackend()) return;
  backendTimer = window.setTimeout(() => {
    backendTimer = undefined;
    if (!installDesktopBackend()) showBackendUnavailable("start");
  }, BACKEND_GRACE_PERIOD_MS);
}

function bootstrapFrontend(): void {
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && (
      target.isContentEditable ||
      target.closest('textarea, input:not([type]), input[type="text"], input[type="number"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], input[type="tel"]')
    )) return;
    event.preventDefault();
  });
  editorRuntime = installEditorRuntime(window);
  window.initApp = (data: unknown): void => editorRuntime?.initApp(data);
  window.attachBackendClient = attachDesktopBackend;

  editorRuntime.start();
  void installWindowChrome(window).catch((error: unknown) => {
    console.error("Could not set up the title bar", error);
  });
  void installNativeSurface(window).catch((error: unknown) => {
    console.error("Could not set up the native preview", error);
  });

  if (document.readyState === "complete") waitForDesktopBackend();
  else window.addEventListener("load", waitForDesktopBackend, { once: true });
}

if (typeof window !== "undefined") bootstrapFrontend();
