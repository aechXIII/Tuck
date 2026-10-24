import assert from "node:assert/strict";
import test from "node:test";

import { draggedSplit, keyedSplit, lutInset, shownPicture } from "../../src/features/preview/lut-compare.ts";
import { NO_PICTURE } from "../../src/platform/native-surface.ts";

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRectReadOnly;

test("an untransformed video compares across the picture it draws, not its bars", () => {
  const stage = box(100, 50, 800, 600);
  assert.deepEqual(shownPicture(stage, "contain", 1920, 1080, stage), { x: 100, y: 125, width: 800, height: 450 });
});

test("a cropped or turned video fills its box and is cut to what the viewport shows", () => {
  const viewport = box(0, 0, 800, 450);
  assert.deepEqual(shownPicture(box(-200, 0, 1200, 450), "fill", 1920, 1080, viewport), { x: 0, y: 0, width: 800, height: 450 });
  assert.deepEqual(shownPicture(box(900, 0, 400, 450), "fill", 1920, 1080, viewport), NO_PICTURE);
});

test("the LUT layer is cut on the edge that runs across the screen", () => {
  assert.equal(lutInset(null, 0.5), "inset(0 0 0 50%)");
  assert.equal(lutInset({ a: 2, b: 0, c: 0, d: 2 }, 0.25), "inset(0 0 0 25%)");
  // flipped left to right, the box's own right edge is on the left of the screen
  assert.equal(lutInset({ a: -1, b: 0, c: 0, d: 1 }, 0.25), "inset(0 25% 0 0)");
  // a quarter turn right puts the box's bottom on the left, a quarter turn left puts its top there
  assert.equal(lutInset({ a: 0, b: 1, c: -1, d: 0 }, 0.25), "inset(0 0 25% 0)");
  assert.equal(lutInset({ a: 0, b: -1, c: 1, d: 0 }, 0.25), "inset(25% 0 0 0)");
  assert.equal(lutInset({ a: -1, b: 0, c: 0, d: -1 }, 0.25), "inset(0 25% 0 0)");
});

test("the LUT layer's cut stays inside the box", () => {
  assert.equal(lutInset(null, -0.2), "inset(0 0 0 0%)");
  assert.equal(lutInset(null, 1.4), "inset(0 0 0 100%)");
  assert.equal(lutInset(null, 1 / 3), "inset(0 0 0 33.33%)");
});

test("a dragged divider keeps its distance from the grab point and stays on the picture", () => {
  assert.equal(draggedSplit(0.5, 100, 400), 0.75);
  assert.equal(draggedSplit(0.5, 0, 400), 0.5);
  assert.equal(draggedSplit(0.9, 200, 400), 1);
  assert.equal(draggedSplit(0.1, -200, 400), 0);
  assert.equal(draggedSplit(0.3, 50, 0), 0.3);
});

test("the divider's keys step it, jump to the ends, and leave other keys alone", () => {
  assert.equal(keyedSplit(0.5, "ArrowRight"), 0.55);
  assert.equal(keyedSplit(0.5, "ArrowUp"), 0.55);
  assert.equal(keyedSplit(0.5, "ArrowLeft"), 0.45);
  assert.equal(keyedSplit(0.5, "ArrowDown"), 0.45);
  assert.equal(keyedSplit(0.98, "ArrowRight"), 1);
  assert.equal(keyedSplit(0.02, "ArrowLeft"), 0);
  assert.equal(keyedSplit(0.5, "Home"), 0);
  assert.equal(keyedSplit(0.5, "End"), 1);
  assert.equal(keyedSplit(0.5, " "), null);
  assert.equal(keyedSplit(0.5, "Enter"), null);
});
