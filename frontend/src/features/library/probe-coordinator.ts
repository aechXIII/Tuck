import { getBackendClient } from "../../backend/client.ts";
import { completeProbe, beginProbe, failProbe } from "../../state/probe.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import type { EditorClip, ProbeData } from "../editor/types.ts";

export interface ProbeCoordinatorHost {
  clip(path: string): EditorClip | undefined;
  onProbeStarted(path: string): void;
  onProbeFinished(path: string, clip: EditorClip, succeeded: boolean): void;
}

export interface ProbeCoordinator {
  probe(path: string, requestId?: number): Promise<void>;
  retry(path: string): Promise<void>;
  dispose(path: string): Promise<void>;
}

const generations = new Map<string, number>();

export function nextProbeGeneration(path: string): number {
  const next = (generations.get(path) ?? 0) + 1;
  generations.set(path, next);
  return next;
}

export function currentProbeGeneration(path: string): number {
  return generations.get(path) ?? 0;
}

export function forgetProbeGeneration(path: string): void {
  generations.delete(path);
}

export function createProbeCoordinator(host: ProbeCoordinatorHost): ProbeCoordinator {
  async function probe(path: string, requestId?: number): Promise<void> {
    const clip = host.clip(path);
    if (!clip) return;
    if (!beginProbe(clip)) return;
    const generation = requestId ?? nextProbeGeneration(path);
    host.onProbeStarted(path);
    try {
      const response = await legacyBackendResult(getBackendClient().probeFile(path));
      if (currentProbeGeneration(path) !== generation || host.clip(path) !== clip) return;
      const result = completeProbe(clip, response);
      if (result.ok && result.data && typeof result.data === "object") {
        const data = result.data as ProbeData;
        clip.probeData = data;
        if (typeof data.file_size === "number") clip._fileSize = data.file_size;
      }
      host.onProbeFinished(path, clip, result.ok);
    } catch (error) {
      if (currentProbeGeneration(path) !== generation || host.clip(path) !== clip) return;
      failProbe(clip, error);
      host.onProbeFinished(path, clip, false);
    }
  }

  return {
    probe,
    retry: (path) => {
      const clip = host.clip(path);
      if (clip) {
        clip.probed = false;
        clip.probing = false;
      }
      return probe(path);
    },
    dispose: async (path) => {
      forgetProbeGeneration(path);
    },
  };
}
