export interface ProbeClip {
  probed?: boolean;
  probing?: boolean;
  probeData?: unknown;
  error?: string;
}

export interface ProbeResponse {
  readonly ok?: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

export type ProbeResult = { ok: true; data: unknown } | { ok: false; error: string };

export function probeErrorMessage(response?: ProbeResponse | null, thrown?: unknown): string {
  const nested = response?.data;
  const dataError = nested !== null && typeof nested === "object" && "error" in nested ? nested.error : undefined;
  const thrownMessage = thrown instanceof Error ? thrown.message : undefined;
  const value = response?.error ?? dataError ?? thrownMessage ?? "";
  return String(value).trim() || "Couldn’t read this video’s details.";
}

export function beginProbe(clip: ProbeClip | null | undefined): boolean {
  if (!clip || clip.probed || clip.probing) return false;
  clip.probing = true;
  clip.error = "";
  return true;
}

export function completeProbe(clip: ProbeClip, response?: ProbeResponse | null): ProbeResult {
  clip.probing = false;
  if (response?.ok && response.data !== undefined) {
    clip.probed = true;
    clip.probeData = response.data;
    clip.error = "";
    return { ok: true, data: response.data };
  }
  const error = probeErrorMessage(response);
  clip.probed = false;
  clip.probeData = null;
  clip.error = error;
  return { ok: false, error };
}

export function failProbe(clip: ProbeClip, thrown?: unknown): ProbeResult {
  return completeProbe(clip, { ok: false, error: probeErrorMessage(null, thrown) });
}

export function probeStatus(clip: ProbeClip | null | undefined): "ready" | "error" | "loading" {
  if (clip?.probed && clip.probeData) return "ready";
  return clip?.error ? "error" : "loading";
}

export function isProbeReady(clip: ProbeClip | null | undefined): boolean {
  return probeStatus(clip) === "ready";
}

export function allProbesReady(clips: Readonly<Record<string, ProbeClip>> | null | undefined): boolean {
  const values = Object.values(clips ?? {});
  return values.length > 0 && values.every(isProbeReady);
}

export interface ProbeSummary {
  readonly ready: readonly string[];
  readonly loading: readonly string[];
  // a failed read won't finish on its own, so exporting all can go ahead without these
  readonly failed: readonly string[];
}

/** The Library's paths grouped by how far reading each video has got, in the order given. */
export function probeSummary(
  paths: readonly string[],
  clip: (path: string) => ProbeClip | null | undefined,
): ProbeSummary {
  const ready: string[] = [];
  const loading: string[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    const status = probeStatus(clip(path));
    if (status === "ready") ready.push(path);
    else if (status === "error") failed.push(path);
    else loading.push(path);
  }
  return { ready, loading, failed };
}

export { beginProbe as begin, completeProbe as complete, failProbe as fail, probeStatus as status, isProbeReady as isReady, allProbesReady as allReady };
