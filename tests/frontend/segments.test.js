"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const segments = require("../../tuck/web/segments.js");

test("omitted segments select the full source", () => {
  assert.deepEqual(segments.normalizeSegments(null, 10), [{ start: 0, end: 10 }]);
  assert.equal(segments.selectedDuration([{ start: 1, end: 2.5 }]), 1.5);
});

test("timeline view state is empty when no video is selected", () => {
  assert.deepEqual(segments.timelineViewState(null, 47.5), {
    status: "empty",
    items: [],
  });
});

test("timeline view state reports loading until probe duration is available", () => {
  assert.deepEqual(segments.timelineViewState({ segments: [] }, 0), {
    status: "loading",
    items: [],
  });
});

test("timeline view state assigns readable segment identities", () => {
  assert.deepEqual(
    segments.timelineViewState(
      {
        segments: [
          { start: 0, end: 2.5 },
          { start: 4, end: 10 },
        ],
      },
      10,
    ),
    {
      status: "ready",
      items: [
        { index: 0, badge: "S1", start: 0, end: 2.5 },
        { index: 1, badge: "S2", start: 4, end: 10 },
      ],
    },
  );
});

test("timeline view state preserves source-audio mute state", () => {
  const state = segments.timelineViewState(
    { segments: [{ start: 0, end: 4, muted: true }] },
    4,
  );

  assert.equal(state.items[0].muted, true);
});

test("normalization rejects invalid, short, unordered, and overlapping ranges", () => {
  assert.throws(
    () => segments.normalizeSegments([{ start: 0, end: Number.POSITIVE_INFINITY }], 10),
    /finite/,
  );
  assert.throws(
    () => segments.normalizeSegments([{ start: 0.1, end: 0.14 }], 10),
    /0.05/,
  );
  assert.throws(
    () =>
      segments.normalizeSegments(
        [
          { start: 2, end: 3 },
          { start: 1, end: 1.5 },
        ],
        10,
      ),
    /ordered/,
  );
  assert.throws(
    () =>
      segments.normalizeSegments(
        [
          { start: 1, end: 3 },
          { start: 2.5, end: 4 },
        ],
        10,
      ),
    /overlap/,
  );
  assert.throws(
    () => segments.normalizeSegments([{ start: 9, end: 11 }], 10),
    /source duration/,
  );
});

test("endpoint editing enforces minimum duration and neighboring segment bounds", () => {
  const source = [
    { start: 1, end: 2 },
    { start: 4, end: 5 },
  ];
  assert.deepEqual(segments.editEndpoint(source, 1, "start", 1.5, 10), [
    { start: 1, end: 2 },
    { start: 2, end: 5 },
  ]);
  assert.deepEqual(segments.editEndpoint(source, 0, "end", 4.5, 10), [
    { start: 1, end: 4 },
    { start: 4, end: 5 },
  ]);
  assert.deepEqual(segments.editEndpoint(source, 0, "start", 1.99, 10), [
    { start: 1.95, end: 2 },
    { start: 4, end: 5 },
  ]);
});

test("adding and removing segments preserves ordered non-overlapping state", () => {
  const added = segments.addSegment([{ start: 1, end: 2 }], 10, 5);
  assert.equal(added.index, 1);
  assert.deepEqual(added.segments, [
    { start: 1, end: 2 },
    { start: 4.5, end: 5.5 },
  ]);
  assert.deepEqual(segments.removeSegment(added.segments, 0, 10), [
    { start: 4.5, end: 5.5 },
  ]);

  assert.equal(segments.canAddSegment([{ start: 0, end: 10 }], 10), false);
  assert.throws(
    () => segments.addSegment([{ start: 0, end: 10 }], 10, 4),
    /create a gap/,
  );
});

test("new segments honor a usable requested duration on long sources", () => {
  const added = segments.addSegment([{ start: 300, end: 1800 }], 1800, 100, 144);

  assert.equal(added.index, 0);
  assert.deepEqual(added.segments, [
    { start: 28, end: 172 },
    { start: 300, end: 1800 },
  ]);
});

test("new segments use the gap nearest an occupied playhead", () => {
  const added = segments.addSegment(
    [
      { start: 300, end: 400 },
      { start: 420, end: 900 },
    ],
    1000,
    450,
    80,
  );

  assert.equal(added.index, 1);
  assert.deepEqual(added.segments, [
    { start: 300, end: 400 },
    { start: 400, end: 420 },
    { start: 420, end: 900 },
  ]);
});

test("moving a segment preserves its duration and stops at neighboring ranges", () => {
  const source = [
    { start: 1, end: 2 },
    { start: 4, end: 6 },
    { start: 8, end: 9 },
  ];

  assert.deepEqual(segments.moveSegment(source, 1, 5, 10), [
    { start: 1, end: 2 },
    { start: 5, end: 7 },
    { start: 8, end: 9 },
  ]);
  assert.deepEqual(segments.moveSegment(source, 1, 1, 10), [
    { start: 1, end: 2 },
    { start: 2, end: 4 },
    { start: 8, end: 9 },
  ]);
  assert.deepEqual(segments.moveSegment(source, 1, 9, 10), [
    { start: 1, end: 2 },
    { start: 6, end: 8 },
    { start: 8, end: 9 },
  ]);
});

test("splitAt divides a kept range without changing neighboring clips", () => {
  const split = segments.splitAt([{ start: 0, end: 10 }], 4, 10);
  assert.deepEqual(split.segments, [
    { start: 0, end: 4 },
    { start: 4, end: 10 },
  ]);
  assert.equal(split.index, 1);
  assert.equal(segments.splitAt([{ start: 0, end: 10 }], 0.02, 10), null);
});

test("audioSegmentsForClip returns unmuted ranges only", () => {
  assert.deepEqual(
    segments.audioSegmentsForClip({ segments: [{ start: 1, end: 9 }] }, 10),
    [{ start: 1, end: 9 }],
  );
  assert.deepEqual(
    segments.audioSegmentsForClip({ segments: [{ start: 0, end: 10, muted: true }] }, 10),
    [],
  );
});

test("playback traverses gaps and loops after the final segment", () => {
  const kept = [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ];
  assert.equal(segments.playbackTarget(kept, 0.5), null);
  assert.equal(segments.playbackTarget(kept, 0.98), 2);
  assert.equal(segments.playbackTarget(kept, 1.5), 2);
  assert.equal(segments.playbackTarget(kept, 2.5), null);
  assert.equal(segments.playbackTarget(kept, 2.98), 0);
  assert.equal(segments.playbackTarget(kept, 4), 0);
});
