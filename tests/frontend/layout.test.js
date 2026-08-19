const test = require("node:test");
const assert = require("node:assert/strict");

const layout = require("../../tuck/web/layout.js");

test("timeline height bounds preserve a usable preview at supported window sizes", () => {
  assert.deepEqual(layout.timelineHeightBounds(900), {
    min: 170,
    max: 495,
    defaultHeight: 270,
  });
  assert.deepEqual(layout.timelineHeightBounds(640), {
    min: 170,
    max: 310,
    defaultHeight: 192,
  });
});

test("timeline heights clamp invalid and out-of-range persisted values", () => {
  assert.equal(layout.clampTimelineHeight(100, 900), 170);
  assert.equal(layout.clampTimelineHeight(700, 900), 495);
  assert.equal(layout.clampTimelineHeight(260, 900), 260);
  assert.equal(layout.clampTimelineHeight(0, 900), 270);
  assert.equal(layout.clampTimelineHeight("broken", 900), 270);
});

test("timeline separator keys resize predictably and expose range endpoints", () => {
  assert.equal(layout.timelineHeightForKey(260, "ArrowUp", false, 900), 270);
  assert.equal(layout.timelineHeightForKey(260, "ArrowDown", true, 900), 228);
  assert.equal(layout.timelineHeightForKey(260, "Home", false, 900), 170);
  assert.equal(layout.timelineHeightForKey(260, "End", false, 900), 495);
  assert.equal(layout.timelineHeightForKey(260, "Enter", false, 900), null);
});
