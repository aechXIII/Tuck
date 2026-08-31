export interface ProbeClip { probed?: boolean; probing?: boolean; probeData?: unknown; error?: string; }
export interface ProbeResponse { readonly ok?: boolean; readonly data?: unknown; readonly error?: unknown; }
export function probeErrorMessage(response?: ProbeResponse | null, thrown?: unknown): string {
  const nested = response?.data;
  const dataError = nested !== null && typeof nested === "object" && "error" in nested ? nested.error : undefined;
  const thrownMessage = thrown instanceof Error ? thrown.message : undefined;
  const value = response?.error ?? dataError ?? thrownMessage ?? "";
  return String(value).trim() || "Couldn’t read clip details.";
}
export function beginProbe(clip: ProbeClip | null | undefined): boolean { if (!clip || clip.probed || clip.probing) return false; clip.probing = true; clip.error = ""; return true; }
export function completeProbe(clip: ProbeClip, response?: ProbeResponse | null): { ok: true; data: unknown } | { ok: false; error: string } { if (response?.ok && response.data !== undefined) { clip.probing=false; clip.probed=true; clip.probeData=response.data; clip.error=""; return {ok:true,data:response.data}; } const error=probeErrorMessage(response); clip.probing=false; clip.probed=false; clip.probeData=null; clip.error=error; return {ok:false,error}; }
export function failProbe(clip: ProbeClip, thrown?: unknown): { ok: true; data: unknown } | { ok: false; error: string } { return completeProbe(clip, { ok:false, error:probeErrorMessage(null, thrown) }); }
export function probeStatus(clip: ProbeClip | null | undefined): "ready" | "error" | "loading" { if (clip?.probed && clip.probeData) return "ready"; return clip?.error ? "error" : "loading"; }
export function isProbeReady(clip: ProbeClip | null | undefined): boolean { return probeStatus(clip) === "ready"; }
export function allProbesReady(clips: Readonly<Record<string, ProbeClip>> | null | undefined): boolean { const values=Object.values(clips ?? {}); return values.length>0 && values.every(isProbeReady); }
export { beginProbe as begin, completeProbe as complete, failProbe as fail, probeStatus as status, isProbeReady as isReady, allProbesReady as allReady };
