import type { CropTransform } from "../transform/crop-geometry.ts";
import {
  defaultRateControl,
  isCpuEncoder,
  nativePresetForSpeed,
  type RateControlDisplay,
  type Workflow,
} from "./encoder-options.ts";
import { encoderForPlatform, type PlatformCapabilities } from "../../platform/capabilities.ts";

/** Snapshot of every export-form control value, read once from the DOM. */
export interface ExportFormState {
  workflow: Workflow;
  profileId: string;
  targetSizeMb: number;
  resolutionMode: "source" | "custom";
  customWidth: number;
  customHeight: number;
  scaler: string;
  useSourceFps: boolean;
  customFps: number;
  keepAudio: boolean;
  audioBitrateKbps: number;
  twoPass: boolean;
  encoder: string;
  preset: string;
  rateControl: RateControlDisplay;
  qualityValue: number;
  bitrateKbps: number;
  tune: string;
}

export interface PlanSegment {
  start: number;
  end: number;
}

export interface PlanRequestContext {
  source: string;
  requestId?: number;
  /** Timeline segments when the clip is edited; null/empty means full clip. */
  segments?: readonly PlanSegment[] | null;
  /** Crop/rotation transform when it should override the profile intent. */
  transform?: CropTransform | null;
  /** Audio timeline request payload merged into the request. */
  audioPayload?: Readonly<Record<string, unknown>> | null;
  /** Restricts the request to encoders supported by the running desktop platform. */
  platformCapabilities?: PlatformCapabilities;
}

export interface ProfilePayloadContext {
  name: string;
  /** The currently selected profile, for CQP/cq/qp/crf fallbacks. */
  currentProfile: Readonly<Record<string, unknown>> | null;
  clip: {
    cropAspect: string;
    rotation: number;
    sizingMode: string;
    transformIntentTouched: boolean;
  } | null;
  /** Restricts the saved profile to encoders supported by the running desktop platform. */
  platformCapabilities?: PlatformCapabilities;
}

const RC_TO_METHOD: Readonly<Record<RateControlDisplay, string>> = {
  CRF: "crf",
  CQ: "cq",
  CBR: "cbr",
  VBR: "vbr",
};

/** Pure translation of the legacy `buildReq`. Python remains authoritative for validation. */
export function buildPlanRequest(
  form: ExportFormState,
  ctx: PlanRequestContext,
): Record<string, unknown> {
  const up = form.workflow === "upscale";
  const encoder = ctx.platformCapabilities
    ? encoderForPlatform(form.encoder, ctx.platformCapabilities)
    : form.encoder;
  const encoderChanged = encoder !== form.encoder;
  const rc = encoderChanged ? defaultRateControl(form.workflow, encoder) : form.rateControl;
  const req: Record<string, unknown> = {
    source: ctx.source,
    profile_id: form.profileId,
    workflow: up ? "upscale" : "compression",
    rate_control: "target_size",
    video_encoder: encoder,
    preset: encoderChanged ? nativePresetForSpeed("balanced", encoder) : form.preset,
    rate_control_method: RC_TO_METHOD[rc] ?? "cbr",
  };
  if (ctx.requestId !== undefined) req._request_id = ctx.requestId;
  if (!up) req.target_size_bytes = toInt(form.targetSizeMb) * 1024 * 1024;
  if (form.resolutionMode === "custom") {
    req.resolution_mode = "custom";
    req.custom_width = toInt(form.customWidth);
    req.custom_height = toInt(form.customHeight);
    req.scaler = form.scaler.toLowerCase();
  } else {
    req.resolution_mode = "source";
  }
  if (form.useSourceFps) req.fps_mode = "source";
  else {
    req.fps_mode = "custom";
    req.custom_fps = toInt(form.customFps);
  }
  req.keep_audio = form.keepAudio;
  if (!form.keepAudio) req.audio_bitrate = toInt(form.audioBitrateKbps) * 1000;
  req.two_pass = !up && form.twoPass;
  if (rc === "CRF") req.crf = toInt(form.qualityValue);
  if (rc === "CQ") req.cq = toInt(form.qualityValue);
  if (up && (rc === "CBR" || rc === "VBR")) {
    req.rate_control = "explicit_bitrate";
    req.explicit_bitrate = toInt(form.bitrateKbps) * 1000;
  }
  if (up && (encoder === "libx264" || encoder === "libx265") && form.tune !== "none") {
    req.tune = form.tune;
  }
  const segments = ctx.segments ?? null;
  if (segments && segments.length) {
    req.segments = segments.map((segment) => ({ start: segment.start, end: segment.end }));
  }
  if (ctx.transform) req.transform = ctx.transform;
  if (ctx.audioPayload) Object.assign(req, ctx.audioPayload);
  return req;
}

/** Pure translation of the legacy `savePayload`. */
export function buildProfilePayload(
  form: ExportFormState,
  ctx: ProfilePayloadContext,
): Record<string, unknown> {
  const up = form.workflow === "upscale";
  const current = ctx.currentProfile ?? {};
  const encoder = ctx.platformCapabilities
    ? encoderForPlatform(form.encoder, ctx.platformCapabilities)
    : form.encoder;
  const encoderChanged = encoder !== form.encoder;
  const rateControl = encoderChanged
    ? defaultRateControl(form.workflow, encoder)
    : form.rateControl;
  let rc = up
    ? (RC_TO_METHOD[rateControl] ?? "crf")
    : isCpuEncoder(encoder)
      ? "cbr"
      : "vbr";
  const isBr = rc === "cbr" || rc === "vbr";
  if (current.rate_control_method === "cqp" && rc === "cq") rc = "cqp";
  const quality = toInt(form.qualityValue);
  const data: Record<string, unknown> = {
    name: ctx.name,
    target_size_mb: toInt(form.targetSizeMb),
    resolution_mode: form.resolutionMode,
    custom_width: toInt(form.customWidth),
    custom_height: toInt(form.customHeight),
    max_width: toInt(form.customWidth),
    max_height: toInt(form.customHeight),
    fps_mode: form.useSourceFps ? "source" : "custom",
    custom_fps: toInt(form.customFps),
    max_fps: toInt(form.customFps),
    rate_control: up && isBr ? "explicit_bitrate" : "target_size",
    audio_bitrate_kbps: toInt(form.audioBitrateKbps),
    keep_audio: form.keepAudio,
    two_pass: !up && form.twoPass,
    preset: encoderChanged ? nativePresetForSpeed("balanced", encoder) : form.preset,
    scaler: form.scaler.toLowerCase(),
    video_encoder: encoder,
    workflow: up ? "upscale" : "compression",
    rate_control_method: rc,
    cq: rc === "cq" ? quality : numberOr(current.cq, 23),
    qp: rc === "cqp" ? quality : numberOr(current.qp, 23),
    crf: rc === "crf" ? quality : numberOr(current.crf, 23),
  };
  const clip = ctx.clip;
  if (current.transform_intent || (clip && clip.transformIntentTouched)) {
    data.transform_intent = {
      crop_aspect: clip && clip.cropAspect !== "off" ? clip.cropAspect || "free" : "free",
      rotation: clip ? clip.rotation || 0 : 0,
      sizing_mode: clip ? clip.sizingMode || "fit" : "fit",
    };
  }
  if (up && isBr) data.explicit_bitrate_kbps = toInt(form.bitrateKbps);
  if (up && isCpuEncoder(encoder)) data.tune = form.tune === "none" ? "" : form.tune;
  return data;
}

function toInt(value: number | string): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
