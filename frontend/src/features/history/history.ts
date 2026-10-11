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
  // names the next step on each button, e.g. "Undo split"; null when there is none
  labelButtons?(undo: string | null, redo: string | null): void;
}

export interface HistoryApi {
  begin: (path: string | null, label?: string) => void;
  commit: () => void;
  cancel: () => void;
  // puts the video back the way it was when the step began, and drops the step
  revert: () => void;
  action: <T>(path: string | null, fn: () => T, label?: string) => T;
  undo: () => void;
  redo: () => void;
  updateButtons: () => void;
  forgetClip: (path: string) => void;
  // a removed video takes its steps along, so bringing it back brings them back too
  detachClip: (path: string) => DetachedHistory;
  restoreClip: (detached: DetachedHistory) => void;
  hasEdits: (path: string) => boolean;
  // goes up with every edit, undo and redo of the video, so a later change can be noticed
  editCount: (path: string) => number;
}

/** One video's undo and redo steps, kept aside while the video is out of the Library. */
export interface DetachedHistory {
  readonly path: string;
  readonly undo: readonly HistoryEntry[];
  readonly redo: readonly HistoryEntry[];
}

export interface HistoryRecorder {
  action: <T>(path: string | null, fn: () => T, label?: string) => T;
}

/**
 * An edit command that is one undo step for the selected video. Commands that call other
 * recorded commands still make a single step. The label names the step on the Undo button.
 */
export function recordedCommand<A extends unknown[], R>(
  history: HistoryRecorder | null | undefined,
  selectedPath: () => string | null,
  run: (...args: A) => R,
  label?: string,
): (...args: A) => R {
  return (...args: A): R =>
    history ? history.action(selectedPath(), () => run(...args), label) : run(...args);
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

export interface HistoryEntry {
  path: string;
  // lower case, read after "Undo" or "Redo"
  label: string;
  before: ClipSnapshot;
  after: ClipSnapshot;
  // order across videos, so restored steps go back where they were
  seq: number;
}

interface PendingEntry {
  path: string;
  label: string;
  before: ClipSnapshot;
}

const DEFAULT_LABEL = "edit";

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
  let actionDepth = 0;
  let seq = 0;
  const editCounts = new Map<string, number>();

  function countEdit(path: string): void {
    editCounts.set(path, (editCounts.get(path) ?? 0) + 1);
  }

  // each video has its own steps, so Undo never changes a video that isn't on screen
  function lastIndexFor(stack: readonly HistoryEntry[], path: string | null): number {
    if (!path) return -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]?.path === path) return index;
    }
    return -1;
  }

  function updateButtons(): void {
    const path = host.selectedPath();
    const undoEntry = undoStack[lastIndexFor(undoStack, path)];
    const redoEntry = redoStack[lastIndexFor(redoStack, path)];
    const undoBtn = host.undoButton();
    const redoBtn = host.redoButton();
    if (undoBtn) undoBtn.disabled = !undoEntry;
    if (redoBtn) redoBtn.disabled = !redoEntry;
    host.labelButtons?.(undoEntry?.label ?? null, redoEntry?.label ?? null);
  }

  function begin(path: string | null, label: string = DEFAULT_LABEL): void {
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
    pending = { path, label, before };
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
      label: pending.label,
      before: pending.before,
      after,
      seq: (seq += 1),
    });
    if (undoStack.length > MAX_ENTRIES) undoStack.shift();
    // a new edit replaces only this video's redo steps
    const editedPath = pending.path;
    redoStack = redoStack.filter((entry) => entry.path !== editedPath);
    countEdit(pending.path);
    pending = null;
    updateButtons();
  }

  function cancel(): void {
    pending = null;
  }

  function revert(): void {
    if (!pending) return;
    const { path, before } = pending;
    pending = null;
    const clip = host.getClip(path);
    if (!clip) return;
    apply(clip, before);
    host.refreshUiForClip(path);
  }

  function action<T>(path: string | null, fn: () => T, label?: string): T {
    // an action inside another belongs to the outer step
    if (actionDepth > 0) return fn();
    actionDepth += 1;
    begin(path, label);
    try {
      const result = fn();
      commit();
      return result;
    } catch (error) {
      cancel();
      throw error;
    } finally {
      actionDepth -= 1;
    }
  }

  function undo(): void {
    const index = lastIndexFor(undoStack, host.selectedPath());
    if (index < 0) return;
    const [entry] = undoStack.splice(index, 1);
    if (!entry) return;
    const clip = host.getClip(entry.path);
    if (clip) {
      apply(clip, entry.before);
      host.refreshUiForClip(entry.path);
    }
    countEdit(entry.path);
    redoStack.push(entry);
    updateButtons();
  }

  function redo(): void {
    const index = lastIndexFor(redoStack, host.selectedPath());
    if (index < 0) return;
    const [entry] = redoStack.splice(index, 1);
    if (!entry) return;
    const clip = host.getClip(entry.path);
    if (clip) {
      apply(clip, entry.after);
      host.refreshUiForClip(entry.path);
    }
    countEdit(entry.path);
    undoStack.push(entry);
    updateButtons();
  }

  function forgetClip(path: string): void {
    undoStack = undoStack.filter((entry) => entry.path !== path);
    redoStack = redoStack.filter((entry) => entry.path !== path);
    updateButtons();
  }

  function detachClip(path: string): DetachedHistory {
    const detached = {
      path,
      undo: undoStack.filter((entry) => entry.path === path),
      redo: redoStack.filter((entry) => entry.path === path),
    };
    if (pending?.path === path) pending = null;
    forgetClip(path);
    return detached;
  }

  function restoreClip(detached: DetachedHistory): void {
    undoStack = [...undoStack, ...detached.undo].sort((a, b) => a.seq - b.seq).slice(-MAX_ENTRIES);
    // steps are per video, so edits to other videos while it was gone don't touch its redo
    redoStack = [...redoStack, ...detached.redo].sort((a, b) => b.seq - a.seq);
    updateButtons();
  }

  function hasEdits(path: string): boolean {
    return undoStack.some((entry) => entry.path === path);
  }

  function editCount(path: string): number {
    return editCounts.get(path) ?? 0;
  }

  return {
    begin,
    commit,
    cancel,
    revert,
    action,
    undo,
    redo,
    updateButtons,
    forgetClip,
    detachClip,
    restoreClip,
    hasEdits,
    editCount,
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
