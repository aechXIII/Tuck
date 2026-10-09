export function settingsSnapshot(value: unknown): string { return JSON.stringify(value ?? {}); }
export function settingsAreDirty(openingSnapshot: string, currentValue: unknown): boolean { return Boolean(openingSnapshot) && settingsSnapshot(currentValue) !== openingSnapshot; }
export { settingsSnapshot as snapshot, settingsAreDirty as isDirty };

export type MediaTool = "FFmpeg" | "FFprobe";

/** The media tools the backend reported as unusable; a setting that was never sent counts as fine. */
export function missingMediaTools(settings: Readonly<Record<string, unknown>>): MediaTool[] {
  const missing: MediaTool[] = [];
  if (settings.ffmpeg_available === false) missing.push("FFmpeg");
  if (settings.ffprobe_available === false) missing.push("FFprobe");
  return missing;
}

/** What the editor says once when tools are missing, naming what stops working. */
export function mediaToolsMessage(missing: readonly MediaTool[]): string {
  const ffmpeg = missing.includes("FFmpeg");
  const ffprobe = missing.includes("FFprobe");
  if (ffmpeg && ffprobe) return "Tuck can’t find FFmpeg or FFprobe, so videos can’t be read or exported. Choose them in Settings.";
  if (ffprobe) return "Tuck can’t find FFprobe, so videos can’t be read. Choose it in Settings.";
  if (ffmpeg) return "Tuck can’t find FFmpeg, so videos can’t be exported. Choose it in Settings.";
  return "";
}
