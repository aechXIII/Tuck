import {
  createPywebviewClientFromWindow,
  createTauriBackendClientFromWindow,
  hasPywebviewApi,
  hasTauriInvoke,
  PYWEBVIEW_READY_EVENT,
  setBackendClient,
} from "./backend/index.ts";
import type { TauriBackendClient } from "./backend/index.ts";

const BACKEND_GRACE_PERIOD_MS = 2_000;
let backendTimer: number | undefined;
let blockedSiblings: HTMLElement[] = [];
let tauriStartupStarted = false;
let legacyInitApp: ((data: unknown) => void) | undefined;

export function hasDesktopBackend(host: unknown): boolean {
  return hasPywebviewApi(host) || hasTauriInvoke(host);
}

export function backendUnavailableMessage(reason?: string): string {
  const normalizedReason = reason?.trim();
  if (normalizedReason) {
    const sentence = /[.!?]$/.test(normalizedReason)
      ? normalizedReason
      : `${normalizedReason}.`;
    return `Tuck could not connect to its desktop backend: ${sentence} Close and reopen Tuck.`;
  }
  return "Tuck could not connect to its desktop backend. Close and reopen Tuck. Developers should run npm run build before launching the Python app.";
}

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

function attachDesktopBackend(client: Parameters<NonNullable<typeof window.attachBackendClient>>[0]): void {
  setBackendClient(client);
  window.tuckBackendClient = client;
  window.attachBackendClient?.(client);
  markDesktopBackendReady();
}

function startTauriBackend(client: TauriBackendClient): void {
  if (tauriStartupStarted) return;
  tauriStartupStarted = true;
  client.onFatal((error) => showBackendUnavailable(error.message));
  showBackendLoading();
  void client.health().then((result) => {
    if (!result.ok) {
      showBackendUnavailable(result.error.message);
      return;
    }
    legacyInitApp?.({ files: [], sendto: null });
    attachDesktopBackend(client);
  });
}

function installDesktopBackend(): boolean {
  if (window.tuckBackendClient) {
    attachDesktopBackend(window.tuckBackendClient);
    return true;
  }
  const tauriClient = createTauriBackendClientFromWindow(window);
  if (tauriClient) {
    startTauriBackend(tauriClient);
    return true;
  }
  const client = createPywebviewClientFromWindow(window);
  if (!client) return false;
  attachDesktopBackend(client);
  return true;
}

function waitForDesktopBackend(): void {
  if (installDesktopBackend()) return;
  backendTimer = window.setTimeout(() => {
    backendTimer = undefined;
    if (!installDesktopBackend()) showBackendUnavailable();
  }, BACKEND_GRACE_PERIOD_MS);
}

if (typeof window !== "undefined") {
  void import("./startup.css");
  window.addEventListener(PYWEBVIEW_READY_EVENT, installDesktopBackend, {
    once: true,
  });

  const initialLegacyInitApp = window.initApp;
  legacyInitApp = initialLegacyInitApp;
  if (initialLegacyInitApp) {
    window.initApp = (data: unknown) => {
      initialLegacyInitApp(data);
      installDesktopBackend();
    };
  }

  if (document.readyState === "complete") waitForDesktopBackend();
  else window.addEventListener("load", waitForDesktopBackend, { once: true });
}
