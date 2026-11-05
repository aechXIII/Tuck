import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMbps,
  keyframeLabel,
  maxBitrateRow,
  parseMaxBitrate,
  tenBitRow,
} from "../../src/features/export/encoding-extras.ts";
import { buildPlanRequest, buildProfilePayload, type ExportFormState } from "../../src/features/export/plan-request.ts";
import * as inspectorUi from "../../src/features/panels/inspector-ui.ts";
import { profileChangeSummary } from "../../src/features/profiles/profile-summary.ts";

test("Max bitrate applies to quality levels on encoders that can cap them", () => {
  const quality = { workflow: "compression", goal: "quality", rateControl: "CRF", encoder: "libx265" } as const;
  assert.deepEqual(maxBitrateRow(quality), { enabled: true, placeholder: "No limit", note: "" });
  assert.deepEqual(maxBitrateRow({ ...quality, goal: "size" }), { enabled: false, placeholder: "Set by Size", note: "" });
  assert.deepEqual(
    maxBitrateRow({ ...quality, workflow: "upscale", rateControl: "VBR" }),
    { enabled: false, placeholder: "Set by Bitrate", note: "" },
  );
  assert.equal(maxBitrateRow({ ...quality, workflow: "upscale", rateControl: "CQ", encoder: "hevc_nvenc" }).enabled, true);
  for (const encoder of ["hevc_vaapi", "h264_amf"]) {
    assert.deepEqual(maxBitrateRow({ ...quality, encoder }), { enabled: false, placeholder: "No limit", note: "Needs software or NVIDIA." });
  }
  // Auto moves past the encoders that can't cap
  assert.equal(maxBitrateRow({ ...quality, encoder: "auto_compression" }).enabled, true);
});

test("10-bit needs H.265 and an encoder that said yes", () => {
  assert.equal(tenBitRow("libx264", undefined).note, "10-bit needs H.265.");
  assert.equal(tenBitRow("auto", undefined).enabled, false);
  assert.deepEqual(tenBitRow("hevc_nvenc", undefined), { enabled: true, placeholder: "", note: "" });
  assert.equal(tenBitRow("libx265", false).note, "10-bit needs a GPU encoder here.");
  assert.equal(tenBitRow("hevc_vaapi", false).note, "This encoder can't make 10-bit.");
  assert.equal(tenBitRow("hevc_vaapi", true).enabled, true);
});

test("the cap is typed in Mbps and kept to a tenth", () => {
  assert.equal(parseMaxBitrate("8"), 8);
  assert.equal(parseMaxBitrate(" 2,5 "), 2.5);
  assert.equal(parseMaxBitrate("12.345"), 12.3);
  assert.equal(parseMaxBitrate(""), 0);
  assert.equal(parseMaxBitrate("fast"), 0);
  assert.equal(parseMaxBitrate("-3"), 0);
  assert.equal(parseMaxBitrate("0.01"), 0.1);
  assert.equal(parseMaxBitrate("5000"), 1000);
  assert.equal(formatMbps(0), "");
  assert.equal(formatMbps(2.5), "2.5");
  assert.deepEqual([0, 1, 2, 10].map(keyframeLabel), ["Auto", "1 second", "2 seconds", "10 seconds"]);
});

function form(overrides: Partial<ExportFormState> = {}): ExportFormState {
  return {
    workflow: "compression", profileId: "p", goal: "quality", targetSizeMb: 25, qualityLevel: 26,
    resolutionMode: "source", customWidth: 1920, customHeight: 1080, scaler: "lanczos",
    useSourceFps: true, customFps: 30, keepAudio: false, audioBitrateKbps: 128, twoPass: false,
    encoder: "libx265", preset: "medium", rateControl: "CRF", qualityValue: 23, bitrateKbps: 2000,
    tune: "none", ...overrides,
  };
}

test("requests and profiles carry the settings, and turning one off sends it off", () => {
  const request = buildPlanRequest(form({ maxBitrateMbps: 8, tenBit: true, keyframeSeconds: 2 }), { source: "clip.mp4" });
  assert.equal(request.max_bitrate, 8_000_000);
  assert.equal(request.ten_bit, true);
  assert.equal(request.keyframe_seconds, 2);
  // a profile with a cap must not keep it when this export has none
  const off = buildPlanRequest(form(), { source: "clip.mp4" });
  assert.deepEqual([off.max_bitrate, off.ten_bit, off.keyframe_seconds], [0, false, 0]);
  const profile = buildProfilePayload(form({ maxBitrateMbps: 2.5, tenBit: true, keyframeSeconds: 5 }), { name: "Cap", currentProfile: null, clip: null });
  assert.deepEqual([profile.max_bitrate_mbps, profile.ten_bit, profile.keyframe_seconds], [2.5, true, 5]);
});

test("the card names the cap and the Encoder line names 10-bit", () => {
  const state = { workflow: "compression", goal: "quality", width: 2560, height: 1440, fps: 60, videoEncoder: "libx265" } as const;
  assert.equal(inspectorUi.exportSummary({ ...state, maxBitrateMbps: 8 }).detail, "2560×1440 · 60 fps · max 8 Mbps");
  assert.equal(inspectorUi.exportSummary(state).detail, "2560×1440 · 60 fps");
  // with Size the line ends with the bitrate the size works out to, so no cap there
  assert.equal(
    inspectorUi.exportSummary({ ...state, goal: "size", videoBitrateKbps: 5200, maxBitrateMbps: 8 }).detail,
    "2560×1440 · 60 fps · 5.2 Mbps",
  );
  assert.equal(inspectorUi.encoderPanelSummary({ videoEncoder: "libx265", speed: "balanced", tenBit: true }), "H.265 · Balanced · 10-bit");
  assert.equal(inspectorUi.encoderPanelSummary({ videoEncoder: "libx265", speed: "balanced" }), "H.265 · Balanced");
  assert.equal(profileChangeSummary({ mb: 0, tb: false, kf: "0" }, { mb: 8, tb: false, kf: "0" }), "Changed encoder");
});
