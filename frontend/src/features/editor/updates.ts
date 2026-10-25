import { getBackendClient } from "../../backend/client.ts";
import type { BackendClient, UpdateCheck } from "../../backend/types.ts";
import {
  activeExportCount,
  cancelExit,
  QUEUE_CHECK_TIMEOUT_MS,
  showExitScreen,
  stopExportsQuestion,
  withTimeout,
} from "../../platform/app-exit.ts";
import { fetchPlatformCapabilities, shouldShowUpdater } from "../../platform/capabilities.ts";
import { showStatusScreen } from "../../platform/status-screen.ts";
import {
  backendUnavailableScreen,
  restartTuckAction,
  updateStoppedTuck,
} from "../../desktop-status.ts";
import { legacyBackendResult } from "./backend-compat.ts";
import { byId } from "./session.ts";
import { closeMod, confirmToast, showMod, toast } from "./toast.ts";

export interface UpdateNoteBlock {
  type: "heading" | "bullet" | "text";
  text: string;
}

export function cleanUpdateNoteText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function updateNoteBlocks(notes: unknown): UpdateNoteBlock[] {
  const blocks: UpdateNoteBlock[] = [];
  const lines = String(notes || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading?.[1]) {
      const headingText = cleanUpdateNoteText(heading[1]);
      if (/^\[?v?\d+\.\d+\.\d+\]?\s+-\s+\d{4}-\d{2}-\d{2}$/i.test(headingText)) continue;
      blocks.push({ type: "heading", text: headingText });
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet?.[1]) {
      blocks.push({ type: "bullet", text: cleanUpdateNoteText(bullet[1]) });
      continue;
    }
    blocks.push({ type: "text", text: cleanUpdateNoteText(line) });
  }
  return blocks;
}

export function renderUpdateNotes(notes: unknown): void {
  const root = byId("update-notes");
  if (!root) return;
  root.replaceChildren();
  let blocks = updateNoteBlocks(notes);
  if (!blocks.length) blocks = [{ type: "text", text: "No release notes provided." }];
  let list: HTMLUListElement | null = null;
  for (const block of blocks) {
    if (block.type === "bullet") {
      if (!list) {
        list = document.createElement("ul");
        root.appendChild(list);
      }
      const item = document.createElement("li");
      item.textContent = block.text;
      list.appendChild(item);
      continue;
    }
    list = null;
    const element = document.createElement(block.type === "heading" ? "h4" : "p");
    element.textContent = block.text;
    root.appendChild(element);
  }
}

export function showUpdateModal(update: UpdateCheck | Record<string, unknown>): void {
  showMod(
    `<h2>Update available</h2>
    <div>
      Version <strong id="update-version"></strong>
    </div>
    <h3>What's new</h3>
    <div class="update-notes" id="update-notes"></div>
    <div class="brow">
      <button type="button" class="btn2" id="update-later">Later</button>
      <button type="button" class="btn1" id="update-install">Download &amp; install</button>
    </div>`,
  );
  const version = byId("update-version");
  if (version) version.textContent = `v${String(update.version ?? "")}`;
  byId("update-later")?.addEventListener("click", closeMod);
  byId("update-install")?.addEventListener("click", () => {
    void downloadAndInstallUpdate();
  });
  renderUpdateNotes(update.notes);
}

async function downloadAndInstallUpdate(): Promise<void> {
  const button = byId("update-install") as HTMLButtonElement | null;
  const later = byId("update-later") as HTMLButtonElement | null;
  if (!button || !later) return;
  button.disabled = true;
  later.disabled = true;
  const restoreOffer = (): void => {
    button.disabled = false;
    later.disabled = false;
    button.textContent = "Download & install";
  };
  const api = getBackendClient();
  button.textContent = "Starting download…";
  try {
    await downloadUpdate(api, button);
  } catch (error) {
    restoreOffer();
    const message = error instanceof Error ? error.message : String(error);
    toast(`Update failed: ${message}`, "err");
    return;
  }
  // a dialog closed during the download means "not now": Tuck never restarts by itself
  if (!button.isConnected || !byId("mod-overlay")?.classList.contains("open")) {
    toast("The update is downloaded. Install it when you’re ready.", "info", {
      label: "Install",
      run: () => void installWhenIdle(api, null),
    }, { key: "update-ready" });
    return;
  }
  await installWhenIdle(api, restoreOffer);
}

// installing closes Tuck, so running exports are never stopped without asking
async function installWhenIdle(api: BackendClient, restoreOffer: (() => void) | null): Promise<void> {
  const count = await activeExports(api);
  if (count === 0) {
    await installUpdate(api, restoreOffer);
    return;
  }
  restoreOffer?.();
  const question = stopExportsQuestion(count, "update");
  confirmToast(question.message, () => void installUpdate(api, null), {
    title: question.title,
    confirmLabel: question.confirmLabel,
    cancelLabel: question.cancelLabel,
    danger: true,
  });
}

// the shell keeps a finished, verified download, so asking again does not fetch it twice
async function downloadUpdate(api: BackendClient, button: HTMLButtonElement): Promise<void> {
  const started = await legacyBackendResult(api.downloadUpdate());
  if (!started.ok) {
    throw new Error(started.error || "Could not start the download");
  }
  while (true) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    const progress = await legacyBackendResult(api.getDownloadProgress());
    if (progress.downloading) {
      button.textContent = `Downloading ${Number(progress.progress || 0)}%`;
      continue;
    }
    if (progress.error) throw new Error(String(progress.error));
    if (progress.done) return;
    throw new Error("Download stopped unexpectedly");
  }
}

async function activeExports(api: BackendClient): Promise<number | null> {
  const result = await withTimeout(api.getQueueState(), QUEUE_CHECK_TIMEOUT_MS, null);
  return result?.ok ? activeExportCount(result.value) : null;
}

async function installUpdate(api: BackendClient, restoreOffer: (() => void) | null): Promise<void> {
  showExitScreen(document, null, "update");
  const installed = await api.installUpdate();
  if (installed.ok) {
    // the installer normally closes Tuck itself; this covers a shell that returned instead
    await api.closeWindow();
    return;
  }
  cancelExit(document);
  if (updateStoppedTuck(installed.error)) {
    // trying again can't work without the backend, and only a restart brings it back
    closeMod();
    showStatusScreen(document, backendUnavailableScreen("update", [restartTuckAction()]));
    return;
  }
  restoreOffer?.();
  toast(`Update failed: ${installed.error.message || "Could not start the installer"}`, "err");
}

export async function checkUpdates(silent: boolean): Promise<void> {
  if (!shouldShowUpdater(await fetchPlatformCapabilities())) return;
  const api = getBackendClient();
  const r = await legacyBackendResult(api.checkForUpdates());
  if (r.error) {
    if (!silent) toast(`Update check failed: ${r.error}`, "err");
    return;
  }
  if (!r.available) {
    if (!silent) toast("Running latest version.", "ok");
    return;
  }
  showUpdateModal(r);
}

export async function checkUpdatesFromSettings(): Promise<void> {
  await checkUpdates(false);
}
