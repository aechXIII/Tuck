import assert from "node:assert/strict";
import test from "node:test";

import { startScreenCopy } from "../../src/features/library/start-screen.ts";

test("the start screen names what the current task does", () => {
  assert.equal(startScreenCopy("compression").title, "Drop a video to compress it");
  assert.match(startScreenCopy("compression").note, /20 MB for Discord/);
  assert.equal(startScreenCopy("upscale").title, "Drop a video to upscale it");
  assert.equal(startScreenCopy("cut").title, "Drop a video to cut it");
  assert.equal(startScreenCopy("cut").note, "Cuts keep the original quality.");
  assert.deepEqual(startScreenCopy("unknown"), startScreenCopy("compression"));
});

