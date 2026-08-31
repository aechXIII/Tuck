import type { BackendError, BackendResult } from "./types.ts";

export function backendFailure<T>(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): BackendResult<T> {
  return { ok: false, error: { code, message, details } };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isBackendError(value: unknown): value is BackendError {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "code") === "string" &&
    typeof Reflect.get(value, "message") === "string" &&
    typeof Reflect.get(value, "details") === "object" &&
    Reflect.get(value, "details") !== null
  );
}
