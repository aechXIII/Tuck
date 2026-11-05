import assert from "node:assert/strict";
import test from "node:test";

import {
  addMarker,
  markersWithin,
  moveMarker,
  removeMarker,
  splitAtMarkers,
} from "../../src/features/timeline/markers.ts";

test("markers stay in order and one moment gets one marker", () => {
  assert.deepEqual(addMarker([], 5, 10), [5]);
  assert.deepEqual(addMarker([5], 2, 10), [2, 5]);
  assert.equal(addMarker([5], 5.004, 10), null);
  // past the ends a marker lands on the end
  assert.deepEqual(addMarker([5], 12, 10), [5, 10]);
  assert.equal(addMarker([], Number.NaN, 10), null);
  assert.equal(addMarker([], 1, 0), null);
});

test("a moved marker takes its new place in the order", () => {
  assert.deepEqual(moveMarker([2, 5, 8], 0, 6, 10), [5, 6, 8]);
  assert.deepEqual(moveMarker([2, 5], 1, -3, 10), [0, 2]);
  assert.deepEqual(moveMarker([2, 5], 4, 6, 10), [2, 5]);
  assert.deepEqual(removeMarker([2, 5, 8], 1), [2, 8]);
});

test("a shorter video drops the markers past its end", () => {
  assert.deepEqual(markersWithin([1, 4, 9], 5), [1, 4]);
  assert.deepEqual(markersWithin(undefined, 5), []);
  assert.deepEqual(markersWithin([1], 0), []);
});

test("splitting at markers cuts only where a marker is inside a segment", () => {
  const segments = [{ start: 0, end: 4 }, { start: 6, end: 10 }];
  const cut = splitAtMarkers(segments, [2, 5, 8, 9.99], 10);
  assert.deepEqual(cut?.map(({ start, end }) => [start, end]), [[0, 2], [2, 4], [6, 8], [8, 10]]);
  // a marker in a gap or on an edge cuts nothing
  assert.equal(splitAtMarkers(segments, [5, 4], 10), null);
  assert.equal(splitAtMarkers(segments, [], 10), null);
});
