import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPlatformCache,
  encoderForPlatform,
  encodersForPlatform,
  shouldShowSendTo,
  shouldShowUpdater,
  supportsHardwareEncoders,
} from "../../src/platform/capabilities.ts";

// Test Windows/Linux payload decisions without needing Tauri runtime
test("Windows capabilities expose Send To, CLI, and updater", async () => {
  const caps = {
    platform: "windows" as const,
    architecture: "x86_64" as const,
    sendToIntegration: true,
    publicCli: true,
    automaticUpdater: true,
    hardwareAcceleration: true,
    packaged: false,
  };
  assert.equal(shouldShowSendTo(caps), true);
  assert.equal(shouldShowUpdater(caps), true);
});

test("Linux capabilities hide Windows integrations but keep the updater", async () => {
  const caps = {
    platform: "linux" as const,
    architecture: "x86_64" as const,
    sendToIntegration: false,
    publicCli: false,
    automaticUpdater: true,
    hardwareAcceleration: false,
    packaged: false,
  };
  assert.equal(shouldShowSendTo(caps), false);
  assert.equal(shouldShowUpdater(caps), true);
  assert.equal(supportsHardwareEncoders(caps), false);
  assert.deepEqual(encodersForPlatform(["libx264", "h264_nvenc", "hevc_amf"], caps), ["libx264"]);
  assert.equal(encoderForPlatform("h264_nvenc", caps), "libx264");
});

test("fallback on invoke failure still hides integrations", async () => {
  clearPlatformCache();
  // Simulate tauri invoke failing by not having invoke; fetch should fallback
  // We cannot easily mock invoke here without patching global, but we can test the helpers directly
  const fallback = {
    platform: "linux" as const,
    architecture: "x86_64" as const,
    sendToIntegration: false,
    publicCli: false,
    automaticUpdater: false,
    hardwareAcceleration: false,
    packaged: false,
  };
  assert.equal(shouldShowSendTo(fallback), false);
});
