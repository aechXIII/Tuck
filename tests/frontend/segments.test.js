"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const segments = require("../../tuck/web/segments.js");

test("omitted segments select the full source", () => {
  assert.deepEqual(segments.normalizeSegments(null, 10), [{ start: 0, end: 10 }]);
  assert.equal(segments.selectedDuration([{ start: 1, end: 2.5 }]), 1.5);
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

test("segment audio can be ungrouped and relinked independently of the video", () => {
  assert.deepEqual(
    segments.audioSegmentsForClip(
      {
        segments: [
          { start: 0, end: 3 },
          { start: 5, end: 9, grouped: false },
        ],
        sourceAudioSegments: [{ start: 5, end: 9 }],
      },
      10,
    ),
    [
      { start: 0, end: 3 },
      { start: 5, end: 9 },
    ],
  );
  assert.deepEqual(
    segments.audioSegmentsForClip(
      { segments: [{ start: 0, end: 10, grouped: false }], sourceAudioSegments: [] },
      10,
    ),
    [],
  );
  assert.deepEqual(
    segments.setSegmentAudio([{ start: 0, end: 10 }], 0, false, 10),
    [{ start: 0, end: 10, grouped: false }],
  );
  assert.deepEqual(
    segments.audioSegmentsForClip({ segments: [{ start: 1, end: 9 }] }, 10),
    [{ start: 1, end: 9 }],
  );
  assert.deepEqual(
    segments.audioSegmentsForClip({ segments: [{ start: 0, end: 10, muted: true }] }, 10),
    [],
  );

  const unlinked = segments.unlinkSegmentAudio([{ start: 1, end: 8 }], [], 0, 10);
  assert.equal(unlinked.segments[0].grouped, false);
  assert.ok(unlinked.segments[0].audioLink);
  assert.equal(unlinked.detached[0].audioLink, unlinked.segments[0].audioLink);
  unlinked.detached[0].start = 4;
  unlinked.detached[0].end = 9;
  const relinked = segments.relinkSegmentAudio(
    unlinked.segments,
    unlinked.detached,
    0,
    10,
  );
  assert.equal(relinked.detached.length, 0);
  assert.equal(relinked.segments[0].grouped, undefined);
  assert.equal(relinked.segments[0].start, 1);
  assert.equal(relinked.segments[0].end, 8);
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
