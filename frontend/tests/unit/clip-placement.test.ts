import assert from "node:assert/strict";
import test from "node:test";
import * as editing from "../../src/features/timeline/segments.ts";

test("legacy movement changes the selected footage without adding placement", () => {
  const original = [{ start: 10, end: 60, muted: true }];
  assert.deepEqual(editing.moveSegment(original, 0, 0, 60, false), [{ start: 0, end: 50, muted: true }]);
  assert.deepEqual(original, [{ start: 10, end: 60, muted: true }]);
});

test("legacy movement on an existing placement shifts footage and stays within source bounds", () => {
  const original = [{ start: 5, end: 25, sourceStart: 10 }];
  assert.deepEqual(editing.moveSegment(original, 0, 10, 60, false), [{ start: 10, end: 30, sourceStart: 15 }]);
  assert.deepEqual(editing.moveSegment([{ start: 20, end: 40, sourceStart: 5 }], 0, 0, 60, false),
    [{ start: 15, end: 35, sourceStart: 0 }]);
  assert.deepEqual(editing.moveSegment([{ start: 0, end: 20, sourceStart: 35 }], 0, 30, 60, false),
    [{ start: 5, end: 25, sourceStart: 40 }]);
  assert.deepEqual(original, [{ start: 5, end: 25, sourceStart: 10 }]);
});

test("switching movement modes preserves neighbors and keeps the current source in the new mode", () => {
  const legacy = editing.moveSegment([{ start: 1, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 9 }], 1, 0, 10, false);
  assert.deepEqual(legacy, [{ start: 1, end: 2 }, { start: 2, end: 4 }, { start: 8, end: 9 }]);
  assert.deepEqual(editing.moveSegment(legacy, 1, 5, 10), [
    { start: 1, end: 2, sourceStart: 1 }, { start: 5, end: 7, sourceStart: 2 }, { start: 8, end: 9, sourceStart: 8 },
  ]);
});

test("moving a trimmed video to zero keeps its first and last source frames", () => {
  const original = [{ start: 10, end: 60, muted: true }];
  const moved = editing.moveSegment(original, 0, 0, 60);
  assert.deepEqual(moved, [{ start: 0, end: 50, sourceStart: 10, muted: true }]);
  assert.deepEqual(original, [{ start: 10, end: 60, muted: true }]);
  assert.deepEqual(editing.moveSegment(moved, 0, 5, 60), [
    { start: 5, end: 55, sourceStart: 10, muted: true },
  ]);
});

test("moving one video segment preserves all source ranges and timeline neighbors", () => {
  assert.deepEqual(editing.moveSegment([
    { start: 1, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 9 },
  ], 1, 1, 10), [
    { start: 1, end: 2, sourceStart: 1 },
    { start: 2, end: 4, sourceStart: 4 },
    { start: 8, end: 9, sourceStart: 8 },
  ]);
});

test("a clamped video move that changes nothing does not convert the timeline", () => {
  assert.deepEqual(editing.moveSegment([{ start: 0, end: 10 }], 0, -4, 10), [
    { start: 0, end: 10 },
  ]);
});

test("trimming a positioned video adjusts source edges without restoring discarded footage", () => {
  const moved = editing.moveSegment([{ start: 10, end: 60 }], 0, 0, 60);
  assert.deepEqual(editing.editEndpoint(moved, 0, "start", 5, 60), [
    { start: 5, end: 50, sourceStart: 15 },
  ]);
  assert.deepEqual(editing.editEndpoint(moved, 0, "end", 59, 60), [
    { start: 0, end: 50, sourceStart: 10 },
  ]);
});

test("splitting and cloning a positioned video preserve source continuity", () => {
  const moved = editing.moveSegment([{ start: 10, end: 60 }], 0, 0, 60);
  const split = editing.splitAt(moved, 20, 60);
  assert.deepEqual(split?.segments, [
    { start: 0, end: 20, sourceStart: 10 },
    { start: 20, end: 50, sourceStart: 30 },
  ]);
  assert.deepEqual(editing.cloneSegments(moved), moved);
});

test("Alt-slip changes footage within source bounds without moving the video", () => {
  const placed = [{ start: 0, end: 20, sourceStart: 10 }];
  assert.deepEqual(editing.slipSegment(placed, 0, 5, 60), [{ start: 0, end: 20, sourceStart: 15 }]);
  assert.deepEqual(editing.slipSegment(placed, 0, -50, 60), [{ start: 0, end: 20, sourceStart: 0 }]);
  assert.deepEqual(editing.slipSegment(placed, 0, 90, 60), [{ start: 0, end: 20, sourceStart: 40 }]);
});

test("positioned source seeks and export requests use the same footage", () => {
  const placed = [{ start: 0, end: 20, sourceStart: 10 }, { start: 25, end: 35, sourceStart: 40 }];
  assert.equal(editing.sourceTimeAt(placed, 5), 15);
  assert.equal(editing.sourceTimeAt(placed, 23), null);
  assert.equal(editing.sourceTimeAt(placed, 30), 45);
  assert.equal(editing.timelineTimeAt(placed, 15), 5);
  assert.deepEqual(editing.exportSegments(placed), [
    { start: 10, end: 30, timeline_start: 0 },
    { start: 40, end: 50, timeline_start: 25 },
  ]);
  assert.deepEqual(editing.exportSegments([{ start: 10, end: 60 }]), [{ start: 10, end: 60 }]);
});

test("I at a positioned playhead trims the corresponding source in-point", () => {
  assert.deepEqual(editing.setBoundaryAt([{ start: 0, end: 50, sourceStart: 10 }], "start", 5, 60)?.segments,
    [{ start: 5, end: 50, sourceStart: 15 }]);
});
