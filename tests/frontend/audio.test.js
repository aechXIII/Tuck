"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const audio = require("../../tuck/web/audio.js");

const segments = [
  { start: 1, end: 3 },
  { start: 6, end: 10 },
];

test("source and output time mapping stays continuous across removed gaps", () => {
  assert.equal(audio.selectedDuration(segments), 6);
  assert.equal(audio.sourceToOutputTime(segments, 2), 1);
  assert.equal(audio.sourceToOutputTime(segments, 5), 2);
  assert.equal(audio.sourceToOutputTime(segments, 8), 4);
  assert.equal(audio.outputToSourceTime(segments, 1), 2);
  assert.equal(audio.outputToSourceTime(segments, 4), 8);
});

test("splitting a regular audio clip preserves source and timeline continuity", () => {
  const clip = {
    id: "first",
    timelineStart: 2,
    timelineDuration: 8,
    sourceIn: 1,
    sourceOut: 9,
    fadeIn: 1,
    fadeOut: 2,
    loop: false,
  };

  const split = audio.splitClip(clip, 5, "second");

  assert.equal(split[0].timelineDuration, 3);
  assert.equal(split[0].sourceOut, 4);
  assert.equal(split[1].timelineStart, 5);
  assert.equal(split[1].timelineDuration, 5);
  assert.equal(split[1].sourceIn, 4);
  assert.equal(split[1].sourceOut, 9);
});

test("split rejects playheads too close to audio clip edges", () => {
  const clip = {
    timelineStart: 2,
    timelineDuration: 3,
    sourceIn: 0,
    sourceOut: 3,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };

  assert.equal(audio.splitClip(clip, 2.01, "new"), null);
  assert.equal(audio.splitClip(clip, 4.99, "new"), null);
});
