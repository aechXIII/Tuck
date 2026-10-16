import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultRateControl, encoderDisplaySummary, encoderIds, encoderLabel, encoderUnavailable,
  nativePresetForSpeed, nativePresets, rateControlOptions, twoPassEligible,
} from "../../src/features/export/encoder-options.ts";
import { encoderForPlatform, encodersForPlatform, type PlatformCapabilities } from "../../src/platform/capabilities.ts";

const linux: PlatformCapabilities = {
  platform: "linux", architecture: "x86_64", sendToIntegration: false,
  publicCli: false, automaticUpdater: true, hardwareAcceleration: true,
  customTitleBar: false, packaged: false,
};

test("Linux exposes discovered VAAPI codecs and preserves Auto choices", () => {
  const available = ["libx264", "h264_vaapi", "hevc_vaapi", "h264_nvenc", "hevc_amf"];
  assert.deepEqual(encodersForPlatform(available, linux), ["libx264", "h264_vaapi", "hevc_vaapi", "h264_nvenc"]);
  for (const encoder of ["h264_vaapi", "hevc_vaapi", "h264_nvenc", "auto_fast", "auto_compression"]) {
    assert.equal(encoderForPlatform(encoder, linux), encoder);
  }
  assert.equal(encoderForPlatform("hevc_amf", linux), "libx264");
  assert.equal(encoderForPlatform("h264_vaapi", { ...linux, platform: "windows" }), "libx264");
  assert.deepEqual(encodersForPlatform(available, { ...linux, hardwareAcceleration: false }), ["libx264"]);
});

test("encoder choices restrict saved and undiscovered hardware to the native platform", () => {
  assert.deepEqual(encoderIds(["libx264", "h264_vaapi", "hevc_vaapi"], "h264_vaapi", true, "linux"),
    ["auto_compression", "auto_fast", "libx264", "h264_vaapi", "hevc_vaapi"]);
  assert.ok(!encoderIds([], "h264_amf", true, "linux").includes("h264_amf"));
  assert.ok(!encoderIds([], "h264_vaapi", true, "windows").includes("h264_vaapi"));
  assert.ok(!encoderIds([], "auto_fast", true, "linux").includes("h264_vaapi"));
  assert.equal(encoderUnavailable([], "h264_vaapi"), true);
});

test("VAAPI codecs use readable labels and hardware rate control", () => {
  assert.equal(encoderLabel("h264_vaapi"), "VAAPI H.264 · Hardware");
  assert.equal(encoderLabel("hevc_vaapi"), "VAAPI H.265 · Hardware");
  assert.equal(encoderDisplaySummary(["libx264", "h264_vaapi", "hevc_vaapi"]), "VAAPI · CPU");
  for (const encoder of ["h264_vaapi", "hevc_vaapi"]) {
    assert.deepEqual(nativePresets(encoder), ["speed", "balanced", "quality"]);
    assert.equal(nativePresetForSpeed("fast", encoder), "speed");
    assert.equal(nativePresetForSpeed("best", encoder), "quality");
    assert.deepEqual(rateControlOptions("compression", encoder), ["CBR", "VBR"]);
    assert.deepEqual(rateControlOptions("upscale", encoder), ["CQ", "CBR", "VBR"]);
    assert.equal(defaultRateControl("upscale", encoder), "CQ");
    assert.equal(twoPassEligible("compression", encoder), false);
  }
});

test("unknown backend encoder names remain diagnostic text without becoming choices", () => {
  const name = '<img src=x onerror="bad()">';
  assert.deepEqual(encodersForPlatform(["libx264", name], { ...linux, platform: "windows" }), ["libx264", name]);
  assert.equal(encoderLabel(name), name);
  assert.ok(!encoderIds(["libx264", name], name, true, "windows").includes(name));
});
