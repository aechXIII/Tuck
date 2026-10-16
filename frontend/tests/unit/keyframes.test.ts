import assert from "node:assert/strict";
import test from "node:test";

import type { CutAnalysisPayload, CutSegment, MediaTime } from "../../src/backend/cutting-types.ts";
import * as Keyframes from "../../src/features/timeline/keyframes.ts";

const time = (seconds: number): MediaTime => ({ ticks: String(Math.round(seconds * 1000)), time_base_num: 1, time_base_den: 1000 });

function analysis(overrides: Partial<CutAnalysisPayload> = {}): CutAnalysisPayload {
  return {
    work_id: "scan",
    status: "ready",
    progress: 1,
    coverage_end: time(120),
    keyframes: [time(4), time(0), time(2)],
    issue: null,
    analysis: null,
    ...overrides,
  };
}

function segment(start: number, end: number, exportedStart: number, kind: CutSegment["start_kind"] = "moved"): CutSegment {
  return {
    requested: { start: time(start), end: time(end) },
    resolved: { start: time(exportedStart), end: time(end) },
    start_kind: kind,
    end_frames_moved: 0,
    audio_source: null,
    audio_output: null,
    audio_packet_count: 0,
    copied: null,
  };
}

test("lossless feedback follows the source frames after the video is moved", () => {
  const placed = { start: 0, end: 20, sourceStart: 10 };
  const planned = segment(10, 30, 12);
  assert.equal(Keyframes.planMatches(placed, planned), true);
  assert.deepEqual(Keyframes.sliverFor(0, placed, planned), {
    index: 0, requestedStart: 0, exportedStart: 2, delta: 2, kind: "moved",
  });
});

test("the strip sorts keyframes and reports full coverage once reading finishes", () => {
  assert.deepEqual(Keyframes.keyframeStrip(analysis(), 120), { times: [0, 2, 4], coverage: 1 });
});

test("the strip reports scanned coverage while reading and unknown coverage before it starts", () => {
  const reading = Keyframes.keyframeStrip(analysis({ status: "reading", progress: 0.1, coverage_end: time(30) }), 120);
  assert.equal(reading.coverage, 0.25);
  assert.equal(Keyframes.keyframeStrip(analysis({ status: "pending", progress: null, coverage_end: time(0), keyframes: [] }), 120).coverage, null);
  assert.equal(Keyframes.keyframeStrip(analysis({ status: "reading", progress: 0.4, coverage_end: time(0) }), 120).coverage, 0.4);
  assert.deepEqual(Keyframes.keyframeStrip(null, 120), { times: [], coverage: null });
});

test("unknown coverage is never presented as a video without keyframes", () => {
  const failed = Keyframes.keyframeStrip(analysis({ status: "failed", keyframes: [], coverage_end: time(0) }), 120);
  assert.equal(failed.coverage, null);
});

test("[ and ] step to the neighbouring keyframe and skip the one under the playhead", () => {
  const times = [0, 2, 4, 3725.5];
  assert.equal(Keyframes.adjacentKeyframe(times, 2, 1), 4);
  assert.equal(Keyframes.adjacentKeyframe(times, 2, -1), 0);
  assert.equal(Keyframes.adjacentKeyframe(times, 2.05, -1, 1 / 60), 2);
  assert.equal(Keyframes.adjacentKeyframe(times, 2.004, -1, 1 / 60), 0);
  assert.equal(Keyframes.adjacentKeyframe(times, 3725.5, 1), null);
  assert.equal(Keyframes.adjacentKeyframe(times, 0, -1), null);
  assert.equal(Keyframes.adjacentKeyframe(times, 3600, 1), 3725.5);
  assert.equal(Keyframes.adjacentKeyframe([], 3, 1), null);
});

test("snap candidates are the keyframes either side of the dragged time", () => {
  const times = [0, 2, 4, 6];
  assert.deepEqual(Keyframes.keyframeSnapCandidates(times, 3.1), [2, 4]);
  assert.deepEqual(Keyframes.keyframeSnapCandidates(times, 4), [2, 4]);
  assert.deepEqual(Keyframes.keyframeSnapCandidates(times, 7), [6]);
  assert.deepEqual(Keyframes.keyframeSnapCandidates(times, -1), [0]);
  assert.deepEqual(Keyframes.keyframeSnapCandidates([], 1), []);
});

test("the playhead lights the keyframe it sits on, or the two either side", () => {
  const times = [0, 2, 4, 6];
  assert.deepEqual(Keyframes.keyframesAround(times, 2.7, 0.01), [2, 4]);
  assert.deepEqual(Keyframes.keyframesAround(times, 4.005, 0.01), [4]);
  assert.deepEqual(Keyframes.keyframesAround(times, 9, 0.01), [6]);
  assert.deepEqual(Keyframes.keyframesAround([], 1, 0.01), []);
});

test("a dragged start copies from that keyframe or the next one", () => {
  const times = [0, 2, 4];
  assert.equal(Keyframes.landingKeyframe(times, 2.3, 0.01), 4);
  assert.equal(Keyframes.landingKeyframe(times, 1.995, 0.01), 2);
  assert.equal(Keyframes.landingKeyframe(times, 4.5, 0.01), null);
});

test("a sliver covers the skipped part between the requested and exported start", () => {
  assert.deepEqual(Keyframes.sliverFor(1, { start: 42.4, end: 120 }, segment(42.4, 120, 44)), {
    index: 1,
    requestedStart: 42.4,
    exportedStart: 44,
    delta: 44 - 42.4,
    kind: "moved",
  });
});

test("no sliver is drawn for kept starts, collapsed segments or a plan made before the edit", () => {
  assert.equal(Keyframes.sliverFor(0, { start: 0, end: 30 }, segment(0, 30, 0, "at_start")), null);
  assert.equal(Keyframes.sliverFor(0, { start: 4, end: 30 }, segment(4, 30, 4, "keyframe")), null);
  assert.equal(Keyframes.sliverFor(0, { start: 1, end: 2 }, segment(1, 2, 1, "collapsed")), null);
  assert.equal(Keyframes.sliverFor(0, { start: 43, end: 120 }, segment(42.4, 120, 44)), null);
  assert.equal(Keyframes.sliverFor(0, { start: 42.4, end: 120 }, undefined), null);
});

test("the last segment still matches when the analysed duration differs from the probe", () => {
  const plan = segment(42.4, 120.021, 44);
  assert.ok(Keyframes.sliverFor(0, { start: 42.4, end: 120 }, plan));
});

test("chip text reads as a start delay or as re-encoded time", () => {
  assert.equal(Keyframes.chipText("moved", 1.6), "starts 1.6 s later");
  assert.equal(Keyframes.chipText("exact", 1.6), "1.6 s re-encoded");
  assert.equal(Keyframes.chipText("moved", 0.033), "starts 0.03 s later");
  assert.equal(Keyframes.chipText("moved", 13.66), "starts 13.7 s later");
});

test("precise times keep milliseconds and hours", () => {
  assert.equal(Keyframes.preciseTime(44), "0:44.000");
  assert.equal(Keyframes.preciseTime(30.2667), "0:30.267");
  assert.equal(Keyframes.preciseTime(3725.5), "1:02:05.500");
  assert.equal(Keyframes.preciseTime(-1), "0:00.000");
});

test("chip labels name where the export starts", () => {
  const sliver = Keyframes.sliverFor(1, { start: 42.4, end: 120 }, segment(42.4, 120, 44))!;
  assert.equal(Keyframes.chipLabel(sliver), "Starts at 0:44.000, the next keyframe, 1.6 s later than where you cut");
});

test("handles expose the exported boundary in their value text", () => {
  const moved = { ...segment(42.4, 120, 44), resolved: { start: time(44), end: time(119.9) } };
  assert.equal(Keyframes.handleValueText("start", 42.4, moved), "0:42.400, exported from 0:44.000");
  assert.equal(Keyframes.handleValueText("end", 120, moved), "2:00.000, exported to 1:59.900");
  assert.equal(Keyframes.handleValueText("start", 4, segment(4, 8, 4, "keyframe")), "0:04.000");
  assert.equal(Keyframes.handleValueText("start", 42.4, null), "0:42.400");
  assert.equal(Keyframes.handleValueText("start", 1, segment(1, 2, 1, "collapsed")), "0:01.000");
});

function exactSegment(start: number, end: number, copied: [number, number] | null, kind: CutSegment["start_kind"] = "exact"): CutSegment {
  return {...segment(start, end, start, kind), copied: copied && { start: time(copied[0]), end: time(copied[1]) }};
}

test("an exact start is drawn as re-encoded, up to where copying starts", () => {
  const sliver = Keyframes.sliverFor(1, { start: 42.4, end: 120 }, exactSegment(42.4, 120, [44, 119]))!;
  assert.equal(sliver.kind, "exact");
  assert.equal(sliver.exportedStart, 44);
  assert.equal(Keyframes.chipText(sliver.kind, sliver.delta), "1.6 s re-encoded");
  assert.equal(Keyframes.chipLabel(sliver), "Starts exactly at 0:42.400. 1.6 s near the start is re-encoded");
});

test("a wholly encoded segment is drawn across its full width", () => {
  const sliver = Keyframes.sliverFor(0, { start: 42.4, end: 42.8 }, exactSegment(42.4, 42.8, null))!;
  assert.equal(sliver.exportedStart, 42.8);
  assert.equal(Keyframes.chipLabel(sliver), "This segment is re-encoded");
});

test("exact segments that start on a keyframe draw nothing at their start", () => {
  assert.equal(Keyframes.sliverFor(0, { start: 44, end: 120 }, exactSegment(44, 120, [44, 119], "keyframe")), null);
});

test("the keyframe mask shows dividers in full over kept segments and faintly between them", () => {
  assert.equal(
    Keyframes.keyframeLaneMask([{ start: 2, end: 4 }, { start: 6, end: 8 }], 10),
    "linear-gradient(90deg, rgb(0 0 0 / 0.3) 0% 20%, #000 20% 40%, rgb(0 0 0 / 0.3) 40% 60%, #000 60% 80%, rgb(0 0 0 / 0.3) 80% 100%)",
  );
  // one segment over the whole video still makes a valid gradient
  assert.equal(Keyframes.keyframeLaneMask([{ start: 0, end: 10 }], 10), "linear-gradient(90deg, #000 0% 100%, #000 0% 100%)");
  assert.equal(Keyframes.keyframeLaneMask([], 0), "none");
});
