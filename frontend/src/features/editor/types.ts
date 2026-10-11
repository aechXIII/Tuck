import type { CropRect, Segment } from "../../types/foundation.ts";
import type { CutClipState } from "../export/cut-state.ts";
import type { QueueItemState } from "../queue/queue-view.ts";

export type { CropRect, Segment };

export interface ProbeData {
  readonly duration?: number;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly has_audio?: boolean;
  readonly format?: string;
  readonly video_codec?: string;
  readonly audio_codec?: string;
  readonly [key: string]: unknown;
}

export interface AudioClip {
  id: string;
  timelineStart: number;
  timelineDuration: number;
  sourceIn: number;
  sourceOut: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
  muted?: boolean;
  gainDb?: number;
  [key: string]: unknown;
}

export interface AudioTrack {
  id: string;
  sourceDuration: number;
  clips: AudioClip[];
  muted?: boolean;
  name?: string;
  path?: string;
  color?: string;
  sourceWaveformUrl?: string;
  sourceWaveformToken?: string;
  gainDb?: number;
  mediaUrl?: string;
  mediaToken?: string;
  waveformUrl?: string;
  waveformToken?: string;
  codec?: string;
  [key: string]: unknown;
}

export interface AudioTimelineState {
  enabled: boolean;
  sourceMuted: boolean;
  sourceGainDb: number;
  sourceWaveformUrl: string;
  sourceWaveformToken: string;
  sourceWaveformLoading: boolean;
  tracks: AudioTrack[];
}

export interface ClipBadge {
  readonly label: string;
  readonly icon: string;
  readonly className: string;
}

export interface EditorClip {
  path: string;
  name: string;
  probed: boolean;
  probing: boolean;
  probeData: ProbeData | null;
  planData: Record<string, unknown> | null;
  cutState?: CutClipState;
  mediaToken: string | null;
  error: string;
  segments: Segment[] | null;
  activeSegment: number;
  crop: CropRect | null;
  cropAspect: string;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  sizingMode: string;
  transformOverride: boolean;
  transformIntentTouched: boolean;
  audioTimeline: AudioTimelineState | null;
  _statusText?: string;
  // the backend queue's state for this video, or "" when it has no queue item
  _queueState?: QueueItemState | "";
  _queueItemId?: string;
  _resultPath?: string;
  _progress?: number;
  _progressIndeterminate?: boolean;
  _fileSize?: number;
  _resultSize?: number;
  // the size the finished export aimed for, in bytes, and whether it came in under it
  _resultTarget?: number;
  _resultFits?: boolean;
  // what the finished export still has to say, e.g. the encoder it fell back to
  _resultNote?: string;
  _resultNoteDetail?: string;
  _queueError?: string;
  _previewRequestId?: number;
  // the Library picture: undefined until asked for, "" when there is none
  _thumbnail?: string;
  trimStart?: number | null;
  trimEnd?: number | null;
}

export function createEditorClip(path: string): EditorClip {
  const name = path.split(/[\\/]/).pop() || path;
  return {
    path,
    name,
    probed: false,
    probing: false,
    probeData: null,
    planData: null,
    mediaToken: null,
    error: "",
    segments: null,
    activeSegment: 0,
    crop: null,
    cropAspect: "off",
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    sizingMode: "fit",
    transformOverride: false,
    transformIntentTouched: false,
    audioTimeline: null,
  };
}
