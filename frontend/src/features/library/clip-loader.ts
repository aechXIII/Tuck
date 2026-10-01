export interface ClipLoader {
  // queues paths in order; a path that is waiting or loading keeps its place
  add(paths: readonly string[]): void;
  // moves a waiting path to the front, or queues it there
  prioritize(path: string): void;
}

/**
 * Runs `load` for a few paths at a time, in queue order, so Library rows fill in from the top.
 * Sending every request at once instead puts the first rows behind all the others in the
 * backend's queue.
 */
export function createClipLoader(load: (path: string) => Promise<void>, limit: number): ClipLoader {
  const waiting: string[] = [];
  const running = new Set<string>();

  async function run(path: string): Promise<void> {
    try {
      await load(path);
    } finally {
      running.delete(path);
      pump();
    }
  }

  function pump(): void {
    while (running.size < limit) {
      const path = waiting.shift();
      if (path === undefined) return;
      running.add(path);
      void run(path);
    }
  }

  return {
    add(paths) {
      for (const path of paths) {
        if (!running.has(path) && !waiting.includes(path)) waiting.push(path);
      }
      pump();
    },
    prioritize(path) {
      if (running.has(path)) return;
      const index = waiting.indexOf(path);
      if (index >= 0) waiting.splice(index, 1);
      waiting.unshift(path);
      pump();
    },
  };
}
