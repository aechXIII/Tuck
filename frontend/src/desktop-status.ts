import { hasPywebviewApi, hasTauriInvoke } from "./backend/index.ts";

export function hasDesktopBackend(host: unknown): boolean {
  return hasPywebviewApi(host) || hasTauriInvoke(host);
}

export function backendUnavailableMessage(reason?: string): string {
  const normalizedReason = reason?.trim();
  if (normalizedReason) {
    const sentence = /[.!?]$/.test(normalizedReason)
      ? normalizedReason
      : `${normalizedReason}.`;
    return `Tuck could not connect to its desktop backend: ${sentence} Close and reopen Tuck.`;
  }
  return "Tuck could not connect to its desktop backend. Close and reopen Tuck. Developers should run npm run build before launching the Python app.";
}
