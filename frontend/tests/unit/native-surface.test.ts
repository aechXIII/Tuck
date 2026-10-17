import assert from "node:assert/strict";
import test from "node:test";

import {
  holeProperties,
  NO_PICTURE,
  pictureRect,
  sameRect,
} from "../../src/platform/native-surface.ts";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

test("a wide video in a taller box leaves bars above and below", () => {
  const stage = box(100, 50, 800, 600);
  assert.deepEqual(pictureRect(stage, 1920, 1080, stage), { x: 100, y: 125, width: 800, height: 450 });
});

test("a tall video in a wide box leaves bars at the sides", () => {
  const stage = box(0, 0, 1000, 500);
  assert.deepEqual(pictureRect(stage, 1080, 1920, stage), {
    x: 500 - (500 * 1080) / 1920 / 2,
    y: 0,
    width: (500 * 1080) / 1920,
    height: 500,
  });
});

test("a zoomed video is clipped to what the viewport shows", () => {
  const viewport = box(0, 0, 800, 450);
  const zoomed = box(-400, -225, 1600, 900);
  assert.deepEqual(pictureRect(zoomed, 1920, 1080, viewport), { x: 0, y: 0, width: 800, height: 450 });
});

test("no picture before the video has a size, while hidden, or when scrolled out", () => {
  const stage = box(0, 0, 800, 450);
  assert.deepEqual(pictureRect(stage, 0, 0, stage), NO_PICTURE);
  assert.deepEqual(pictureRect(box(0, 0, 0, 0), 1920, 1080, stage), NO_PICTURE);
  assert.deepEqual(pictureRect(box(900, 0, 800, 450), 1920, 1080, stage), NO_PICTURE);
});

test("only a real change counts as a new rectangle", () => {
  const rect = { x: 10, y: 20, width: 300, height: 200 };
  assert.equal(sameRect(rect, { ...rect, x: 10.004 }), true);
  assert.equal(sameRect(rect, { ...rect, width: 301 }), false);
});

test("the hole is described in page pixels", () => {
  assert.deepEqual(holeProperties({ x: 10.5, y: 20, width: 300, height: 168.75 }), [
    ["--native-hole-x", "10.5px"],
    ["--native-hole-y", "20px"],
    ["--native-hole-w", "300px"],
    ["--native-hole-h", "168.75px"],
  ]);
});
