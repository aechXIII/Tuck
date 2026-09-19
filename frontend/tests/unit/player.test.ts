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
