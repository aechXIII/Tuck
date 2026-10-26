import assert from "node:assert/strict";
import test from "node:test";

import {
  addMuteRanges,
  isMutedAt,
  keptSourceTrackCount,
  laneToSourceRanges,
  muteRangeIndexAt,
  normalizeMuteRanges,
  removeMuteRange,
  setMuteRangeEdge,
  sourceToLaneRanges,
} from "../../src/features/audio/mute-ranges.ts";

test("muting a stretch joins it with the ones it overlaps or touches", () => {
  const ranges = [{ start: 1, end: 2 }, { start: 5, end: 6 }];
  assert.deepEqual(addMuteRanges(ranges, [{ start: 1.5, end: 3 }]), [
    { start: 1, end: 3 },
    { start: 5, end: 6 },
  ]);
  assert.deepEqual(addMuteRanges(ranges, [{ start: 2, end: 5 }]), [{ start: 1, end: 6 }]);
  // the original list is left as it was, so undo snapshots stay intact
  assert.deepEqual(ranges, [{ start: 1, end: 2 }, { start: 5, end: 6 }]);
});

test("a click-sized stretch is not muted", () => {
  assert.equal(addMuteRanges([], [{ start: 1, end: 1.01 }]), null);
  assert.deepEqual(normalizeMuteRanges([{ start: 3, end: 3.01 }, { start: -1, end: 1 }]), [{ start: 0, end: 1 }]);
});

test("unmuting removes only the picked stretch", () => {
  assert.deepEqual(removeMuteRange([{ start: 1, end: 2 }, { start: 3, end: 4 }], 0), [{ start: 3, end: 4 }]);
});

test("an edge moves to the playhead, joining a neighbor it reaches", () => {
  const ranges = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
  assert.deepEqual(setMuteRangeEdge(ranges, 0, "end", 2.5), [{ start: 1, end: 2.5 }, { start: 3, end: 4 }]);
  assert.deepEqual(setMuteRangeEdge(ranges, 0, "end", 3.5), [{ start: 1, end: 4 }]);
  assert.deepEqual(setMuteRangeEdge(ranges, 1, "start", 0.5), [{ start: 0.5, end: 4 }]);
  // an edge past the other one would leave nothing to mute
  assert.equal(setMuteRangeEdge(ranges, 0, "start", 2.5), null);
  assert.equal(setMuteRangeEdge(ranges, 4, "start", 0), null);
});

test("a time inside a stretch is muted, its end is not", () => {
  const ranges = [{ start: 1, end: 2 }];
  assert.equal(isMutedAt(ranges, 1), true);
  assert.equal(isMutedAt(ranges, 1.99), true);
  assert.equal(isMutedAt(ranges, 2), false);
  assert.equal(isMutedAt(undefined, 1), false);
  assert.equal(muteRangeIndexAt(ranges, 0.5), -1);
});

test("without moved clips a source lane is the source's own time", () => {
  const segments = [{ start: 0, end: 4 }, { start: 6, end: 10 }];
  assert.deepEqual(laneToSourceRanges(segments, 3, 7), [{ start: 3, end: 7 }]);
  assert.deepEqual(sourceToLaneRanges(segments, { start: 3, end: 7 }), [{ start: 3, end: 7 }]);
});

test("on moved clips a stretch is kept in source time and drawn where the clips are", () => {
  // the second half of the video plays first
  const segments = [
    { start: 0, end: 5, sourceStart: 5 },
    { start: 5, end: 10, sourceStart: 0 },
  ];
  const stored = laneToSourceRanges(segments, 4, 6);
  assert.deepEqual(stored, [{ start: 9, end: 10 }, { start: 0, end: 1 }]);
  assert.deepEqual(sourceToLaneRanges(segments, { start: 9, end: 10 }), [{ start: 4, end: 5 }]);
  assert.deepEqual(sourceToLaneRanges(segments, { start: 0, end: 1 }), [{ start: 5, end: 6 }]);
  // footage no clip shows has nowhere to be drawn
  assert.deepEqual(sourceToLaneRanges([{ start: 0, end: 2, sourceStart: 3 }], { start: 0, end: 1 }), []);
});

test("the Export as choice counts the source tracks that are kept", () => {
  assert.equal(keptSourceTrackCount(false, false, [{ muted: false }]), 0);
  assert.equal(keptSourceTrackCount(true, false, []), 1);
  assert.equal(keptSourceTrackCount(true, false, [{ muted: false }]), 2);
  assert.equal(keptSourceTrackCount(true, true, [{ muted: false }, { muted: true }]), 1);
});
