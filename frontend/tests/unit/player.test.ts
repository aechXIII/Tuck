import assert from "node:assert/strict";
import test from "node:test";
import { installPlayer, type PlayerHost } from "../../src/features/player/player.ts";

function setup() {
  const video = Object.assign(new EventTarget(), {currentTime: 0, paused: true});
  const timers = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const host: PlayerHost = {
    byId: <T extends HTMLElement>(id: string) => id === "vid" ? video as unknown as T : null,
    clips: () => ({}), selPath: () => null,
    getMuted: () => false, setMuted: () => {}, getVolBefore: () => 80, setVolBefore: () => {},
    playbackSegments: () => [], clipSegments: () => [], videoDuration: () => 10,
    setPlayheadUI: () => {}, document: {} as Document,
    clock: {
      setTimeout: callback => { timers.set(++next, callback); return next; },
      clearTimeout: id => { timers.delete(id); },
      requestAnimationFrame: callback => { frames.set(++next, callback); return next; },
      cancelAnimationFrame: id => { frames.delete(id); },
    },
  };
  const player = installPlayer(host);
  function seek(time: number) {
    player.seekPreview(time);
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  }
  return {video, player, seek, timers};
}

test("slow seeks finish before the latest scrub position starts", () => {
  const {video, player, seek, timers} = setup();
  try {
    seek(1); seek(2); seek(7);
    for (const callback of [...timers.values()]) callback();
    assert.equal(video.currentTime, 1);
    video.dispatchEvent(new Event("seeked"));
    assert.equal(video.currentTime, 7);
  } finally { player.dispose(); }
});

test("changing source or disposing abandons a queued seek", () => {
  for (const action of ["emptied", "error", "dispose"]) {
    const {video, player, seek} = setup();
    seek(1); seek(7);
    if (action === "dispose") player.dispose();
    else video.dispatchEvent(new Event(action));
    video.currentTime = 0;
    video.dispatchEvent(new Event("seeked"));
    assert.equal(video.currentTime, 0);
    if (action !== "dispose") { seek(3); assert.equal(video.currentTime, 3); }
    player.dispose();
  }
});

function loopSetup(loop: boolean) {
  const calls: string[] = [];
  const video = Object.assign(new EventTarget(), {
    currentTime: 5,
    paused: false,
    duration: 10,
    pause() { calls.push("pause"); this.paused = true; },
    play() { calls.push("play"); this.paused = false; return Promise.resolve(); },
  });
  const segments = [{ start: 2, end: 4 }];
  const host: PlayerHost = {
    byId: <T extends HTMLElement>(id: string) => id === "vid" ? video as unknown as T : null,
    clips: () => ({ a: {} as never }), selPath: () => "a",
    getMuted: () => false, setMuted: () => {}, getVolBefore: () => 80, setVolBefore: () => {},
    playbackSegments: () => segments, clipSegments: () => segments, videoDuration: () => 10,
    setPlayheadUI: () => {}, document: {} as Document,
    loopPlayback: () => loop,
    clock: {
      setTimeout: () => 0, clearTimeout: () => {},
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    },
  };
  return { video, calls, player: installPlayer(host) };
}

test("past the last segment, playback loops back or stops as chosen", () => {
  const looping = loopSetup(true);
  try {
    looping.player.updateTime();
    assert.deepEqual(looping.calls, ["play"]);
    assert.equal(looping.video.currentTime, 2);
  } finally { looping.player.dispose(); }

  const stopping = loopSetup(false);
  try {
    stopping.player.updateTime();
    assert.deepEqual(stopping.calls, ["pause"]);
    assert.equal(stopping.video.currentTime, 5);
    // the end of the video doesn't start it again either
    stopping.video.dispatchEvent(new Event("ended"));
    assert.deepEqual(stopping.calls, ["pause"]);
  } finally { stopping.player.dispose(); }
});

test("while playing, the playhead follows every decoded frame and stops at a segment's end", () => {
  const playheads: number[] = [];
  const calls: string[] = [];
  const frameCallbacks = new Map<number, VideoFrameRequestCallback>();
  let nextFrame = 0;
  const segments = [{ start: 0, end: 4 }, { start: 6, end: 8 }];
  const video = Object.assign(new EventTarget(), {
    currentTime: 3.9,
    paused: false,
    ended: false,
    duration: 10,
    pause() { calls.push("pause"); this.paused = true; },
    play() { calls.push("play"); this.paused = false; return Promise.resolve(); },
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) { frameCallbacks.set(++nextFrame, callback); return nextFrame; },
    cancelVideoFrameCallback(id: number) { frameCallbacks.delete(id); },
  });
  const host: PlayerHost = {
    byId: <T extends HTMLElement>(id: string) => id === "vid" ? video as unknown as T : null,
    clips: () => ({ a: {} as never }), selPath: () => "a",
    getMuted: () => false, setMuted: () => {}, getVolBefore: () => 80, setVolBefore: () => {},
    playbackSegments: () => segments, clipSegments: () => segments, videoDuration: () => 10,
    setPlayheadUI: (time) => { playheads.push(time); }, document: {} as Document,
    loopPlayback: () => true,
    clock: {
      setTimeout: () => 0, clearTimeout: () => {},
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    },
  };
  const player = installPlayer(host);
  const nextFrameTick = (time: number): void => {
    video.currentTime = time;
    const pending = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of pending) callback(0, {} as VideoFrameCallbackMetadata);
  };
  try {
    video.dispatchEvent(new Event("play"));
    nextFrameTick(3.95);
    assert.equal(playheads.at(-1), 3.95);
    // the frame past the segment's end moves straight on to the next segment
    nextFrameTick(4.02);
    assert.equal(video.currentTime, 6);
    assert.ok(frameCallbacks.size > 0);

    video.paused = true;
    video.dispatchEvent(new Event("pause"));
    assert.equal(frameCallbacks.size, 0);
  } finally { player.dispose(); }
});
