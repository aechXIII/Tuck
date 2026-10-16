import assert from "node:assert/strict";
import test from "node:test";
import { installPlayer, type PlayerHost } from "../../src/features/player/player.ts";
import type { SegmentRange } from "../../src/features/timeline/segments.ts";

function setup(segments: SegmentRange[], loop = false) {
  const frames = new Map<number, FrameRequestCallback>();
  const playheads: number[] = [];
  const gaps: boolean[] = [];
  let syncs = 0;
  let next = 0;
  let failPlay = false;
  const video = Object.assign(new EventTarget(), {
    currentTime: 0, duration: 60, paused: true, ended: false, playbackRate: 1,
    defaultPlaybackRate: 1,
    pause() { this.paused = true; video.dispatchEvent(new Event("pause")); },
    play() {
      if (failPlay) return Promise.reject(new Error("unavailable"));
      this.paused = false;
      video.dispatchEvent(new Event("play"));
      return Promise.resolve();
    },
  });
  const host: PlayerHost = {
    byId: <T extends HTMLElement>(id: string) => id === "vid" ? video as unknown as T : null,
    clips: () => ({}), selPath: () => null,
    getMuted: () => false, setMuted: () => {}, getVolBefore: () => 80, setVolBefore: () => {},
    playbackSegments: () => segments, clipSegments: () => segments, videoDuration: () => 60,
    setPlayheadUI: time => { playheads.push(time); }, setPreviewGap: gap => { gaps.push(gap); },
    AudioTimeline: { applyPreviewVolume() {}, syncPreview() { syncs++; } },
    loopPlayback: () => loop, document: {} as Document,
    clock: {
      setTimeout: () => 0, clearTimeout() {},
      requestAnimationFrame: callback => { frames.set(++next, callback); return next; },
      cancelAnimationFrame: id => { frames.delete(id); },
    },
  };
  const player = installPlayer(host);
  const tick = (milliseconds: number) => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(milliseconds);
  };
  const seek = (time: number) => { player.seekPreview(time); tick(0); video.dispatchEvent(new Event("seeked")); };
  return { player, video, tick, seek, playheads, gaps, frames, syncs: () => syncs, failPlay: () => { failPlay = true; },
    replaceSegments: (nextSegments: SegmentRange[]) => { segments = nextSegments; } };
}

test("placed seeks, stepping and frame capture map project time to source footage", () => {
  const s = setup([{ start: 0, end: 50, sourceStart: 10 }]);
  try {
    s.seek(2);
    assert.equal(s.video.currentTime, 12);
    assert.equal(s.player.timelineTime(), 2);
    assert.equal(s.player.sourceTime(), 12);
    s.player.setPreviewSec(2);
    assert.equal(s.player.captureFrameTime(), 12);
    s.player.seekBy(3); s.tick(1); s.video.dispatchEvent(new Event("seeked"));
    assert.equal(s.video.currentTime, 15);
    s.player.stepFrame(1); s.tick(2);
    assert.ok(Math.abs(s.video.currentTime - (15 + 1 / 30)) < 0.00001);
  } finally { s.player.dispose(); }
});

test("placed scrubs preserve slow decoder batching and capture the latest source request", () => {
  const s = setup([{ start: 0, end: 50, sourceStart: 10 }]);
  try {
    s.player.seekPreview(1); s.tick(0);
    s.player.seekPreview(7); s.tick(1);
    assert.equal(s.video.currentTime, 11);
    assert.equal(s.player.captureFrameTime(), 17);
    s.video.dispatchEvent(new Event("seeked"));
    assert.equal(s.video.currentTime, 17);
  } finally { s.player.dispose(); }
});

test("leading and internal gaps stay black while project playback and music continue", () => {
  const s = setup([{ start: 2, end: 4, sourceStart: 10 }, { start: 6, end: 8, sourceStart: 20 }]);
  try {
    s.seek(0);
    assert.equal(s.gaps.at(-1), true);
    assert.equal(s.player.sourceTime(), null);
    assert.throws(() => s.player.captureFrameTime(), /gap/i);
    s.player.togglePlay(); s.tick(0); s.tick(1000);
    assert.equal(s.player.isPlaying(), true);
    assert.equal(s.video.paused, true);
    assert.equal(s.player.timelineTime(), 1);
    assert.equal(s.playheads.at(-1), 1);
    assert.ok(s.syncs() > 0);
    s.tick(2000);
    assert.equal(s.video.currentTime, 10);
    assert.equal(s.video.paused, false);
    assert.equal(s.gaps.at(-1), false);
    s.video.currentTime = 11.5; s.tick(2500);
    assert.equal(s.player.timelineTime(), 3.5);
    assert.equal(s.playheads.at(-1), 3.5);
    s.video.currentTime = 12; s.tick(3000);
    assert.equal(s.player.timelineTime(), 4);
    assert.equal(s.video.paused, true);
    assert.equal(s.player.isPlaying(), true);
    s.tick(4000);
    assert.equal(s.player.timelineTime(), 5);
    s.tick(5000);
    assert.equal(s.video.currentTime, 20);
    assert.equal(s.player.timelineTime(), 6);
    s.player.togglePlay();
    assert.equal(s.player.isPlaying(), false);
    assert.equal(s.frames.size, 0);
  } finally { s.player.dispose(); }
});

test("project gaps follow playback speed and stop or loop at the placed end", () => {
  for (const loop of [false, true]) {
    const s = setup([{ start: 2, end: 3, sourceStart: 10 }], loop);
    try {
      s.seek(0); s.player.changeSpeed(1);
      s.player.togglePlay(); s.tick(0); s.tick(1000);
      assert.equal(s.player.timelineTime(), 1.5);
      s.tick(1400);
      assert.ok(Math.abs(s.video.currentTime - 10.1) < 0.00001);
      s.video.currentTime = 11; s.tick(2000);
      assert.equal(s.player.isPlaying(), loop);
      assert.equal(s.player.timelineTime(), loop ? 0 : 3);
      assert.equal(s.video.paused, true);
    } finally { s.player.dispose(); }
  }
});

test("source resets and disposal abandon gap playback, frames and queued seeks", () => {
  for (const action of ["emptied", "error", "dispose"]) {
    const s = setup([{ start: 2, end: 4, sourceStart: 10 }]);
    s.seek(0); s.player.togglePlay(); s.tick(0); s.tick(1000);
    if (action === "dispose") s.player.dispose();
    else s.video.dispatchEvent(new Event(action));
    assert.equal(s.player.isPlaying(), false);
    assert.equal(s.frames.size, 0);
    assert.equal(s.gaps.at(-1), false);
    s.video.dispatchEvent(new Event("seeked"));
    assert.equal(s.video.currentTime, 0);
    s.player.dispose();
  }
});

test("failed native playback stops the project and its imported music", async () => {
  const s = setup([{ start: 0, end: 3, sourceStart: 10 }]);
  try {
    s.seek(0); s.failPlay(); s.player.togglePlay();
    await Promise.resolve();
    assert.equal(s.player.isPlaying(), false);
    assert.equal(s.frames.size, 0);
  } finally { s.player.dispose(); }
});

test("native media ending enters the next project gap even when pause arrives first", () => {
  const s = setup([{ start: 0, end: 2, sourceStart: 58 }, { start: 4, end: 5, sourceStart: 10 }]);
  try {
    s.seek(0); s.player.togglePlay(); s.tick(0);
    s.video.currentTime = 60;
    s.video.ended = true;
    s.video.pause();
    s.video.dispatchEvent(new Event("ended"));
    assert.equal(s.player.isPlaying(), true);
    assert.equal(s.player.timelineTime(), 2);
    assert.equal(s.gaps.at(-1), true);
    s.tick(1000);
    assert.equal(s.player.timelineTime(), 3);
  } finally { s.player.dispose(); }
});

test("repeated source ranges keep the playhead in the active project segment", () => {
  const s = setup([{ start: 0, end: 2, sourceStart: 10 }, { start: 2, end: 4, sourceStart: 10 }]);
  try {
    s.seek(3); s.player.togglePlay(); s.tick(0);
    s.video.currentTime = 11.5; s.tick(500);
    assert.equal(s.player.timelineTime(), 3.5);
    assert.equal(s.player.captureFrameTime(), 11.5);
    assert.equal(s.player.timelineTime(), 3.5);
  } finally { s.player.dispose(); }
});

test("disposed playback cannot schedule work again", () => {
  const s = setup([{ start: 0, end: 3, sourceStart: 10 }]);
  s.player.dispose();
  s.player.togglePlay();
  s.player.continuePlaybackAt(1);
  assert.equal(s.frames.size, 0);
  assert.equal(s.video.paused, true);
});

test("seeking into a gap abandons a pending source seek and leaves no capture target", () => {
  const s = setup([{ start: 2, end: 5, sourceStart: 10 }]);
  try {
    s.player.seekPreview(3); s.tick(0);
    s.player.seekPreview(4); s.tick(1);
    assert.equal(s.video.currentTime, 11);
    s.seek(0);
    assert.equal(s.video.currentTime, 11);
    assert.equal(s.player.sourceTime(), null);
    assert.throws(() => s.player.captureFrameTime(), /gap/i);
    s.video.dispatchEvent(new Event("seeked"));
    assert.equal(s.video.currentTime, 11);
    s.seek(4);
    assert.equal(s.video.currentTime, 12);
  } finally { s.player.dispose(); }
});

test("resetting placed segments clears a paused gap and restores legacy playback", () => {
  const s = setup([{ start: 2, end: 5, sourceStart: 10 }]);
  try {
    s.seek(0);
    s.replaceSegments([{ start: 0, end: 60 }]);
    s.player.updateTime();
    assert.equal(s.gaps.at(-1), false);
    s.seek(3);
    assert.equal(s.video.currentTime, 3);
    s.player.togglePlay(); s.tick(1000);
    assert.equal(s.player.isPlaying(), true);
    assert.equal(s.video.paused, false);
  } finally { s.player.dispose(); }
});

test("resetting segments while a project gap plays resumes the native source clock", () => {
  const s = setup([{ start: 2, end: 5, sourceStart: 10 }]);
  try {
    s.seek(0); s.player.togglePlay(); s.tick(0); s.tick(1000);
    s.replaceSegments([{ start: 0, end: 60 }]); s.player.updateTime();
    assert.equal(s.gaps.at(-1), false);
    assert.equal(s.video.paused, false);
    assert.equal(s.video.currentTime, 1);
    assert.equal(s.player.isPlaying(), true);
    s.video.currentTime = 2; s.tick(2000);
    assert.equal(s.playheads.at(-1), 2);
    s.replaceSegments([{ start: 0, end: 10, sourceStart: 10 }]); s.player.updateTime();
    assert.equal(s.player.isPlaying(), true);
    assert.equal(s.gaps.at(-1), false);
    assert.equal(s.video.currentTime, 12);
    assert.equal(s.player.timelineTime(), 2);
  } finally { s.player.dispose(); }
});

test("undo and redo slip reconcile the paused source while preserving the project playhead", () => {
  const s = setup([{ start: 0, end: 5, sourceStart: 15 }]);
  try {
    s.seek(1);
    s.replaceSegments([{ start: 0, end: 5, sourceStart: 10 }]); s.player.updateTime(); s.tick(0);
    assert.equal(s.video.currentTime, 11);
    assert.equal(s.player.timelineTime(), 1);
    assert.equal(s.player.captureFrameTime(), 11);
    s.video.dispatchEvent(new Event("seeked"));
    s.replaceSegments([{ start: 0, end: 5, sourceStart: 15 }]); s.player.updateTime(); s.tick(1);
    assert.equal(s.video.currentTime, 16);
    assert.equal(s.player.timelineTime(), 1);
  } finally { s.player.dispose(); }
});

test("undoing a move recalculates a paused gap and seeks the restored footage", () => {
  const s = setup([{ start: 3, end: 8, sourceStart: 10 }]);
  try {
    s.seek(1);
    s.replaceSegments([{ start: 0, end: 5, sourceStart: 10 }]); s.player.updateTime(); s.tick(0);
    assert.equal(s.gaps.at(-1), false);
    assert.equal(s.video.currentTime, 11);
    s.video.dispatchEvent(new Event("seeked"));
    s.replaceSegments([{ start: 3, end: 8, sourceStart: 10 }]); s.player.updateTime(); s.tick(1);
    assert.equal(s.gaps.at(-1), true);
    assert.equal(s.player.sourceTime(), null);
  } finally { s.player.dispose(); }
});

test("slip undo while playing keeps project time and changes the native footage", () => {
  const s = setup([{ start: 0, end: 5, sourceStart: 15 }]);
  try {
    s.seek(1); s.player.togglePlay(); s.tick(0);
    s.video.currentTime = 17;
    s.replaceSegments([{ start: 0, end: 5, sourceStart: 10 }]); s.player.updateTime();
    assert.equal(s.video.currentTime, 12);
    assert.equal(s.player.timelineTime(), 2);
    assert.equal(s.player.isPlaying(), true);
    assert.equal(s.frames.size, 1);
  } finally { s.player.dispose(); }
});

test("repeated slip edits wait for the active decoder seek before applying the latest source", () => {
  const s = setup([{ start: 0, end: 5, sourceStart: 10 }]);
  try {
    s.player.seekPreview(1); s.tick(0);
    s.replaceSegments([{ start: 0, end: 5, sourceStart: 15 }]); s.player.updateTime(); s.tick(1);
    s.replaceSegments([{ start: 0, end: 5, sourceStart: 20 }]); s.player.updateTime(); s.tick(2);
    assert.equal(s.video.currentTime, 11);
    assert.equal(s.player.captureFrameTime(), 21);
    s.video.dispatchEvent(new Event("seeked"));
    assert.equal(s.video.currentTime, 21);
  } finally { s.player.dispose(); }
});

test("loading a placed clip seeks its source in-point only after metadata arrives", () => {
  const s = setup([{ start: 0, end: 50, sourceStart: 10 }]);
  try {
    s.seek(2);
    s.video.dispatchEvent(new Event("emptied"));
    s.video.currentTime = 0;
    s.video.dispatchEvent(new Event("durationchange")); s.tick(0);
    assert.equal(s.video.currentTime, 0);
    assert.equal(s.frames.size, 0);
    s.video.dispatchEvent(new Event("loadedmetadata")); s.tick(1);
    assert.equal(s.video.currentTime, 10);
    assert.equal(s.player.timelineTime(), 0);
    assert.equal(s.player.sourceTime(), 10);
  } finally { s.player.dispose(); }
});

test("loading a placed clip with a leading gap restores the black preview", () => {
  const s = setup([{ start: 2, end: 22, sourceStart: 10 }]);
  try {
    s.seek(3);
    s.video.dispatchEvent(new Event("emptied"));
    s.video.currentTime = 0;
    s.video.dispatchEvent(new Event("loadedmetadata")); s.tick(0);
    assert.equal(s.gaps.at(-1), true);
    assert.equal(s.video.currentTime, 0);
    assert.equal(s.player.timelineTime(), 0);
    assert.equal(s.player.sourceTime(), null);
    s.player.togglePlay(); s.tick(0); s.tick(2000);
    assert.equal(s.video.currentTime, 10);
    assert.equal(s.gaps.at(-1), false);
  } finally { s.player.dispose(); }
});

test("loading an unplaced full clip retains its native initial frame", () => {
  const s = setup([{ start: 0, end: 60 }]);
  try {
    s.video.dispatchEvent(new Event("emptied"));
    s.video.dispatchEvent(new Event("loadedmetadata")); s.tick(0);
    assert.equal(s.video.currentTime, 0);
    assert.equal(s.frames.size, 0);
    assert.equal(s.player.sourceTime(), 0);
  } finally { s.player.dispose(); }
});

test("a leading gap stays at project zero when its placed footage starts at source zero", () => {
  const s = setup([{ start: 2, end: 22, sourceStart: 0 }]);
  try {
    s.video.dispatchEvent(new Event("emptied"));
    s.video.dispatchEvent(new Event("durationchange"));
    s.video.dispatchEvent(new Event("loadedmetadata")); s.tick(0);
    assert.equal(s.player.timelineTime(), 0);
    assert.equal(s.player.sourceTime(), null);
    assert.equal(s.gaps.at(-1), true);
  } finally { s.player.dispose(); }
});
