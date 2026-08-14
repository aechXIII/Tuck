"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function button(dataset) {
  return {
    dataset,
    active: false,
    pressed: "false",
    classList: {
      toggle(_name, active) {
        this.owner.active = active;
      },
      owner: null,
    },
    setAttribute(name, value) {
      if (name === "aria-pressed") this.pressed = value;
    },
  };
}

function buttons(values, key) {
  return values.map((value) => {
    const item = button({ [key]: String(value) });
    item.classList.owner = item;
    return item;
  });
}

const aspects = buttons(["free", "16:9", "9:16", "1:1", "4:3"], "aspect");
const rotations = buttons([0, 270, 90, 180], "rotation");
const sizing = buttons(["fit", "fill", "stretch"], "sizing");
const flipHorizontal = button({});
const flipVertical = button({});
flipHorizontal.classList.owner = flipHorizontal;
flipVertical.classList.owner = flipVertical;

global.document = {
  getElementById(id) {
    if (id === "flip-horizontal") return flipHorizontal;
    if (id === "flip-vertical") return flipVertical;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "[data-aspect]") return aspects;
    if (selector === "[data-rotation]") return rotations;
    if (selector === "[data-sizing]") return sizing;
    return [];
  },
};
global.selPath = "clip.mp4";
global.clips = {
  "clip.mp4": {
    cropAspect: "9:16",
    rotation: 270,
    flipHorizontal: true,
    flipVertical: false,
    sizingMode: "fill",
  },
};

require("../../tuck/web/transform.js");

test("transform controls expose selected state to assistive technology", () => {
  global.syncTransformControls();

  assert.deepEqual(
    aspects.map((item) => item.pressed),
    ["false", "false", "true", "false", "false"],
  );
  assert.deepEqual(
    rotations.map((item) => item.pressed),
    ["false", "true", "false", "false"],
  );
  assert.equal(flipHorizontal.pressed, "true");
  assert.equal(flipVertical.pressed, "false");
  assert.deepEqual(
    sizing.map((item) => item.pressed),
    ["false", "true", "false"],
  );
});
