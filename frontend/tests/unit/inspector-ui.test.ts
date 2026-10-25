import assert from "node:assert/strict";
import test from "node:test";

import * as inspectorUi from "../../src/features/panels/inspector-ui.ts";

test("export summary presents the current output decision in one compact line", () => {
  assert.deepEqual(
    inspectorUi.exportSummary({
      workflow: "compression",
      targetSizeMb: 50,
      width: 2560,
      height: 1440,
      fps: 60,
      videoEncoder: "libx264",
      audioBitrateKbps: 128,
      keepAudio: false,
    }),
    {
      title: "50 MB",
      detail: "2560×1440 · 60 fps · H.264 · AAC 128k",
    },
  );
});

test("export summaries describe copy, disabled audio, and encoder speed honestly", () => {
  assert.equal(
    inspectorUi.audioSummary({ keepAudio: true, audioBitrateKbps: 128 }),
    "Copy when possible",
  );
  assert.equal(
    inspectorUi.audioSummary({ audioEnabled: false, audioBitrateKbps: 128 }),
    "No audio",
  );
  assert.equal(
    inspectorUi.encoderSummary({ videoEncoder: "hevc_nvenc", speed: "best" }),
    "H.265 · Best compression",
  );
  assert.equal(
    inspectorUi.encoderPanelSummary({
      videoEncoder: "hevc_nvenc",
      speed: "balanced",
    }),
    "NVENC · Balanced",
  );
});

test("size presets keep only the three approved quick decisions", () => {
  assert.deepEqual(inspectorUi.sizePresets(), [20, 50, 200, 500]);
});

test("export video facades preserve source and common output decisions", () => {
  const landscape = inspectorUi.resolutionChoices(2560, 1440);
  const label = (choices: inspectorUi.ChoiceOption[], value: string) =>
    choices.find(option => option.value === value)?.label;
  assert.equal(label(landscape, "720p"), "1280 × 720");
  assert.equal(label(landscape, "2160p"), "3840 × 2160");
  assert.equal(landscape[0]?.value, "source");
  assert.equal(label(inspectorUi.resolutionChoices(1080, 1920), "720p"), "720 × 1280");
  assert.equal(label(inspectorUi.resolutionChoices(3440, 1440), "1080p"), "2580 × 1080");
  assert.deepEqual(inspectorUi.resolutionDecision("1920x1080"), {
    mode: "custom",
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(inspectorUi.resolutionDecision("1440p"), { mode: "short_side", shortSide: 1440 });
  assert.deepEqual(inspectorUi.resolutionDecision("custom"), { mode: "custom" });
  assert.deepEqual(inspectorUi.resolutionDecision("source"), { mode: "source" });
  const fps = inspectorUi.frameRateChoices(60);
  assert.deepEqual(fps.map(option => option.value), ["source", "24", "30", "60", "120", "custom"]);
});

test("upscale summary describes the output without inventing a target size", () => {
  assert.deepEqual(
    inspectorUi.exportSummary({
      workflow: "upscale",
      width: 3840,
      height: 2160,
      fps: 30,
      videoEncoder: "hevc_nvenc",
      audioBitrateKbps: 0,
    }),
    {
      title: "Upscale output",
      detail: "3840×2160 · 30 fps · H.265 · No audio",
    },
  );
});

test("inspector startup resolves fixed and last-used panel preferences", () => {
  assert.equal(inspectorUi.startupTab("video", "export"), "edit");
  assert.equal(inspectorUi.startupTab("audio", "edit"), "audio");
  assert.equal(inspectorUi.startupTab("export", "audio"), "export");
  assert.equal(inspectorUi.startupTab("last", "audio"), "audio");
  assert.equal(inspectorUi.startupTab("last", "unexpected"), "export");
  assert.equal(inspectorUi.startupTab("unexpected", "audio"), "export");
});

test("resolution presets size the short side so vertical videos stay vertical", () => {
  assert.deepEqual(inspectorUi.shortSideSize(1080, 1920, 1440), { width: 1440, height: 2560 });
  assert.deepEqual(inspectorUi.shortSideSize(1920, 1080, 1440), { width: 2560, height: 1440 });
  assert.deepEqual(inspectorUi.shortSideSize(1080, 1080, 2160), { width: 2160, height: 2160 });
  // halves round up, the same as the planner
  assert.deepEqual(inspectorUi.shortSideSize(853, 480, 1440), { width: 2560, height: 1440 });
  assert.deepEqual(inspectorUi.shortSideSize(2560, 1080, 1440), { width: 3414, height: 1440 });
});

test("the resolution menu shows the preset a short side or a matching size picks", () => {
  const state = (mode: string, shortSide: number, width = 0, height = 0) => ({ mode, shortSide, width, height });
  assert.equal(inspectorUi.resolutionChoiceValue(1080, 1920, state("short_side", 1440)), "1440p");
  assert.equal(inspectorUi.resolutionChoiceValue(1080, 1920, state("short_side", 900)), "custom");
  assert.equal(inspectorUi.resolutionChoiceValue(1080, 1920, state("source", 1440)), "source");
  assert.equal(inspectorUi.resolutionChoiceValue(1920, 1080, state("custom", 0, 2560, 1440)), "1440p");
  // a landscape box on a vertical video is a custom size, not 1440p
  assert.equal(inspectorUi.resolutionChoiceValue(1080, 1920, state("custom", 0, 2560, 1440)), "custom");
});

test("scaling offers Smooth and Sharp pixels and reads anything else as Smooth", () => {
  assert.deepEqual(inspectorUi.SCALING_CHOICES.map(choice => choice.label), ["Smooth", "Sharp pixels"]);
  assert.equal(inspectorUi.scalingChoice("neighbor"), "neighbor");
  assert.equal(inspectorUi.scalingChoice("lanczos"), "lanczos");
  assert.equal(inspectorUi.scalingChoice(undefined), "lanczos");
});
