import assert from "node:assert/strict";
import test from "node:test";

import { NO_FIT, playerFit } from "../../src/features/player/player-fit.ts";

const docked = { docked: true, libraryOpen: true, inspectorOpen: true };

test("a stage wider than the picture hands the spare width to the open panels", () => {
  // 1948 x 1023 stage, 16:9 picture needs 1818 wide: 130 px spare, split between both panels
  assert.deepEqual(playerFit({ width: 1948, height: 1023 }, 16 / 9, docked), {
    libraryExtra: 64,
    inspectorExtra: 65,
    shrinkX: 0,
    shrinkY: 0,
  });
  assert.deepEqual(playerFit({ width: 1948, height: 1023 }, 16 / 9, { ...docked, libraryOpen: false }), {
    libraryExtra: 0,
    inspectorExtra: 129,
    shrinkX: 0,
    shrinkY: 0,
  });
});

test("with no docked panel to take it, the card narrows instead", () => {
  const fit = playerFit({ width: 924, height: 271 }, 16 / 9, { docked: false, libraryOpen: true, inspectorOpen: false });
  assert.deepEqual(fit, { ...NO_FIT, shrinkX: 442 });
  assert.deepEqual(playerFit({ width: 1948, height: 1023 }, 16 / 9, { docked: true, libraryOpen: false, inspectorOpen: false }), {
    ...NO_FIT,
    shrinkX: 129,
  });
  // never narrower than the controls under the picture need
  assert.deepEqual(playerFit({ width: 924, height: 271 }, 9 / 16, { docked: false, libraryOpen: false, inspectorOpen: false }, 300), {
    ...NO_FIT,
    shrinkX: 624,
  });
});

test("a stage taller than the picture shortens the card", () => {
  assert.deepEqual(playerFit({ width: 612, height: 431 }, 16 / 9, docked), { ...NO_FIT, shrinkY: 86 });
});

test("a picture that already fits, or no picture, leaves the layout alone", () => {
  assert.deepEqual(playerFit({ width: 812, height: 457 }, 16 / 9, docked), NO_FIT);
  assert.deepEqual(playerFit({ width: 812, height: 457 }, null, docked), NO_FIT);
  assert.deepEqual(playerFit({ width: 0, height: 457 }, 16 / 9, docked), NO_FIT);
});

test("vertical video hugs its height too", () => {
  // a 9:16 phone clip in a 1000 x 600 stage is 337.5 wide
  assert.deepEqual(playerFit({ width: 1000, height: 600 }, 9 / 16, docked), {
    libraryExtra: 331,
    inspectorExtra: 331,
    shrinkX: 0,
    shrinkY: 0,
  });
});
