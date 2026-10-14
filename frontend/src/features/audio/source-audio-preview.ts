import type { BackendResult, UrlPayload } from "../../backend/types.ts";

export interface SourcePreviewPlayer {
  sync(time: number, rate: number, gain: number, playing: boolean): void;
  dispose(): void;
}

interface SourcePreviewHost {
  request(path: string, track: number): Promise<BackendResult<UrlPayload>>;
  release(token: string): Promise<void>;
  player(url: string, failed: (message: string) => void): SourcePreviewPlayer;
  status(message: string | null): void;
}

interface SourceTrackLevel {
  muted: boolean;
  gainDb: number;
}

export function createSourceAudioPreview(host: SourcePreviewHost) {
  let generation = 0;
  let selectedPath: string | null = null;
  let selectedCount = 0;
  let ready = false;
  let failed = false;
  let tracks: Array<{ player: SourcePreviewPlayer; token: string; index: number }> = [];
  let desired = { time: 0, rate: 1, base: 0, playing: false, levels: [] as readonly SourceTrackLevel[] };

  async function release(token: string | undefined) {
    if (!token) return;
    try { await host.release(token); } catch { /* releasing a stopped preview is best-effort */ }
  }

  function apply() {
    for (const track of tracks) {
      const level = desired.levels[track.index];
      const gain = level && !level.muted ? desired.base * Math.pow(10, level.gainDb / 20) : 0;
      track.player.sync(desired.time, desired.rate, gain, ready && !failed && desired.playing && gain > 0);
    }
  }

  function fail(message: string, request: number) {
    if (generation !== request || failed) return;
    failed = true;
    host.status(`Could not preview source audio. ${message}`);
    apply();
  }

  async function clear() {
    generation += 1;
    selectedPath = null;
    selectedCount = 0;
    ready = false;
    failed = false;
    const previous = tracks;
    tracks = [];
    host.status(null);
    for (const track of previous) track.player.dispose();
    await Promise.all(previous.map((track) => release(track.token)));
  }

  async function load(path: string, count: number, request: number) {
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      let token: string | undefined;
      try {
        const response = await host.request(path, index);
        if (response.ok) token = response.value.token;
        if (request !== generation) { await release(token); return; }
        if (!response.ok || !response.value.url) {
          await release(token);
          fail(response.ok ? `Audio track ${index + 1} is unavailable. Export still works.` : response.error.message, request);
          return;
        }
        const player = host.player(response.value.url, (message) => fail(message, request));
        tracks.push({ player, token: token ?? "", index });
      } catch {
        await release(token);
        fail(`Audio track ${index + 1} is unavailable. Export still works.`, request);
      }
    }));
    if (request !== generation) return;
    ready = true;
    if (!failed) host.status(null);
    apply();
  }

  return {
    select(path: string, count: number) {
      if (selectedPath === path && selectedCount === count) return;
      void clear();
      selectedPath = path;
      selectedCount = count;
      host.status("Preparing source audio preview...");
      void load(path, count, generation);
    },
    sync(time: number, rate: number, base: number, playing: boolean, levels: readonly SourceTrackLevel[]) {
      desired = { time, rate, base, playing, levels };
      apply();
    },
    clear,
  };
}

export function browserSourcePreviewPlayers(documentRef: Document, windowRef: Window & typeof globalThis) {
  let context: AudioContext | null = null;
  return (url: string, failed: (message: string) => void): SourcePreviewPlayer => {
    context ??= new windowRef.AudioContext();
    const audioContext = context;
    const audio = documentRef.createElement("audio");
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.src = url;
    const source = audioContext.createMediaElementSource(audio);
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(audioContext.destination);
    const onError = () => failed("The audio track could not be played. Export still works.");
    audio.addEventListener("error", onError);
    let disposed = false;
    return {
      sync(time, rate, volume, playing) {
        if (disposed) return;
        gain.gain.value = volume;
        if (audio.playbackRate !== rate) audio.playbackRate = rate;
        // keep the source clock, including gaps left by source-audio edits
        if (!Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - time) > 0.12) audio.currentTime = time;
        if (!playing) { audio.pause(); return; }
        if (audioContext.state === "suspended") void audioContext.resume().catch(onError);
        if (audio.paused) void audio.play().catch((error: unknown) => {
          // a seek, pause or selection can interrupt an in-flight play request
          if (!disposed && (!(error instanceof DOMException) || error.name !== "AbortError")) onError();
        });
      },
      dispose() {
        disposed = true;
        audio.pause();
        audio.removeEventListener("error", onError);
        audio.removeAttribute("src");
        audio.load();
        source.disconnect();
        gain.disconnect();
      },
    };
  };
}
