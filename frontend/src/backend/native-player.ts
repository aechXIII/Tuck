import { invoke } from "@tauri-apps/api/core";

import type { LutChange } from "../features/preview/lut-preview.ts";
import { backendFailure, errorMessage, isBackendError } from "./errors.ts";
import type { TauriInvoke } from "./tauri.ts";
import type { BackendResult } from "./types.ts";

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

/** The decoder and renderer, when the native player library plays the video. */
export interface NativeVideoInfo {
  readonly decoder: string;
  readonly hardware: boolean;
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
  /** null while only the clock runs, without decoding */
  readonly video: NativeVideoInfo | null;
}

/** Seeks carry request IDs that go up for each opened video, so a late reply can't win. */
export type NativePlayerCommand =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "seek"; readonly requestId: number; readonly seconds: number }
  /** the sound's level, 0 to 1 */
  | { readonly kind: "volume"; readonly volume: number };

export interface NativePlayerOpen {
  readonly durationSeconds: number;
  /** the video file, which the native player library decodes */
  readonly path: string | null;
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

function isVideoInfo(value: unknown): value is NativeVideoInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.decoder === "string" &&
    typeof info.hardware === "boolean" &&
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
    (status.video === null || isVideoInfo(status.video))
  );
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
    lut: async (change, keepTable) => {
      // the table goes as raw floats: a 65-point LUT is 3.3 MB, too much to send as JSON
      const body = change && !keepTable
        ? new Uint8Array(change.table.buffer, change.table.byteOffset, change.table.byteLength)
        : new Uint8Array(0);
      const headers = { "x-lut-size": String(change?.size ?? 0), "x-lut-strength": String(change?.strength ?? 1) };
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
