export type StartTask = "compression" | "upscale" | "cut";

export interface StartScreenCopy {
  readonly title: string;
  readonly note: string;
}

const TASK_COPY: Readonly<Record<StartTask, StartScreenCopy>> = {
  compression: {
    title: "Drop a video to compress it",
    note: "It will fit the size you pick, like 20 MB for Discord.",
  },
  upscale: {
    title: "Drop a video to upscale it",
    note: "It is re-encoded at a higher resolution.",
  },
  cut: {
    title: "Drop a video to cut it",
    note: "Cuts keep the original quality.",
  },
};

/** What the start screen says for the current task. */
export function startScreenCopy(task: string): StartScreenCopy {
  return TASK_COPY[task as StartTask] ?? TASK_COPY.compression;
}

export interface StartScreenDeps {
  readonly document: Document;
  task(): string;
}

/**
 * The center of the editor before any video is added: what the current task does. While the
 * Library is empty, the Inspector and timeline show a short note instead of their controls (see
 * the library-empty rules in the stylesheets).
 */
export function createStartScreen(deps: StartScreenDeps) {
  const doc = deps.document;

  function renderCopy(): void {
    const copy = startScreenCopy(deps.task());
    const title = doc.getElementById("empty-title");
    const note = doc.getElementById("empty-note");
    if (title && title.textContent !== copy.title) title.textContent = copy.title;
    if (note && note.textContent !== copy.note) note.textContent = copy.note;
  }

  return {
    /** call whenever the Library or the task may have changed */
    sync(hasVideos: boolean): void {
      doc.body.classList.toggle("library-empty", !hasVideos);
      // hidden behind the player; it catches up the next time it shows
      if (hasVideos) return;
      renderCopy();
    },
  };
}
