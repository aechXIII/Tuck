// Routes a dropped file to the Library or the audio panel, and leaves out what is neither, the
// way pasting does. Mirrors VIDEO_EXTENSIONS and AUDIO_EXTENSIONS in tuck/bridge_validation.py;
// Python still validates each path, this only decides which importer to call.

const VIDEO_DROP_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".wmv",
  ".asf",
  ".flv",
  ".f4v",
  ".ts",
  ".m2ts",
  ".mts",
  ".3gp",
  ".3g2",
  ".ogv",
  ".mpg",
  ".mpeg",
  ".m2v",
  ".vob",
  ".mxf",
]);

const AUDIO_DROP_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".wma",
  ".aif",
  ".aiff",
]);

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function extension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function isAudioPath(path: string): boolean {
  return AUDIO_DROP_EXTENSIONS.has(extension(path));
}

export interface RoutedDropPaths {
  readonly videoPaths: string[];
  readonly audioPaths: string[];
  /** files that are neither, such as a text file or a folder */
  readonly skippedPaths: string[];
}

export function routeDroppedPaths(paths: readonly string[]): RoutedDropPaths {
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  const skippedPaths: string[] = [];
  for (const path of paths) {
    if (isAudioPath(path)) audioPaths.push(path);
    else if (VIDEO_DROP_EXTENSIONS.has(extension(path))) videoPaths.push(path);
    else skippedPaths.push(path);
  }
  return { videoPaths, audioPaths, skippedPaths };
}

/** What to say about files a drop left out; null when it took everything. */
export function skippedDropMessage(skippedPaths: readonly string[]): string | null {
  if (!skippedPaths.length) return null;
  if (skippedPaths.length > 1) return `Skipped ${skippedPaths.length} files that aren’t videos or audio.`;
  const path = skippedPaths[0] ?? "";
  return `Skipped ${fileName(path) || path}, which isn’t a video or audio file.`;
}
