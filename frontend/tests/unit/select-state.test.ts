import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSelectOptions, nextSelectIndex, nextSelectMatch, selectPopupPlacement, selectTypeaheadPrefix } from "../../src/ui/select-state.ts";

const options = [
  { value: "fast", label: "Fast", detail: "Finish sooner", disabled: false },
  { value: "gpu", label: "Hardware", detail: "NVIDIA", disabled: true },
  { value: "best", label: "Best compression", detail: "Smaller files", disabled: false },
];

test("keyboard navigation skips unavailable options and stops at the list ends", () => {
  assert.equal(nextSelectIndex(options, 0, 1), 2);
  assert.equal(nextSelectIndex(options, 2, -1), 0);
  assert.equal(nextSelectIndex(options, 2, 1), 2);
  assert.equal(nextSelectIndex(options, -1, 1), 0);
  assert.equal(nextSelectIndex(options, -1, -1), 2);
  assert.equal(nextSelectIndex(options.map(option => ({ ...option, disabled: true })), -1, 1), -1);
  assert.equal(nextSelectIndex([], -1, 1), -1);
});

test("search matches names and guidance without changing availability", () => {
  assert.deepEqual(filterSelectOptions(options, "  SMALLER "), [options[2]]);
  assert.deepEqual(filterSelectOptions(options, "Nvidia"), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, "missing"), []);
  assert.deepEqual(filterSelectOptions(options, ""), options);
});

test("typeahead cycles enabled initials and preserves multi-character matches", () => {
  const choices = [
    { value: "bilinear", label: "Bilinear", detail: "", disabled: false },
    { value: "box", label: "Box", detail: "", disabled: true },
    { value: "bicubic", label: "Bicubic", detail: "", disabled: false },
  ];
  assert.equal(nextSelectMatch(choices, -1, "b", true), 0);
  assert.equal(nextSelectMatch(choices, 0, "B", true), 2);
  assert.equal(nextSelectMatch(choices, 2, "b", true), 0);
  assert.equal(nextSelectMatch(choices, 0, "bic", false), 2);
  assert.equal(nextSelectMatch(choices, 2, "bi", false), 2);
  assert.equal(nextSelectMatch(choices, 2, "missing", false), 2);
  assert.equal(nextSelectMatch([], -1, "b", true), -1);
});

test("typing builds prefixes, cycles repeated initials, and starts again after a pause", () => {
  assert.equal(selectTypeaheadPrefix("", 0, "b", 100), "b");
  assert.equal(selectTypeaheadPrefix("b", 100, "B", 200), "B");
  assert.equal(selectTypeaheadPrefix("bi", 200, "c", 300), "bic");
  assert.equal(selectTypeaheadPrefix("bi", 200, "c", 851), "c");
  assert.equal(selectTypeaheadPrefix("b", 100, "b", 200, false), "bb");
});

test("popup placement fits below, above, and inside compact viewports", () => {
  assert.deepEqual(selectPopupPlacement({ left: 20, top: 40, bottom: 73, width: 220 }, 240, 960, 640),
    { left: 20, top: 79, width: 220, maxHeight: 240 });
  assert.deepEqual(selectPopupPlacement({ left: 760, top: 520, bottom: 553, width: 180 }, 240, 960, 640),
    { left: 760, top: 274, width: 180, maxHeight: 240 });
  const compact = selectPopupPlacement({ left: 0, top: 50, bottom: 83, width: 400 }, 500, 240, 150);
  assert.ok(compact.left >= 8 && compact.left + compact.width <= 232);
  assert.ok(compact.top >= 8 && compact.top + Math.min(500, compact.maxHeight) <= 142);
});

test("an upward menu uses the same height for its position and size limit", () => {
  const anchor = { left: 20, top: 580, bottom: 613, width: 220 };
  const placement = selectPopupPlacement(anchor, 380, 960, 640);
  assert.equal(placement.maxHeight, 380);
  assert.ok(placement.top + placement.maxHeight <= anchor.top - 6);
  assert.ok(placement.top + placement.maxHeight <= 632);
});

test("menus match their field width instead of expanding to a minimum", () => {
  const anchor = { left: 100, top: 40, bottom: 73, width: 176 };
  assert.equal(selectPopupPlacement(anchor, 380, 960, 640).width, anchor.width);
});

test("attached profile menus meet their header below or above without a gap", () => {
  const upperHeader = { left: 100, top: 40, bottom: 116, width: 320 };
  const below = selectPopupPlacement(upperHeader, 250, 960, 640, 0);
  assert.equal(below.top, upperHeader.bottom);
  const lowerHeader = { left: 100, top: 500, bottom: 576, width: 320 };
  const above = selectPopupPlacement(lowerHeader, 250, 960, 640, 0);
  assert.equal(above.top + above.maxHeight, lowerHeader.top);
  assert.equal(above.width, lowerHeader.width);
});
