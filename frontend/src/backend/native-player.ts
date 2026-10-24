import { invoke } from "@tauri-apps/api/core";

import type { LutChange } from "../features/preview/lut-preview.ts";
import type { PreviewMix } from "./preview-mix-types.ts";
import { backendFailure, errorMessage, isBackendError } from "./errors.ts";
import type { TauriInvoke } from "./tauri.ts";
import type { BackendResult, JsonObject } from "./types.ts";

/** The video's sound in the native player. */
export interface NativeSoundInfo {
  /**
   * "playing": the sound plays and the clock follows it; "unavailable": the file has sound that
   * can't play (error says why) and the clock runs on its own; "none": the file has no sound
   */
  readonly state: "none" | "playing" | "unavailable";
  /** times the device wanted sound before it was decoded */
  readonly underruns: number;
  readonly error: string;
}

/**
 * Why the native player decodes in software: "no-device" when no GPU decoding device could be
 * opened (a missing or refusing driver), "codec" when the GPU decoders don't handle the codec,
 * "start-failed" when the GPU decoder could not start, "stream" when the GPU can't decode this
 * particular stream, such as its profile or pixel format.
 */
export type NativeSoftwareReason = "no-device" | "codec" | "start-failed" | "stream";

/** The decoder and renderer, when the native player library plays the video. */
export interface NativeVideoInfo {
  readonly decoder: string;
  readonly hardware: boolean;
  /** null while the GPU decodes the frames */
  readonly softwareReason: NativeSoftwareReason | null;
  readonly frameRate: number;
  readonly presented: number;
  /** the video can't play any more; error says why */
  readonly failed: boolean;
  readonly error: string;
  readonly sound: NativeSoundInfo;
}

/** What the native player reports after every command. Times are in seconds. */
export interface NativePlayerStatus {
  /** the engine's own monotonic clock when the status was read */
  readonly monotonicSeconds: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  /** goes up with every new position; a frame from an older one never confirms a seek */
  readonly generation: number;
  readonly seekRequestId: number;
  readonly confirmedSeekRequestId: number;
  readonly paused: boolean;
  /** the clock waits until the new position's first frame is on screen */
  readonly seekPending: boolean;
  readonly ended: boolean;
  /** media seconds per second of playing */
  readonly rate: number;
  /** null while only the clock runs, without decoding */
  readonly video: NativeVideoInfo | null;
}

/** Seeks carry request IDs that go up for each opened video, so a late reply can't win. */
export type NativePlayerCommand =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "seek"; readonly requestId: number; readonly seconds: number }
  /** the sound's level, 0 to 1 */
  | { readonly kind: "volume"; readonly volume: number }
  /** media seconds per second, 0.25 to 4; a new speed restarts at the same spot */
  | { readonly kind: "rate"; readonly rate: number };

export interface NativePlayerOpen {
  readonly durationSeconds: number;
  /** the video file, which the native player library decodes */
  readonly path: string | null;
}

/** A stretch of the timeline showing the file's footage from `sourceStart`. */
export interface NativeEditSegment {
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
}

/** The timeline's length and footage; no segments shows the file as it is. */
export interface NativeEdits {
  readonly duration: number;
  readonly segments: readonly NativeEditSegment[];
}

/** the engine refuses larger IDs, so they stay exact in JavaScript too */
export const MAX_SEEK_REQUEST_ID = Number.MAX_SAFE_INTEGER;

export interface PlayerEngine {
  /** starts over for the selected video, replacing the previous one */
  open(request: NativePlayerOpen): Promise<BackendResult<NativePlayerStatus>>;
  command(command: NativePlayerCommand): Promise<BackendResult<NativePlayerStatus>>;
  status(): Promise<BackendResult<NativePlayerStatus>>;
  /** shows `change` (null removes the LUT); `keepTable` sends only its strength */
  lut(change: LutChange | null, keepTable: boolean): Promise<BackendResult<null>>;
  /** the timeline the engine plays: its length and which footage each part shows */
  edits(edits: NativeEdits): Promise<BackendResult<NativePlayerStatus>>;
  /** plays this mix instead of the video's own sound from the next moment on */
  mix(mix: PreviewMix): Promise<BackendResult<null>>;
}

/** Sends a command with a raw body, which Tauri passes on without turning it into JSON. */
export type TauriInvokeBytes = (
  command: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
) => Promise<unknown>;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSoundInfo(value: unknown): value is NativeSoundInfo {
  if (typeof value !== "object" || value === null) return false;
  const sound = value as Record<string, unknown>;
  return (
    (sound.state === "none" || sound.state === "playing" || sound.state === "unavailable") &&
    isCount(sound.underruns) &&
    typeof sound.error === "string"
  );
}

const SOFTWARE_REASONS: readonly unknown[] = ["no-device", "codec", "start-failed", "stream"];

function isVideoInfo(value: unknown): value is NativeVideoInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.decoder === "string" &&
    typeof info.hardware === "boolean" &&
    (info.softwareReason === null || SOFTWARE_REASONS.includes(info.softwareReason)) &&
    isSeconds(info.frameRate) &&
    isCount(info.presented) &&
    typeof info.failed === "boolean" &&
    typeof info.error === "string" &&
    isSoundInfo(info.sound)
  );
}

export function isNativePlayerStatus(value: unknown): value is NativePlayerStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    isSeconds(status.monotonicSeconds) &&
    isSeconds(status.positionSeconds) &&
    isSeconds(status.durationSeconds) &&
    isCount(status.generation) &&
    isCount(status.seekRequestId) &&
    isCount(status.confirmedSeekRequestId) &&
    typeof status.paused === "boolean" &&
    typeof status.seekPending === "boolean" &&
    typeof status.ended === "boolean" &&
    typeof status.rate === "number" && Number.isFinite(status.rate) && status.rate > 0 &&
    (status.video === null || isVideoInfo(status.video))
  );
}

/**
 * The shell's report on the preview for the diagnostic report: how it plays, whether the native
 * player library loaded, and the open video's status. Python checks and words it, so the page
 * passes it on as it came; null when the shell can't be asked.
 */
export async function readPlayerReport(
  invokeCommand: TauriInvoke = (command, args) => invoke(command, args),
): Promise<JsonObject | null> {
  try {
    const value = await invokeCommand("player_report", {});
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
}

/** The engine in the desktop shell. Every call refuses unless this run turned it on. */
export function createTauriPlayerEngine(
  invokeCommand: TauriInvoke = (command, args) => invoke(command, args),
  invokeBytes: TauriInvokeBytes = (command, body, headers) => invoke(command, body, { headers }),
): PlayerEngine {
  async function call(
    method: string,
    command: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<BackendResult<NativePlayerStatus>> {
    try {
      const value = await invokeCommand(command, args);
      if (isNativePlayerStatus(value)) return { ok: true, value };
      return backendFailure("INVALID_RESPONSE", "The player sent a status Tuck could not read.", { method });
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not reach the player."), { method });
    }
  }
  return {
    open: (request) => call("open", "player_open", { request }),
    command: (command) => call(command.kind, "player_command", { command }),
    status: () => call("status", "player_status", {}),
    edits: (edits) => call("edits", "player_edits", { edits }),
    mix: async (mix) => {
      try {
        await invokeCommand("player_mix", { mix });
        return { ok: true, value: null };
      } catch (error) {
        if (isBackendError(error)) return { ok: false, error };
        return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not reach the player."), { method: "mix" });
      }
    },
    lut: async (change, keepTable) => {
      // the table goes as raw floats: a 65-point LUT is 3.3 MB, too much to send as JSON
      const body = change && !keepTable
        ? new Uint8Array(change.table.buffer, change.table.byteOffset, change.table.byteLength)
        : new Uint8Array(0);
      const headers: Record<string, string> = {
        "x-lut-size": String(change?.size ?? 0),
        "x-lut-strength": String(change?.strength ?? 1),
      };
      // only while comparing; without it the LUT covers the whole picture
      if (typeof change?.split === "number") headers["x-lut-split"] = String(change.split);
      try {
        await invokeBytes("player_lut", body, headers);
        return { ok: true, value: null };
      } catch (error) {
        if (isBackendError(error)) return { ok: false, error };
        return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not reach the player."), { method: "lut" });
      }
    },
  };
}
