import assert from "node:assert/strict";
import test from "node:test";

import { previewPlacement, previewRequest, previewTile } from "../../src/features/library/hover-preview.ts";

test("the picture under the pointer follows its share of the row", () => {
  assert.equal(previewTile(0), 0);
  assert.equal(previewTile(0.5), 16);
  assert.equal(previewTile(1), 31);
  assert.equal(previewTile(-0.2), 0);
  assert.equal(previewTile(Number.NaN), 0);
  assert.equal(previewTile(0.99, 8), 7);
});

test("pictures come from the middle of each slot across the whole video", () => {
  assert.deepEqual(previewRequest(64), { start: 1, step: 2 });
  assert.equal(previewRequest(0), null);
  assert.equal(previewRequest(Number.NaN), null);
});

test("the card sits beside the Library, level with the row, inside the window", () => {
  const view = { width: 960, height: 640 };
  const card = { width: 162, height: 116 };
  assert.deepEqual(previewPlacement({ top: 100, height: 60 }, { left: 8, right: 240 }, card, view), { left: 248, top: 72 });
  // near the bottom it stays in the window
  assert.deepEqual(previewPlacement({ top: 600, height: 60 }, { left: 8, right: 240 }, card, view), { left: 248, top: 516 });
  // a Library on the right edge puts the card on its left
  assert.deepEqual(previewPlacement({ top: 100, height: 60 }, { left: 800, right: 950 }, card, view), { left: 630, top: 72 });
});
