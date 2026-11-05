import assert from "node:assert/strict";
import test from "node:test";

import { findMatch, sortedPaths } from "../../src/features/library/library-order.ts";
import type { EditorClip } from "../../src/features/editor/types.ts";

function clip(name: string, data: { modified?: number; size?: number; duration?: number }): EditorClip {
  return {
    name,
    _fileSize: data.size,
    probeData: data.modified === undefined && data.duration === undefined ? null : { modified: data.modified, duration: data.duration },
  } as unknown as EditorClip;
}

const clips = {
  a: clip("Replay 10.mp4", { modified: 300, size: 50, duration: 30 }),
  b: clip("replay 9.mp4", { modified: 100, size: 900, duration: 120 }),
  c: clip("Clutch.mp4", { modified: 200, size: 400, duration: 60 }),
  // still loading: its date and length aren't known yet
  d: clip("Ace.mp4", {}),
};
const paths = ["a", "b", "c", "d"];

test("each order sorts what it knows and keeps loading videos last, in their order", () => {
  assert.deepEqual(sortedPaths(paths, clips, "yours"), paths);
  assert.deepEqual(sortedPaths(paths, clips, "newest"), ["a", "c", "b", "d"]);
  assert.deepEqual(sortedPaths(paths, clips, "oldest"), ["b", "c", "a", "d"]);
  // numbers in names count as numbers, and capitals don't matter
  assert.deepEqual(sortedPaths(paths, clips, "name"), ["d", "c", "b", "a"]);
  assert.deepEqual(sortedPaths(paths, clips, "longest"), ["b", "c", "a", "d"]);
  assert.deepEqual(sortedPaths(["d", "a", "b"], clips, "largest"), ["b", "a", "d"]);
});

test("Find matches names ignoring capitals", () => {
  assert.deepEqual(findMatch("Replay 2026-10-30.mp4", "10-30"), [12, 17]);
  assert.deepEqual(findMatch("Clutch 1v4.mp4", "CLUTCH"), [0, 6]);
  assert.equal(findMatch("Clutch.mp4", "ace"), null);
  assert.equal(findMatch("Clutch.mp4", "  "), null);
});
