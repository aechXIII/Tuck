import type { CropRect, Segment } from "../../types/foundation.ts";

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
  _queueState?: string;
  _queueItemId?: string;
  _resultPath?: string;
  _progress?: number;
  _fileSize?: number;
  _resultSize?: number;
  _queueError?: string;
  _previewRequestId?: number;
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
