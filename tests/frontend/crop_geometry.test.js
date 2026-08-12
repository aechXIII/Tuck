"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crop = require("../../tuck/web/crop.js");

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
    1080
  );
  const largeContent = crop.containedRect(1280, 720, 1920, 1080);
  const large = crop.sourceRectToDisplay(sourceCrop, largeContent, 1920, 1080);
  assert.ok(large.width > small.width);
  const recovered = crop.displayPointToSource(
    large.left,
    large.top,
    largeContent,
    1920,
    1080
  );
  assert.deepEqual(recovered, { x: 320, y: 180 });
});
