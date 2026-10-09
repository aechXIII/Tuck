export function formatTime(seconds: number): string {
  const value = Number(seconds) || 0;
  const m = Math.floor(value / 60);
  const sec = Math.floor(value % 60);
  const h = Math.floor(m / 60);
  if (h)
    return `${h}:${("0" + (m % 60)).slice(-2)}:${("0" + sec).slice(-2)}`;
  return `${m}:${("0" + sec).slice(-2)}`;
}

// 0:05.50, as the player bar and timeline show cut points
export function formatTimeToHundredths(seconds: number): string {
  const centiseconds = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  return `${formatTime(Math.floor(centiseconds / 100))}.${String(centiseconds % 100).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function errorSummary(error: unknown, limit = 140): string {
  const text = String(error || "Unknown error")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.substring(0, limit)}…` : text;
}

/** Backend text as one tidy sentence, or "" when there is none. */
export function reasonSentence(error: unknown): string {
  const text = typeof error === "string" ? error.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** "Couldn’t do X." followed by why, or by what to do next when the backend gave no reason. */
export function withReason(what: string, error: unknown, next = "Try again."): string {
  return `${what} ${reasonSentence(error) || next}`;
}

export function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}
