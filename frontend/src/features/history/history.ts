import type {
  AudioTimelineState,
  EditorClip,
} from "../editor/types.ts";
import type { CropRect, Segment } from "../../types/foundation.ts";

export interface HistoryHost {
  getClip(path: string): EditorClip | null | undefined;
  selectedPath(): string | null;
  refreshUiForClip(path: string): void;
  undoButton(): { disabled: boolean } | null;
  redoButton(): { disabled: boolean } | null;
}

export interface HistoryApi {
  begin: (path: string | null) => void;
  commit: () => void;
  cancel: () => void;
  action: <T>(path: string | null, fn: () => T) => T;
  wrap: (owner: object, name: string) => void;
  undo: () => void;
  redo: () => void;
  updateButtons: () => void;
  forgetClip: (path: string) => void;
}

interface ClipSnapshot {
  crop: CropRect | null;
  cropAspect: string;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  sizingMode: string;
  transformOverride: boolean;
  transformIntentTouched: boolean;
  segments: Segment[] | null;
  activeSegment: number;
  audioTimeline: AudioTimelineState | null;
}

interface HistoryEntry {
  path: string;
  before: ClipSnapshot;
  after: ClipSnapshot;
}

interface PendingEntry {
  path: string;
  before: ClipSnapshot;
}

const MAX_ENTRIES = 100;

function cloneSegments(
  segments: Segment[] | null | undefined,
): Segment[] | null | undefined {
  return Array.isArray(segments)
    ? segments.map((s) => Object.assign({}, s))
    : segments;
}

function cloneAudioTimeline(
  audioTimeline: AudioTimelineState | null,
): AudioTimelineState | null {
  return audioTimeline
    ? (JSON.parse(JSON.stringify(audioTimeline)) as AudioTimelineState)
    : null;
}

function snapshot(clip: EditorClip | null | undefined): ClipSnapshot | null {
  if (!clip) return null;
  return {
    crop: clip.crop ? Object.assign({}, clip.crop) : null,
    cropAspect: clip.cropAspect,
    rotation: clip.rotation,
    flipHorizontal: clip.flipHorizontal,
    flipVertical: clip.flipVertical,
    sizingMode: clip.sizingMode,
    transformOverride: clip.transformOverride,
    transformIntentTouched: clip.transformIntentTouched,
    segments: (cloneSegments(clip.segments) as Segment[] | null) ?? null,
    activeSegment: clip.activeSegment,
    audioTimeline: cloneAudioTimeline(clip.audioTimeline),
  };
}

function apply(clip: EditorClip, snap: ClipSnapshot): void {
  clip.crop = snap.crop ? Object.assign({}, snap.crop) : null;
  clip.cropAspect = snap.cropAspect;
  clip.rotation = snap.rotation;
  clip.flipHorizontal = snap.flipHorizontal;
  clip.flipVertical = snap.flipVertical;
  clip.sizingMode = snap.sizingMode;
  clip.transformOverride = snap.transformOverride;
  clip.transformIntentTouched = snap.transformIntentTouched;
  clip.segments = (cloneSegments(snap.segments) as Segment[] | null) ?? null;
  clip.activeSegment = snap.activeSegment;
  clip.audioTimeline = cloneAudioTimeline(snap.audioTimeline);
  clip.planData = null;
}

export function createHistory(host: HistoryHost): HistoryApi {
  let undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  let pending: PendingEntry | null = null;

  function updateButtons(): void {
    const undoBtn = host.undoButton();
    const redoBtn = host.redoButton();
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function begin(path: string | null): void {
    if (!path) {
      pending = null;
      return;
    }
    const clip = host.getClip(path);
    if (!clip) {
      pending = null;
      return;
    }
    const before = snapshot(clip);
    if (!before) {
      pending = null;
      return;
    }
    pending = { path, before };
  }

  function commit(): void {
    if (!pending) return;
    const clip = host.getClip(pending.path);
    if (!clip) {
      pending = null;
      return;
    }
    const after = snapshot(clip);
    if (!after || JSON.stringify(after) === JSON.stringify(pending.before)) {
      pending = null;
      return;
    }
    undoStack.push({
      path: pending.path,
      before: pending.before,
      after,
    });
    if (undoStack.length > MAX_ENTRIES) undoStack.shift();
    redoStack.length = 0;
    pending = null;
    updateButtons();
  }

  function cancel(): void {
    pending = null;
  }

  function action<T>(path: string | null, fn: () => T): T {
    begin(path);
    const result = fn();
    commit();
    return result;
  }

  function wrap(owner: object, name: string): void {
    const record = owner as Record<string, unknown>;
    const original = record[name];
    if (typeof original !== "function") return;
    const fn = original as (...args: unknown[]) => unknown;
    record[name] = function (this: unknown, ...args: unknown[]) {
      return action(host.selectedPath(), () => fn.apply(this, args));
    };
  }

  function undo(): void {
    const entry = undoStack.pop();
    if (!entry) return;
    const clip = host.getClip(entry.path);
    if (clip) {
      apply(clip, entry.before);
      host.refreshUiForClip(entry.path);
    }
    redoStack.push(entry);
    updateButtons();
  }

  function redo(): void {
    const entry = redoStack.pop();
    if (!entry) return;
    const clip = host.getClip(entry.path);
    if (clip) {
      apply(clip, entry.after);
      host.refreshUiForClip(entry.path);
    }
    undoStack.push(entry);
    updateButtons();
  }

  function forgetClip(path: string): void {
    undoStack = undoStack.filter((entry) => entry.path !== path);
    redoStack = redoStack.filter((entry) => entry.path !== path);
    updateButtons();
  }

  return {
    begin,
    commit,
    cancel,
    action,
    wrap,
    undo,
    redo,
    updateButtons,
    forgetClip,
  };
}

export function installHistory(
  host: HistoryHost,
  shortcuts?: {
    registerAction: (id: string, action: () => void) => void;
  },
): HistoryApi {
  const api = createHistory(host);
  if (shortcuts) {
    shortcuts.registerAction("edit.undo", api.undo);
    shortcuts.registerAction("edit.redo", api.redo);
  }
  return api;
}
