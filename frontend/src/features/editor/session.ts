import { byId, formatBytes, formatTime } from "./format.ts";
import { createEditorClip, type EditorClip } from "./types.ts";

export interface EditorSession {
  clips: Record<string, EditorClip>;
  clipOrder: string[];
  selPath: string | null;
  appSettings: Record<string, unknown>;
  allProfiles: unknown[];
  availEncoders: string[];
  previewRequestId: number;
  wf: number;
  muted: boolean;
  volBefore: number;
  settingsDirty: boolean;
}

export function createEditorSession(
  initial: Partial<EditorSession> = {},
): EditorSession {
  return {
    clips: initial.clips ?? {},
    clipOrder: initial.clipOrder ? [...initial.clipOrder] : [],
    selPath: initial.selPath ?? null,
    appSettings: initial.appSettings ? { ...initial.appSettings } : {},
    allProfiles: initial.allProfiles ? [...initial.allProfiles] : [],
    availEncoders: initial.availEncoders ? [...initial.availEncoders] : [],
    previewRequestId: initial.previewRequestId ?? 0,
    wf: initial.wf ?? 0,
    muted: initial.muted ?? false,
    volBefore: initial.volBefore ?? 80,
    settingsDirty: initial.settingsDirty ?? false,
  };
}

export { byId, formatBytes, formatTime, createEditorClip, type EditorClip };
