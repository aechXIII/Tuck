import type {
  AppSettings,
  ClipState as FoundationClipState,
  ProfileSummary,
  QueueItemState,
} from "../types/foundation.ts";

export type ClipState = FoundationClipState;

export interface QueueState {
  readonly items: ReadonlyMap<string, QueueItemState>;
}

export interface EditorState {
  readonly clips: ReadonlyMap<string, ClipState>;
  readonly selectedPath: string | null;
  readonly settings: AppSettings;
  readonly profiles: readonly ProfileSummary[];
  readonly encoders: readonly string[];
  readonly settingsDirty: boolean;
  readonly queue: ReadonlyMap<string, QueueItemState>;
}

export type EditorCommand =
  | { readonly type: "replace-clips"; readonly clips: readonly ClipState[] }
  | { readonly type: "select-clip"; readonly path: string | null }
  | { readonly type: "replace-settings"; readonly settings: AppSettings }
  | { readonly type: "replace-profiles"; readonly profiles: readonly ProfileSummary[] }
  | { readonly type: "replace-encoders"; readonly encoders: readonly string[] }
  | { readonly type: "set-settings-dirty"; readonly dirty: boolean }
  | { readonly type: "replace-queue"; readonly items: readonly QueueItemState[] };

export interface EditorStore {
  getSnapshot(): EditorState;
  dispatch(command: EditorCommand): void;
  subscribe(listener: (state: EditorState) => void): () => void;
}

const INITIAL_STATE: EditorState = {
  clips: new Map(),
  selectedPath: null,
  settings: {},
  profiles: [],
  encoders: [],
  settingsDirty: false,
  queue: new Map(),
};

function copyClips(clips: readonly ClipState[]): ReadonlyMap<string, ClipState> {
  const next = new Map<string, ClipState>();
  for (const clip of clips) {
    if (!clip.path) throw new Error("A clip must have a path.");
    if (next.has(clip.path)) throw new Error(`Duplicate clip path: ${clip.path}`);
    next.set(clip.path, clip);
  }
  return next;
}

function copyQueue(items: readonly QueueItemState[]): ReadonlyMap<string, QueueItemState> {
  const next = new Map<string, QueueItemState>();
  for (const item of items) {
    if (!item.id) throw new Error("A queue item must have an id.");
    if (next.has(item.id)) throw new Error(`Duplicate queue item: ${item.id}`);
    next.set(item.id, item);
  }
  return next;
}

export function createEditorStore(initial: Partial<EditorState> = {}): EditorStore {
  let state: EditorState = {
    ...INITIAL_STATE,
    ...initial,
    clips: new Map(initial.clips ?? INITIAL_STATE.clips),
    queue: new Map(initial.queue ?? INITIAL_STATE.queue),
    profiles: [...(initial.profiles ?? INITIAL_STATE.profiles)],
    encoders: [...(initial.encoders ?? INITIAL_STATE.encoders)],
  };
  const listeners = new Set<(current: EditorState) => void>();

  const notify = (): void => {
    for (const listener of listeners) listener(state);
  };

  return {
    getSnapshot: (): EditorState => state,
    dispatch: (command: EditorCommand): void => {
      switch (command.type) {
        case "replace-clips": {
          const clips = copyClips(command.clips);
          state = {
            ...state,
            clips,
            selectedPath: state.selectedPath && clips.has(state.selectedPath) ? state.selectedPath : null,
          };
          break;
        }
        case "select-clip":
          if (command.path !== null && !state.clips.has(command.path)) {
            throw new Error(`Cannot select unknown clip: ${command.path}`);
          }
          state = { ...state, selectedPath: command.path };
          break;
        case "replace-settings":
          state = { ...state, settings: { ...command.settings } };
          break;
        case "replace-profiles":
          state = { ...state, profiles: [...command.profiles] };
          break;
        case "replace-encoders":
          state = { ...state, encoders: [...command.encoders] };
          break;
        case "set-settings-dirty":
          state = { ...state, settingsDirty: command.dirty };
          break;
        case "replace-queue":
          state = { ...state, queue: copyQueue(command.items) };
          break;
      }
      notify();
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
