import assert from "node:assert/strict";
import test from "node:test";

import {
  createTauriPlayerEngine,
  isNativePlayerStatus,
  type NativePlayerStatus,
} from "../../src/backend/native-player.ts";
import type { TauriInvoke } from "../../src/backend/tauri.ts";
import { installNativePlayer } from "../../src/features/player/native-player.ts";
import { SOURCE_EVENT } from "../../src/features/preview/preview-controller.ts";
import type { PlayerHost } from "../../src/features/player/player.ts";
import type { SegmentRange } from "../../src/features/timeline/segments.ts";
import { createFixtureEngine } from "../fixtures/fixture-engine.ts";

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
}

interface Setup {
  duration?: number;
  segments?: SegmentRange[];
  loop?: boolean;
  frameDelayMs?: number;
  fps?: number;
  wrap?: (invoke: TauriInvoke) => TauriInvoke;
}

interface SentCommand {
  kind: string;
  requestId?: number;
  seconds?: number;
  volume?: number;
}

function setup(options: Setup = {}) {
  const duration = options.duration ?? 10;
  let time = 1000;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames = new Map<number, FrameRequestCallback>();
  const shown: Array<{ at: number; run: () => void }> = [];
  const fixture = createFixtureEngine({
    now: () => time,
    frameDelayMs: options.frameDelayMs ?? 0,
    schedule: (run, delayMs) => shown.push({ at: time + delayMs, run }),
  });
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    paused: true,
    readyState: 0,
    duration: Number.NaN,
    pause() {
      this.paused = true;
    },
  });
  const classes = new Set<string>();
  const button = {
    classList: {
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      remove: (name: string) => classes.delete(name),
    },
  };
  const painted: number[] = [];
  const gaps: boolean[] = [];
  const segments = options.segments ?? [{ start: 0, end: duration }];
  const host: PlayerHost = {
    byId: <T extends HTMLElement>(id: string) =>
      (id === "vid" ? video : id === "btn-play" ? button : null) as unknown as T | null,
    clips: () => ({ a: { probeData: { fps: options.fps ?? 25 } } as never }),
    selPath: () => "a",
    getMuted: () => false,
    setMuted: () => {},
    getVolBefore: () => 80,
    setVolBefore: () => {},
    playbackSegments: () => segments,
    clipSegments: () => segments,
    videoDuration: () => duration,
    setPlayheadUI: (seconds) => {
      painted.push(seconds);
    },
    setPreviewGap: (gap) => {
      gaps.push(gap);
    },
    loopPlayback: () => options.loop ?? false,
    document: {} as Document,
    clock: {
      now: () => time,
      setTimeout: (run, delay = 0) => {
        timers.set(++next, { at: time + delay, run });
        return next;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      requestAnimationFrame: (callback) => {
        frames.set(++next, callback);
        return next;
      },
      cancelAnimationFrame: (id) => {
        frames.delete(id);
      },
    },
  };
  const invoke: TauriInvoke = (command, args) => fixture.invoke(command, { ...args });
  const luts: Array<{ bytes: number; headers: Readonly<Record<string, string>> }> = [];
  const lutRequests: string[] = [];
  video.addEventListener("tuck-lut-request", () => lutRequests.push("asked"));
  const player = installNativePlayer(host, createTauriPlayerEngine(
    options.wrap ? options.wrap(invoke) : invoke,
    async (command, body, headers) => {
      luts.push({ bytes: body.byteLength, headers });
      return fixture.invoke(command, body, { headers: { ...headers } });
    },
  ));

  function frame(): void {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  }

  return {
    player,
    video,
    fixture,
    luts,
    lutRequests,
    classes,
    painted,
    gaps,
    timers,
    frame,
    async load(): Promise<void> {
      video.readyState = 1;
      video.duration = duration;
      video.dispatchEvent(new Event("loadedmetadata"));
      await settle();
    },
    // moves time on in display frames, running due timers, shown frames and frame callbacks
    async advance(ms: number): Promise<void> {
      const end = time + ms;
      while (time < end) {
        time = Math.min(end, time + 16);
        for (const item of shown.splice(0)) {
          if (item.at <= time) item.run();
          else shown.push(item);
        }
        for (const [id, timer] of [...timers]) {
          if (timer.at > time) continue;
          timers.delete(id);
          timer.run();
        }
        frame();
        await settle();
      }
    },
    commands: (): SentCommand[] =>
      fixture.calls
        .filter((call) => call.command === "player_command")
        .map((call) => call.args.command as SentCommand),
    seeks(): SentCommand[] {
      return this.commands().filter((command) => command.kind === "seek");
    },
    last: (): number => painted.at(-1) ?? Number.NaN,
  };
}

test("the client sends typed commands and reads the status", async () => {
  const fixture = createFixtureEngine();
  const engine = createTauriPlayerEngine((command, args) => fixture.invoke(command, { ...args }));
  const opened = await engine.open({ durationSeconds: 12, path: "C:\\media\\clip.mp4" });
  assert.ok(opened.ok);
  assert.equal(opened.value.durationSeconds, 12);
  assert.equal(opened.value.paused, true);
  const seek = await engine.command({ kind: "seek", requestId: 1, seconds: 5 });
  assert.ok(seek.ok);
  assert.equal(seek.value.confirmedSeekRequestId, 1);
  assert.equal(seek.value.positionSeconds, 5);
  const repeated = await engine.command({ kind: "seek", requestId: 1, seconds: 6 });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.ok ? "" : repeated.error.code, "SEEK_REFUSED");
  const tooShort = await engine.open({ durationSeconds: 0, path: null });
  assert.equal(tooShort.ok ? "" : tooShort.error.code, "INVALID_REQUEST");
  assert.deepEqual(fixture.calls.slice(0, 2).map((call) => [call.command, call.args]), [
    ["player_open", { request: { durationSeconds: 12, path: "C:\\media\\clip.mp4" } }],
    ["player_command", { command: { kind: "seek", requestId: 1, seconds: 5 } }],
  ]);

  const unreadable = await createTauriPlayerEngine(async () => ({ paused: "no" })).status();
  assert.equal(unreadable.ok ? "" : unreadable.error.code, "INVALID_RESPONSE");
  const unreachable = await createTauriPlayerEngine(async () => {
    throw new Error("gone");
  }).status();
  assert.equal(unreachable.ok ? "" : unreachable.error.code, "TAURI_INVOKE_FAILED");
});

test("a status is only accepted with exact counters and real times", () => {
  const status: NativePlayerStatus = {
    monotonicSeconds: 3, positionSeconds: 1, durationSeconds: 10, generation: 2,
    seekRequestId: 1, confirmedSeekRequestId: 1, paused: true, seekPending: false, ended: false,
    video: null,
  };
  assert.ok(isNativePlayerStatus(status));
  const sound = { state: "playing", underruns: 0, error: "" };
  const video = {
    decoder: "av1 d3d11va", hardware: true, softwareReason: null, frameRate: 60, presented: 4, failed: false, error: "",
    sound,
  };
  assert.ok(isNativePlayerStatus({ ...status, video }));
  for (const broken of [
    { ...status, generation: 2 ** 53 },
    { ...status, seekRequestId: -1 },
    { ...status, positionSeconds: Number.NaN },
    { ...status, durationSeconds: Number.POSITIVE_INFINITY },
    { ...status, paused: 1 },
    { ...status, ended: undefined },
    { ...status, video: undefined },
    { ...status, video: { ...video, presented: -1 } },
    { ...status, video: { ...video, error: null } },
    { ...status, video: { ...video, sound: undefined } },
    { ...status, video: { ...video, sound: { ...sound, state: "loud" } } },
    { ...status, video: { ...video, sound: { ...sound, underruns: 0.5 } } },
    { ...status, video: { ...video, softwareReason: undefined } },
    { ...status, video: { ...video, softwareReason: "slow" } },
  ]) assert.equal(isNativePlayerStatus(broken), false);
  for (const state of ["none", "playing", "unavailable"]) {
    assert.ok(isNativePlayerStatus({ ...status, video: { ...video, sound: { ...sound, state } } }));
  }
  for (const softwareReason of ["no-device", "codec", "start-failed", "stream"]) {
    const software = { ...video, decoder: "h264 software", hardware: false, softwareReason };
    assert.ok(isNativePlayerStatus({ ...status, video: software }));
  }
});

test("the native sound takes the level the editor gives its video element", async () => {
  const run = setup();
  try {
    const element = run.video as unknown as { volume: number; muted: boolean };
    const changed = async (): Promise<void> => {
      run.video.dispatchEvent(new Event("volumechange"));
      await settle();
    };
    const levels = (): Array<number | undefined> =>
      run.commands().filter((command) => command.kind === "volume").map((command) => command.volume);
    element.volume = 0.4;
    await changed();
    assert.equal(run.fixture.calls.length, 0, "nothing is sent before the video is open");
    await run.load();
    assert.deepEqual(levels(), [0.4], "an opened video gets the level it should play at");
    await changed();
    assert.deepEqual(levels(), [0.4], "an unchanged level is not sent again");
    element.muted = true;
    await changed();
    element.muted = false;
    element.volume = 1;
    await changed();
    assert.deepEqual(levels(), [0.4, 0, 1]);
  } finally {
    run.player.dispose();
  }
});

test("the export's LUT reaches the native picture, its table only when it changes", async () => {
  const run = setup();
  try {
    assert.deepEqual(run.lutRequests, ["asked"], "the player asks for a LUT chosen before it took over");
    const table = new Float32Array(2 * 2 * 2 * 3).fill(0.5);
    const send = async (detail: unknown): Promise<void> => {
      run.video.dispatchEvent(new CustomEvent("tuck-lut", { detail }));
      await settle();
    };
    await send({ table, size: 2, strength: 0.5 });
    await send({ table, size: 2, strength: 0.8 });
    await send(null);
    await send({ table: new Float32Array(table), size: 2, strength: 1 });
    assert.deepEqual(run.luts.map((lut) => [lut.bytes, lut.headers["x-lut-size"], lut.headers["x-lut-strength"]]), [
      [96, "2", "0.5"],
      [0, "2", "0.8"],
      [0, "0", "1"],
      [96, "2", "1"],
    ]);
  } finally {
    run.player.dispose();
  }
});

test("playing waits for the engine and follows its clock without a call per frame", async () => {
  const run = setup();
  try {
    run.player.togglePlay();
    assert.equal(run.fixture.calls.length, 0, "nothing is sent before the video is open");
    await run.load();
    assert.deepEqual(run.fixture.calls.map((call) => call.command), ["player_open"]);
    run.player.togglePlay();
    assert.equal(run.player.isPlaying(), true);
    assert.equal(run.classes.has("playing"), false, "the button waits for the engine");
    await settle();
    assert.equal(run.classes.has("playing"), true);
    await run.advance(1000);
    assert.ok(Math.abs(run.last() - 1) < 0.02, `playhead at ${run.last()}`);
    const polls = run.fixture.calls.filter((call) => call.command === "player_status").length;
    assert.ok(polls >= 8 && polls <= 11, `${polls} status calls in a second`);
    assert.deepEqual(run.commands().map((command) => command.kind), ["play"]);

    run.player.togglePlay();
    await settle();
    assert.equal(run.player.isPlaying(), false);
    assert.equal(run.classes.has("playing"), false);
    const at = run.player.timelineTime();
    await run.advance(500);
    assert.equal(run.player.timelineTime(), at);
    assert.equal(run.timers.size, 0, "a paused engine is not polled");
    assert.equal(run.video.paused, true, "the hidden video never plays");
  } finally {
    run.player.dispose();
  }
});

test("scrubbing sends one seek per frame with rising request IDs", async () => {
  const run = setup();
  try {
    await run.load();
    run.player.seekPreview(1);
    run.player.seekPreview(2);
    run.player.seekPreview(7);
    assert.equal(run.last(), 7);
    assert.equal(run.player.timelineTime(), 7);
    run.frame();
    await settle();
    run.player.seekPreview(3);
    run.frame();
    await settle();
    run.player.seekPreview(4.5);
    run.player.flushVideoSeek();
    await settle();
    assert.deepEqual(run.seeks(), [
      { kind: "seek", requestId: 1, seconds: 7 },
      { kind: "seek", requestId: 2, seconds: 3 },
      { kind: "seek", requestId: 3, seconds: 4.5 },
    ]);
    assert.equal(run.player.timelineTime(), 4.5);
    assert.equal(run.video.currentTime, 7, "the hidden video finishes its seek first");
    run.video.dispatchEvent(new Event("seeked"));
    assert.equal(run.video.currentTime, 4.5, "the hidden video keeps the paused position");

    // a seek waiting behind one still on its way is replaced by the newer one
    run.player.seekPreview(1);
    run.player.flushVideoSeek();
    run.player.seekPreview(2);
    run.player.flushVideoSeek();
    run.player.seekPreview(8);
    run.player.flushVideoSeek();
    await settle();
    assert.deepEqual(run.seeks().slice(3), [
      { kind: "seek", requestId: 4, seconds: 1 },
      { kind: "seek", requestId: 5, seconds: 8 },
    ]);
    assert.equal(run.fixture.mostInFlight, 1, "commands go one at a time");
    assert.equal(run.player.timelineTime(), 8);
  } finally {
    run.player.dispose();
  }
});

test("a seek holds the playhead on its target until its frame is shown", async () => {
  const run = setup({ frameDelayMs: 80 });
  try {
    await run.load();
    await run.advance(100);
    run.player.togglePlay();
    await run.advance(500);
    const before = run.last();
    assert.ok(before > 0.3 && before < 0.6, `playhead at ${before}`);
    run.player.continuePlaybackAt(6);
    await run.advance(48);
    assert.equal(run.last(), 6, "held while the seek frame is pending");
    await run.advance(500);
    assert.ok(run.last() > 6.2 && run.last() < 6.6, `playhead at ${run.last()}`);
  } finally {
    run.player.dispose();
  }
});

test("playback skips removed parts and stops after the last segment", async () => {
  const run = setup({ segments: [{ start: 0, end: 2 }, { start: 4, end: 6 }] });
  try {
    await run.load();
    run.player.togglePlay();
    await run.advance(2200);
    assert.equal(run.seeks()[0]?.seconds, 4);
    assert.ok(run.last() >= 4 && run.last() < 4.3, `playhead at ${run.last()}`);
    await run.advance(2200);
    assert.equal(run.player.isPlaying(), false);
    assert.equal(run.commands().at(-1)?.kind, "pause");
  } finally {
    run.player.dispose();
  }

  const looping = setup({ segments: [{ start: 1, end: 2 }], loop: true });
  try {
    await looping.load();
    looping.player.togglePlay();
    await looping.advance(1600);
    assert.equal(looping.player.isPlaying(), true);
    assert.deepEqual(looping.seeks().map((command) => command.seconds), [1, 1]);
  } finally {
    looping.player.dispose();
  }
});

test("the end of the video stops or starts over as chosen", async () => {
  const stopping = setup({ duration: 2 });
  try {
    await stopping.load();
    stopping.player.togglePlay();
    await stopping.advance(2500);
    assert.equal(stopping.player.isPlaying(), false);
    assert.equal(stopping.classes.has("playing"), false);
    // like the HTML player, the last segment ends within its last 40 ms
    assert.ok(stopping.last() > 1.94 && stopping.last() <= 2, `playhead at ${stopping.last()}`);
    stopping.player.togglePlay();
    await stopping.advance(300);
    assert.ok(stopping.last() > 0.1 && stopping.last() < 0.5, "playing again starts over");
  } finally {
    stopping.player.dispose();
  }

  const looping = setup({ duration: 2, loop: true });
  try {
    await looping.load();
    looping.player.togglePlay();
    await looping.advance(2500);
    assert.equal(looping.player.isPlaying(), true);
    assert.ok(looping.last() < 1, `playhead at ${looping.last()}`);
  } finally {
    looping.player.dispose();
  }
});

test("moved clips play through gaps in timeline time and stop at the project end", async () => {
  const run = setup({
    duration: 5,
    segments: [
      { start: 0, end: 2, sourceStart: 0 },
      { start: 4, end: 7, sourceStart: 2 },
    ],
  });
  try {
    await run.load();
    assert.deepEqual(run.fixture.calls[0]?.args, { request: { durationSeconds: 7, path: "a" } },
      "the engine covers the whole project and gets the selected file");
    run.player.togglePlay();
    await run.advance(2500);
    assert.equal(run.gaps.at(-1), true);
    assert.equal(run.player.sourceTime(), null);
    assert.throws(() => run.player.captureFrameTime(), /timeline gap/);
    await run.advance(1800);
    assert.equal(run.gaps.at(-1), false);
    const source = run.player.sourceTime();
    assert.ok(source != null && Math.abs(source - (run.player.timelineTime() - 2)) < 1e-9);
    await run.advance(3000);
    assert.equal(run.player.isPlaying(), false);
    assert.equal(run.player.timelineTime(), 7);
  } finally {
    run.player.dispose();
  }
});

test("frame steps and saved frames pause first", async () => {
  const run = setup({ fps: 25 });
  try {
    await run.load();
    run.player.togglePlay();
    await run.advance(400);
    run.player.stepFrame(1);
    assert.equal(run.player.isPlaying(), false);
    const stepped = run.player.timelineTime();
    run.frame();
    await settle();
    const seek = run.seeks().at(-1);
    assert.ok(seek?.seconds != null && Math.abs(seek.seconds - stepped) < 1e-9);
    run.player.togglePlay();
    await run.advance(300);
    const time = run.player.captureFrameTime();
    assert.equal(run.player.isPlaying(), false);
    await settle();
    assert.ok(Math.abs(run.player.timelineTime() - time) < 0.05);
  } finally {
    run.player.dispose();
  }
});

test("replies for the previous video are ignored", async () => {
  const run = setup();
  try {
    await run.load();
    run.player.togglePlay();
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: null }));
    await settle();
    assert.equal(run.player.isPlaying(), false);
    assert.equal(run.classes.has("playing"), false);
    run.player.togglePlay();
    await settle();
    assert.equal(run.commands().length, 1, "nothing is sent until the next video opens");
    await run.load();
    assert.equal(run.fixture.calls.filter((call) => call.command === "player_open").length, 2);
  } finally {
    run.player.dispose();
  }
});

test("a shown video opens from its probed length before the webview reads it", async () => {
  const run = setup();
  try {
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: "a" }));
    await settle();
    const opens = run.fixture.calls.filter((call) => call.command === "player_open");
    assert.equal(opens.length, 1);
    assert.equal((opens[0]?.args.request as { durationSeconds: number } | undefined)?.durationSeconds, 10);
    run.player.togglePlay();
    await settle();
    assert.deepEqual(run.commands().map((command) => command.kind), ["play"]);
    await run.load();
    assert.equal(run.fixture.calls.filter((call) => call.command === "player_open").length, 1,
      "the webview reading the file later doesn't open it again");
  } finally {
    run.player.dispose();
  }
});

test("a file the webview can't read keeps playing in the engine", async () => {
  const run = setup();
  try {
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: "a" }));
    await settle();
    run.player.togglePlay();
    await settle();
    run.video.dispatchEvent(new Event("error"));
    run.video.dispatchEvent(new Event("emptied"));
    await run.advance(500);
    assert.equal(run.player.isPlaying(), true);
    assert.ok(run.player.timelineTime() > 0.3);
  } finally {
    run.player.dispose();
  }
});

test("a refused play leaves the player paused", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  const run = setup({
    wrap: (invoke) => async (command, args) => {
      if (command === "player_command") throw { code: "NOT_AVAILABLE", message: "The native preview is not turned on.", details: {} };
      return invoke(command, args);
    },
  });
  try {
    await run.load();
    run.player.togglePlay();
    await settle();
    assert.equal(run.player.isPlaying(), false);
    assert.equal(run.classes.has("playing"), false);
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
    run.player.dispose();
  }
});

test("dispose stops polling and ignores the video", async () => {
  const run = setup();
  await run.load();
  run.player.togglePlay();
  await run.advance(200);
  run.player.dispose();
  const calls = run.fixture.calls.length;
  await run.advance(500);
  run.video.dispatchEvent(new Event("loadedmetadata"));
  await settle();
  assert.equal(run.fixture.calls.length, calls);
  assert.equal(run.timers.size, 0);
});
