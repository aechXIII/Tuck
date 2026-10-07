export type SettingsPage =
  | "general"
  | "appearance"
  | "tools"
  | "keyboard"
  | "files"
  | "queue"
  | "profiles"
  | "explorer"
  | "media"
  | "about";

export interface SettingsPageInfo {
  readonly id: SettingsPage;
  readonly title: string;
  readonly group: "Workspace" | "Export" | "System";
}

export const SETTINGS_PAGES: readonly SettingsPageInfo[] = [
  { id: "general", title: "General", group: "Workspace" },
  { id: "appearance", title: "Appearance", group: "Workspace" },
  { id: "tools", title: "Tasks & tools", group: "Workspace" },
  { id: "keyboard", title: "Keyboard", group: "Workspace" },
  { id: "files", title: "Files & names", group: "Export" },
  { id: "queue", title: "Queue", group: "Export" },
  { id: "profiles", title: "Profiles", group: "Export" },
  { id: "explorer", title: "File Explorer", group: "System" },
  { id: "media", title: "Media tools", group: "System" },
  { id: "about", title: "About", group: "System" },
];

// older page names still open the page that holds those settings
const PAGE_ALIASES: Readonly<Record<string, SettingsPage>> = {
  output: "files",
  system: "about",
};

export function settingsPage(value: unknown): SettingsPage {
  if (typeof value !== "string") return "general";
  const alias = PAGE_ALIASES[value];
  if (alias) return alias;
  return SETTINGS_PAGES.some((page) => page.id === value) ? (value as SettingsPage) : "general";
}

export function pageTitle(page: SettingsPage): string {
  return SETTINGS_PAGES.find((info) => info.id === page)?.title ?? "Settings";
}

/** One setting that search can find; `id` matches the row's `data-setting`. */
export interface SettingsEntry {
  readonly id: string;
  readonly page: SettingsPage;
  readonly label: string;
  readonly keywords?: string;
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { id: "start-task", page: "general", label: "Start with", keywords: "launch open task startup" },
  { id: "inspector-start", page: "general", label: "Inspector opens on", keywords: "tab panel launch startup" },
  { id: "reopen", page: "general", label: "Reopen last videos", keywords: "session library restore startup" },
  { id: "loop", page: "general", label: "Loop playback", keywords: "repeat play again player" },
  { id: "skip-length", page: "general", label: "Skip length", keywords: "seek jump seconds arrow shift player" },
  { id: "time-format", page: "general", label: "Time format", keywords: "timecode frames seconds timeline player clock" },
  { id: "accent", page: "appearance", label: "Accent color", keywords: "theme colour violet purple blue teal green amber rose" },
  { id: "interface-size", page: "appearance", label: "Interface size", keywords: "zoom scale compact large small big text" },
  { id: "timeline-style", page: "appearance", label: "Timeline", keywords: "clips colour color graphite violet waveform look" },
  { id: "animations", page: "appearance", label: "Animations", keywords: "motion reduce transitions effects" },
  { id: "task-compression", page: "tools", label: "Compress", keywords: "task show hide" },
  { id: "task-upscale", page: "tools", label: "Upscale", keywords: "task show hide" },
  { id: "task-cut", page: "tools", label: "Lossless cut", keywords: "task show hide trim" },
  { id: "panel-video", page: "tools", label: "Transform panel", keywords: "crop rotate flip resize show hide" },
  { id: "panel-audio", page: "tools", label: "Audio panel", keywords: "volume show hide" },
  { id: "audio-editing", page: "tools", label: "Audio editing", keywords: "tracks music show hide" },
  { id: "frame-blending", page: "tools", label: "Frame blending", keywords: "motion blur show hide" },
  { id: "lut", page: "tools", label: "Color LUT", keywords: "grading look cube colour show hide" },
  { id: "keyboard", page: "keyboard", label: "Keyboard shortcuts", keywords: "keys hotkeys bindings" },
  { id: "save-to", page: "files", label: "Save to", keywords: "output folder location directory subfolder export where" },
  { id: "keep-dates", page: "files", label: "Keep original file dates", keywords: "modified date time sort" },
  { id: "suffix-compression", page: "files", label: "Compress file names", keywords: "suffix naming size" },
  { id: "suffix-upscale", page: "files", label: "Upscale file names", keywords: "suffix naming width height" },
  { id: "suffix-cut", page: "files", label: "Lossless cut file names", keywords: "suffix naming" },
  { id: "name-taken", page: "files", label: "If the name is taken", keywords: "overwrite replace exists collision number duplicate" },
  { id: "show-folder", page: "queue", label: "Show the last export in its folder", keywords: "open explorer reveal finished done" },
  { id: "clear-finished", page: "queue", label: "Clear finished jobs", keywords: "completed automatically remove" },
  { id: "notify", page: "queue", label: "Notify me", keywords: "notification done finished alert" },
  { id: "keep-awake", page: "queue", label: "Keep the PC awake", keywords: "sleep power computer" },
  { id: "background", page: "queue", label: "Run exports in the background", keywords: "priority games performance slow" },
  { id: "profiles", page: "profiles", label: "Profiles", keywords: "presets discord manage pin favorite favourite hide picker" },
  { id: "new-profile", page: "profiles", label: "New profile", keywords: "create add preset" },
  { id: "import-profiles", page: "profiles", label: "Import profiles", keywords: "json file" },
  { id: "default-scaler", page: "profiles", label: "Scaler", keywords: "default upscale resize lanczos bicubic neighbor" },
  { id: "send-to", page: "explorer", label: "Send to", keywords: "right-click context menu shortcuts explorer" },
  { id: "profile-shortcuts", page: "explorer", label: "Profile shortcuts", keywords: "send to right-click" },
  { id: "ffmpeg", page: "media", label: "FFmpeg", keywords: "path tools location" },
  { id: "ffprobe", page: "media", label: "FFprobe", keywords: "path tools location" },
  { id: "encoders", page: "media", label: "Available encoders", keywords: "hardware gpu nvenc qsv amf rescan" },
  { id: "encoder-check", page: "media", label: "Encoder check", keywords: "cache startup days" },
  { id: "updates", page: "about", label: "Check for updates automatically", keywords: "update version new" },
  { id: "diagnostics", page: "about", label: "Diagnostic report", keywords: "support bug copy problem" },
  { id: "logs", page: "about", label: "Logs", keywords: "folder open support" },
  { id: "settings-folder", page: "about", label: "Settings folder", keywords: "config configuration open" },
  { id: "backup", page: "about", label: "Back up", keywords: "export import settings backup restore file" },
  { id: "reset", page: "about", label: "Reset settings", keywords: "defaults start over" },
];

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Settings whose label, keywords, or page match every word of the query, in page order.
 * `available` limits results to pages this platform shows.
 */
export function searchSettings(
  query: string,
  entries: readonly SettingsEntry[],
  available: (page: SettingsPage) => boolean = () => true,
): SettingsEntry[] {
  const words = terms(query);
  if (!words.length) return [];
  const order = (page: SettingsPage): number => SETTINGS_PAGES.findIndex((info) => info.id === page);
  return entries
    .filter((entry) => available(entry.page))
    .filter((entry) => {
      const text = `${entry.label} ${entry.keywords ?? ""} ${pageTitle(entry.page)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => order(a.entry.page) - order(b.entry.page) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Splits a label around the query's words so the matches can be marked without HTML. */
export function highlightParts(label: string, query: string): { text: string; match: boolean }[] {
  const words = terms(query);
  if (!words.length) return [{ text: label, match: false }];
  const lower = label.toLowerCase();
  const marked = new Array<boolean>(label.length).fill(false);
  for (const word of words) {
    let from = lower.indexOf(word);
    while (from >= 0) {
      for (let i = from; i < from + word.length; i += 1) marked[i] = true;
      from = lower.indexOf(word, from + word.length);
    }
  }
  const parts: { text: string; match: boolean }[] = [];
  for (let i = 0; i < label.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.match === marked[i]) last.text += label[i];
    else parts.push({ text: label[i]!, match: marked[i]! });
  }
  return parts;
}
