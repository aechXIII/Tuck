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
  assert.ok(landscape.some(option => option.value === "1280x720"));
  assert.ok(landscape.some(option => option.value === "3840x2160"));
  assert.equal(landscape[0]?.value, "source");
  assert.ok(inspectorUi.resolutionChoices(1080, 1920).some(option => option.value === "720x1280"));
  assert.ok(inspectorUi.resolutionChoices(3440, 1440).some(option => option.value === "2580x1080"));
  assert.deepEqual(inspectorUi.resolutionDecision("1920x1080"), {
    mode: "custom",
    width: 1920,
    height: 1080,
  });
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
