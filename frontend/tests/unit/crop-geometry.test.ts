import assert from "node:assert/strict";
import test from "node:test";

import * as crop from "../../src/features/transform/crop-geometry.ts";

test("crop initializes to the full source frame", () => {
  assert.deepEqual(crop.selectionCrop(null, 1920, 1080), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
});

test("moving a crop keeps its size and clamps to source bounds", () => {
  const original = { x: 100, y: 80, width: 800, height: 600 };
  assert.deepEqual(crop.resizeCrop(original, "move", 250, 120, 1920, 1080), {
    x: 350,
    y: 200,
    width: 800,
    height: 600,
  });
  assert.deepEqual(crop.resizeCrop(original, "move", 5000, 5000, 1920, 1080), {
    x: 1120,
    y: 480,
    width: 800,
    height: 600,
  });
});

test("edge and corner resizing preserves even output dimensions", () => {
  const original = { x: 100, y: 80, width: 800, height: 600 };
  assert.deepEqual(crop.resizeCrop(original, "w", 121, 0, 1920, 1080), {
    x: 220,
    y: 80,
    width: 680,
    height: 600,
  });
  assert.deepEqual(crop.resizeCrop(original, "se", 101, 99, 1920, 1080), {
    x: 100,
    y: 80,
    width: 902,
    height: 700,
  });
});

test("reset removes stored crop state", () => {
  assert.equal(crop.resetCrop(), null);
});

test("aspect presets preserve center and stay inside landscape source", () => {
  const current = { x: 300, y: 200, width: 800, height: 600 };
  for (const aspect of ["16:9", "9:16", "1:1", "4:3"]) {
    const result = crop.cropForAspect(current, aspect, 1920, 1080);
    const parts = crop.aspectParts(aspect);
    assert.ok(parts);
    assert.equal(result.width * parts.height, result.height * parts.width);
    assert.equal(result.x + result.width / 2, current.x + current.width / 2);
    assert.equal(result.y + result.height / 2, current.y + current.height / 2);
    assert.ok(result.x >= 0 && result.y >= 0);
    assert.ok(result.x + result.width <= 1920);
    assert.ok(result.y + result.height <= 1080);
  }
});

test("aspect presets work for portrait and matching sources", () => {
  assert.deepEqual(crop.cropForAspect(null, "9:16", 1080, 1920), {
    x: 0,
    y: 0,
    width: 1080,
    height: 1920,
  });
  const square = crop.cropForAspect(null, "1:1", 1080, 1920);
  assert.deepEqual(square, { x: 0, y: 420, width: 1080, height: 1080 });
});

test("free aspect keeps the current crop", () => {
  const current = { x: 300, y: 200, width: 800, height: 600 };
  assert.deepEqual(crop.cropForAspect(current, "free", 1920, 1080), current);
});

test("switching aspect presets does not progressively shrink the crop", () => {
  const square = crop.cropForAspect(null, "1:1", 1920, 1080);
  const fourThree = crop.cropForAspect(square, "4:3", 1920, 1080);
  const squareAgain = crop.cropForAspect(fourThree, "1:1", 1920, 1080);
  const fourThreeAgain = crop.cropForAspect(squareAgain, "4:3", 1920, 1080);

  assert.deepEqual(squareAgain, square);
  assert.deepEqual(fourThreeAgain, fourThree);
});

test("aspect presets describe the visible ratio after rotation", () => {
  const selected = crop.cropForAspect(null, "16:9", 1920, 1080, 90);
  assert.equal(selected.width * 16, selected.height * 9);

  const preview = crop.previewTransformGeometry(
    { crop: selected, rotation: 90, sizing_mode: "fit" },
    1920,
    1080,
  );
  assert.equal(preview.orientedWidth * 9, preview.orientedHeight * 16);
});

test("locked corner resize preserves ratio and bounds", () => {
  const original = { x: 240, y: 180, width: 640, height: 360 };
  const result = crop.resizeCrop(original, "se", 1000, 1000, 1280, 720, "16:9");
  assert.equal(result.width * 9, result.height * 16);
  assert.ok(result.x >= 0 && result.y >= 0);
  assert.ok(result.x + result.width <= 1280);
  assert.ok(result.y + result.height <= 720);
});

test("locked edge resize preserves ratio and center", () => {
  const original = { x: 320, y: 180, width: 640, height: 360 };
  const result = crop.resizeCrop(original, "e", -160, 0, 1280, 720, "16:9");
  assert.equal(result.width * 9, result.height * 16);
  assert.equal(result.y + result.height / 2, original.y + original.height / 2);
});

test("coordinate conversion accounts for letterboxing", () => {
  const content = crop.containedRect(1000, 1000, 1920, 1080);
  assert.ok(Math.abs(content.left) < 0.001);
  assert.ok(Math.abs(content.width - 1000) < 0.001);
  assert.ok(Math.abs(content.top - 218.75) < 0.001);
  const center = crop.displayPointToSource(500, 500, content, 1920, 1080);
  assert.deepEqual(center, { x: 960, y: 540 });
});

test("preview resize changes display geometry without changing source crop", () => {
  const sourceCrop = { x: 320, y: 180, width: 1280, height: 720 };
  const small = crop.sourceRectToDisplay(
    sourceCrop,
    crop.containedRect(640, 480, 1920, 1080),
    1920,
    1080,
  );
  const largeContent = crop.containedRect(1280, 720, 1920, 1080);
  const large = crop.sourceRectToDisplay(sourceCrop, largeContent, 1920, 1080);
  assert.ok(large.width > small.width);
  const recovered = crop.displayPointToSource(
    large.left,
    large.top,
    largeContent,
    1920,
    1080,
  );
  assert.deepEqual(recovered, { x: 320, y: 180 });
});

test("Fit, Fill, and Stretch produce distinct preview geometry", () => {
  const selected = { x: 660, y: 0, width: 600, height: 1080 };
  const output = { width: 1920, height: 1080 };
  const fit = crop.previewTransformGeometry(
    { crop: selected, output, rotation: 0, sizing_mode: "fit" },
    1920,
    1080,
  );
  const fill = crop.previewTransformGeometry(
    { crop: selected, output, rotation: 0, sizing_mode: "fill" },
    1920,
    1080,
  );
  const stretch = crop.previewTransformGeometry(
    { crop: selected, output, rotation: 0, sizing_mode: "stretch" },
    1920,
    1080,
  );
  assert.deepEqual(fit.output, { width: 600, height: 1080 });
  assert.ok(fill.fillCrop);
  assert.equal(fill.fillCrop.width, 600);
  assert.equal(Math.round(fill.fillCrop.height), 338);
  assert.deepEqual(fill.output, output);
  assert.equal(stretch.fillCrop, null);
  assert.deepEqual(stretch.output, output);
});

test("crop number fields clamp to the frame and keep sizes even", () => {
  const box = { x: 100, y: 80, width: 800, height: 600 };
  assert.deepEqual(crop.cropWithField(box, "x", 1500, 1920, 1080), { ...box, x: 1120 });
  assert.deepEqual(crop.cropWithField(box, "y", -40, 1920, 1080), { ...box, y: 0 });
  assert.deepEqual(crop.cropWithField(box, "x", 250.6, 1920, 1080), { ...box, x: 251 });
  // an odd width rounds to even; a size past the frame stops at it and slides the box back in
  assert.deepEqual(crop.cropWithField(box, "width", 641, 1920, 1080), { ...box, width: 642 });
  assert.deepEqual(crop.cropWithField(box, "width", 5000, 1920, 1080), { ...box, x: 0, width: 1920 });
  assert.deepEqual(crop.cropWithField(box, "height", 1000, 1920, 1080), { ...box, y: 80, height: 1000 });
  assert.deepEqual(crop.cropWithField(box, "height", 0, 1920, 1080), { ...box, height: 2 });
  // something that isn't a number leaves the crop as it was
  assert.deepEqual(crop.cropWithField(box, "width", Number.NaN, 1920, 1080), box);
  // no crop yet means the whole frame
  assert.deepEqual(crop.cropWithField(null, "x", 40, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(crop.isCropField("width"), true);
  assert.equal(crop.isCropField("left"), false);
});

test("crop number fields keep a chosen aspect ratio", () => {
  const box = { x: 0, y: 0, width: 1280, height: 720 };
  assert.deepEqual(crop.cropWithField(box, "width", 1000, 1920, 1080, "16:9"), { x: 0, y: 0, width: 992, height: 558 });
  assert.deepEqual(crop.cropWithField(box, "height", 360, 1920, 1080, "16:9"), { x: 0, y: 0, width: 640, height: 360 });
  // a square crop on a video turned a quarter: the height can't pass the frame's 1080
  const square = { x: 600, y: 100, width: 400, height: 400 };
  assert.deepEqual(crop.cropWithField(square, "width", 1600, 1920, 1080, "1:1", 90), { x: 600, y: 0, width: 1080, height: 1080 });
});

test("arrow keys move and resize the crop the way it looks on screen", () => {
  const box = { x: 100, y: 80, width: 800, height: 600 };
  const upright = { a: 0.5, b: 0, c: 0, d: 0.5 };
  const options = { resize: false, large: false, map: upright, sourceWidth: 1920, sourceHeight: 1080 };
  assert.deepEqual(crop.cropAfterKey(box, "ArrowRight", options), { ...box, x: 101 });
  assert.deepEqual(crop.cropAfterKey(box, "ArrowUp", { ...options, large: true }), { ...box, y: 70 });
  assert.deepEqual(crop.cropAfterKey(box, "ArrowRight", { ...options, resize: true }), { ...box, width: 802 });
  assert.deepEqual(crop.cropAfterKey(box, "ArrowUp", { ...options, resize: true, large: true }), { ...box, height: 580 });
  assert.equal(crop.cropAfterKey(box, "Enter", options), null);
  // turned a quarter clockwise, the screen's right is the source's down
  const turned = { a: 0, b: 0.5, c: -0.5, d: 0 };
  assert.deepEqual(crop.sourceDirection(turned, 1, 0), { x: 0, y: -1 });
  assert.deepEqual(crop.cropAfterKey(box, "ArrowRight", { ...options, map: turned }), { ...box, y: 79 });
  // flipped, Right moves the box left in the source
  const flipped = { a: -0.5, b: 0, c: 0, d: 0.5 };
  assert.deepEqual(crop.cropAfterKey(box, "ArrowRight", { ...options, map: flipped }), { ...box, x: 99 });
  assert.deepEqual(crop.cropAfterKey(box, "ArrowRight", { ...options, map: flipped, resize: true }), { x: 98, y: 80, width: 802, height: 600 });
  // a locked ratio resizes by whole steps of it
  const wide = { x: 0, y: 0, width: 1280, height: 720 };
  assert.deepEqual(
    crop.cropAfterKey(wide, "ArrowRight", { ...options, resize: true, aspect: "16:9" }),
    { x: 0, y: 0, width: 1312, height: 738 },
  );
});
