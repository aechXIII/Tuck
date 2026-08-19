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
const allControls = [...aspects, ...rotations, ...sizing, flipHorizontal, flipVertical];
const transformFields = {
  disabled: false,
  ariaDisabled: "false",
  classList: {
    toggle(_name, active) {
      transformFields.disabled = active;
    },
  },
  setAttribute(name, value) {
    if (name === "aria-disabled") this.ariaDisabled = value;
  },
};

global.document = {
  getElementById(id) {
    if (id === "transform-fields") return transformFields;
    if (id === "flip-horizontal") return flipHorizontal;
    if (id === "flip-vertical") return flipVertical;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "#transform-fields button") return allControls;
    if (selector === "[data-aspect]") return aspects;
    if (selector === "[data-rotation]") return rotations;
    if (selector === "[data-sizing]") return sizing;
    return [];
  },
};
global.selPath = "clip.mp4";
global.clips = {
  "clip.mp4": {
    probed: true,
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

test("transform controls are unavailable until a probed clip is selected", () => {
  global.selPath = null;
  global.syncTransformControls();

  assert.equal(transformFields.disabled, true);
  assert.equal(transformFields.ariaDisabled, "true");
  assert.equal(allControls.every((item) => item.disabled), true);

  global.selPath = "clip.mp4";
  global.syncTransformControls();
  assert.equal(transformFields.disabled, false);
  assert.equal(allControls.every((item) => !item.disabled), true);
});
