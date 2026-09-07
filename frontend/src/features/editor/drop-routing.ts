// Routes a dropped file to the Library or the audio panel. Mirrors
// AUDIO_EXTENSIONS in tuck/bridge_validation.py; Python still validates each
// path, this only decides which importer to call.

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

export function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && AUDIO_DROP_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export interface RoutedDropPaths {
  readonly videoPaths: string[];
  readonly audioPaths: string[];
}

export function routeDroppedPaths(paths: readonly string[]): RoutedDropPaths {
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  for (const path of paths) {
    (isAudioPath(path) ? audioPaths : videoPaths).push(path);
  }
  return { videoPaths, audioPaths };
}
