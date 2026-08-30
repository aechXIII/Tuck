interface DesktopHost {
  initApp?: (data: unknown) => void;
  pywebview?: {
    api?: object;
  };
}

const BACKEND_GRACE_PERIOD_MS = 2_000;
let backendTimer: number | undefined;
let blockedSiblings: HTMLElement[] = [];

export function hasDesktopBackend(host: unknown): host is DesktopHost {
  if (typeof host !== "object" || host === null) return false;
  const pywebview = (host as DesktopHost).pywebview;
  return (
    typeof pywebview === "object" &&
    pywebview !== null &&
    typeof pywebview.api === "object" &&
    pywebview.api !== null
  );
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

function waitForDesktopBackend(): void {
  if (hasDesktopBackend(window)) {
    markDesktopBackendReady();
    return;
  }
  backendTimer = window.setTimeout(() => {
    backendTimer = undefined;
    if (hasDesktopBackend(window)) markDesktopBackendReady();
    else showBackendUnavailable();
  }, BACKEND_GRACE_PERIOD_MS);
}

if (typeof window !== "undefined") {
  void import("./startup.css");
  window.addEventListener("pywebviewready", markDesktopBackendReady);

  const host = window as Window & DesktopHost;
  const legacyInitApp = host.initApp;
  if (legacyInitApp) {
    host.initApp = (data: unknown) => {
      markDesktopBackendReady();
      legacyInitApp(data);
    };
  }

  if (document.readyState === "complete") waitForDesktopBackend();
  else window.addEventListener("load", waitForDesktopBackend, { once: true });
}
