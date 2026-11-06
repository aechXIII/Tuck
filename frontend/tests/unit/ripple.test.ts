import assert from "node:assert/strict";
import test from "node:test";

import type { AudioClip, AudioTimelineState } from "../../src/features/editor/types.ts";
import { rippleAudio, rippleMarkers, rippleTime, takeOut } from "../../src/features/timeline/ripple.ts";
import { removeStretch, timelineGaps } from "../../src/features/timeline/segments.ts";

const three = () => [{ start: 0, end: 20 }, { start: 20, end: 40 }, { start: 40, end: 60 }];

test("a removed segment's place closes up and every segment keeps its footage", () => {
  assert.deepEqual(removeStretch(three(), 20, 40, 60), [
    { start: 0, end: 20, sourceStart: 0 },
    { start: 20, end: 40, sourceStart: 40 },
  ]);
});

test("a stretch inside a segment leaves both of its sides, joined", () => {
  assert.deepEqual(removeStretch(three(), 5, 12, 60), [
    { start: 0, end: 5, sourceStart: 0 },
    { start: 5, end: 13, sourceStart: 12 },
    { start: 13, end: 33, sourceStart: 20 },
    { start: 33, end: 53, sourceStart: 40 },
  ]);
});

test("closing a gap slides only what comes after it, and placed footage stays placed", () => {
  const placed = [{ start: 0, end: 10, sourceStart: 30 }, { start: 25, end: 35, sourceStart: 0 }, { start: 40, end: 45, muted: true }];
  assert.deepEqual(removeStretch(placed, 10, 25, 60), [
    { start: 0, end: 10, sourceStart: 30 },
    { start: 10, end: 20, sourceStart: 0 },
    { start: 25, end: 30, sourceStart: 40, muted: true },
  ]);
});

test("a piece too short to be a segment goes, and an empty stretch changes nothing", () => {
  assert.deepEqual(removeStretch(three(), 0.02, 20, 60).map((segment) => segment.start), [0, 20]);
  assert.deepEqual(removeStretch(three(), 30, 30, 60), three());
});

test("gaps are the empty stretches before and between segments, not after the last", () => {
  assert.deepEqual(timelineGaps([{ start: 5, end: 10 }, { start: 20, end: 30 }], 60), [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
  ]);
  assert.deepEqual(timelineGaps(three(), 60), []);
});

test("markers after the stretch slide; on removed footage they go, in a gap they stay at its start", () => {
  assert.equal(rippleTime(50, 20, 40), 30);
  assert.equal(rippleTime(25, 20, 40), 20);
  assert.equal(rippleTime(10, 20, 40), 10);
  assert.deepEqual(rippleMarkers([10, 25, 50], 20, 40, true), [10, 30]);
  assert.deepEqual(rippleMarkers([10, 25, 50], 20, 40, false), [10, 20, 30]);
  // two markers that land on one moment become one
  assert.deepEqual(rippleMarkers([20, 25], 20, 40, false), [20]);
});

function clip(id: string, timelineStart: number, timelineDuration: number): AudioClip {
  return { id, timelineStart, timelineDuration, sourceIn: 0, sourceOut: timelineDuration, fadeIn: 0, fadeOut: 0, loop: false };
}

function audio(clips: AudioClip[], muteRanges = [{ start: 52, end: 54 }]): AudioTimelineState {
  return {
    enabled: true, sourceMuted: false, sourceGainDb: 0, sourceWaveformUrl: "", sourceWaveformToken: "", sourceWaveformLoading: false,
    tracks: [{ id: "music", sourceDuration: 90, clips, muteRanges }],
  };
}

test("added audio after the stretch slides with it; music playing across it stays put", () => {
  const state = audio([clip("intro", 0, 30), clip("outro", 50, 10)]);
  rippleAudio(state, 20, 40);
  assert.deepEqual(state.tracks[0]!.clips.map((item) => item.timelineStart), [0, 30]);
  // the muted stretch on the outro went with it
  assert.deepEqual(state.tracks[0]!.muteRanges, [{ start: 32, end: 34 }]);
});

test("a clip starting on removed footage moves to the cut, and never into the clip before it", () => {
  const state = audio([clip("a", 5, 20), clip("b", 30, 5), clip("c", 45, 5)], []);
  rippleAudio(state, 20, 40);
  // b would go to 20 and c to 25, but a plays until 25
  assert.deepEqual(state.tracks[0]!.clips.map((item) => item.timelineStart), [5, 25, 30]);
  rippleAudio(null, 0, 1);
});

test("taking a stretch out of a never placed timeline closes its other gaps too, as its export already does", () => {
  // trimmed at the start, a gap at 20 to 30, and the stretch at 40 to 50
  const parts = { segments: [{ start: 5, end: 20 }, { start: 30, end: 40 }, { start: 40, end: 50 }, { start: 50, end: 60 }], markers: [35, 55], audio: null };
  const result = takeOut(parts, 40, 50, true, 60)!;
  assert.deepEqual(result.closedGaps, [{ start: 0, end: 5 }, { start: 20, end: 30 }]);
  assert.equal(result.at, 25);
  assert.deepEqual(result.parts.segments, [
    { start: 0, end: 15, sourceStart: 5 },
    { start: 15, end: 25, sourceStart: 30 },
    { start: 25, end: 35, sourceStart: 50 },
  ]);
  assert.deepEqual(result.parts.markers, [20, 30]);
  // the old parts are left as they were
  assert.equal(parts.segments[0]!.start, 5);
});

test("on a placed timeline only the stretch closes, and closing a gap of a never placed one closes them all", () => {
  const placed = { segments: [{ start: 0, end: 10, sourceStart: 0 }, { start: 20, end: 30, sourceStart: 20 }, { start: 40, end: 50, sourceStart: 40 }], markers: [], audio: null };
  const closed = takeOut(placed, 10, 20, false, 60)!;
  assert.deepEqual(closed.closedGaps, []);
  assert.deepEqual(closed.parts.segments.map((segment) => segment.start), [0, 10, 30]);
  const never = { segments: [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }], markers: [], audio: null };
  assert.deepEqual(takeOut(never, 10, 20, false, 60)!.parts.segments.map((segment) => segment.start), [0, 10, 20]);
  // nothing left is no result
  assert.equal(takeOut({ segments: [{ start: 0, end: 10 }], markers: [], audio: null }, 0, 10, true, 60), null);
});
