import assert from "node:assert/strict";
import test from "node:test";

import * as timeline from "../../src/features/timeline/timeline-core.ts";

test("track actions expose only controls owned by each track kind", () => {
  assert.deepEqual(timeline.trackActions("video"), []);
  assert.deepEqual(timeline.trackActions("source"), ["mute"]);
  assert.deepEqual(timeline.trackActions("imported"), ["mute", "remove"]);
});

test("timeline zoom stays inside the supported range", () => {
  assert.equal(timeline.clampZoom(-4), 1);
  assert.equal(timeline.clampZoom(3.5), 3.5);
  assert.equal(timeline.clampZoom(99), 8);
  assert.equal(timeline.clampZoom(Number.NaN), 1);
});

test("long videos zoom until a screen shows about two seconds", () => {
  // short videos keep the 8x they always had
  assert.equal(timeline.maxZoom(12, 1000), 8);
  assert.equal(timeline.maxZoom(0, 1000), 8);
  // an hour shows 3.6 s per 1000 px screen, held back by the million-pixel cap
  assert.equal(timeline.maxZoom(3600, 1000), 1000);
  assert.equal(3600 / timeline.maxZoom(3600, 1000), 3.6);
  // ten minutes reach the full two seconds
  assert.equal(timeline.maxZoom(600, 1000), 300);
  assert.equal(timeline.clampZoom(5000, timeline.maxZoom(600, 1000)), 300);
  assert.equal(timeline.clampZoom(0.5, 300), 1);
});

test("the zoom slider moves in doublings and the wheel zooms smoothly", () => {
  assert.equal(timeline.zoomSliderValue(1), 0);
  assert.equal(timeline.zoomSliderValue(8), 3);
  assert.equal(timeline.zoomFromSlider(3), 8);
  assert.equal(timeline.zoomFromSlider("bad"), 1);
  const zoomedIn = timeline.wheelZoom(4, -100, 0, 64);
  assert.ok(zoomedIn > 4 && zoomedIn < 5, String(zoomedIn));
  assert.ok(timeline.wheelZoom(4, 100, 0, 64) < 4);
  // a line-based wheel notch counts as 16 px per line
  assert.equal(timeline.wheelZoom(4, -3, 1, 64), timeline.wheelZoom(4, -48, 0, 64));
  assert.equal(timeline.wheelZoom(60, -2000, 0, 64), 64);
  assert.equal(timeline.wheelZoom(1.1, 2000, 0, 64), 1);
  assert.equal(timeline.wheelZoom(3, 0, 0, 64), 3);
});

test("zooming around the pointer keeps the time under it in place", () => {
  // the track starts 140 px in; the pointer sat 300 px into the frame over 25% of the track
  const scroll = timeline.pointerAnchoredScroll(140, 8000, 0.25, 300, 1000, 8140);
  assert.equal(scroll, 140 + 2000 - 300);
  // never past either end
  assert.equal(timeline.pointerAnchoredScroll(140, 8000, 0, 600, 1000, 8140), 0);
  assert.equal(timeline.pointerAnchoredScroll(140, 8000, 1, 10, 1000, 8140), 7140);
});

test("a deep zoom draws only the ruler ticks on screen", () => {
  assert.deepEqual(timeline.rulerTickRange(3600, 0.1, 1800, 1803.6), { first: 17999, last: 18037 });
  assert.deepEqual(timeline.rulerTickRange(12, 1, 0, 12), { first: 0, last: 12 });
  assert.deepEqual(timeline.rulerTickRange(12, 0, 0, 12), { first: 0, last: -1 });
  assert.equal(timeline.visibleSpanText(3.6), "3.6 seconds");
  assert.equal(timeline.visibleSpanText(1), "1 second");
  assert.equal(timeline.visibleSpanText(450), "7 min 30 s");
  assert.equal(timeline.visibleSpanText(3600), "1 h");
  assert.equal(timeline.visibleSpanText(3900), "1 h 05 min");
});

test("zoom anchoring keeps the subject centered and clamps at both edges", () => {
  assert.equal(timeline.anchorScrollLeft(1000, 2000, 0.5), 500);
  assert.equal(timeline.anchorScrollLeft(1000, 2000, 0.1), 0);
  assert.equal(timeline.anchorScrollLeft(1000, 2000, 0.9), 1000);
  assert.equal(timeline.anchorScrollLeft(1000, 800, 0.5), 0);
});

test("ruler density responds to pixels per second", () => {
  assert.equal(timeline.rulerStep(36, 40), 1);
  assert.equal(timeline.rulerStep(36, 160), 0.25);
  assert.equal(timeline.rulerStep(600, 0), 30);
  assert.equal(timeline.rulerMajorEvery(1, 40), 5);
  // every 2 s, not every 1.25 s, so labels never round to uneven numbers
  assert.equal(timeline.rulerMajorEvery(0.25, 160), 8);
  assert.equal(timeline.rulerMajorEvery(0.5, 60), 10);
  assert.equal(timeline.rulerMajorEvery(2, 30), 5);
  assert.equal(timeline.rulerMajorEvery(15, 0.5), 40);
});

test("timeline edit keys identify focused segments and trim handles", () => {
  const segment = {
    classList: { contains: (name: string) => name === "tl-segment" },
    dataset: { segmentIndex: "2" },
  };

  assert.deepEqual(timeline.editKeyIntent(segment, "ArrowLeft", false), {
    type: "segment",
    index: 2,
    delta: -0.01,
    snap: false,
  });
  assert.deepEqual(timeline.editKeyIntent({ id: "tl-out" }, "ArrowRight", true), {
    type: "trim",
    endpoint: "end",
    delta: 0.1,
    snap: false,
  });
  assert.equal(timeline.editKeyIntent({ id: "timeline" }, "ArrowLeft", false), null);
  assert.equal(timeline.editKeyIntent({ id: "tl-in" }, "Space", false), null);
});

test("source-audio mute does not change video segment presentation", () => {
  assert.deepEqual(timeline.segmentPresentationState(1, 1), {
    className: "tl-segment active",
  });
  assert.deepEqual(timeline.segmentPresentationState(0, 1), {
    className: "tl-segment",
  });
});

test("timeline shares theme fills while preserving custom segment colors", () => {
  assert.equal(timeline.clipFill("video", true, false, "#A855F7"), "var(--seg-fill-active)");
  assert.equal(timeline.clipFill("video", false, false, "#A855F7"), "#A855F7");
  assert.equal(timeline.clipFill("video", false, false, "#6D28D9"), "#6D28D9");
  assert.equal(timeline.clipFill("source", true, false), "var(--audio-clip-fill)");
  assert.equal(timeline.clipFill("imported", true, false), "var(--audio-clip-fill)");
  assert.equal(timeline.clipFill("imported", false, false, "#B45309"), "#B45309");
  assert.equal(timeline.clipFill("video", true, true), "var(--raised)");
  assert.equal(timeline.clipFill("imported", false, true), "var(--raised)");
  assert.equal(timeline.videoSegmentSelected(2, 2, true), true);
  assert.equal(timeline.videoSegmentSelected(2, 2, false), false);
});

test("the playhead moves itself and skips writes that change nothing", () => {
  let writes = 0;
  let left = "";
  const playhead = { style: {
    get left() { return left; },
    set left(value: string) { left = value; writes++; },
  } };
  timeline.placePlayhead(playhead, 12.5);
  assert.equal(left, "12.5%");
  timeline.placePlayhead(playhead, 12.5);
  timeline.placePlayhead(playhead, 12.50000004);
  assert.equal(writes, 1);
  // a hundredth of a pixel even on a million-pixel deep zoom
  timeline.placePlayhead(playhead, 100 / 3);
  assert.equal(left, "33.333333%");
  timeline.placePlayhead(playhead, 0);
  assert.equal(left, "0%");
  assert.equal(writes, 3);
  assert.doesNotThrow(() => timeline.placePlayhead(null, 50));
});
