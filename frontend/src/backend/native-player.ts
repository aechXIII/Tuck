import { invoke } from "@tauri-apps/api/core";

import { backendFailure, errorMessage, isBackendError } from "./errors.ts";
import type { TauriInvoke } from "./tauri.ts";
import type { BackendResult } from "./types.ts";

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
}

/** Seeks carry request IDs that go up for each opened video, so a late reply can't win. */
export type NativePlayerCommand =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "seek"; readonly requestId: number; readonly seconds: number };

/** the engine refuses larger IDs, so they stay exact in JavaScript too */
export const MAX_SEEK_REQUEST_ID = Number.MAX_SAFE_INTEGER;

export interface PlayerEngine {
  /** starts over for a video of this length, replacing the previous one */
  open(durationSeconds: number): Promise<BackendResult<NativePlayerStatus>>;
  command(command: NativePlayerCommand): Promise<BackendResult<NativePlayerStatus>>;
  status(): Promise<BackendResult<NativePlayerStatus>>;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
    typeof status.ended === "boolean"
  );
}

/** The engine in the desktop shell. Every call refuses unless this run turned it on. */
export function createTauriPlayerEngine(
  invokeCommand: TauriInvoke = (command, args) => invoke(command, args),
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
    open: (durationSeconds) => call("open", "player_open", { durationSeconds }),
    command: (command) => call(command.kind, "player_command", { command }),
    status: () => call("status", "player_status", {}),
  };
}
