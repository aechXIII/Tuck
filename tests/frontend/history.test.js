"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../../tuck/web/shortcuts.js");

const windowListeners = {};
const documentListeners = {};
const undoButton = { disabled: true };
const redoButton = { disabled: true };

global.window = global;
global.document = {
  activeElement: null,
  addEventListener(name, listener) {
    documentListeners[name] = listener;
  },
  getElementById(id) {
    if (id === "btn-undo") return undoButton;
    if (id === "btn-redo") return redoButton;
    return null;
  },
};
global.addEventListener = function (name, listener) {
  windowListeners[name] = listener;
};
global.selPath = "clip.mp4";
global.clips = {
  "clip.mp4": {
    segments: [{ start: 0, end: 12 }],
    activeSegment: 0,
    audioTimeline: null,
  },
};
global.trimActiveSegmentToPlayhead = function () {
  global.clips[global.selPath].segments[0].start = 4;
};
global.resetVideoTransform = function () {
  Object.assign(global.clips[global.selPath], {
    crop: null,
    cropAspect: "off",
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    sizingMode: "fit",
  });
};
global.AudioTimeline = {
  render() {},
  trimSelectedToPlayhead() {
    global.clips[global.selPath].audioTimeline = {
      tracks: [{ clips: [{ timelineStart: 4 }] }],
    };
  },
};

require("../../tuck/web/history.js");
windowListeners.load();

test("edit history restores clip state and forgets removed clips", () => {
  global.History.action(global.selPath, () => {
    global.clips[global.selPath].segments = [
      { start: 0, end: 4 },
      { start: 4, end: 12 },
    ];
    global.clips[global.selPath].activeSegment = 1;
  });

  assert.equal(undoButton.disabled, false);
  assert.equal(redoButton.disabled, true);

  global.History.undo();
  assert.deepEqual(global.clips[global.selPath].segments, [{ start: 0, end: 12 }]);
  assert.equal(global.clips[global.selPath].activeSegment, 0);
  assert.equal(undoButton.disabled, true);
  assert.equal(redoButton.disabled, false);

  global.History.redo();
  assert.deepEqual(global.clips[global.selPath].segments, [
    { start: 0, end: 4 },
    { start: 4, end: 12 },
  ]);
  assert.equal(global.clips[global.selPath].activeSegment, 1);

  global.History.forgetClip(global.selPath);
  assert.equal(undoButton.disabled, true);
  assert.equal(redoButton.disabled, true);
});

test("setting a video segment boundary can be undone and redone", () => {
  global.clips[global.selPath].segments = [{ start: 0, end: 12 }];

  global.trimActiveSegmentToPlayhead("start");
  assert.equal(global.clips[global.selPath].segments[0].start, 4);

  global.History.undo();
  assert.equal(global.clips[global.selPath].segments[0].start, 0);

  global.History.redo();
  assert.equal(global.clips[global.selPath].segments[0].start, 4);
  global.History.forgetClip(global.selPath);
});

test("setting an audio fragment boundary can be undone", () => {
  global.clips[global.selPath].audioTimeline = null;

  global.AudioTimeline.trimSelectedToPlayhead("start");
  assert.equal(
    global.clips[global.selPath].audioTimeline.tracks[0].clips[0].timelineStart,
    4,
  );

  global.History.undo();
  assert.equal(global.clips[global.selPath].audioTimeline, null);
  global.History.forgetClip(global.selPath);
});

test("reset all transforms can be undone and redone", () => {
  Object.assign(global.clips[global.selPath], {
    crop: { x: 10, y: 20, width: 720, height: 1280 },
    cropAspect: "9:16",
    rotation: 270,
    flipHorizontal: true,
    flipVertical: true,
    sizingMode: "fill",
  });

  global.resetVideoTransform();
  assert.equal(global.clips[global.selPath].rotation, 0);
  assert.equal(global.clips[global.selPath].crop, null);

  global.History.undo();
  assert.equal(global.clips[global.selPath].rotation, 270);
  assert.deepEqual(global.clips[global.selPath].crop, {
    x: 10,
    y: 20,
    width: 720,
    height: 1280,
  });

  global.History.redo();
  assert.equal(global.clips[global.selPath].rotation, 0);
  assert.equal(global.clips[global.selPath].crop, null);
  global.History.forgetClip(global.selPath);
});
