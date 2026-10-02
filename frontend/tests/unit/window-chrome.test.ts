import assert from "node:assert/strict";
import test from "node:test";

import {
  captionAreaFor,
  captionButtonFrom,
  maximizedFrom,
  sameArea,
  windowMenuPoint,
} from "../../src/platform/window-chrome.ts";

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test("the maximize target is measured from the window's right edge", () => {
  // maximize sits just left of the 46 px close button
  assert.deepEqual(captionAreaFor(box(1148, 0, 46, 40), 1240), { right: 46, width: 46, height: 40 });
  assert.deepEqual(captionAreaFor(box(868.4, 0, 46.2, 40), 960), { right: 45, width: 46, height: 40 });
});

test("a hidden maximize button gives no target", () => {
  assert.equal(captionAreaFor(box(0, 0, 0, 0), 1240), null);
});

test("an unchanged target is not sent again", () => {
  const area = { right: 46, width: 46, height: 40 };
  assert.equal(sameArea(area, { ...area }), true);
  assert.equal(sameArea(area, { ...area, right: 47 }), false);
  assert.equal(sameArea(null, null), true);
  assert.equal(sameArea(area, null), false);
});

test("the window menu opens under the logo", () => {
  assert.deepEqual(windowMenuPoint(box(6, 5, 32, 30)), { x: 6, y: 35 });
});

test("native payloads are read only when they have the expected shape", () => {
  assert.equal(maximizedFrom({ maximized: true }), true);
  assert.equal(maximizedFrom({ maximized: "yes" }), null);
  assert.equal(maximizedFrom(null), null);
  assert.deepEqual(captionButtonFrom({ hovered: true, pressed: false }), { hovered: true, pressed: false });
  assert.equal(captionButtonFrom({ hovered: true }), null);
});
