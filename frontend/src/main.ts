import {
  createTauriBackendClientFromWindow,
  setBackendClient,
} from "./backend/index.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BackendClient } from "./backend/types.ts";
import type { TauriBackendClient } from "./backend/index.ts";
import {
  installEditorRuntime,
  type EditorRuntime,
} from "./features/editor/runtime.ts";
import { backendUnavailableMessage, hasDesktopBackend } from "./desktop-status.ts";
import { createSecondInstanceLaunchQueue } from "./platform/second-instance.ts";
import "./styles/index.ts";

export { backendUnavailableMessage, hasDesktopBackend };

const BACKEND_GRACE_PERIOD_MS = 2_000;
let backendTimer: number | undefined;
let blockedSiblings: HTMLElement[] = [];
let tauriStartupStarted = false;
let editorRuntime: EditorRuntime | undefined;
let backendAttached = false;

function showBackendLoading(): void {
  if (document.getElementById("backend-connecting")) return;

  const status = document.createElement("section");
  status.id = "backend-connecting";
  status.className = "backend-unavailable";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const content = document.createElement("div");
  content.className = "backend-unavailable__content";
  const heading = document.createElement("h1");
  heading.textContent = "Connecting to desktop backend";
  const detail = document.createElement("p");
  detail.textContent = "Tuck is starting its desktop backend.";
  content.append(heading, detail);
  status.append(content);
  document.body.append(status);
}

function showBackendUnavailable(reason?: string): void {
  if (document.getElementById("backend-unavailable")) return;
  document.getElementById("backend-connecting")?.remove();

  const alert = document.createElement("section");
  alert.id = "backend-unavailable";
  alert.className = "backend-unavailable";
  alert.setAttribute("role", "alert");
  alert.setAttribute("aria-live", "assertive");

  const content = document.createElement("div");
  content.className = "backend-unavailable__content";

  const heading = document.createElement("h1");
  heading.textContent = "Desktop backend unavailable";

  const detail = document.createElement("p");
  detail.textContent = backendUnavailableMessage(reason);

  content.append(heading, detail);
  alert.append(content);
  document.body.append(alert);
  blockedSiblings = Array.from(document.body.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== alert && !element.inert,
  );
  blockedSiblings.forEach((element) => {
    element.inert = true;
  });
}

function markDesktopBackendReady(): void {
  if (backendTimer !== undefined) {
    window.clearTimeout(backendTimer);
    backendTimer = undefined;
  }
  document.getElementById("backend-connecting")?.remove();
  document.getElementById("backend-unavailable")?.remove();
  blockedSiblings.forEach((element) => {
    element.inert = false;
  });
  blockedSiblings = [];
}

function attachDesktopBackend(client: BackendClient): void {
  if (backendAttached) return;
  backendAttached = true;
  setBackendClient(client);
  window.tuckBackendClient = client;
  editorRuntime?.attachBackendClient();
  markDesktopBackendReady();
}

function startTauriBackend(client: TauriBackendClient): void {
  if (tauriStartupStarted) return;
  tauriStartupStarted = true;
  client.onFatal((error) => showBackendUnavailable(error.message));
  showBackendLoading();

  // Rust keeps forwarded paths buffered until this listener has completed the
  // startup request; later forwards arrive only through this event.
  const secondInstanceLaunches = createSecondInstanceLaunchQueue((files) => {
    editorRuntime?.initApp({ files, sendto: null });
  });
  const listenerReady = listen<string[]>("second-instance", (event) => {
    secondInstanceLaunches.enqueue(event.payload);
  }).catch(() => undefined);

  void listenerReady.then(() => client.health()).then(async (result) => {
    if (!result.ok) {
      showBackendUnavailable(result.error.message);
      return;
    }
    // Fetch startup files after backend is ready (normalized in Rust, validated in Python)
    let startupFiles: string[] = [];
    try {
      const files = (await invoke("get_startup_files", {})) as unknown;
      if (Array.isArray(files)) {
        startupFiles = files.filter((file): file is string => typeof file === "string");
      }
    } catch {
      // the backend health result remains authoritative if launch-file delivery fails
    }
    editorRuntime?.initApp({
      files: startupFiles.concat(secondInstanceLaunches.drain()),
      sendto: null,
    });
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
    if (!installDesktopBackend()) showBackendUnavailable();
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

  if (document.readyState === "complete") waitForDesktopBackend();
  else window.addEventListener("load", waitForDesktopBackend, { once: true });
}

if (typeof window !== "undefined") bootstrapFrontend();
