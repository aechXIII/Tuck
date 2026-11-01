import type { JoinStatus } from "../../backend/join-types.ts";
import type { BackendClient } from "../../backend/types.ts";
import { toast } from "../editor/toast.ts";

export interface JoinDeps {
  client: () => BackendClient;
  // the joined video goes into the Library and onto the stage like any added video
  addVideo: (path: string) => void;
  // the chosen videos go to Exports the way the task's export all sends them
  exportChosen: (paths: readonly string[]) => void;
  // the export button's name for the task ("Compress", "Upscale", "Export cuts"), and whether
  // these videos can go now
  chosenExport: (paths: readonly string[]) => { label: string; disabled: boolean };
  // only the video on the stage stays chosen
  clearChoice: () => void;
  documentRef?: Document;
  pollMs?: number;
}

export interface JoinApi {
  // the Library's chosen videos, in Library order; called on every Library render
  sync(paths: readonly string[]): void;
  // the export settings or the videos' readiness changed, so the chosen export button may too
  refresh(): void;
  canJoin(): boolean;
  join(): Promise<void>;
}

type JoinView =
  | { kind: "idle" }
  | { kind: "running"; count: number; status: JoinStatus | null; cancelling: boolean }
  | { kind: "failed"; message: string };

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function percent(progress: number): string {
  return `${Math.floor(progress * 100)}%`;
}

// names the stage the backend reports; a share is shown only where it was measured
export function joinStageText(count: number, status: JoinStatus | null): string {
  if (!status || status.stage === "checking") return `Checking ${count} videos…`;
  if (status.stage === "saving") return "Saving…";
  const verb = status.stage === "encoding" ? "Re-encoding" : "Joining";
  return status.progress === null ? `${verb}…` : `${verb} · ${percent(status.progress)}`;
}

export function joinStageNote(status: JoinStatus | null): string {
  if (!status || status.lossless === null) return "";
  if (status.lossless) return "Copying without re-encoding, so nothing changes in quality.";
  const reason = status.reason ? `Re-encoding because ${status.reason}.` : "Re-encoding so the videos match.";
  return status.fallback ? `${reason} ${status.fallback}` : reason;
}

export function joinedMessage(count: number, status: JoinStatus): string {
  const made = `Joined ${count} videos into “${fileName(status.output_path)}”.`;
  if (status.lossless) return `${made} Nothing was re-encoded.`;
  const reason = status.reason ? ` Re-encoded because ${status.reason}.` : "";
  return `${made}${reason}${status.fallback ? ` ${status.fallback}` : ""}`;
}

export function installJoin(deps: JoinDeps): JoinApi {
  const documentRef = deps.documentRef ?? document;
  const pollMs = deps.pollMs ?? 250;
  const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = documentRef.getElementById(id);
    if (!node) throw new Error(`Missing #${id}`);
    return node as T;
  };
  const panel = element("lib-join");
  const text = element("lib-join-text");
  const note = element("lib-join-note");
  const bar = element<HTMLProgressElement>("lib-join-bar");
  const joinButton = element<HTMLButtonElement>("btn-join");
  const exportButton = element<HTMLButtonElement>("btn-chosen-export");
  const actions = element("lib-chosen-actions");
  const clearButton = element<HTMLButtonElement>("lib-join-clear");
  const cancelButton = element<HTMLButtonElement>("lib-join-cancel");
  const dismissButton = element<HTMLButtonElement>("lib-join-dismiss");
  const announcer = element("lib-join-status");
  let selection: readonly string[] = [];
  let view: JoinView = { kind: "idle" };
  let workId = "";

  function announce(message: string): void {
    announcer.textContent = message;
  }

  function render(): void {
    const running = view.kind === "running";
    const failed = view.kind === "failed";
    const choosing = view.kind === "idle" && selection.length > 1;
    panel.hidden = !running && !failed && !choosing;
    panel.dataset.state = view.kind;
    actions.hidden = !choosing;
    clearButton.hidden = !choosing;
    cancelButton.hidden = !running;
    dismissButton.hidden = !failed;
    if (view.kind === "running") {
      text.textContent = joinStageText(view.count, view.status);
      note.textContent = joinStageNote(view.status);
      cancelButton.disabled = view.cancelling;
      cancelButton.textContent = view.cancelling ? "Canceling…" : "Cancel";
      const progress = view.status?.progress;
      bar.hidden = typeof progress !== "number";
      if (typeof progress === "number") bar.value = progress * 100;
    } else if (view.kind === "failed") {
      text.textContent = "Couldn’t join the videos";
      note.textContent = view.message;
      bar.hidden = true;
    } else {
      text.textContent = `${selection.length} chosen`;
      note.textContent = "";
      joinButton.setAttribute("aria-label", `Join ${selection.length} videos into one`);
      if (choosing) {
        const chosen = deps.chosenExport(selection);
        if (exportButton.textContent !== chosen.label) exportButton.textContent = chosen.label;
        exportButton.disabled = chosen.disabled;
        exportButton.setAttribute("aria-label", `${chosen.label} ${selection.length} videos`);
      }
      bar.hidden = true;
    }
    note.hidden = !note.textContent;
  }

  function settle(next: JoinView): void {
    const focusWasInside = panel.contains(documentRef.activeElement);
    view = next;
    render();
    // the button that had focus may have gone; focus stays in the Library's header
    if (!focusWasInside) return;
    const target = [dismissButton, joinButton].find((button) => !button.hidden && !button.closest("[hidden]"));
    if (target) target.focus();
  }

  async function join(): Promise<void> {
    if (!canJoin()) return;
    const paths = [...selection];
    const id = crypto.randomUUID();
    workId = id;
    const focusWasInside = panel.contains(documentRef.activeElement);
    view = { kind: "running", count: paths.length, status: null, cancelling: false };
    render();
    if (focusWasInside) cancelButton.focus();
    announce(`Joining ${paths.length} videos.`);
    let answer = await deps.client().joinVideos(paths, id);
    while (answer.ok && answer.value.status === "running") {
      if (workId !== id || view.kind !== "running") return;
      view = { ...view, status: answer.value };
      render();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      answer = await deps.client().getJoin(id);
    }
    if (workId !== id) return;
    if (!answer.ok) {
      announce("Couldn’t join the videos.");
      settle({ kind: "failed", message: answer.error.message });
      return;
    }
    const status = answer.value;
    if (status.status === "done") {
      settle({ kind: "idle" });
      deps.addVideo(status.output_path);
      const message = joinedMessage(paths.length, status);
      announce(message);
      toast(message, "ok");
    } else if (status.status === "cancelled") {
      announce("Join canceled. Nothing was saved.");
      settle({ kind: "idle" });
    } else {
      const message = status.status === "missing"
        ? "Tuck lost track of the join. Try again."
        : status.message || "The videos couldn’t be joined. Try again.";
      announce(`Couldn’t join the videos. ${message}`);
      settle({ kind: "failed", message });
    }
  }

  function canJoin(): boolean {
    return view.kind !== "running" && selection.length > 1;
  }

  joinButton.addEventListener("click", () => void join());
  exportButton.addEventListener("click", () => {
    if (view.kind === "idle" && selection.length > 1 && !exportButton.disabled) deps.exportChosen([...selection]);
  });
  clearButton.addEventListener("click", () => deps.clearChoice());
  cancelButton.addEventListener("click", () => {
    if (view.kind !== "running" || view.cancelling) return;
    view = { ...view, cancelling: true };
    render();
    void deps.client().cancelJoin(workId);
  });
  dismissButton.addEventListener("click", () => settle({ kind: "idle" }));
  render();

  return {
    sync(paths) {
      if (paths.length === selection.length && paths.every((path, index) => path === selection[index])) return;
      selection = [...paths];
      render();
    },
    refresh: render,
    canJoin,
    join,
  };
}
