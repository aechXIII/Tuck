import type { JsonObject, PlanRequest } from "./types.ts";

/** Save as GIF's settings, as the backend reads them; sizes are in bytes. */
export interface GifSettingsPayload extends JsonObject {
  readonly width: number;
  readonly fps: number;
  readonly colors: number;
  readonly speed: number;
  readonly back_and_forth: boolean;
  /** how many times it plays; 0 is forever */
  readonly plays: number;
  /** 0 sets no limit */
  readonly size_limit: number;
  readonly dither: "soft" | "pattern" | "off";
  readonly palette: "whole" | "frame";
  readonly sharp_pixels: boolean;
  readonly drop_repeated_frames: boolean;
}

/** The timeline to save, as Compress would export it, and how to write it as a GIF. */
export interface GifRequest extends JsonObject {
  readonly plan: PlanRequest;
  readonly gif: GifSettingsPayload;
  /** echoed back, so the dialog keeps only the newest preview */
  readonly _request_id?: number;
}

/** The GIF the dialog shows, made with the settings it was asked for. */
export interface GifPreviewPayload extends JsonObject {
  readonly url: string;
  readonly size_bytes: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  /** how long the whole GIF plays */
  readonly seconds: number;
  /** a size limit lowered the frame rate or the width */
  readonly lowered: boolean;
  /** false when even the smallest setting stays over the size limit */
  readonly fits: boolean;
  /** the size comes from a few pieces of a longer timeline */
  readonly estimated: boolean;
  /** the width and frame rate a size limit starts lowering from */
  readonly start_width: number;
  readonly start_fps: number;
  /** the file name Save gives it */
  readonly name: string;
}

export interface GifPreviewCancellation extends JsonObject {
  readonly cancelled: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isGifPreviewPayload(value: unknown): value is GifPreviewPayload {
  return record(value)
    && typeof value.url === "string"
    && count(value.size_bytes) && count(value.width) && count(value.height)
    && count(value.fps) && count(value.frames) && count(value.seconds)
    && typeof value.lowered === "boolean" && typeof value.fits === "boolean"
    && typeof value.estimated === "boolean"
    && count(value.start_width) && count(value.start_fps) && typeof value.name === "string";
}

export function isGifPreviewCancellation(value: unknown): value is GifPreviewCancellation {
  return record(value) && typeof value.cancelled === "boolean";
}
