"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
