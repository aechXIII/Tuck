import { cropForAspect, isFullCrop, type CropRect } from "../transform/crop-geometry.ts";
import {
  MIN_DURATION,
  isFullSource,
  normalizeSegments,
  segmentsForClip,
  type SegmentRange,
} from "../timeline/segments.ts";
import type { AudioTimelineState, EditorClip, SourceAudioTrackState } from "./types.ts";

/**
 * The edits one video can hand to others: its segments, crop, rotation, flips, sizing, and the
 * source audio's levels and mutes. Added audio tracks stay with their video, since they are files
 * placed on that video's timeline.
 */
export interface CopiedEdits {
  readonly name: string;
  readonly path: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  // null keeps the whole video
  readonly segments: readonly SegmentRange[] | null;
  readonly crop: CropRect | null;
  readonly cropAspect: string;
  readonly rotation: number;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  readonly sizingMode: string;
  readonly audio: CopiedAudio;
}

export interface CopiedAudio {
  readonly enabled: boolean;
  readonly sourceMuted: boolean;
  readonly sourceGainDb: number;
  // the source's second audio track onwards, in order
  readonly extraTracks: readonly { readonly muted: boolean; readonly gainDb: number }[];
}

export interface PasteResult {
  // some segments ran past the end of a shorter video and were cut at its end or left out
  readonly shortened: boolean;
  // none of the segments reach into the video, so its timeline was left as it was
  readonly segmentsSkipped: boolean;
}

interface ClipSize {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

// a video's length and picture size, once it has been read
export function clipSize(clip: EditorClip | null | undefined): ClipSize | null {
  const data = clip?.probed && !clip.error ? clip.probeData : null;
  const duration = Number(data?.duration);
  const width = Number(data?.width);
  const height = Number(data?.height);
  if (!(duration > 0) || !(width > 0) || !(height > 0)) return null;
  return { duration, width, height };
}

function copySegment(segment: SegmentRange): SegmentRange {
  const copy: SegmentRange = { start: segment.start, end: segment.end };
  if (segment.sourceStart != null) copy.sourceStart = segment.sourceStart;
  if (segment.muted) copy.muted = true;
  return copy;
}

function copyAudio(state: AudioTimelineState | null): CopiedAudio {
  return {
    enabled: state ? state.enabled !== false : true,
    sourceMuted: !!state?.sourceMuted,
    sourceGainDb: Number.isFinite(state?.sourceGainDb) ? Number(state?.sourceGainDb) : 0,
    extraTracks: (state?.sourceExtraTracks ?? []).map((track) => ({
      muted: !!track.muted,
      gainDb: Number.isFinite(track.gainDb) ? track.gainDb : 0,
    })),
  };
}

/** What Copy edits keeps from a video, or null while the video hasn't been read. */
export function copyEdits(clip: EditorClip): CopiedEdits | null {
  const size = clipSize(clip);
  if (!size) return null;
  let segments: SegmentRange[] | null;
  try {
    const current = segmentsForClip(clip, size.duration);
    segments = isFullSource(current, size.duration) ? null : current.map(copySegment);
  } catch {
    segments = null;
  }
  return {
    name: clip.name,
    path: clip.path,
    ...size,
    segments,
    crop: clip.crop ? { ...clip.crop } : null,
    cropAspect: clip.cropAspect || "off",
    rotation: clip.rotation || 0,
    flipHorizontal: !!clip.flipHorizontal,
    flipVertical: !!clip.flipVertical,
    sizingMode: clip.sizingMode || "fit",
    audio: copyAudio(clip.audioTimeline),
  };
}

/**
 * Segments placed by their times in the source, cut to a video of another length. A segment that
 * runs past the end stops there; one that starts after the end, or is left shorter than the
 * shortest segment, is dropped. Returns null when nothing is left.
 */
export function segmentsForLength(
  segments: readonly SegmentRange[],
  duration: number,
): { segments: SegmentRange[]; shortened: boolean } | null {
  if (!(duration > 0)) return null;
  const kept: SegmentRange[] = [];
  let shortened = false;
  for (const segment of segments) {
    const source = segment.sourceStart ?? segment.start;
    const length = segment.end - segment.start;
    const fits = Math.min(length, duration - source, duration - segment.start);
    if (fits < length - 1e-6) shortened = true;
    if (fits < MIN_DURATION) continue;
    const next: SegmentRange = { start: segment.start, end: segment.start + fits };
    if (segment.sourceStart != null) next.sourceStart = segment.sourceStart;
    if (segment.muted) next.muted = true;
    kept.push(next);
  }
  if (!kept.length) return null;
  try {
    return { segments: normalizeSegments(kept, duration), shortened };
  } catch {
    return null;
  }
}

/**
 * A crop moved to a video of another size: the same share of the picture, kept to even sizes and to
 * the chosen aspect ratio. Null means the whole picture.
 */
export function cropForSize(
  crop: CropRect | null,
  aspect: string,
  from: { width: number; height: number },
  to: { width: number; height: number },
  rotation: number,
): CropRect | null {
  if (!crop || aspect === "off") return null;
  if (from.width === to.width && from.height === to.height) {
    return isFullCrop(crop, to.width, to.height) ? null : { ...crop };
  }
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  const even = (value: number, maximum: number): number =>
    Math.max(2, Math.min(Math.floor(maximum / 2) * 2, Math.round(value / 2) * 2));
  const width = even(crop.width * scaleX, to.width);
  const height = even(crop.height * scaleY, to.height);
  let scaled: CropRect = {
    x: Math.max(0, Math.min(to.width - width, Math.round(crop.x * scaleX))),
    y: Math.max(0, Math.min(to.height - height, Math.round(crop.y * scaleY))),
    width,
    height,
  };
  if (aspect !== "free") scaled = cropForAspect(scaled, aspect, to.width, to.height, rotation);
  return isFullCrop(scaled, to.width, to.height) ? null : scaled;
}

function blankExtraTrack(): SourceAudioTrackState {
  return { muted: false, gainDb: 0, waveformUrl: "", waveformToken: "", waveformLoading: false };
}

function pasteAudio(audio: CopiedAudio, target: EditorClip): void {
  const state: AudioTimelineState = target.audioTimeline ?? {
    enabled: true,
    sourceMuted: false,
    sourceGainDb: 0,
    sourceWaveformUrl: "",
    sourceWaveformToken: "",
    sourceWaveformLoading: false,
    tracks: [],
  };
  state.enabled = audio.enabled;
  state.sourceMuted = audio.sourceMuted;
  state.sourceGainDb = audio.sourceGainDb;
  // only tracks the video has; its own extra tracks beyond the copied ones go back to full level
  const count = Number(target.probeData?.audio_stream_count);
  const extraCount = target.probeData?.has_audio && Number.isInteger(count) && count > 1 ? count - 1 : 0;
  const extras = (state.sourceExtraTracks ?? []).slice(0, extraCount);
  while (extras.length < extraCount) extras.push(blankExtraTrack());
  extras.forEach((track, index) => {
    const copied = audio.extraTracks[index];
    track.muted = copied?.muted ?? false;
    track.gainDb = copied?.gainDb ?? 0;
  });
  state.sourceExtraTracks = extras;
  target.audioTimeline = state;
}

/**
 * Puts copied edits on a video. Segments are kept at the same times in the source, so on a shorter
 * video they are cut at its end; when none reach into it, its own segments stay. Returns null, and
 * changes nothing, while the video hasn't been read.
 */
export function pasteEdits(edits: CopiedEdits, target: EditorClip): PasteResult | null {
  const size = clipSize(target);
  if (!size) return null;
  let shortened = false;
  let segmentsSkipped = false;
  if (edits.segments === null) {
    target.segments = null;
    target.activeSegment = 0;
    target.trimStart = null;
    target.trimEnd = null;
  } else {
    const fitted = segmentsForLength(edits.segments, size.duration);
    if (fitted) {
      target.segments = fitted.segments;
      target.activeSegment = 0;
      target.trimStart = null;
      target.trimEnd = null;
      shortened = fitted.shortened;
    } else {
      segmentsSkipped = true;
    }
  }
  target.cropAspect = edits.cropAspect;
  target.crop = cropForSize(edits.crop, edits.cropAspect, edits, size, edits.rotation);
  target.rotation = edits.rotation;
  target.flipHorizontal = edits.flipHorizontal;
  target.flipVertical = edits.flipVertical;
  target.sizingMode = edits.sizingMode;
  target.transformOverride = true;
  target.transformIntentTouched = true;
  pasteAudio(edits.audio, target);
  target.planData = null;
  return { shortened, segmentsSkipped };
}
