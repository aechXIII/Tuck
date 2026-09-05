import type { BackendResult } from "../../backend/types.ts";

export interface LegacyBridgePayload {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export async function legacyBackendResult<T>(
  call: Promise<BackendResult<T>>,
): Promise<LegacyBridgePayload> {
  const result = await call;
  if (result.ok) {
    if (Array.isArray(result.value)) return result.value as unknown as LegacyBridgePayload;
    if (result.value && typeof result.value === "object")
      return Object.assign({ ok: true }, result.value) as LegacyBridgePayload;
    return { ok: true, value: result.value };
  }
  return {
    ok: false,
    error: result.error.message,
    code: result.error.code,
    details: result.error.details,
  };
}
