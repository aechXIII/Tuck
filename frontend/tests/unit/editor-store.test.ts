import assert from "node:assert/strict";
import test from "node:test";

import {
  createEditorStore,
  type ClipState,
} from "../../src/state/editor-store.ts";

const firstClip: ClipState = {
  name: "Morning.mp4",
  path: "C:\\media\\Morning.mp4",
};

test("editor state has one owner for clip selection, settings, profiles, encoders, dirtiness, and queue", () => {
  const store = createEditorStore();
  const observedSelections: Array<string | null> = [];
  const unsubscribe = store.subscribe((state) => {
    observedSelections.push(state.selectedPath);
  });

  store.dispatch({ type: "replace-clips", clips: [firstClip] });
  store.dispatch({ type: "select-clip", path: firstClip.path });
  store.dispatch({ type: "replace-settings", settings: { timeline_height: 260 } });
  store.dispatch({
    type: "replace-profiles",
    profiles: [{ id: "balanced", name: "Balanced" }],
  });
  store.dispatch({ type: "replace-encoders", encoders: ["libx264"] });
  store.dispatch({ type: "set-settings-dirty", dirty: true });
  store.dispatch({
    type: "replace-queue",
    items: [{ id: "queue-1", state: "pending" }],
  });
  unsubscribe();

  const state = store.getSnapshot();
  assert.equal(state.clips.get(firstClip.path)?.name, "Morning.mp4");
  assert.equal(state.selectedPath, firstClip.path);
  assert.equal(state.settings.timeline_height, 260);
  assert.deepEqual(state.profiles, [{ id: "balanced", name: "Balanced" }]);
  assert.deepEqual(state.encoders, ["libx264"]);
  assert.equal(state.settingsDirty, true);
  assert.equal(state.queue.get("queue-1")?.state, "pending");
  assert.deepEqual(observedSelections, [null, firstClip.path, firstClip.path, firstClip.path, firstClip.path, firstClip.path, firstClip.path]);
});

test("editor state rejects a selection that is not in its owned clip map", () => {
  const store = createEditorStore();

  assert.throws(
    () => store.dispatch({ type: "select-clip", path: "C:\\missing.mp4" }),
    /unknown clip/i,
  );
});
