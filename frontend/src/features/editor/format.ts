export function formatTime(seconds: number): string {
  const value = Number(seconds) || 0;
  const m = Math.floor(value / 60);
  const sec = Math.floor(value % 60);
  const h = Math.floor(m / 60);
  if (h)
    return `${h}:${("0" + (m % 60)).slice(-2)}:${("0" + sec).slice(-2)}`;
  return `${m}:${("0" + sec).slice(-2)}`;
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

export function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}
