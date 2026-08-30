"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const timeline = require("../../frontend/public/legacy/timeline.js");

test("track actions expose only controls owned by each track kind", () => {
  assert.deepEqual(timeline.trackActions("video"), []);
  assert.deepEqual(timeline.trackActions("source"), ["mute"]);
  assert.deepEqual(timeline.trackActions("imported"), ["mute", "remove"]);
});

test("timeline zoom stays inside the supported range", () => {
  assert.equal(timeline.clampZoom(-4), 1);
  assert.equal(timeline.clampZoom(3.5), 3.5);
  assert.equal(timeline.clampZoom(99), 8);
  assert.equal(timeline.clampZoom(Number.NaN), 1);
});

test("zoom anchoring keeps the subject centered and clamps at both edges", () => {
  assert.equal(timeline.anchorScrollLeft(1000, 2000, 0.5), 500);
  assert.equal(timeline.anchorScrollLeft(1000, 2000, 0.1), 0);
  assert.equal(timeline.anchorScrollLeft(1000, 2000, 0.9), 1000);
  assert.equal(timeline.anchorScrollLeft(1000, 800, 0.5), 0);
});

test("ruler density responds to pixels per second", () => {
  assert.equal(timeline.rulerStep(36, 40), 1);
  assert.equal(timeline.rulerStep(36, 160), 0.25);
  assert.equal(timeline.rulerStep(600, 0), 30);
  assert.equal(timeline.rulerMajorEvery(1, 40), 5);
  assert.equal(timeline.rulerMajorEvery(0.25, 160), 5);
});

test("timeline edit keys identify focused segments and trim handles", () => {
  const segment = {
    classList: { contains: (name) => name === "tl-segment" },
    dataset: { segmentIndex: "2" },
  };

  assert.deepEqual(timeline.editKeyIntent(segment, "ArrowLeft", false), {
    type: "segment",
    index: 2,
    delta: -0.01,
    snap: false,
  });
  assert.deepEqual(
    timeline.editKeyIntent({ id: "tl-out" }, "ArrowRight", true),
    {
      type: "trim",
      endpoint: "end",
      delta: 0.1,
      snap: false,
    },
  );
  assert.equal(
    timeline.editKeyIntent({ id: "timeline" }, "ArrowLeft", false),
    null,
  );
  assert.equal(timeline.editKeyIntent({ id: "tl-in" }, "Space", false), null);
});

test("source-audio mute does not change video segment presentation", () => {
  assert.deepEqual(timeline.segmentPresentationState(1, 1, true), {
    className: "tl-segment active",
  });
  assert.deepEqual(timeline.segmentPresentationState(0, 1, false), {
    className: "tl-segment",
  });
});

test("timeline preserves each video segment shade until it is selected", () => {
  assert.equal(timeline.clipFill("video", true, false, "#A855F7"), "#6D28D9");
  assert.equal(timeline.clipFill("video", false, false, "#A855F7"), "#A855F7");
  assert.equal(timeline.clipFill("video", false, false, "#6D28D9"), "#6D28D9");
  assert.equal(timeline.clipFill("source", true, false), "#4C3A86");
  assert.equal(timeline.clipFill("imported", true, false), "#115E56");
  assert.equal(timeline.clipFill("imported", false, false, "#B45309"), "#B45309");
  assert.equal(timeline.clipFill("video", true, true), "#22222B");
  assert.equal(timeline.clipFill("imported", false, true), "#22222B");
  assert.equal(timeline.videoSegmentSelected(2, 2, true), true);
  assert.equal(timeline.videoSegmentSelected(2, 2, false), false);
});
