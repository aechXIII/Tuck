import type { DataPayload, JsonObject } from "./types.ts";

/** A stretch of one sound on the timeline, as Python compiles it from the export's rules. */
export interface PreviewMixPiece extends JsonObject {
  readonly start: number;
  readonly end: number;
  /** file second under `start` */
  readonly sourceIn: number;
  /** linear; above 1 is a boost, played as the export plays it */
  readonly gain: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  /** with loopSpan above 0, the file's [loopStart, loopStart + loopSpan) repeats */
  readonly loopStart: number;
  readonly loopSpan: number;
}

/** One sound to decode: the video's own stream `stream`, or an added file's first. */
export interface PreviewMixVoice extends JsonObject {
  readonly path: string;
  readonly stream: number;
  readonly pieces: readonly PreviewMixPiece[];
}

/** What the native player plays for the selected video's edit. */
export interface PreviewMix extends JsonObject {
  readonly duration: number;
  readonly voices: readonly PreviewMixVoice[];
}

export interface PreviewMixPayload extends DataPayload {
  readonly data: PreviewMix;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPiece(value: unknown): value is PreviewMixPiece {
  return object(value)
    && finite(value.start) && finite(value.end) && value.end > value.start
    && finite(value.sourceIn) && finite(value.gain) && value.gain >= 0
    && finite(value.fadeIn) && finite(value.fadeOut)
    && finite(value.loopStart) && finite(value.loopSpan);
}

function isVoice(value: unknown): value is PreviewMixVoice {
  return object(value)
    && typeof value.path === "string" && value.path.length > 0
    && Number.isSafeInteger(value.stream) && Number(value.stream) >= 0
    && Array.isArray(value.pieces) && value.pieces.every(isPiece);
}

export function isPreviewMix(value: unknown): value is PreviewMix {
  return object(value) && finite(value.duration) && value.duration > 0
    && Array.isArray(value.voices) && value.voices.every(isVoice);
}

export function isPreviewMixPayload(value: unknown): value is PreviewMixPayload {
  return object(value) && isPreviewMix(value.data);
}
