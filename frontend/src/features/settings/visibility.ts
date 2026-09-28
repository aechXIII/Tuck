// which parts of Tuck the user chose to hide, and what opens on launch. Python validates and
// stores the settings; these helpers only read them defensively for the editor.

export type TaskName = "compression" | "upscale" | "cut";
export type HideablePart =
  | TaskName
  | "panel_video"
  | "panel_audio"
  | "audio_editing"
  | "frame_blending"
  | "lut";

export const TASKS: readonly TaskName[] = ["compression", "upscale", "cut"];
export const HIDEABLE_PARTS: readonly HideablePart[] = [
  ...TASKS,
  "panel_video",
  "panel_audio",
  "audio_editing",
  "frame_blending",
  "lut",
];

export function isTaskName(value: unknown): value is TaskName {
  return typeof value === "string" && (TASKS as readonly string[]).includes(value);
}

export function hiddenParts(value: unknown): ReadonlySet<HideablePart> {
  const parts = new Set<HideablePart>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if ((HIDEABLE_PARTS as readonly unknown[]).includes(item)) parts.add(item as HideablePart);
    }
  }
  // a settings file edited by hand can hide every task; Compress comes back so Export works
  if (TASKS.every((task) => parts.has(task))) parts.delete("compression");
  return parts;
}

export function visibleTasks(hidden: ReadonlySet<HideablePart>): TaskName[] {
  return TASKS.filter((task) => !hidden.has(task));
}

// a shortcut's task wins, then the chosen start task, then the last one used; each only
// counts while it is visible
export function launchTask(options: {
  launch?: unknown;
  start?: unknown;
  last?: unknown;
  hidden: ReadonlySet<HideablePart>;
}): TaskName {
  const visible = visibleTasks(options.hidden);
  const usable = (value: unknown): value is TaskName => isTaskName(value) && visible.includes(value);
  if (usable(options.launch)) return options.launch;
  if (options.start !== "last" && usable(options.start)) return options.start;
  if (usable(options.last)) return options.last;
  return visible[0] ?? "compression";
}

export function taskIndex(task: TaskName): 0 | 1 | 2 {
  return task === "cut" ? 2 : task === "upscale" ? 1 : 0;
}

export function taskAt(index: number): TaskName {
  return index === 2 ? "cut" : index === 1 ? "upscale" : "compression";
}

// Inspector tabs are "edit", "audio" and "export"; Export is never hidden
export function visibleInspectorTab(tab: string, hidden: ReadonlySet<HideablePart>): string {
  if (tab === "edit" && hidden.has("panel_video")) return "export";
  if (tab === "audio" && hidden.has("panel_audio")) return "export";
  return tab;
}
