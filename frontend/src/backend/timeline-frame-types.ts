export type TimelineFrameMode = "center" | "whole";

export interface TimelineFramesPayload {
  readonly url: string;
  readonly token: string;
  readonly start: number;
  readonly step: number;
  readonly count: number;
  readonly tile_width: number;
  readonly tile_height: number;
  readonly columns: number;
}

export function isTimelineFramesPayload(value: unknown): value is TimelineFramesPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("url" in value) || typeof value.url !== "string") return false;
  try {
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password) return false;
  } catch { return false; }
  return "token" in value && typeof value.token === "string" && value.token.length > 0
    && "start" in value && typeof value.start === "number" && Number.isFinite(value.start) && value.start >= 0
    && "step" in value && typeof value.step === "number" && Number.isFinite(value.step) && value.step > 0
    && "count" in value && typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 1 && value.count <= 32
    && "columns" in value && value.columns === value.count
    && "tile_width" in value && value.tile_width === 150
    && "tile_height" in value && value.tile_height === 84;
}
