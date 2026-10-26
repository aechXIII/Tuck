import assert from "node:assert/strict";
import test from "node:test";

import { cutOutputLine, notReadyNote } from "../../src/features/export/cut-state.ts";

test("the Output line says one file is made, and joins several segments into it", () => {
  assert.equal(cutOutputLine(1, "46 MB"), "The kept segment is saved as this file · about 46 MB");
  assert.equal(cutOutputLine(3, "46 MB"), "Kept segments are joined into this one file · about 46 MB");
  assert.equal(cutOutputLine(2, ""), "Kept segments are joined into this one file");
});

test("Export all cuts names the videos it waits for, grouped by why", () => {
  assert.equal(notReadyNote([]), "");
  assert.equal(
    notReadyNote([
      { name: "a.mp4", reason: "keyframes" },
      { name: "b.mov", reason: "problem" },
      { name: "c.mp4", reason: "keyframes" },
    ]),
    "Waiting for keyframes: a.mp4, c.mp4. Can't be cut yet: b.mov.",
  );
  const many = ["1", "2", "3", "4", "5"].map((name) => ({ name: `${name}.mp4`, reason: "keyframes" as const }));
  assert.equal(notReadyNote(many), "Waiting for keyframes: 1.mp4, 2.mp4, 3.mp4 and 2 more.");
  assert.equal(notReadyNote([{ name: "x.mp4", reason: "exporting" }, { name: "y.mp4", reason: "unreadable" }, { name: "z.mp4", reason: "details" }]),
    "Already exporting: x.mp4. Can't be read: y.mp4. Reading video details: z.mp4.");
});
