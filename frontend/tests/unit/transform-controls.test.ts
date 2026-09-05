import assert from "node:assert/strict";
import test from "node:test";

import {
  installTransform,
  resetVideoTransformValues,
  syncTransformControls,
} from "../../src/features/transform/transform.ts";
import type { EditorClip } from "../../src/features/editor/types.ts";
import { createEditorClip } from "../../src/features/editor/types.ts";

interface FakeButton {
  dataset: Record<string, string>;
  active: boolean;
  pressed: string;
  disabled?: boolean;
  classList: {
    toggle: (name: string, active?: boolean) => void;
    owner: FakeButton;
  };
  setAttribute: (name: string, value: string) => void;
}

function button(dataset: Record<string, string>): FakeButton {
  const item: FakeButton = {
    dataset,
    active: false,
    pressed: "false",
    classList: {
      toggle(_name: string, active?: boolean) {
        item.active = !!active;
      },
      owner: null as unknown as FakeButton,
    },
    setAttribute(name: string, value: string) {
      if (name === "aria-pressed") item.pressed = value;
    },
  };
  item.classList.owner = item;
  return item;
}

function buttons(values: Array<string | number>, key: string): FakeButton[] {
  return values.map((value) => button({ [key]: String(value) }));
}

test("transform controls expose selected state to assistive technology", () => {
  const aspects = buttons(["free", "16:9", "9:16", "1:1", "4:3"], "aspect");
  const rotations = buttons([0, 270, 90, 180], "rotation");
  const sizing = buttons(["fit", "fill", "stretch"], "sizing");
  const flipHorizontal = button({});
  const flipVertical = button({});
  const allControls = [...aspects, ...rotations, ...sizing, flipHorizontal, flipVertical];
  const transformFields = {
    disabled: false,
    ariaDisabled: "false",
    classList: {
      toggle(_name: string, active?: boolean) {
        transformFields.disabled = !!active;
      },
    },
    setAttribute(name: string, value: string) {
      if (name === "aria-disabled") transformFields.ariaDisabled = value;
    },
  };

  const clip = createEditorClip("clip.mp4");
  clip.probed = true;
  clip.cropAspect = "9:16";
  clip.rotation = 270;
  clip.flipHorizontal = true;
  clip.flipVertical = false;
  clip.sizingMode = "fill";

  let selPath: string | null = "clip.mp4";
  const clips: Record<string, EditorClip> = { "clip.mp4": clip };

  const fakeDocument = {
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
    createElement() {
      return {
        id: "",
        setAttribute() {},
        classList: { add() {}, remove() {} },
        remove() {},
        style: {},
        dataset: {},
        textContent: "",
      };
    },
    documentElement: { clientWidth: 1280 },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id: string) {
      if (id === "transform-fields") return transformFields;
      if (id === "flip-horizontal") return flipHorizontal;
      if (id === "flip-vertical") return flipVertical;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "#transform-fields button") return allControls;
      if (selector === "[data-aspect]") return aspects;
      if (selector === "[data-rotation]") return rotations;
      if (selector === "[data-sizing]") return sizing;
      return [];
    },
  };

  const api = installTransform({
    document: fakeDocument as unknown as Document,
    clips: () => clips,
    selPath: () => selPath,
  });

  syncTransformControls();

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

  selPath = null;
  api.syncTransformControls();
  assert.equal(transformFields.disabled, true);
  assert.equal(transformFields.ariaDisabled, "true");
  assert.equal(
    allControls.every((item) => item.disabled === true),
    true,
  );

  selPath = "clip.mp4";
  api.syncTransformControls();
  assert.equal(transformFields.disabled, false);
  assert.equal(
    allControls.every((item) => !item.disabled),
    true,
  );

  api.dispose();
});

test("reset all restores every transform value instead of only clearing crop", () => {
  const clip = {
    cropAspect: "9:16",
    crop: { x: 10, y: 20, width: 720, height: 1280 },
    rotation: 270,
    flipHorizontal: true,
    flipVertical: true,
    sizingMode: "fill",
  };

  resetVideoTransformValues(clip);

  assert.deepEqual(clip, {
    cropAspect: "off",
    crop: null,
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    sizingMode: "fit",
  });
});
