export type LaunchTask = "compression" | "upscale" | "cut";

/** Files and the optional export task from `get_startup_files` or a "second-instance" event. */
export interface StartupLaunch {
  readonly files: readonly string[];
  readonly task: LaunchTask | null;
}

export interface SecondInstanceLaunchQueue {
  enqueue(payload: unknown): void;
  drain(): StartupLaunch;
  markReadyAndFlush(): void;
}

const LAUNCH_TASKS: readonly LaunchTask[] = ["compression", "upscale", "cut"];

function isLaunchTask(value: unknown): value is LaunchTask {
  return typeof value === "string" && (LAUNCH_TASKS as readonly string[]).includes(value);
}

export function launchFromPayload(payload: unknown): StartupLaunch {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { files: [], task: null };
  }
  const record = payload as { readonly files?: unknown; readonly task?: unknown };
  const files = Array.isArray(record.files)
    ? record.files.filter((path): path is string => typeof path === "string")
    : [];
  return { files, task: isLaunchTask(record.task) ? record.task : null };
}

// later launches add their files, and a later task replaces an earlier one
export function mergeLaunches(launches: readonly StartupLaunch[]): StartupLaunch {
  let task: LaunchTask | null = null;
  const files: string[] = [];
  for (const launch of launches) {
    files.push(...launch.files);
    if (launch.task) task = launch.task;
  }
  return { files, task };
}

function isEmpty(launch: StartupLaunch): boolean {
  return launch.files.length === 0 && launch.task === null;
}

export function createSecondInstanceLaunchQueue(
  deliver: (launch: StartupLaunch) => void,
): SecondInstanceLaunchQueue {
  const queued: StartupLaunch[] = [];
  let ready = false;

  return {
    enqueue(payload) {
      const launch = launchFromPayload(payload);
      if (isEmpty(launch)) return;
      if (ready) deliver(launch);
      else queued.push(launch);
    },
    drain() {
      return mergeLaunches(queued.splice(0));
    },
    markReadyAndFlush() {
      ready = true;
      const launch = mergeLaunches(queued.splice(0));
      if (!isEmpty(launch)) deliver(launch);
    },
  };
}
