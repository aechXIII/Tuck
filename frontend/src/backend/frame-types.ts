export interface VideoTransformJSON {
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  crop_aspect: string;
  rotation: number;
  flip_horizontal: boolean;
  flip_vertical: boolean;
  sizing_mode: string;
}

export interface LutSettingsJSON {
  enabled: boolean;
  strength: number;
  path: string;
  name: string;
}

export interface FrameExportRequest {
  readonly source: string;
  readonly output: string;
  readonly time: number;
  readonly transform?: VideoTransformJSON;
  readonly lut?: LutSettingsJSON;
}

export interface FrameExportResult {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly time: number;
  readonly warnings: readonly string[];
}

export function isFrameExportResult(value: unknown): value is FrameExportResult {
  if (typeof value !== "object" || value === null) return false;
  return "path" in value && typeof value.path === "string" && value.path.length > 0
    && "width" in value && typeof value.width === "number" && Number.isInteger(value.width) && value.width > 0
    && "height" in value && typeof value.height === "number" && Number.isInteger(value.height) && value.height > 0
    && "time" in value && typeof value.time === "number" && Number.isFinite(value.time) && value.time >= 0
    && "warnings" in value && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === "string");
}
