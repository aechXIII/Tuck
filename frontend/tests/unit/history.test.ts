import assert from "node:assert/strict";
import test from "node:test";

import {
  createHistory,
  recordedCommand,
  type HistoryHost,
} from "../../src/features/history/history.ts";
import {
  createEditorClip,
  type EditorClip,
} from "../../src/features/editor/types.ts";

type MutableSegment = { start: number; end: number; muted?: boolean };

const undoButton = { disabled: true };
const redoButton = { disabled: true };
let buttonLabels: { undo: string | null; redo: string | null } = { undo: null, redo: null };
let selectedPath: string | null = "clip.mp4";
const clips = new Map<string, EditorClip>();

function resetClip(): EditorClip {
  const clip = createEditorClip("clip.mp4");
  clip.segments = [{ start: 0, end: 12 }];
  clip.activeSegment = 0;
  clip.audioTimeline = null;
  clips.clear();
  clips.set(clip.path, clip);
  selectedPath = clip.path;
  undoButton.disabled = true;
  redoButton.disabled = true;
  return clip;
}

const host: HistoryHost = {
  getClip(path) {
    return clips.get(path) ?? null;
  },
  selectedPath() {
    return selectedPath;
  },
  refreshUiForClip() {},
  undoButton() {
    return undoButton;
  },
  redoButton() {
    return redoButton;
  },
  labelButtons(undo, redo) {
    buttonLabels = { undo, redo };
  },
};

const History = createHistory(host);

const transformOwner = {
  resetVideoTransform() {
    const clip = clips.get(selectedPath || "");
    if (!clip) return;
    Object.assign(clip, {
      crop: null,
      cropAspect: "off",
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
      sizingMode: "fit",
    });
  },
};

const timelineOwner = {
  trimActiveSegmentToPlayhead() {
    const clip = clips.get(selectedPath || "");
    if (!clip || !clip.segments || !clip.segments[0]) return;
    (clip.segments[0] as MutableSegment).start = 4;
  },
};

const audioOwner = {
  trimSelectedToPlayhead() {
    const clip = clips.get(selectedPath || "");
    if (!clip) return;
    clip.audioTimeline = {
      enabled: true,
      sourceMuted: false,
      sourceGainDb: 0,
      sourceWaveformUrl: "",
      sourceWaveformToken: "",
      sourceWaveformLoading: false,
      tracks: [
        {
          id: "t1",
          sourceDuration: 12,
          clips: [
            {
              id: "c1",
              timelineStart: 4,
              timelineDuration: 8,
              sourceIn: 0,
              sourceOut: 8,
              fadeIn: 0,
              fadeOut: 0,
              loop: false,
            },
          ],
        },
      ],
    };
  },
};

const selected = (): string | null => selectedPath;
const resetVideoTransform = recordedCommand(History, selected, transformOwner.resetVideoTransform);
const trimActiveSegmentToPlayhead = recordedCommand(History, selected, timelineOwner.trimActiveSegmentToPlayhead);
const trimSelectedToPlayhead = recordedCommand(History, selected, audioOwner.trimSelectedToPlayhead);
History.updateButtons();

test("edit history restores clip state and forgets removed clips", () => {
  const clip = resetClip();

  History.action(selectedPath, () => {
    clip.segments = [
      { start: 0, end: 4 },
      { start: 4, end: 12 },
    ];
    clip.activeSegment = 1;
  });

  assert.equal(undoButton.disabled, false);
  assert.equal(redoButton.disabled, true);

  History.undo();
  assert.deepEqual(clip.segments, [{ start: 0, end: 12 }]);
  assert.equal(clip.activeSegment, 0);
  assert.equal(undoButton.disabled, true);
  assert.equal(redoButton.disabled, false);

  History.redo();
  assert.deepEqual(clip.segments, [
    { start: 0, end: 4 },
    { start: 4, end: 12 },
  ]);
  assert.equal(clip.activeSegment, 1);

  History.forgetClip(selectedPath!);
  assert.equal(undoButton.disabled, true);
  assert.equal(redoButton.disabled, true);
});

test("setting a video segment boundary can be undone and redone", () => {
  const clip = resetClip();
  clip.segments = [{ start: 0, end: 12 }];

  trimActiveSegmentToPlayhead();
  assert.equal((clip.segments![0] as MutableSegment).start, 4);

  History.undo();
  assert.equal((clip.segments![0] as MutableSegment).start, 0);

  History.redo();
  assert.equal((clip.segments![0] as MutableSegment).start, 4);
  History.forgetClip(selectedPath!);
});

test("setting an audio fragment boundary can be undone", () => {
  const clip = resetClip();
  clip.audioTimeline = null;

  trimSelectedToPlayhead();
  assert.equal(clip.audioTimeline!.tracks[0]!.clips[0]!.timelineStart, 4);

  History.undo();
  assert.equal(clip.audioTimeline, null);
  History.forgetClip(selectedPath!);
});

test("reset all transforms can be undone and redone", () => {
  const clip = resetClip();
  Object.assign(clip, {
    crop: { x: 10, y: 20, width: 720, height: 1280 },
    cropAspect: "9:16",
    rotation: 270,
    flipHorizontal: true,
    flipVertical: true,
    sizingMode: "fill",
  });

  resetVideoTransform();
  assert.equal(clip.rotation, 0);
  assert.equal(clip.crop, null);

  History.undo();
  assert.equal(clip.rotation, 270);
  assert.deepEqual(clip.crop, {
    x: 10,
    y: 20,
    width: 720,
    height: 1280,
  });

  History.redo();
  assert.equal(clip.rotation, 0);
  assert.equal(clip.crop, null);
  History.forgetClip(selectedPath!);
});

test("a recorded command that runs another recorded command is one undo step", () => {
  const clip = resetClip();
  const inner = recordedCommand(History, selected, () => {
    clip.rotation = 90;
  });
  const outer = recordedCommand(History, selected, () => {
    clip.flipHorizontal = true;
    inner();
  });
  outer();
  History.undo();
  assert.equal(clip.rotation, 0);
  assert.equal(clip.flipHorizontal, false);
  assert.equal(undoButton.disabled, true);
  History.forgetClip(clip.path);
});

test("a removed video's steps come back with it, in their place", () => {
  const first = resetClip();
  const second = createEditorClip("second.mp4");
  clips.set(second.path, second);
  History.action(first.path, () => {
    first.rotation = 90;
  });
  History.action(second.path, () => {
    second.rotation = 180;
  });
  History.action(first.path, () => {
    first.rotation = 270;
  });
  assert.equal(History.hasEdits(first.path), true);

  const detached = History.detachClip(first.path);
  clips.delete(first.path);
  assert.equal(History.hasEdits(first.path), false);
  selectedPath = second.path;
  History.undo();
  assert.equal(second.rotation, 0);
  History.redo();
  assert.equal(second.rotation, 180);

  clips.set(first.path, first);
  History.restoreClip(detached);
  assert.equal(History.hasEdits(first.path), true);
  selectedPath = first.path;
  History.undo();
  assert.equal(first.rotation, 90);
  History.undo();
  assert.equal(first.rotation, 0);
  assert.equal(undoButton.disabled, true);
  // the other video kept its own step
  selectedPath = second.path;
  History.updateButtons();
  assert.equal(undoButton.disabled, false);
  History.undo();
  assert.equal(second.rotation, 0);
  History.forgetClip(first.path);
  History.forgetClip(second.path);
});

test("each video's edit count goes up with its edits, undo and redo, and not with no-op steps", () => {
  const clip = createEditorClip("counted.mp4");
  const other = createEditorClip("other-counted.mp4");
  clips.set(clip.path, clip);
  clips.set(other.path, other);
  const start = History.editCount(clip.path);
  selectedPath = clip.path;
  History.action(clip.path, () => {
    clip.rotation = 90;
  });
  assert.equal(History.editCount(clip.path), start + 1);
  // a step that changed nothing isn't an edit
  History.action(clip.path, () => {});
  assert.equal(History.editCount(clip.path), start + 1);
  History.undo();
  assert.equal(History.editCount(clip.path), start + 2);
  History.redo();
  assert.equal(History.editCount(clip.path), start + 3);
  History.action(other.path, () => {
    other.rotation = 180;
  });
  assert.equal(History.editCount(clip.path), start + 3);
  assert.equal(History.editCount("never-edited.mp4"), 0);
  clips.delete(clip.path);
  clips.delete(other.path);
});

test("undo and redo only change the video on screen", () => {
  const first = resetClip();
  const second = createEditorClip("second.mp4");
  clips.set(second.path, second);
  History.action(first.path, () => {
    first.rotation = 90;
  }, "rotate");

  // looking at the other video, Undo has nothing of its own to undo
  selectedPath = second.path;
  History.updateButtons();
  assert.equal(undoButton.disabled, true);
  History.undo();
  assert.equal(first.rotation, 90);

  selectedPath = first.path;
  History.updateButtons();
  assert.equal(undoButton.disabled, false);
  History.undo();
  assert.equal(first.rotation, 0);
  History.forgetClip(first.path);
  History.forgetClip(second.path);
});

test("an edit to one video keeps another video's redo step", () => {
  const first = resetClip();
  const second = createEditorClip("second.mp4");
  clips.set(second.path, second);
  History.action(first.path, () => {
    first.rotation = 90;
  });
  History.undo();
  selectedPath = second.path;
  History.action(second.path, () => {
    second.rotation = 180;
  });
  selectedPath = first.path;
  History.redo();
  assert.equal(first.rotation, 90);
  History.forgetClip(first.path);
  History.forgetClip(second.path);
});

test("the buttons name the step they will undo and redo", () => {
  const clip = resetClip();
  const split = recordedCommand(History, selected, () => {
    clip.segments = [
      { start: 0, end: 4 },
      { start: 4, end: 12 },
    ];
  }, "split");
  split();
  assert.deepEqual(buttonLabels, { undo: "split", redo: null });
  History.undo();
  assert.deepEqual(buttonLabels, { undo: null, redo: "split" });
  History.forgetClip(clip.path);
  assert.deepEqual(buttonLabels, { undo: null, redo: null });
});

test("revert puts a video back the way it was when the step began", () => {
  const clip = resetClip();
  History.begin(clip.path, "trim start");
  (clip.segments![0] as MutableSegment).start = 3;
  History.revert();
  assert.equal((clip.segments![0] as MutableSegment).start, 0);
  // nothing was recorded, so a later commit does nothing
  History.commit();
  assert.equal(undoButton.disabled, true);
});
