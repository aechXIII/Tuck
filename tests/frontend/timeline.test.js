"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const timeline = require("../../tuck/web/timeline.js");

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
