import assert from "node:assert/strict";
import test from "node:test";

import { profileChangeSummary, profileSummary } from "../../src/features/profiles/profile-summary.ts";

const MB = 1024 * 1024;

test("a profile sums up its target, size and frame rate in a few words", () => {
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 10 * MB, resolution_mode: "source", fps_mode: "source" }),
    "Target 10 MB · source size and frame rate",
  );
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 16 * MB, resolution_mode: "custom", custom_width: 1280, custom_height: 720, fps_mode: "custom", custom_fps: 30 }),
    "Target 16 MB · 720p · 30 fps",
  );
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 25 * MB, resolution_mode: "limit", max_width: 1920, max_height: 1080, fps_mode: "source" }),
    "Target 25 MB · up to 1080p · source frame rate",
  );
  // a portrait or unusual size keeps its numbers
  assert.equal(
    profileSummary({ workflow: "compression", target_size_bytes: 8 * MB, resolution_mode: "custom", custom_width: 1080, custom_height: 1920, fps_mode: "custom", custom_fps: 29.97 }),
    "Target 8 MB · 1080×1920 · 29.97 fps",
  );
  assert.equal(
    profileSummary({ workflow: "upscale", resolution_mode: "custom", custom_width: 3840, custom_height: 2160, fps_mode: "custom", custom_fps: 60 }),
    "4K · 60 fps",
  );
  assert.equal(
    profileSummary({ workflow: "upscale", rate_control: "explicit_bitrate", explicit_bitrate_kbps: 25000, resolution_mode: "custom", custom_width: 2560, custom_height: 1440, fps_mode: "source" }),
    "25 Mbps · 1440p · source frame rate",
  );
});

test("a change names what moved away from the saved profile", () => {
  const saved = { size: "10", rm: "source", fps: "30", enc: "libx264", pre: "medium", lut: "{}" };
  assert.equal(profileChangeSummary(saved, saved), "");
  assert.equal(profileChangeSummary(saved, { ...saved, size: "20" }), "Target 20 MB, was 10 MB");
  assert.equal(profileChangeSummary(saved, { ...saved, fps: "60" }), "Changed frame rate");
  assert.equal(profileChangeSummary(saved, { ...saved, size: "20", fps: "60" }), "Changed target size and frame rate");
  // several encoder fields are one change
  assert.equal(profileChangeSummary(saved, { ...saved, enc: "libx265", pre: "slow" }), "Changed encoder");
  assert.equal(
    profileChangeSummary(saved, { ...saved, size: "20", fps: "60", lut: '{"enabled":true}', rm: "custom" }),
    "Changed target size, resolution and 2 more",
  );
});
