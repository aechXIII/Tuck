"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const audio = require("../../frontend/public/legacy/audio.js");

const segments = [
  { start: 1, end: 3 },
  { start: 6, end: 10 },
];

test("imported audio tracks cycle through distinct semantic colors", () => {
  assert.equal(audio.trackColor(0), "#0F766E");
  assert.equal(audio.trackColor(1), "#B45309");
  assert.equal(audio.trackColor(2), "#0369A1");
  assert.equal(audio.trackColor(6), "#0F766E");
});

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

test("splitting a muted audio fragment keeps both pieces muted", () => {
  const clip = {
    id: "music",
    timelineStart: 0,
    timelineDuration: 10,
    sourceIn: 4,
    sourceOut: 14,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    muted: true,
  };

  const split = audio.splitClip(clip, 4, "second");

  assert.equal(split[0].muted, true);
  assert.equal(split[1].muted, true);
});

test("setting an audio fragment edge to the playhead preserves source alignment", () => {
  const clip = {
    id: "music",
    timelineStart: 2,
    timelineDuration: 8,
    sourceIn: 1,
    sourceOut: 9,
    fadeIn: 1,
    fadeOut: 2,
    loop: false,
  };

  const start = audio.trimClipToTimelinePoint(
    clip,
    "start",
    5,
    0,
    12,
    20,
    0.05,
  );
  const end = audio.trimClipToTimelinePoint(
    clip,
    "end",
    7,
    0,
    12,
    20,
    0.05,
  );

  assert.deepEqual(
    {
      timelineStart: start.timelineStart,
      timelineDuration: start.timelineDuration,
      sourceIn: start.sourceIn,
      sourceOut: start.sourceOut,
    },
    { timelineStart: 5, timelineDuration: 5, sourceIn: 4, sourceOut: 9 },
  );
  assert.deepEqual(
    {
      timelineStart: end.timelineStart,
      timelineDuration: end.timelineDuration,
      sourceIn: end.sourceIn,
      sourceOut: end.sourceOut,
    },
    { timelineStart: 2, timelineDuration: 5, sourceIn: 1, sourceOut: 6 },
  );
});

test("audio playhead trims respect neighbors, source bounds, and minimum duration", () => {
  const clip = {
    timelineStart: 2,
    timelineDuration: 8,
    sourceIn: 1,
    sourceOut: 9,
    fadeIn: 1,
    fadeOut: 2,
    loop: false,
  };

  const extendedStart = audio.trimClipToTimelinePoint(
    clip,
    "start",
    0,
    0,
    12,
    10,
    0.05,
  );
  const extendedEnd = audio.trimClipToTimelinePoint(
    clip,
    "end",
    15,
    0,
    12,
    10,
    0.05,
  );
  const minimumEnd = audio.trimClipToTimelinePoint(
    clip,
    "end",
    2,
    0,
    12,
    10,
    0.05,
  );

  assert.deepEqual(
    {
      timelineStart: extendedStart.timelineStart,
      timelineDuration: extendedStart.timelineDuration,
      sourceIn: extendedStart.sourceIn,
    },
    { timelineStart: 1, timelineDuration: 9, sourceIn: 0 },
  );
  assert.deepEqual(
    {
      timelineDuration: extendedEnd.timelineDuration,
      sourceOut: extendedEnd.sourceOut,
    },
    { timelineDuration: 9, sourceOut: 10 },
  );
  assert.equal(minimumEnd.timelineDuration, 0.05);
  assert.equal(minimumEnd.fadeOut, 0);
});

test("slipping selects another source fragment without moving or resizing the clip", () => {
  const clip = {
    id: "music",
    timelineStart: 2,
    timelineDuration: 8,
    sourceIn: 1,
    sourceOut: 9,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };

  const slipped = audio.slipClip(clip, 12, 2);
  const clampedRight = audio.slipClip(clip, 12, 20);
  const clampedLeft = audio.slipClip(clip, 12, -20);

  assert.deepEqual(
    {
      timelineStart: slipped.timelineStart,
      timelineDuration: slipped.timelineDuration,
      sourceIn: slipped.sourceIn,
      sourceOut: slipped.sourceOut,
    },
    { timelineStart: 2, timelineDuration: 8, sourceIn: 3, sourceOut: 11 },
  );
  assert.deepEqual(
    { sourceIn: clampedRight.sourceIn, sourceOut: clampedRight.sourceOut },
    { sourceIn: 4, sourceOut: 12 },
  );
  assert.deepEqual(
    { sourceIn: clampedLeft.sourceIn, sourceOut: clampedLeft.sourceOut },
    { sourceIn: 0, sourceOut: 8 },
  );
});

test("split pieces can slip independently and reset to the earliest source range", () => {
  const clip = {
    id: "music",
    timelineStart: 0,
    timelineDuration: 40,
    sourceIn: 40,
    sourceOut: 80,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };
  const split = audio.splitClip(clip, 15, "second");

  const slippedRight = audio.slipClip(split[1], 180, 30);
  const resetRight = audio.resetSlip(slippedRight, 180);

  assert.deepEqual(
    { sourceIn: split[0].sourceIn, sourceOut: split[0].sourceOut },
    { sourceIn: 40, sourceOut: 55 },
  );
  assert.deepEqual(
    {
      timelineStart: slippedRight.timelineStart,
      timelineDuration: slippedRight.timelineDuration,
      sourceIn: slippedRight.sourceIn,
      sourceOut: slippedRight.sourceOut,
    },
    { timelineStart: 15, timelineDuration: 25, sourceIn: 85, sourceOut: 110 },
  );
  assert.deepEqual(
    { sourceIn: resetRight.sourceIn, sourceOut: resetRight.sourceOut },
    { sourceIn: 0, sourceOut: 25 },
  );
});

test("source range state describes the selected fragment and disables impossible slips", () => {
  const movable = audio.sourceRangeState(
    { sourceIn: 40, sourceOut: 80, timelineDuration: 40 },
    200,
  );
  const fixed = audio.sourceRangeState(
    { sourceIn: 0, sourceOut: 40, timelineDuration: 40 },
    40,
  );

  assert.deepEqual(movable, {
    sourceIn: 40,
    sourceOut: 80,
    sourceSpan: 40,
    sourceDuration: 200,
    maxSourceIn: 160,
    startPct: 20,
    widthPct: 20,
    canSlip: true,
  });
  assert.equal(fixed.maxSourceIn, 0);
  assert.equal(fixed.widthPct, 100);
  assert.equal(fixed.canSlip, false);
});

test("a video-fitted clip uses its timeline duration as the selectable source window", () => {
  const fitted = {
    timelineStart: 0,
    timelineDuration: 40,
    sourceIn: 0,
    sourceOut: 180,
    loop: false,
  };

  const state = audio.sourceRangeState(fitted, 180);
  const slipped = audio.slipClip(fitted, 180, 40);

  assert.equal(state.sourceOut, 40);
  assert.equal(state.sourceSpan, 40);
  assert.equal(state.maxSourceIn, 140);
  assert.equal(state.canSlip, true);
  assert.deepEqual(
    { sourceIn: slipped.sourceIn, sourceOut: slipped.sourceOut },
    { sourceIn: 40, sourceOut: 80 },
  );
});

test("source range timecodes keep millisecond precision", () => {
  assert.equal(audio.formatSourceTime(42.125), "0:42.125");
  assert.equal(audio.formatSourceTime(62.5), "1:02.500");
  assert.equal(audio.formatSourceTime(3661.001), "1:01:01.001");
});

test("Alt-drag slips an audio body while trim handles keep their edge actions", () => {
  assert.equal(audio.importedDragAction(null, true, "move"), "slip");
  assert.equal(audio.importedDragAction("start", true, "move"), "trim-start");
  assert.equal(audio.importedDragAction("end", true, "move"), "trim-end");
  assert.equal(audio.importedDragAction(null, false, "move"), "move");
});

test("selecting video or source audio clears an imported audio clip target", () => {
  assert.deepEqual(audio.timelineSelection("music-track", "music-clip"), {
    trackId: "music-track",
    clipId: "music-clip",
  });
  assert.deepEqual(audio.timelineSelection("video", "music-clip"), {
    trackId: "source",
    clipId: null,
  });
  assert.deepEqual(audio.timelineSelection("source", "music-clip"), {
    trackId: "source",
    clipId: null,
  });
});

test("new audio starts at the playhead and fits only the remaining video", () => {
  assert.deepEqual(audio.fitClipToTimeline(180, 12, 4), {
    timelineStart: 4,
    timelineDuration: 8,
    sourceIn: 0,
    sourceOut: 8,
  });
  assert.deepEqual(audio.fitClipToTimeline(180, 12, 0), {
    timelineStart: 0,
    timelineDuration: 12,
    sourceIn: 0,
    sourceOut: 12,
  });
});

test("source-range dragging measures from the waveform content box", () => {
  assert.equal(audio.sourceRangePointerValue(112, 101, 200, 11, 180, 172), 0);
  assert.equal(audio.sourceRangePointerValue(212, 101, 200, 11, 180, 172), 90);
  assert.equal(audio.sourceRangePointerValue(500, 101, 200, 11, 180, 172), 172);
});

test("waveform positioning maps source slices to CSS backgrounds", () => {
  assert.equal(audio.waveformPositionPct(5, 5, 10), 100);

  const detail = audio.sourceRangeDetailState(51.571, 8.793, 257.254);

  assert.ok(Math.abs(detail.visibleSpan - 21.9825) < 1e-9);
  assert.ok(Math.abs(detail.viewportStart - 44.97625) < 1e-9);
  assert.ok(Math.abs(detail.waveformLeftPct + 204.600250199022) < 1e-9);
  assert.ok(Math.abs(detail.waveformWidthPct - 1170.26725804617) < 1e-9);
  assert.ok(Math.abs(detail.waveformPositionPct - 19.1167438470024) < 1e-9);
  assert.equal(detail.selectionStartPct, 30);
  assert.equal(detail.selectionWidthPct, 40);
});

test("source detail preserves its fixed frame at the source boundaries", () => {
  const atStart = audio.sourceRangeDetailState(0, 8, 80);
  const atEnd = audio.sourceRangeDetailState(72, 8, 80);

  assert.equal(atStart.selectionStartPct, 30);
  assert.equal(atStart.waveformLeftPct, 30);
  assert.equal(atEnd.selectionStartPct, 30);
  assert.equal(atEnd.waveformLeftPct, -330);
});

test("source detail shows the full waveform when the selection is already wide", () => {
  const detail = audio.sourceRangeDetailState(20, 60, 100);

  assert.equal(detail.visibleSpan, 100);
  assert.equal(detail.viewportStart, 0);
  assert.equal(detail.waveformPositionPct, 0);
  assert.equal(detail.selectionStartPct, 20);
  assert.equal(detail.selectionWidthPct, 60);
});

test("dragging the detail waveform slips audio beneath the fixed frame", () => {
  assert.ok(
    Math.abs(audio.sourceRangeDetailDragValue(51.571, -30, 21.9825, 270, 248.461) - 54.0135) <
      1e-9,
  );
  assert.ok(
    Math.abs(audio.sourceRangeDetailDragValue(51.571, 30, 21.9825, 270, 248.461) - 49.1285) <
      1e-9,
  );
  assert.equal(audio.sourceRangeDetailDragValue(1, 200, 20, 100, 72), 0);
  assert.equal(audio.sourceRangeDetailDragValue(71, -200, 20, 100, 72), 72);
});

test("source-range keyboard movement uses precise and accelerated steps", () => {
  assert.equal(audio.sourceRangeKeyboardValue(40, 172, "ArrowLeft", false), 39.9);
  assert.equal(audio.sourceRangeKeyboardValue(40, 172, "ArrowRight", true), 41);
  assert.equal(audio.sourceRangeKeyboardValue(0, 172, "ArrowLeft", false), 0);
  assert.equal(audio.sourceRangeKeyboardValue(172, 172, "ArrowRight", true), 172);
  assert.equal(audio.sourceRangeKeyboardValue(40, 172, "Home", false), 0);
  assert.equal(audio.sourceRangeKeyboardValue(40, 172, "End", false), 172);
  assert.equal(audio.sourceRangeKeyboardValue(40, 172, "Enter", false), null);
});
