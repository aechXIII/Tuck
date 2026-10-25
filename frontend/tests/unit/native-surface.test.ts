import assert from "node:assert/strict";
import test from "node:test";

import {
  holeProperties,
  NO_PICTURE,
  pictureRect,
  placePicture,
  sameRect,
  sameView,
  transformMatrix,
  WHOLE_PICTURE,
} from "../../src/platform/native-surface.ts";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const matrix = (a: number, b: number, c: number, d: number) => ({ a, b, c, d });

function assertView(actual: typeof WHOLE_PICTURE, expected: Partial<typeof WHOLE_PICTURE>): void {
  const wanted = { ...WHOLE_PICTURE, ...expected };
  assert.ok(sameView(actual, wanted), `${JSON.stringify(actual)} is not ${JSON.stringify(wanted)}`);
}

test("a video that is only scaled keeps the letterboxed picture it always had", () => {
  const frame = box(100, 0, 800, 450);
  const placed = placePicture(frame, matrix(0.5, 0, 0, 0.5), 1920, 1080, frame);
  assert.deepEqual(placed.rect, pictureRect(frame, 1920, 1080, frame));
  assert.equal(placed.view, WHOLE_PICTURE);
  assert.deepEqual(placePicture(frame, null, 1920, 1080, frame).rect, pictureRect(frame, 1920, 1080, frame));
});

test("a crop shows its part of the picture in the whole viewport", () => {
  const viewport = box(0, 0, 800, 450);
  // the picture drawn twice as large, its middle in the viewport
  const placed = placePicture(box(-200, -100, 1600, 900), matrix(2, 0, 0, 2), 800, 450, viewport);
  assert.deepEqual(placed.rect, { x: 0, y: 0, width: 800, height: 450 });
  assertView(placed.view, { x: 0.125, y: 100 / 900, width: 0.5, height: 0.5 });
});

test("a quarter turn to the right shows the whole picture sideways", () => {
  const frame = box(100, 0, 450, 800);
  const s = 800 / 1920;
  const placed = placePicture(frame, matrix(0, s, -s, 0), 1920, 1080, frame);
  assert.deepEqual(placed.rect, { x: 100, y: 0, width: 450, height: 800 });
  assertView(placed.view, { quarterTurns: 1 });
});

test("other turns and mirrors become one turn to the right and mirrors after it", () => {
  const frame = box(0, 0, 450, 800);
  // a turn to the left is a right turn mirrored both ways
  assertView(placePicture(frame, matrix(0, -1, 1, 0), 1920, 1080, frame).view,
    { quarterTurns: 1, flipHorizontal: true, flipVertical: true });
  // a right turn then a mirror across
  assertView(placePicture(frame, matrix(0, 1, 1, 0), 1920, 1080, frame).view,
    { quarterTurns: 1, flipHorizontal: true });
  const wide = box(0, 0, 800, 450);
  assertView(placePicture(wide, matrix(-1, 0, 0, 1), 1920, 1080, wide).view, { flipHorizontal: true });
  // a half turn is both mirrors
  assertView(placePicture(wide, matrix(-1, 0, 0, -1), 1920, 1080, wide).view,
    { flipHorizontal: true, flipVertical: true });
});

test("a crop on a turned picture is taken back to the picture the editor crops", () => {
  // a 1000 by 500 picture turned right: its left half fills a 500 by 500 viewport
  const placed = placePicture(box(0, 0, 500, 1000), matrix(0, 1, -1, 0), 1000, 500, box(0, 0, 500, 500));
  assert.deepEqual(placed.rect, { x: 0, y: 0, width: 500, height: 500 });
  assertView(placed.view, { x: 0, y: 0, width: 0.5, height: 1, quarterTurns: 1 });
  // mirrored across as well, the same half shows, drawn the other way round
  const mirrored = placePicture(box(0, 0, 500, 1000), matrix(0, 1, 1, 0), 1000, 500, box(0, 0, 500, 500));
  assertView(mirrored.view, { x: 0, y: 0, width: 0.5, height: 1, quarterTurns: 1, flipHorizontal: true });
});

test("Stretch sizing changes the picture's shape", () => {
  const frame = box(0, 0, 800, 450);
  assertView(placePicture(frame, matrix(1, 0, 0, 0.75), 800, 600, frame).view, { stretch: true });
});

test("a transformed picture out of the viewport shows nothing", () => {
  const placed = placePicture(box(900, 0, 800, 450), matrix(-1, 0, 0, 1), 1920, 1080, box(0, 0, 800, 450));
  assert.deepEqual(placed.rect, NO_PICTURE);
});

test("the computed transform is read as its matrix", () => {
  assert.deepEqual(transformMatrix("matrix(0, 0.5, -0.5, 0, 120, 0)"), { a: 0, b: 0.5, c: -0.5, d: 0 });
  assert.equal(transformMatrix("none"), null);
  assert.equal(transformMatrix("matrix(a, b)"), null);
});

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
