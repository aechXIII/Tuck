/** The most videos the next launch reopens; Python enforces the same limit. */
export const SESSION_FILES_MAX = 500;

export interface SessionFilesDeps {
  /** whether the user asked to reopen the Library next time */
  enabled: () => boolean;
  save: (paths: readonly string[]) => Promise<void>;
  schedule: (run: () => void, delay: number) => unknown;
  cancel: (handle: unknown) => void;
  delay?: number;
}

/**
 * Remembers the Library for the next launch while "Reopen last videos" is on. The list is only
 * written when it changes, and a burst of changes is saved once.
 */
export function createSessionFiles(deps: SessionFilesDeps) {
  let saved: string | null = null;
  let pending: unknown = null;
  let latest: readonly string[] = [];

  function flush(): void {
    pending = null;
    const key = latest.join("\n");
    if (key === saved) return;
    saved = key;
    void deps.save(latest);
  }

  return {
    /** call with the Library's paths whenever it may have changed */
    track(paths: readonly string[]): void {
      if (!deps.enabled()) return;
      const next = paths.slice(0, SESSION_FILES_MAX);
      const key = next.join("\n");
      // the Library re-renders while the queue runs; the same list must not keep pushing the
      // pending save back, or it would never be written
      if (pending !== null && key === latest.join("\n")) return;
      latest = next;
      if (key === saved) return;
      if (pending !== null) deps.cancel(pending);
      pending = deps.schedule(flush, deps.delay ?? 600);
    },
    /** call after the setting changes; turning it off forgets the saved list */
    sync(paths: readonly string[]): void {
      if (pending !== null) deps.cancel(pending);
      pending = null;
      if (deps.enabled()) {
        latest = paths.slice(0, SESSION_FILES_MAX);
        flush();
      } else if (saved !== "") {
        saved = "";
        latest = [];
        void deps.save([]);
      }
    },
    /** the list read at launch, so an unchanged Library isn't written again */
    remember(paths: readonly string[]): void {
      saved = paths.slice(0, SESSION_FILES_MAX).join("\n");
    },
  };
}
