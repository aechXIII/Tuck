import assert from "node:assert/strict";
import test from "node:test";

import {
  bitrateText,
  defaultQualityLevel,
  parseTypedGoal,
  qualityFromSlider,
  qualityMethod,
  qualityPicks,
  qualitySliderValue,
  sizeForBitrate,
} from "../../src/features/export/goal.ts";

test("software encoders take CRF and GPUs take CQ; Auto follows the encoder it tries first", () => {
  assert.equal(qualityMethod("libx264"), "CRF");
  assert.equal(qualityMethod("libx265"), "CRF");
  assert.equal(qualityMethod("auto_compression"), "CRF");
  assert.equal(qualityMethod("h264_nvenc"), "CQ");
  assert.equal(qualityMethod("hevc_vaapi"), "CQ");
  assert.equal(qualityMethod("h264_amf"), "CQ");
  assert.equal(qualityMethod("auto"), "CQ");
});

test("H.265 starts higher, and the picks run from smaller files to a better picture", () => {
  assert.equal(defaultQualityLevel("libx264"), 23);
  assert.equal(defaultQualityLevel("hevc_nvenc"), 28);
  assert.deepEqual(qualityPicks("libx264"), [33, 28, 23, 18]);
  assert.deepEqual(qualityPicks("libx265"), [32, 28, 24, 20]);
});

test("the slider's right end is the best picture, and levels round-trip through it", () => {
  assert.ok(qualitySliderValue(18) > qualitySliderValue(33));
  for (const level of [10, 18, 23, 45]) assert.equal(qualityFromSlider(qualitySliderValue(level)), level);
  // a typed level past the slider's ends pins the slider there
  assert.equal(qualitySliderValue(51), qualitySliderValue(45));
});

test("a unit typed with the number picks the goal", () => {
  assert.deepEqual(parseTypedGoal("crf 20"), { goal: "quality", value: 20 });
  assert.deepEqual(parseTypedGoal("CQ24"), { goal: "quality", value: 24 });
  assert.deepEqual(parseTypedGoal("25mb"), { goal: "size", value: 25 });
  assert.deepEqual(parseTypedGoal("25 MB"), { goal: "size", value: 25 });
  assert.deepEqual(parseTypedGoal("8 mbps"), { goal: "bitrate", value: 8 });
  assert.deepEqual(parseTypedGoal("2,5 Mb/s"), { goal: "bitrate", value: 2.5 });
  assert.deepEqual(parseTypedGoal("40"), { goal: null, value: 40 });
  assert.equal(parseTypedGoal("lots").goal, null);
  assert.ok(Number.isNaN(parseTypedGoal("lots").value));
});

test("a typed bitrate becomes the size whose plan gives about that bitrate", () => {
  // 10 MB planned to 1.1 Mbps with 128k audio: 8 Mbps needs about 66 MB
  assert.equal(sizeForBitrate(8, { targetSizeMb: 10, videoKbps: 1100, audioKbps: 128, durationS: 65 }), 66);
  // a Quality plan has no bitrate, so the duration gives the size
  assert.equal(sizeForBitrate(8, { targetSizeMb: 10, videoKbps: 0, audioKbps: 128, durationS: 65 }), 63);
  assert.equal(sizeForBitrate(8, { targetSizeMb: 10, videoKbps: 0, audioKbps: 0, durationS: 0 }), null);
  assert.equal(sizeForBitrate(0, { targetSizeMb: 10, videoKbps: 1100, audioKbps: 128, durationS: 65 }), null);
  // never below the smallest size Tuck accepts
  assert.equal(sizeForBitrate(0.01, { targetSizeMb: 10, videoKbps: 1100, audioKbps: 0, durationS: 65 }), 2);
});

test("the detail line's bitrate reads in kbps below 1 Mbps", () => {
  assert.equal(bitrateText(0), "");
  assert.equal(bitrateText(850), "850 kbps");
  assert.equal(bitrateText(1120), "1.1 Mbps");
  assert.equal(bitrateText(12_400), "12 Mbps");
});
