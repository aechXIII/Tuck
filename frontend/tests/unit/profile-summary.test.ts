import assert from "node:assert/strict";
import test from "node:test";

import { profileChangeSummary, profileSummary } from "../../src/features/profiles/profile-summary.ts";

const MB = 1024 * 1024;

test("the integrated header omits its separate target value and preserves Upscale details", () => {
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 10 * MB, resolution_mode: "source", fps_mode: "source" }, { includeTargetSize: false }),
    "source size and frame rate",
  );
  assert.equal(
    profileSummary({ workflow: "upscale", target_size_bytes: 10 * MB, rate_control: "explicit_bitrate", explicit_bitrate_kbps: 25000, resolution_mode: "custom", custom_width: 2560, custom_height: 1440, fps_mode: "source" }, { includeTargetSize: false }),
    "25 Mbps · 1440p · source frame rate",
  );
});

test("a profile sums up its target, size and frame rate in a few words", () => {
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 10 * MB, resolution_mode: "source", fps_mode: "source" }),
    "10 MB · source size and frame rate",
  );
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 16 * MB, resolution_mode: "custom", custom_width: 1280, custom_height: 720, fps_mode: "custom", custom_fps: 30 }),
    "16 MB · 720p · 30 fps",
  );
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 25 * MB, resolution_mode: "limit", max_width: 1920, max_height: 1080, fps_mode: "source" }),
    "25 MB · up to 1080p · source frame rate",
  );
  // a portrait or unusual size keeps its numbers
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 8 * MB, resolution_mode: "custom", custom_width: 1080, custom_height: 1920, fps_mode: "custom", custom_fps: 29.97 }),
    "8 MB · 1080×1920 · 29.97 fps",
  );
  assert.equal(
    profileSummary({ workflow: "upscale", resolution_mode: "custom", custom_width: 3840, custom_height: 2160, fps_mode: "custom", custom_fps: 60 }),
    "4K · 60 fps",
  );
  assert.equal(
    profileSummary({ workflow: "upscale", rate_control: "explicit_bitrate", explicit_bitrate_kbps: 25000, resolution_mode: "custom", custom_width: 2560, custom_height: 1440, fps_mode: "source" }),
    "25 Mbps · 1440p · source frame rate",
  );
  // a short side reads the same for every video, tall or wide
  assert.equal(
    profileSummary({ workflow: "upscale", resolution_mode: "short_side", short_side: 1440, custom_width: 2560, custom_height: 1440, fps_mode: "source" }),
    "1440p · source frame rate",
  );
  assert.equal(
    profileSummary({ workflow: "upscale", resolution_mode: "short_side", short_side: 2160, fps_mode: "source" }),
    "4K · source frame rate",
  );
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 8 * MB, resolution_mode: "short_side", short_side: 900, fps_mode: "source" }),
    "8 MB · 900p · source frame rate",
  );
});

test("a change names what moved away from the saved profile", () => {
  const saved = { size: "10", rm: "source", fps: "30", enc: "libx264", pre: "medium", lut: "{}" };
  assert.equal(profileChangeSummary(saved, saved), "");
  assert.equal(profileChangeSummary(saved, { ...saved, size: "20" }), "20 MB, was 10 MB");
  assert.equal(profileChangeSummary(saved, { ...saved, fps: "60" }), "Changed frame rate");
  assert.equal(profileChangeSummary(saved, { ...saved, size: "20", fps: "60" }), "Changed size and frame rate");
  // several encoder fields are one change
  assert.equal(profileChangeSummary(saved, { ...saved, enc: "libx265", pre: "slow" }), "Changed encoder");
  assert.equal(
    profileChangeSummary(saved, { ...saved, size: "20", fps: "60", lut: '{"enabled":true}', rm: "custom" }),
    "Changed size, resolution and 2 more",
  );
});

test("picking another short side counts as a resolution change", () => {
  const saved = { size: "500", rm: "short_side", rw: "", rh: "", rs: "1440", sc: "lanczos" };
  assert.equal(profileChangeSummary(saved, { ...saved, rs: "2160" }), "Changed resolution");
  assert.equal(profileChangeSummary(saved, { ...saved, sc: "neighbor" }), "Changed scaling");
});

test("a Quality profile is summed up by its level instead of its size", () => {
  const base = { workflow: "compression", target_size_bytes: 50 * MB, resolution_mode: "source", fps_mode: "source" };
  assert.equal(profileSummary({ ...base, rate_control_method: "crf", crf: 20 }), "CRF 20 · source size and frame rate");
  assert.equal(profileSummary({ ...base, rate_control_method: "cqp", qp: 27, cq: 23 }), "CQ 27 · source size and frame rate");
  assert.equal(profileSummary({ ...base, rate_control_method: "cq", cq: 26 }, { includeTargetSize: false }), "source size and frame rate");
});

test("a goal change is one change, and only the chosen goal's value counts", () => {
  const size = { goal: "size", size: "10", level: "23", lm: "CRF", fps: "30" };
  const quality = { ...size, goal: "quality" };
  assert.equal(profileChangeSummary(size, quality), "Changed goal");
  assert.equal(profileChangeSummary(size, { ...quality, size: "20", level: "28" }), "Changed goal");
  assert.equal(profileChangeSummary(quality, { ...quality, level: "28" }), "CRF 28, was CRF 23");
  // a level moved and left behind for Size isn't saved, so it isn't a change
  assert.equal(profileChangeSummary(size, { ...size, level: "28" }), "");
  assert.equal(profileChangeSummary(quality, { ...quality, size: "20" }), "");
  assert.equal(profileChangeSummary(quality, { ...quality, level: "28", fps: "60" }), "Changed quality level and frame rate");
});
