import assert from "node:assert/strict";
import test from "node:test";

import * as shortcuts from "../../src/features/shortcuts/shortcuts.ts";

const press = (key: string, modifiers: {ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean} = {}) => ({key, ...modifiers});

test.afterEach(() => shortcuts.setShortcutOverrides({}));

test("saved shortcut changes keep only known, changeable commands and usable keys", () => {
  shortcuts.setShortcutOverrides({
    "file.add-videos": ["Ctrl+Shift+O"],
    "timeline.split": ["X", "X"],
    "ui.dismiss": ["Q"],
    "timeline.adjust-trim-forward": ["L"],
    "edit.undo": ["Tab"],
    "made.up": ["K"],
    "settings.open": "Ctrl+P",
  });
  assert.deepEqual(shortcuts.shortcutOverrides(), {"file.add-videos": ["Ctrl+Shift+O"], "timeline.split": ["X"]});
  shortcuts.setShortcutOverrides(null);
  assert.deepEqual(shortcuts.shortcutOverrides(), {});
});

test("the chosen keys run the command and its old keys no longer do", () => {
  const command = shortcuts.commands.find((item) => item.id === "timeline.split")!;
  const registry = shortcuts.createRegistry([command], shortcuts.effectiveBindings);
  const runs: string[] = [];
  registry.registerAction("timeline.split", () => runs.push("split"));
  shortcuts.setShortcutOverrides({"timeline.split": ["X"]});
  assert.equal(registry.dispatch(press("s")), null);
  assert.equal(registry.dispatch(press("x")), "timeline.split");
  shortcuts.setShortcutOverrides({"timeline.split": []});
  assert.equal(registry.dispatch(press("x")), null);
  assert.deepEqual(runs, ["split"]);
});

test("a key press becomes the shortcut the way it is stored", () => {
  assert.equal(shortcuts.bindingFromEvent(press("o", {ctrlKey:true, shiftKey:true})), "Ctrl+Shift+O");
  assert.equal(shortcuts.bindingFromEvent(press(" ")), "Space");
  assert.equal(shortcuts.bindingFromEvent(press("?", {shiftKey:true})), "?");
  assert.equal(shortcuts.bindingFromEvent(press("ArrowLeft", {altKey:true})), "Alt+ArrowLeft");
  assert.equal(shortcuts.bindingFromEvent(press("Shift", {shiftKey:true})), null);
  assert.equal(shortcuts.isAssignableBinding("Tab"), false);
  assert.equal(shortcuts.isAssignableBinding("Escape"), false);
  assert.equal(shortcuts.isAssignableBinding("Ctrl+Shift+O"), true);
  assert.equal(shortcuts.isAssignableBinding("F12"), true);
  assert.equal(shortcuts.isAssignableBinding("AudioVolumeUp"), false);
  assert.equal(shortcuts.isAssignableBinding("Shift"), false);
});

test("keys already in use name the command that has them", () => {
  assert.deepEqual(shortcuts.commandsUsing("Ctrl+Q").map((item) => item.id), ["app.exit"]);
  assert.deepEqual(shortcuts.commandsUsing("Ctrl+Q", "app.exit"), []);
  // the trim nudge is handled by the focused handle and cannot be changed, so it never conflicts
  assert.equal(shortcuts.commandsUsing("ArrowLeft").some((item) => item.id.startsWith("timeline.adjust-trim")), false);
});

test("hints, button attributes and the guide follow the chosen keys", () => {
  shortcuts.setShortcutOverrides({"timeline.split": ["Shift+X"]});
  assert.equal(shortcuts.withShortcut("Split", "timeline.split"), "Split (Shift+X)");
  assert.equal(shortcuts.ariaShortcuts(shortcuts.commandBindings("edit.redo")), "Control+Shift+Z Control+Y");
  const split = shortcuts.currentSections().flatMap((section) => section.items).find((item) => item.label === "Split at playhead");
  assert.deepEqual(split?.keys, [["Shift", "X"]]);
  assert.equal(Object.isFrozen(shortcuts.currentSections()), true);
  shortcuts.setShortcutOverrides({"timeline.split": []});
  assert.equal(shortcuts.withShortcut("Split", "timeline.split"), "Split");
});

test("the Settings list names each paired command on its own", () => {
  const labels = shortcuts.editableCommands().map((item) => item.label);
  assert.ok(labels.includes("Previous frame"));
  assert.ok(labels.includes("Next frame"));
  assert.ok(!labels.includes("Close dialog"));
  assert.equal(new Set(labels).size, labels.length);
});
