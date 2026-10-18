/**
 * A stand-in for the native player engine with the same rules: one video at a time, seek
 * request IDs that must go up, a seek held until its own frame is shown, playback that stops
 * on the last frame and starts over when played again. It answers the player commands the way
 * the desktop shell does, including its errors, so tests run the editor without native code.
 *
 * It is self-contained so a page can run it from its source; see `fixtureEngineScript`.
 */
export interface FixtureEngineOptions {
  /** how long a new position's first frame takes to show; 0 shows it at once like the shell */
  frameDelayMs?: number;
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => void;
}

export interface FixtureEngineCall {
  command: string;
  args: Record<string, unknown>;
  /** milliseconds on the engine's clock when the call arrived */
  at: number;
}

/** What a `player_lut` call carried, as the desktop shell reads it from the body and headers. */
export interface FixtureLut {
  /** bytes of the table; 0 keeps the table sent before */
  bytes: number;
  /** points per side; 0 removes the LUT */
  size: number;
  strength: number;
  /** the table's values summed by place, to tell one table from another */
  checksum: number;
}

export interface FixtureEngine {
  invoke(command: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown>;
  /** every LUT the page sent, in order */
  luts: FixtureLut[];
  calls: FixtureEngineCall[];
  /** the most commands that were ever waiting on the engine at the same time */
  mostInFlight: number;
}

export function createFixtureEngine(options: FixtureEngineOptions = {}): FixtureEngine {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((run: () => void, delayMs: number) => void setTimeout(run, delayMs));
  const frameDelayMs = options.frameDelayMs ?? 0;
  const maxDuration = 7 * 24 * 3600;
  const calls: FixtureEngineCall[] = [];
  const luts: FixtureLut[] = [];
  let inFlight = 0;

  interface Player {
    duration: number;
    position: number;
    playing: boolean;
    ended: boolean;
    pending: boolean;
    generation: number;
    requested: number;
    confirmed: number;
    updatedAt: number;
  }
  let player: Player | null = null;

  const failure = (code: string, message: string) => ({ code, message, details: {} });

  function advance(p: Player, at: number): void {
    if (p.playing && !p.pending && !p.ended && at > p.updatedAt) {
      p.position = Math.min(p.duration, p.position + (at - p.updatedAt) / 1000);
      if (p.position >= p.duration) {
        p.ended = true;
        p.playing = false;
      }
    }
    if (at > p.updatedAt) p.updatedAt = at;
  }

  // a new position: the clock waits for its frame, and only that frame confirms its seek
  function restart(p: Player, seconds: number, requestId: number): void {
    p.generation += 1;
    p.position = seconds;
    p.ended = false;
    p.pending = true;
    const generation = p.generation;
    const shown = (): void => {
      if (player !== p || p.generation !== generation) return;
      p.pending = false;
      if (requestId) p.confirmed = requestId;
      p.updatedAt = now();
    };
    if (frameDelayMs > 0) schedule(shown, frameDelayMs);
    else shown();
  }

  function status(p: Player) {
    advance(p, now());
    return {
      monotonicSeconds: now() / 1000,
      positionSeconds: p.position,
      durationSeconds: p.duration,
      generation: p.generation,
      seekRequestId: p.requested,
      confirmedSeekRequestId: p.confirmed,
      paused: !p.playing,
      seekPending: p.pending,
      ended: p.ended,
      video: null,
    };
  }

  function answer(command: string, args: Record<string, unknown>): unknown {
    if (command === "player_open") {
      const request: unknown = args.request;
      const duration = typeof request === "object" && request !== null ? Reflect.get(request, "durationSeconds") : undefined;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > maxDuration) {
        throw failure("INVALID_REQUEST", "The video length is not valid.");
      }
      const p: Player = {
        duration, position: 0, playing: false, ended: false, pending: false,
        generation: 0, requested: 0, confirmed: 0, updatedAt: now(),
      };
      player = p;
      restart(p, 0, 0);
      return status(p);
    }
    // the LUT only changes the picture, which the fixture doesn't draw; it is checked like the shell does
    if (command === "player_lut") {
      const lut = luts.at(-1);
      const sizeValid = lut !== undefined && Number.isInteger(lut.size) && (lut.size === 0 || (lut.size >= 2 && lut.size <= 65));
      const bytesValid = lut !== undefined && (lut.bytes === 0 || lut.bytes === lut.size ** 3 * 3 * 4);
      const strengthValid = lut !== undefined && Number.isFinite(lut.strength) && lut.strength >= 0 && lut.strength <= 1;
      if (!sizeValid || !bytesValid || !strengthValid) throw failure("INVALID_REQUEST", "The LUT is not valid.");
      return null;
    }
    if (command !== "player_command" && command !== "player_status") return undefined;
    const p = player;
    if (!p) throw failure("PLAYER_NOT_OPEN", "No video is open.");
    if (command === "player_status") return status(p);
    const request: unknown = args.command;
    const field = (name: string): unknown =>
      typeof request === "object" && request !== null ? Reflect.get(request, name) : undefined;
    const kind = field("kind");
    advance(p, now());
    if (kind === "play") {
      if (p.ended) restart(p, 0, 0);
      p.playing = true;
    } else if (kind === "pause") {
      p.playing = false;
    } else if (kind === "seek") {
      const id = field("requestId");
      const seconds = field("seconds");
      const validId = typeof id === "number" && Number.isSafeInteger(id) && id > p.requested;
      const validTime = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= p.duration;
      if (!validId || !validTime) {
        throw failure("SEEK_REFUSED", "The seek was older than the last one or outside the video.");
      }
      p.requested = id;
      restart(p, seconds, id);
    } else if (kind === "volume") {
      const volume = field("volume");
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw failure("INVALID_REQUEST", "The volume must be between 0 and 1.");
      }
    } else {
      throw failure("INVALID_REQUEST", "Unknown player command.");
    }
    return status(p);
  }

  function readLut(body: unknown, headers: Record<string, string>): FixtureLut {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(0);
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    // weighted by place, so tables holding the same values in another order still differ
    let checksum = 0;
    for (let index = 0; index < floats.length; index++) checksum += (floats[index] ?? 0) * (index + 1);
    return {
      bytes: bytes.byteLength,
      size: Number(headers["x-lut-size"]),
      strength: Number(headers["x-lut-strength"]),
      checksum: Math.round(checksum * 1000) / 1000,
    };
  }

  const engine: FixtureEngine = {
    calls,
    luts,
    mostInFlight: 0,
    async invoke(command, args, options) {
      if (command === "player_lut") {
        const lut = readLut(args, options?.headers ?? {});
        luts.push(lut);
        calls.push({ command, args: { ...lut }, at: now() });
      } else {
        calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})), at: now() });
      }
      inFlight += 1;
      engine.mostInFlight = Math.max(engine.mostInFlight, inFlight);
      try {
        // a real bridge answers later, so callers must not rely on an answer in the same task
        await Promise.resolve();
        return answer(command, (args ?? {}) as Record<string, unknown>);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return engine;
}

/**
 * Page script that installs the fixture engine as the desktop shell, with the native engine
 * turned on, and keeps it on `window.__fixtureEngine`. Other shell commands are answered as
 * a plain success, like the window chrome tests do.
 */
export function fixtureEngineScript(options: { frameDelayMs?: number; nativePreview?: "engine" | "off" } = {}): string {
  const capabilities = {
    platform: "windows", architecture: "x86_64", customTitleBar: true,
    sendToIntegration: true, publicCli: true, automaticUpdater: true,
    hardwareAcceleration: true, packaged: false,
    nativePreview: options.nativePreview ?? "engine",
  };
  return `(() => {
    const engine = (${createFixtureEngine.toString()})(${JSON.stringify({ frameDelayMs: options.frameDelayMs ?? 0 })});
    const surface = [];
    window.__fixtureEngine = engine;
    window.__fixtureSurface = surface;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args, options) => {
        if (command === "platform_capabilities") return ${JSON.stringify(capabilities)};
        if (command === "preview_surface_open" || command === "preview_surface_viewport") {
          surface.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
          return null;
        }
        if (command.startsWith("player_")) return engine.invoke(command, args, options);
        return 1;
      },
    };
  })();`;
}
