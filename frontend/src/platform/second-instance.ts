export interface SecondInstanceLaunchQueue {
  enqueue(payload: unknown): void;
  drain(): string[];
  markReadyAndFlush(): void;
}

function pathsFromPayload(payload: unknown): string[] {
  return Array.isArray(payload)
    ? payload.filter((path): path is string => typeof path === "string")
    : [];
}

export function createSecondInstanceLaunchQueue(
  deliver: (files: readonly string[]) => void,
): SecondInstanceLaunchQueue {
  const queued: string[][] = [];
  let ready = false;

  return {
    enqueue(payload) {
      const files = pathsFromPayload(payload);
      if (!files.length) return;
      if (ready) deliver(files);
      else queued.push(files);
    },
    drain() {
      return queued.splice(0).flat();
    },
    markReadyAndFlush() {
      ready = true;
      const files = queued.splice(0).flat();
      if (files.length) deliver(files);
    },
  };
}
