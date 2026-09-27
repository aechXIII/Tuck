import assert from "node:assert/strict";
import test from "node:test";
import type { CutPlanPreview, CutSegment } from "../../src/backend/cutting-types.ts";
import { segmentsAtExportedStarts } from "../../src/features/timeline/cut-starts.ts";

const time = (hundredths: number) => ({ticks: String(hundredths), time_base_num: 1, time_base_den: 100});
const segment = (start: number, end: number): CutSegment => ({
  requested: {start: time(start), end: time(end)},
  resolved: {start: time(start), end: time(end)},
  start_kind: "moved", end_frames_moved: 0, audio_source: null, audio_output: null, audio_packet_count: 0, copied: null,
});
const plan = (segments: CutSegment[]): CutPlanPreview => ({
  operation: "cut", precision: "keyframes", container: "mp4", include_audio: true,
  output_path: "clip_cut.mp4", exported_duration: time(100), estimated_bytes: 1,
  fingerprint: "a".repeat(64), issues: [], exact_available: false, exact_reason: "",
  unverified: [], tracks: [], chapter_count: 0,
  source_identity: {path: "clip.mp4", size: 1, mtime_ns: "1", signature: "b".repeat(64)},
  segments,
});
const clip = {segments: [{start: 0, end: 5}, {start: 6, end: 9}]};

test("starts move to where each cut is exported and ends stay", () => {
  const moved = segmentsAtExportedStarts(clip, plan([segment(100, 500), segment(800, 900)]), 10);
  assert.deepEqual(moved.ok && moved.segments.map(({start, end}) => [start, end]), [[1, 5], [8, 9]]);
});

test("a start that would leave a sliver explains why nothing moved", () => {
  const moved = segmentsAtExportedStarts(clip, plan([segment(100, 500), segment(898, 900)]), 10);
  assert.equal(moved.ok, false);
  assert.match(!moved.ok ? moved.message : "", /too short/);
});

test("a plan for other segments leaves the timeline unchanged", () => {
  const moved = segmentsAtExportedStarts(clip, plan([segment(100, 500)]), 10);
  assert.deepEqual(moved, {ok: false, message: "The cut points could not be moved. Your timeline is unchanged."});
});
