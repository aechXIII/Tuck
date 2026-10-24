import assert from "node:assert/strict";
import test from "node:test";

import {
  createTauriPlayerEngine,
  isNativePlayerStatus,
  readPlayerReport,
  type NativePlayerStatus,
} from "../../src/backend/native-player.ts";
import type { TauriInvoke } from "../../src/backend/tauri.ts";
import { installNativePlayer } from "../../src/features/player/native-player.ts";
import { SOURCE_EVENT, SOURCE_FAILED_EVENT, SOURCE_READY_EVENT } from "../../src/features/preview/preview-controller.ts";
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
  compilePreviewMix?: PlayerHost["compilePreviewMix"];
  /** the volume slider, 0 to 100 */
  level?: number;
}

interface SentCommand {
  kind: string;
  requestId?: number;
  seconds?: number;
  volume?: number;
  rate?: number;
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
  const bar = { value: String(options.level ?? 100) };
  let muted = false;
  const classes = new Set<string>();
  const button = {
    classList: {
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      remove: (name: string) => classes.delete(name),
    },
  };
  const painted: number[] = [];
  const gaps: boolean[] = [];
  const audioSyncs: number[] = [];
  const segments = options.segments ?? [{ start: 0, end: duration }];
  const host: PlayerHost = {
    ...(options.compilePreviewMix
      ? { previewMixRequest: () => ({ source: "a" }), compilePreviewMix: options.compilePreviewMix }
      : {}),
    byId: <T extends HTMLElement>(id: string) =>
      (id === "vid" ? video : id === "btn-play" ? button : id === "vbar" ? bar : null) as unknown as T | null,
    clips: () => ({ a: { probeData: { fps: options.fps ?? 25 } } as never }),
    selPath: () => "a",
    getMuted: () => muted,
    setMuted: (value) => {
      muted = value;
    },
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
    AudioTimeline: { applyPreviewVolume: () => {}, syncPreview: () => audioSyncs.push(time) },
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
    bar,
    fixture,
    luts,
    lutRequests,
    classes,
    painted,
    gaps,
    audioSyncs,
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
    rate: 1, video: null,
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
    { ...status, rate: 0 },
    { ...status, rate: Number.NaN },
    { ...status, rate: undefined },
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

test("the native sound takes the preview's level from the slider and mute", async () => {
  const run = setup({ level: 40 });
  try {
    const levels = (): Array<number | undefined> =>
      run.commands().filter((command) => command.kind === "volume").map((command) => command.volume);
    run.player.setVol("40");
    await settle();
    assert.equal(run.fixture.calls.length, 0, "nothing is sent before the video is open");
    await run.load();
    assert.deepEqual(levels(), [0.4], "an opened video gets the level it should play at");
    run.player.setVol("40");
    await settle();
    assert.deepEqual(levels(), [0.4], "an unchanged level is not sent again");
    run.player.toggleMute();
    await settle();
    run.bar.value = "100";
    run.player.setVol("100");
    await settle();
    assert.deepEqual(levels(), [0.4, 0, 1]);
    // WebKitGTK can leave an older volume on the hidden video; the engine doesn't follow it
    Object.assign(run.video, { volume: 0 });
    run.video.dispatchEvent(new Event("volumechange"));
    await settle();
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
    await send({ table, size: 2, strength: 0.5, split: null });
    await send({ table, size: 2, strength: 0.8, split: null });
    await send(null);
    const next = new Float32Array(table);
    await send({ table: next, size: 2, strength: 1, split: null });
    // comparing moves only the split, so the table isn't sent again
    await send({ table: next, size: 2, strength: 1, split: 0.35 });
    await send({ table: next, size: 2, strength: 1, split: null });
    assert.deepEqual(
      run.luts.map((lut) => [lut.bytes, lut.headers["x-lut-size"], lut.headers["x-lut-strength"], lut.headers["x-lut-split"]]),
      [
        [96, "2", "0.5", undefined],
        [0, "2", "0.8", undefined],
        [0, "0", "1", undefined],
        [96, "2", "1", undefined],
        [0, "2", "1", "0.35"],
        [0, "2", "1", undefined],
      ],
    );
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
    assert.deepEqual(run.fixture.calls.map((call) => call.command), ["player_open", "player_edits"],
      "the timeline goes with the video");
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

test("moved clips go to the engine as its timeline, which plays through gaps to the project end", async () => {
  const run = setup({
    duration: 5,
    segments: [
      { start: 0, end: 2, sourceStart: 0 },
      { start: 4, end: 7, sourceStart: 2 },
    ],
  });
  try {
    await run.load();
    assert.deepEqual(run.fixture.calls[0]?.args, { request: { durationSeconds: 5, path: "a" } },
      "the engine opens the selected file");
    assert.deepEqual(run.fixture.edits.at(-1), {
      duration: 7,
      segments: [
        { start: 0, end: 2, sourceStart: 0 },
        { start: 4, end: 7, sourceStart: 2 },
      ],
    }, "and plays the project's timeline, mapping each clip to its own footage");
    run.player.togglePlay();
    await run.advance(2500);
    assert.equal(run.gaps.at(-1), true);
    assert.equal(run.player.isPlaying(), true, "the gap plays on");
    assert.equal(run.player.sourceTime(), null);
    assert.throws(() => run.player.captureFrameTime(), /timeline gap/);
    await run.advance(1800);
    assert.equal(run.gaps.at(-1), false);
    const source = run.player.sourceTime();
    assert.ok(source != null && Math.abs(source - (run.player.timelineTime() - 2)) < 1e-9);
    await run.advance(3000);
    assert.equal(run.player.isPlaying(), false);
    assert.ok(Math.abs(run.player.timelineTime() - 7) < 0.01, "stopped at the project end");
  } finally {
    run.player.dispose();
  }
});

test("an edit to a moved clip goes to the engine as a new timeline", async () => {
  const ranges = [{ start: 0, end: 3, sourceStart: 2 }];
  const run = setup({ duration: 6, segments: ranges });
  try {
    await run.load();
    assert.deepEqual(run.fixture.edits.at(-1)?.segments, [{ start: 0, end: 3, sourceStart: 2 }]);
    // a slip moves the footage under the clip; the engine shows the new frame itself
    ranges[0] = { start: 0, end: 3, sourceStart: 1.5 };
    run.player.updateTime();
    await settle();
    assert.deepEqual(run.fixture.edits.at(-1)?.segments, [{ start: 0, end: 3, sourceStart: 1.5 }]);
    const sent = run.fixture.edits.length;
    run.player.updateTime();
    await settle();
    assert.equal(run.fixture.edits.length, sent, "an unchanged timeline isn't sent again");
  } finally {
    run.player.dispose();
  }
});

test("clips moved flush against each other reach the engine in order", async () => {
  // a move lands one rounding error past the next clip's start, as `(start - length) + length` can
  const end = 0.1 + 0.2;
  const run = setup({
    duration: 5,
    segments: [
      { start: 0, end, sourceStart: 1 },
      { start: 0.3, end: 2, sourceStart: 2 },
    ],
  });
  try {
    await run.load();
    const sent = run.fixture.edits.at(-1)?.segments;
    assert.equal(sent?.length, 2, "the shell takes the timeline");
    assert.equal(sent?.[1]?.start, end);
    assert.ok(Math.abs((sent?.[1]?.sourceStart ?? 0) - 2) < 1e-9);
  } finally {
    run.player.dispose();
  }
});

test("a timeline the shell refuses is sent once more, not every frame", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  const ranges: SegmentRange[] = [{ start: 0, end: 2, sourceStart: 1 }];
  let refusals = 2;
  let attempts = 0;
  const run = setup({
    duration: 5,
    segments: ranges,
    wrap: (invoke) => async (command, args) => {
      if (command === "player_edits") {
        attempts++;
        if (refusals > 0) {
          refusals--;
          throw { code: "BACKEND_TIMEOUT", message: "The backend did not answer in time.", details: {} };
        }
      }
      return invoke(command, args);
    },
  });
  try {
    await run.load();
    assert.equal(attempts, 2, "tried once more");
    run.player.updateTime();
    run.player.updateTime();
    await settle();
    assert.equal(attempts, 2, "then left until the timeline changes");
    // a refusal that passes: the next try shows the new arrangement
    refusals = 1;
    ranges[0] = { start: 0, end: 2, sourceStart: 1.5 };
    run.player.updateTime();
    await settle();
    assert.equal(attempts, 4);
    assert.deepEqual(run.fixture.edits.at(-1)?.segments, [{ start: 0, end: 2, sourceStart: 1.5 }]);
    assert.equal(errors.length, 3);
  } finally {
    console.error = original;
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

test("a video that leaves the stage stops playing, and its replies are ignored", async () => {
  const run = setup();
  try {
    await run.load();
    // the play is still on its way when the stage empties
    run.player.togglePlay();
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: null }));
    await settle();
    assert.equal(run.player.isPlaying(), false);
    assert.equal(run.classes.has("playing"), false);
    assert.deepEqual(run.commands().map((command) => command.kind), ["play", "pause"],
      "the engine keeps no sound of a video that left");
    run.player.togglePlay();
    await settle();
    assert.equal(run.commands().length, 2, "nothing more is sent until the next video opens");
    const engine = await run.fixture.invoke("player_status", {}) as NativePlayerStatus;
    assert.equal(engine.paused, true);
    await run.load();
    assert.equal(run.fixture.calls.filter((call) => call.command === "player_open").length, 2);
  } finally {
    run.player.dispose();
  }

  // a paused video has nothing to stop
  const paused = setup();
  try {
    await paused.load();
    paused.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: null }));
    await settle();
    assert.deepEqual(paused.commands(), []);
  } finally {
    paused.player.dispose();
  }
});

test("a mix compiled for a video the engine refused never reaches the engine", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  const mix = { duration: 10, voices: [] };
  const compiles: Array<() => void> = [];
  const refusals: Array<() => void> = [];
  let opens = 0;
  const run = setup({
    wrap: (invoke) => async (command, args) => {
      if (command === "player_open" && ++opens === 2) {
        await new Promise<void>((resolve) => refusals.push(resolve));
        throw { code: "PLAYER_OPEN_FAILED", message: "The video could not be opened.", details: {} };
      }
      return invoke(command, args);
    },
    compilePreviewMix: () => new Promise((resolve) => compiles.push(() => resolve({ ok: true, value: { data: mix } }))),
  });
  try {
    await run.load();
    await run.advance(100);
    compiles.shift()?.();
    await run.advance(20);
    assert.equal(run.fixture.mixes.length, 1);
    // the next video's mix is compiled while the engine is still opening it, then the open fails
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: "a" }));
    await run.advance(100);
    assert.equal(compiles.length, 1);
    refusals.shift()?.();
    await settle();
    compiles.shift()?.();
    await run.advance(100);
    assert.equal(run.fixture.mixes.length, 1, "the engine still holds the previous video");
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
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

test("the stage hears once when the first frame of a shown video is ready", async () => {
  const run = setup();
  const answers: string[] = [];
  run.video.addEventListener(SOURCE_READY_EVENT, () => answers.push("ready"));
  run.video.addEventListener(SOURCE_FAILED_EVENT, () => answers.push("failed"));
  try {
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: "a" }));
    await settle();
    run.player.togglePlay();
    await run.advance(500);
    assert.deepEqual(answers, ["ready"]);
  } finally {
    run.player.dispose();
  }
});

test("a video the engine can't open is reported once and not tried again", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  const run = setup({
    wrap: (invoke) => async (command, args) => {
      if (command === "player_open") throw { code: "PLAYER_OPEN_FAILED", message: "The video could not be opened.", details: {} };
      return invoke(command, args);
    },
  });
  const answers: string[] = [];
  run.video.addEventListener(SOURCE_READY_EVENT, () => answers.push("ready"));
  run.video.addEventListener(SOURCE_FAILED_EVENT, () => answers.push("failed"));
  try {
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: "a" }));
    await settle();
    run.player.togglePlay();
    run.player.updateTime();
    await run.advance(200);
    assert.deepEqual(answers, ["failed"]);
    assert.equal(run.fixture.calls.filter((call) => call.command === "player_open").length, 0);
    assert.equal(errors.length, 1, "one refusal, not one per timeline refresh");
  } finally {
    console.error = original;
    run.player.dispose();
  }
});

test("a new speed goes to the engine and the playhead moves at it", async () => {
  const run = setup();
  try {
    await run.load();
    run.player.togglePlay();
    await run.advance(400);
    run.player.changeSpeed(1);
    run.player.changeSpeed(1);
    await settle();
    const rates = () => run.commands().filter((command) => command.kind === "rate").map((command) => command.rate);
    assert.deepEqual(rates(), [1.5, 2], "two steps up from normal speed");
    const before = run.player.timelineTime();
    await run.advance(1000);
    const moved = run.player.timelineTime() - before;
    assert.ok(moved > 1.8 && moved < 2.2, `moved ${moved} s in one second at double speed`);
    assert.equal((run.video as unknown as { playbackRate: number }).playbackRate, 2);
    run.player.resetSpeed();
    await settle();
    assert.deepEqual(rates(), [1.5, 2, 1]);
  } finally {
    run.player.dispose();
  }
});

test("the chosen speed carries over to the next video", async () => {
  const run = setup();
  try {
    await run.load();
    run.player.changeSpeed(-1);
    await settle();
    run.video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: "a" }));
    await settle();
    const sent = run.fixture.calls.map((call) => call.command === "player_command"
      ? (call.args.command as SentCommand).kind + ":" + String((call.args.command as SentCommand).rate ?? "")
      : call.command);
    assert.deepEqual(sent.filter((entry) => entry === "player_open" || entry.startsWith("rate")),
      ["player_open", "rate:0.5", "player_open", "rate:0.5"]);
  } finally {
    run.player.dispose();
  }
});

test("source and imported audio keep following the clock while the engine plays", async () => {
  const run = setup();
  try {
    await run.load();
    run.player.togglePlay();
    await run.advance(100);
    const started = run.audioSyncs.length;
    await run.advance(1000);
    // the hidden video stays paused and sends no timeupdate, so the status reads stand in for it
    assert.ok(run.audioSyncs.length - started >= 8, `${run.audioSyncs.length - started} syncs in a second of playing`);
    run.player.togglePlay();
    await run.advance(1000);
    const paused = run.audioSyncs.length;
    await run.advance(1000);
    assert.equal(run.audioSyncs.length, paused, "nothing more to follow while paused");
  } finally {
    run.player.dispose();
  }
});

test("the engine plays the mix Python compiles, and only the newest one", async () => {
  const mix = (gain: number) => ({
    duration: 10,
    voices: [{ path: "/videos/a.mp4", stream: 0, pieces: [{
      start: 0, end: 10, sourceIn: 0, gain, fadeIn: 0, fadeOut: 0, loopStart: 0, loopSpan: 0,
    }] }],
  });
  const answers: Array<(gain: number) => void> = [];
  const requests: unknown[] = [];
  const run = setup({
    compilePreviewMix: (request) => {
      requests.push(request);
      return new Promise((resolve) => answers.push((gain) => resolve({ ok: true, value: { data: mix(gain) } })));
    },
  });
  try {
    await run.load();
    await run.advance(100);
    assert.deepEqual(requests, [{ source: "a" }], "compiled from the export's request once the video opens");
    answers[0]?.(1);
    await run.advance(20);
    assert.deepEqual(run.fixture.mixes, [mix(1)]);
    // two edits in a row: the first compile finishes last and is dropped
    run.player.refreshMix?.();
    await run.advance(100);
    run.player.refreshMix?.();
    await run.advance(100);
    answers[2]?.(0.5);
    await run.advance(20);
    answers[1]?.(0.25);
    await run.advance(20);
    assert.deepEqual(run.fixture.mixes, [mix(1), mix(0.5)]);
  } finally {
    run.player.dispose();
  }
});

test("an edit the export refuses plays no sound, and a timeout keeps the last mix", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  const playing = {
    duration: 10,
    voices: [{ path: "/videos/a.mp4", stream: 0, pieces: [{
      start: 0, end: 10, sourceIn: 0, gain: 1, fadeIn: 0, fadeOut: 0, loopStart: 0, loopSpan: 0,
    }] }],
  };
  const answers = [
    { ok: true as const, value: { data: playing } },
    { ok: false as const, error: { code: "BACKEND_TIMEOUT", message: "The backend did not answer in time.", details: {} } },
    { ok: false as const, error: { code: "INTERNAL_ERROR", message: "Use Compress or Upscale to keep timeline gaps, or close the gaps.", details: {} } },
  ];
  const run = setup({ compilePreviewMix: async () => answers.shift() ?? answers[answers.length - 1]! });
  try {
    await run.load();
    await run.advance(100);
    assert.deepEqual(run.fixture.mixes, [playing]);
    run.player.refreshMix?.();
    await run.advance(100);
    assert.deepEqual(run.fixture.mixes, [playing], "a timeout keeps the sound that was playing");
    run.player.refreshMix?.();
    await run.advance(100);
    assert.deepEqual(run.fixture.mixes, [playing, { duration: 10, voices: [] }]);
    assert.equal(errors.length, 2);
  } finally {
    console.error = original;
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

test("the player report passes the shell's answer on, and nothing when the shell can't answer", async () => {
  const report = { mode: "player", library: { loaded: false, interface: 8, error: "missing" }, status: null };
  const asked: string[] = [];
  assert.deepEqual(await readPlayerReport(async (command) => { asked.push(command); return report; }), report);
  assert.deepEqual(asked, ["player_report"]);
  assert.equal(await readPlayerReport(async () => { throw new Error("no shell"); }), null);
  assert.equal(await readPlayerReport(async () => ["player"]), null);
});
