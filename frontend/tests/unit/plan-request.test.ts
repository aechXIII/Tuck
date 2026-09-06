import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlanRequest,
  buildProfilePayload,
  type ExportFormState,
} from "../../src/features/export/plan-request.ts";

function form(overrides: Partial<ExportFormState> = {}): ExportFormState {
  return {
    workflow: "compression",
    profileId: "profile-1",
    targetSizeMb: 25,
    resolutionMode: "source",
    customWidth: 1920,
    customHeight: 1080,
    scaler: "Neighbor",
    useSourceFps: true,
    customFps: 30,
    keepAudio: false,
    audioBitrateKbps: 128,
    twoPass: true,
    encoder: "libx264",
    preset: "medium",
    rateControl: "CBR",
    qualityValue: 23,
    bitrateKbps: 2000,
    tune: "none",
    ...overrides,
  };
}

test("compression request carries target size, source resolution, and audio bitrate", () => {
  const req = buildPlanRequest(form(), { source: "C:\\a.mp4", requestId: 7 });
  assert.equal(req.workflow, "compression");
  assert.equal(req.target_size_bytes, 25 * 1024 * 1024);
  assert.equal(req.resolution_mode, "source");
  assert.equal(req.fps_mode, "source");
  assert.equal(req.keep_audio, false);
  assert.equal(req.audio_bitrate, 128000);
  assert.equal(req.two_pass, true);
  assert.equal(req._request_id, 7);
  assert.ok(!("custom_fps" in req));
});

test("keep-audio suppresses an explicit audio bitrate", () => {
  const req = buildPlanRequest(form({ keepAudio: true }), { source: "s" });
  assert.equal(req.keep_audio, true);
  assert.ok(!("audio_bitrate" in req));
});

test("custom resolution adds width, height, and a lowercased scaler", () => {
  const req = buildPlanRequest(
    form({ resolutionMode: "custom", customWidth: 1280, customHeight: 720, scaler: "Lanczos" }),
    { source: "s" },
  );
  assert.equal(req.resolution_mode, "custom");
  assert.equal(req.custom_width, 1280);
  assert.equal(req.custom_height, 720);
  assert.equal(req.scaler, "lanczos");
});

test("custom frame rate is emitted only when source fps is unchecked", () => {
  const req = buildPlanRequest(form({ useSourceFps: false, customFps: 24 }), { source: "s" });
  assert.equal(req.fps_mode, "custom");
  assert.equal(req.custom_fps, 24);
});

test("upscale uses explicit bitrate and drops target size for CBR", () => {
  const req = buildPlanRequest(
    form({ workflow: "upscale", encoder: "h264_nvenc", rateControl: "CBR", bitrateKbps: 8000 }),
    { source: "s" },
  );
  assert.equal(req.workflow, "upscale");
  assert.ok(!("target_size_bytes" in req));
  assert.equal(req.rate_control, "explicit_bitrate");
  assert.equal(req.explicit_bitrate, 8_000_000);
  assert.equal(req.two_pass, false);
});

test("upscale CRF maps quality value to crf and a cpu tune passes through", () => {
  const req = buildPlanRequest(
    form({ workflow: "upscale", encoder: "libx265", rateControl: "CRF", qualityValue: 18, tune: "grain" }),
    { source: "s" },
  );
  assert.equal(req.crf, 18);
  assert.equal(req.rate_control_method, "crf");
  assert.equal(req.tune, "grain");
});

test("segments are included only when the clip is edited", () => {
  const withSegments = buildPlanRequest(form(), {
    source: "s",
    segments: [
      { start: 0, end: 4 },
      { start: 6, end: 9 },
    ],
  });
  assert.deepEqual(withSegments.segments, [
    { start: 0, end: 4 },
    { start: 6, end: 9 },
  ]);
  const noSegments = buildPlanRequest(form(), { source: "s", segments: [] });
  assert.ok(!("segments" in noSegments));
});

test("a transform payload is merged when provided", () => {
  const transform = { crop: { x: 0, y: 0, width: 10, height: 10 }, rotation: 90 } as never;
  const req = buildPlanRequest(form(), { source: "s", transform });
  assert.equal(req.transform, transform);
});

test("profile payload keeps CQP when the current profile used CQP", () => {
  const data = buildProfilePayload(
    form({ workflow: "upscale", encoder: "h264_nvenc", rateControl: "CQ", qualityValue: 20 }),
    { name: "My profile", currentProfile: { rate_control_method: "cqp", qp: 19 }, clip: null },
  );
  assert.equal(data.rate_control_method, "cqp");
  assert.equal(data.qp, 20);
  assert.equal(data.name, "My profile");
});

test("profile payload writes transform intent when the clip touched it", () => {
  const data = buildProfilePayload(form(), {
    name: "P",
    currentProfile: null,
    clip: { cropAspect: "16:9", rotation: 90, sizingMode: "fill", transformIntentTouched: true },
  });
  assert.deepEqual(data.transform_intent, {
    crop_aspect: "16:9",
    rotation: 90,
    sizing_mode: "fill",
  });
});

test("profile payload omits transform intent when nothing touched it", () => {
  const data = buildProfilePayload(form(), { name: "P", currentProfile: null, clip: null });
  assert.ok(!("transform_intent" in data));
});
