import {
  createPywebviewClientFromWindow,
  hasPywebviewApi,
  PYWEBVIEW_READY_EVENT,
  setBackendClient,
} from "./backend/index.ts";

const BACKEND_GRACE_PERIOD_MS = 2_000;
let backendTimer: number | undefined;
let blockedSiblings: HTMLElement[] = [];

export function hasDesktopBackend(host: unknown): boolean {
  return hasPywebviewApi(host);
}

function showBackendUnavailable(): void {
  if (document.getElementById("backend-unavailable")) return;

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
  detail.textContent =
    "Tuck could not connect to its desktop backend. Close and reopen Tuck. Developers should run npm run build before launching the Python app.";

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
  document.getElementById("backend-unavailable")?.remove();
  blockedSiblings.forEach((element) => {
    element.inert = false;
  });
  blockedSiblings = [];
}

function installDesktopBackend(): boolean {
  if (window.tuckBackendClient) {
    setBackendClient(window.tuckBackendClient);
    window.attachBackendClient?.(window.tuckBackendClient);
    markDesktopBackendReady();
    return true;
  }
  const client = createPywebviewClientFromWindow(window);
  if (!client) return false;
  setBackendClient(client);
  window.tuckBackendClient = client;
  window.attachBackendClient?.(client);
  markDesktopBackendReady();
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

  const legacyInitApp = window.initApp;
  if (legacyInitApp) {
    window.initApp = (data: unknown) => {
      legacyInitApp(data);
      installDesktopBackend();
    };
  }

  if (document.readyState === "complete") waitForDesktopBackend();
  else window.addEventListener("load", waitForDesktopBackend, { once: true });
}
