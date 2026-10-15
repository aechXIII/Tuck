export interface FrameSprite {
  readonly url: string;
  readonly token: string;
  readonly start: number;
  readonly step: number;
  readonly count: number;
  readonly tile_width: number;
  readonly tile_height: number;
  readonly columns: number;
}

export interface FrameRequest {
  readonly path: string;
  readonly start: number;
  readonly step: number;
  readonly count: number;
  readonly mode: "center" | "whole";
  readonly exact: boolean;
}

interface FrameView {
  readonly path: string;
  readonly duration: number;
  readonly step: number;
  readonly mode: "center" | "whole";
  readonly chunks: readonly number[];
  readonly exact: boolean;
}

interface FrameGeometry {
  readonly duration: number;
  readonly trackWidth: number;
  readonly tileHeight: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly segments: readonly {
    readonly start: number;
    readonly end: number;
  }[];
}

const CHUNK_SIZE = 16;
const MAX_VISIBLE_TILES = 256;

export function frameLayout(view: FrameGeometry) {
  const tiles: { segment: number; index: number; left: number }[] = [];
  const chunks = new Set<number>();
  const tileWidth = (view.tileHeight * 16) / 9;
  const pixelsPerSecond = view.trackWidth / view.duration;
  const step = tileWidth / pixelsPerSecond;
  if (
    ![view.duration, view.trackWidth, view.tileHeight, step].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  ) {
    return { tiles, chunks: [], step: 0, tileWidth: 0 };
  }
  const visibleStart = Math.max(0, view.visibleStart - step);
  const visibleEnd = Math.min(view.duration, view.visibleEnd + step);
  view.segments.forEach((segment, segmentIndex) => {
    const start = Math.max(segment.start, visibleStart);
    const end = Math.min(segment.end, visibleEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return;
    const first = Math.max(0, Math.floor(start / step));
    const last = Math.ceil(end / step);
    for (
      let index = first;
      index < last && tiles.length < MAX_VISIBLE_TILES;
      index++
    ) {
      tiles.push({
        segment: segmentIndex,
        index,
        left: (index * step - segment.start) * pixelsPerSecond,
      });
      chunks.add(Math.floor(index / CHUNK_SIZE));
    }
  });
  return { tiles, chunks: [...chunks], step, tileWidth };
}

type SpriteEntry =
  { state: "pending" | "failed" } | { state: "ready"; sprite: FrameSprite };

export class FrameStripStore {
  private identity = "";
  private generation = 0;
  private active = 0;
  private view: FrameView | null = null;
  private entries = new Map<string, SpriteEntry>();
  private wanted = new Map<string, FrameRequest>();

  constructor(
    private readonly host: {
      request: (request: FrameRequest) => Promise<FrameSprite>;
      release: (token: string) => void;
      changed: () => void;
      load: (sprite: FrameSprite) => Promise<boolean>;
    },
  ) {}

  clear(): void {
    this.generation++;
    this.identity = "";
    this.view = null;
    this.wanted.clear();
    for (const entry of this.entries.values()) {
      if (entry.state === "ready") this.host.release(entry.sprite.token);
    }
    this.entries.clear();
  }

  update(view: FrameView): void {
    const identity = JSON.stringify([
      view.path,
      view.duration,
      view.step,
      view.mode,
    ]);
    if (identity !== this.identity) {
      this.clear();
      this.identity = identity;
    }
    this.view = view;
    this.wanted.clear();
    const total = Math.ceil(view.duration / view.step);
    for (const exact of view.exact ? [false, true] : [false]) {
      for (const chunk of view.chunks) {
        const first = chunk * CHUNK_SIZE;
        const count = Math.min(CHUNK_SIZE, total - first);
        if (count <= 0) continue;
        this.wanted.set(this.key(chunk, exact), {
          path: view.path,
          start: first * view.step,
          step: view.step,
          count,
          mode: view.mode,
          exact,
        });
      }
    }
    this.prune();
    this.pump();
  }

  get(index: number): FrameSprite | null {
    const chunk = Math.floor(index / CHUNK_SIZE);
    for (const exact of this.view?.exact ? [true, false] : [false]) {
      const key = this.key(chunk, exact);
      const entry = this.entries.get(key);
      if (entry?.state !== "ready" || index % CHUNK_SIZE >= entry.sprite.count)
        continue;
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.sprite;
    }
    return null;
  }

  private key(chunk: number, exact: boolean): string {
    return `${chunk}:${exact}`;
  }

  private prune(): void {
    let ready = [...this.entries.values()].filter(
      (entry) => entry.state === "ready",
    ).length;
    for (const [key, entry] of this.entries) {
      if (this.wanted.has(key) || entry.state === "pending") continue;
      if (ready <= 24 && this.entries.size <= 128) break;
      if (entry.state === "ready") {
        this.host.release(entry.sprite.token);
        ready--;
      }
      this.entries.delete(key);
    }
  }

  private pump(): void {
    for (const [key, request] of this.wanted) {
      if (this.active >= 2) break;
      if (this.entries.has(key)) continue;
      if (request.exact) {
        const base = this.entries.get(key.replace(":true", ":false"));
        if (!base || base.state === "pending") continue;
      }
      this.active++;
      this.entries.set(key, { state: "pending" });
      void this.fetch(key, request, this.generation);
    }
  }

  private async fetch(
    key: string,
    request: FrameRequest,
    generation: number,
  ): Promise<void> {
    let sprite: FrameSprite | null = null;
    try {
      sprite = await this.host.request(request);
      if (generation !== this.generation) return;
      if (
        !sprite ||
        typeof sprite.token !== "string" ||
        typeof sprite.url !== "string" ||
        !(await this.host.load(sprite))
      ) {
        throw new Error("Timeline pictures unavailable");
      }
      if (generation !== this.generation) return;
      this.entries.set(key, { state: "ready", sprite });
      sprite = null;
      this.prune();
      this.host.changed();
    } catch {
      if (generation === this.generation)
        this.entries.set(key, { state: "failed" });
    } finally {
      if (sprite?.token) this.host.release(sprite.token);
      this.active--;
      this.pump();
    }
  }
}
