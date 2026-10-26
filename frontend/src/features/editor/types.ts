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
  readonly variable_frame_rate?: boolean | null;
  readonly average_fps?: number;
  readonly has_audio?: boolean;
  readonly audio_stream_count?: number;
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

// a stretch of one audio track that plays silent: in the source's own time on a source
// track, so it stays on the same sound through cuts and moves, and in track time on an added one
export interface MuteRange {
  start: number;
  end: number;
}

export interface AudioTrack {
  id: string;
  sourceDuration: number;
  clips: AudioClip[];
  muted?: boolean;
  muteRanges?: MuteRange[];
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

// one of the source's audio tracks after the first; it follows the source audio edits and
// is mixed into the export's one track, or written as its own with Separate tracks
export interface SourceAudioTrackState {
  muted: boolean;
  gainDb: number;
  muteRanges?: MuteRange[];
  waveformUrl: string;
  waveformToken: string;
  waveformLoading: boolean;
}

export interface AudioTimelineState {
  enabled: boolean;
  sourceMuted: boolean;
  sourceGainDb: number;
  sourceWaveformUrl: string;
  sourceWaveformToken: string;
  sourceWaveformLoading: boolean;
  // the source's second audio track onwards, filled in once the video is probed
  sourceExtraTracks?: SourceAudioTrackState[];
  sourceMuteRanges?: MuteRange[];
  tracks: AudioTrack[];
  // false writes each kept source track as its own; unset is the shared default, one track
  mixTracks?: boolean;
  evenLoudness?: boolean;
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
  // the row has shown a size estimate, so it keeps its place while new settings are planned
  _hadEstimate?: boolean;
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
