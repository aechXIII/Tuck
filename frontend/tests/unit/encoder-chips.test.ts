import assert from "node:assert/strict";
import test from "node:test";

import {
  autoEncoderChoices,
  chipEncoder,
  encoderCodec,
  encoderPlace,
  resolvedEncoder,
} from "../../src/features/export/encoder-options.ts";

const laptop = ["libx264", "libx265", "h264_vaapi", "hevc_vaapi"];
const autos = { auto_compression: "libx264", auto_fast: "h264_vaapi", auto: "h264_vaapi" };

test("chips name the encoder an Auto choice starts with", () => {
  assert.equal(resolvedEncoder("auto_fast", autos), "h264_vaapi");
  assert.equal(resolvedEncoder("auto_compression", autos), "libx264");
  assert.equal(resolvedEncoder("auto_fast", {}), "libx264");
  assert.equal(resolvedEncoder("hevc_nvenc", autos), "hevc_nvenc");
  assert.equal(encoderCodec("hevc_vaapi"), "H.265");
  assert.equal(encoderCodec("libx264"), "H.264");
  assert.equal(encoderPlace("libx265"), "CPU");
  assert.equal(encoderPlace("h264_nvenc"), "GPU");
});

test("the codec chip keeps the place and the place chip keeps the codec", () => {
  assert.equal(chipEncoder("libx264", "codec", laptop, autos), "libx265");
  assert.equal(chipEncoder("libx264", "place", laptop, autos), "h264_vaapi");
  assert.equal(chipEncoder("hevc_vaapi", "codec", laptop, autos), "h264_vaapi");
  assert.equal(chipEncoder("hevc_vaapi", "place", laptop, autos), "libx265");
  assert.equal(chipEncoder("auto_fast", "codec", laptop, autos), "hevc_vaapi");
  assert.equal(chipEncoder("auto_compression", "place", laptop, autos), "h264_vaapi");
});

test("a GPU keeps its maker when it has the codec, and a missing one disables the chip", () => {
  const both = ["libx264", "libx265", "h264_nvenc", "h264_amf", "hevc_amf"];
  assert.equal(chipEncoder("h264_amf", "codec", both, {}), "hevc_amf");
  assert.equal(chipEncoder("h264_nvenc", "codec", both, {}), "hevc_amf");
  assert.equal(chipEncoder("libx264", "place", both, {}), "h264_nvenc");
  assert.equal(chipEncoder("libx264", "place", ["libx264", "libx265"], {}), null);
  assert.equal(chipEncoder("libx265", "place", ["libx264", "libx265", "h264_nvenc"], {}), null);
});

test("Auto choices from the backend keep only names", () => {
  assert.deepEqual(autoEncoderChoices({ auto_fast: "h264_vaapi", auto: 3 }), { auto_fast: "h264_vaapi" });
  assert.deepEqual(autoEncoderChoices(null), {});
  assert.deepEqual(autoEncoderChoices(["libx264"]), {});
});
