import assert from "node:assert/strict";
import test from "node:test";
import { encoderIds, encoderUnavailable, nativePresetForSpeed, rateControlOptions, twoPassEligible } from "../../src/features/export/encoder-options.ts";
import { encoderForPlatform, encodersForPlatform, type PlatformCapabilities } from "../../src/platform/capabilities.ts";

const linux: PlatformCapabilities = {
  platform: "linux", architecture: "x86_64", sendToIntegration: false,
  publicCli: false, automaticUpdater: true, hardwareAcceleration: true,
  customTitleBar: false, packaged: false,
};

test("Linux supports discovered NVENC alongside VAAPI while excluding AMF", () => {
  const available = ["libx264", "h264_nvenc", "hevc_nvenc", "h264_vaapi", "h264_amf"];
  assert.deepEqual(encodersForPlatform(available, linux), available.slice(0, -1));
  for (const encoder of ["h264_nvenc", "hevc_nvenc"]) {
    assert.equal(encoderForPlatform(encoder, linux), encoder);
    assert.ok(encoderIds(available, encoder, true, "linux").includes(encoder));
    assert.equal(nativePresetForSpeed("best", encoder), "p7");
    assert.deepEqual(rateControlOptions("upscale", encoder), ["CQ", "CBR", "VBR"]);
    assert.equal(twoPassEligible("compression", encoder), false);
    assert.equal(encoderForPlatform(encoder, { ...linux, hardwareAcceleration: false }), "libx264");
  }
  assert.equal(encoderForPlatform("h264_amf", linux), "libx264");
});

test("Linux never offers unprobed NVENC encoders as available", () => {
  assert.ok(!encoderIds([], "auto_fast", true, "linux").includes("h264_nvenc"));
  assert.equal(encoderUnavailable([], "h264_nvenc", "linux"), true);
  assert.equal(encoderUnavailable(["libx264"], "hevc_nvenc", "linux"), true);
  assert.equal(encoderUnavailable(["h264_nvenc"], "h264_nvenc", "linux"), false);
});
