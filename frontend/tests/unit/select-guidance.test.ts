import assert from "node:assert/strict";
import test from "node:test";

import { selectGuidance } from "../../src/features/export/select-guidance.ts";

test("Fit describes resizing within the requested bounds without padding", () => {
  assert.equal(selectGuidance("pe-sizing", "fit"), "Keep the whole frame within the output dimensions; no padding");
});
