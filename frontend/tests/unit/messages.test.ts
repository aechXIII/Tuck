import assert from "node:assert/strict";
import test from "node:test";

import { reasonSentence, withReason } from "../../src/features/editor/format.ts";
import { probeSummary, type ProbeClip } from "../../src/state/probe.ts";
import { mediaToolsMessage, missingMediaTools } from "../../src/state/settings-state.ts";

test("backend reasons read as one sentence and an empty one gives the next step", () => {
  assert.equal(reasonSentence("  Profile\n not found "), "Profile not found.");
  assert.equal(reasonSentence("Disk is full."), "Disk is full.");
  assert.equal(reasonSentence(undefined), "");
  assert.equal(withReason("Couldn’t stop the queue.", "Queue is busy"), "Couldn’t stop the queue. Queue is busy.");
  assert.equal(withReason("Couldn’t stop the queue.", ""), "Couldn’t stop the queue. Try again.");
});

test("a video that can't be read is counted apart from ones still being read", () => {
  const clips: Record<string, ProbeClip> = {
    "a.mp4": { probed: true, probeData: { duration: 1 } },
    "broken.mp4": { probed: false, error: "moov atom not found" },
    "b.mp4": { probed: true, probeData: { duration: 2 } },
  };
  // nothing is still reading, so exporting all can go ahead with the readable two
  assert.deepEqual(probeSummary(["a.mp4", "broken.mp4", "b.mp4"], (path) => clips[path]), {
    ready: ["a.mp4", "b.mp4"],
    loading: [],
    failed: ["broken.mp4"],
  });
  clips["c.mp4"] = { probing: true };
  assert.deepEqual(probeSummary(["c.mp4", "broken.mp4"], (path) => clips[path]).loading, ["c.mp4"]);
});

test("missing media tools are named once with what stops working", () => {
  assert.deepEqual(missingMediaTools({}), []);
  assert.deepEqual(missingMediaTools({ ffmpeg_available: true, ffprobe_available: false }), ["FFprobe"]);
  assert.deepEqual(missingMediaTools({ ffmpeg_available: false, ffprobe_available: false }), ["FFmpeg", "FFprobe"]);
  assert.equal(mediaToolsMessage(["FFprobe"]), "Tuck can’t find FFprobe, so videos can’t be read. Choose it in Settings.");
  assert.equal(mediaToolsMessage(["FFmpeg"]), "Tuck can’t find FFmpeg, so videos can’t be exported. Choose it in Settings.");
  assert.equal(mediaToolsMessage([]), "");
});
