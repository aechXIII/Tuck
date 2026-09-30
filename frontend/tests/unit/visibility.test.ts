import assert from "node:assert/strict";
import test from "node:test";
import { hiddenParts, launchTask, taskAt, taskIndex, visibleInspectorTab, visibleTasks } from "../../src/features/settings/visibility.ts";

test("hidden parts keep only known names and never hide every task", () => {
  assert.deepEqual([...hiddenParts(["cut", "lut", "unknown", 3, "lut"])], ["cut", "lut"]);
  assert.deepEqual([...hiddenParts(null)], []);
  const everything = hiddenParts(["compression", "upscale", "cut"]);
  assert.deepEqual(visibleTasks(everything), ["compression"]);
});

test("a shortcut task wins over the start task, which wins over the last task", () => {
  const hidden = hiddenParts([]);
  assert.equal(launchTask({launch:"cut", start:"upscale", last:"compression", hidden}), "cut");
  assert.equal(launchTask({launch:null, start:"upscale", last:"cut", hidden}), "upscale");
  assert.equal(launchTask({start:"last", last:"cut", hidden}), "cut");
  assert.equal(launchTask({start:"nonsense", last:"nonsense", hidden}), "compression");
});

test("hidden tasks are skipped at launch, even when a shortcut asks for one", () => {
  const hidden = hiddenParts(["compression", "cut"]);
  assert.equal(launchTask({launch:"cut", start:"compression", last:"cut", hidden}), "upscale");
  assert.equal(launchTask({start:"cut", last:"upscale", hidden:hiddenParts(["cut"])}), "upscale");
  assert.equal(launchTask({start:"last", last:"upscale", hidden:hiddenParts(["upscale"])}), "compression");
});

test("task names and workflow indexes map both ways", () => {
  for (const task of ["compression", "upscale", "cut"] as const) assert.equal(taskAt(taskIndex(task)), task);
});

test("This video falls back to Export only when Transform and Audio are both hidden", () => {
  assert.equal(visibleInspectorTab("edit", hiddenParts(["panel_video"])), "edit");
  assert.equal(visibleInspectorTab("audio", hiddenParts(["panel_audio"])), "audio");
  assert.equal(visibleInspectorTab("edit", hiddenParts(["panel_video", "panel_audio"])), "export");
  assert.equal(visibleInspectorTab("audio", hiddenParts(["panel_video", "panel_audio"])), "export");
  assert.equal(visibleInspectorTab("export", hiddenParts(["panel_video", "panel_audio"])), "export");
});
