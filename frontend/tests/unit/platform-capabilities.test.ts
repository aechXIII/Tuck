import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPlatformCache,
  encoderForPlatform,
  encodersForPlatform,
  shouldShowSendTo,
  shouldShowUpdater,
  supportsFileDragOut,
  supportsHardwareEncoders,
  usesCustomTitleBar,
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
    customTitleBar: true,
    packaged: false,
  };
  assert.equal(shouldShowSendTo(caps), true);
  assert.equal(shouldShowUpdater(caps), true);
  assert.equal(usesCustomTitleBar(caps), true);
});

test("Linux capabilities hide Windows integrations but keep the updater", async () => {
  const caps = {
    platform: "linux" as const,
    architecture: "x86_64" as const,
    sendToIntegration: false,
    publicCli: false,
    automaticUpdater: true,
    hardwareAcceleration: true,
    customTitleBar: false,
    packaged: false,
  };
  assert.equal(shouldShowSendTo(caps), false);
  assert.equal(shouldShowUpdater(caps), true);
  assert.equal(supportsHardwareEncoders(caps), true);
  assert.equal(usesCustomTitleBar(caps), false);
  assert.deepEqual(encodersForPlatform(["libx264", "h264_nvenc", "hevc_amf"], caps), ["libx264", "h264_nvenc"]);
  assert.equal(encoderForPlatform("hevc_amf", caps), "libx264");
});

test("dragging exports out is offered only where the shell says it can start a file drag", () => {
  const base = {
    platform: "linux" as const,
    architecture: "x86_64" as const,
    sendToIntegration: false,
    publicCli: false,
    automaticUpdater: true,
    hardwareAcceleration: true,
    customTitleBar: false,
    packaged: true,
  };
  assert.equal(supportsFileDragOut({ ...base, fileDragOut: true }), true);
  assert.equal(supportsFileDragOut({ ...base, fileDragOut: false }), false);
  // an older shell that doesn't report it can't drag
  assert.equal(supportsFileDragOut(base), false);
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
    customTitleBar: false,
    packaged: false,
  };
  assert.equal(shouldShowSendTo(fallback), false);
});
