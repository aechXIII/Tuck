import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { chooseSelect } from "../fixtures/select";

async function startLinux(page: Page, available = ["libx264", "libx265", "h264_vaapi", "hevc_vaapi"]) {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as Record<string, unknown>, available_encoders: available,
  };
  fixture.responses.pickFiles = { files: ["/home/user/Recording.mp4"] };
  fixture.responses.probeFile = { data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true } };
  fixture.responses.getMediaUrl = { url: "https://media.test/video", token: "video" };
  fixture.responses.getThumbnail = { thumbnail: "" };
  fixture.responses.createPlan = { data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  fixture.responses.enqueueWithOptions = {};
  fixture.responses.refreshEncoders = { available_encoders: ["libx264", "libx265"] };
  await installFakeBackend(page, fixture);
  await page.addInitScript(() => {
    Reflect.set(window, "__TAURI_INTERNALS__", {
      transformCallback: () => 1,
      invoke: async (command: string) => command === "platform_capabilities" ? {
        platform: "linux", architecture: "x86_64", customTitleBar: false,
        sendToIntegration: false, publicCli: false, automaticUpdater: true,
        hardwareAcceleration: true, packaged: false,
      } : 1,
    });
  });
  await page.goto("/");
  await page.locator("#empty-add").click();
  if (page.viewportSize()!.width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compress this video" })).toBeEnabled();
  await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
}

for (const width of [1240, 960]) {
  test(`Linux VAAPI selection and export work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await startLinux(page);
    const picker = page.locator("#enc-sel-trigger");
    await picker.click();
    const popup = page.locator("#enc-sel-popup");
    await expect(popup).toContainText("VAAPI H.264");
    await expect(popup).toContainText("VAAPI H.265");
    await expect(popup).not.toContainText("NVIDIA");
    await expect(popup).not.toContainText("AMD H.");
    await picker.press("End");
    await picker.press("Enter");
    await expect(page.locator("#enc-sel")).toHaveValue("hevc_vaapi");
    await expect(picker).toBeFocused();
    await expect(page.locator("#two-pass")).toBeDisabled();
    await page.getByRole("button", { name: "Compress this video" }).click();
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "enqueueWithOptions").length)).toBe(1);
    const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(c => c.method === "enqueueWithOptions")?.args[0]);
    expect(request).toMatchObject({ video_encoder: "hevc_vaapi", preset: "balanced", two_pass: false, rate_control_method: "vbr" });
  });
}

test("Linux rescan retains the selected VAAPI encoder as unavailable", async ({ page }) => {
  await startLinux(page);
  await chooseSelect(page, page.locator("#enc-sel-trigger"), "h264_vaapi");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Media tools", exact: true }).click();
  await expect(page.locator("#settings-workspace")).toContainText("VAAPI");
  await page.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Encoder detection refreshed.");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator("#enc-sel-trigger").click();
  await expect(page.locator('#enc-sel-popup [data-value="h264_vaapi"]')).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator('#enc-sel-popup [data-value="h264_vaapi"]')).toContainText("unavailable");
});

test("Linux without a usable VAAPI probe only offers software and Auto", async ({ page }) => {
  await startLinux(page, ["libx264", "libx265"]);
  await page.locator("#enc-sel-trigger").click();
  await expect(page.locator("#enc-sel-popup")).not.toContainText("VAAPI");
  await expect(page.locator("#enc-sel-popup")).toContainText("Auto (fastest available)");
});

test("Linux profiles save VAAPI presets and hardware rate control", async ({ page }) => {
  await startLinux(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("GPU clips");
  await chooseSelect(page, page.locator("#pe-enc-trigger"), "hevc_vaapi");
  await chooseSelect(page, page.locator("#pe-speed-trigger"), "best");
  await expect(page.locator("#pe-preset")).toHaveValue("quality");
  await expect(page.locator("#pe-two-pass")).toBeDisabled();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "createProfile").length)).toBe(1);
  const payload = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(c => c.method === "createProfile")?.args[0]);
  expect(payload).toMatchObject({ video_encoder: "hevc_vaapi", preset: "quality", two_pass: false, rate_control_method: "cbr" });
});

for (const width of [1240, 960]) {
  for (const encoder of ["h264_nvenc", "hevc_nvenc"]) {
    test(`Linux ${encoder} selection and export work at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
      await startLinux(page, ["libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_vaapi"]);
      const picker = page.locator("#enc-sel-trigger");
      await picker.click();
      const popup = page.locator("#enc-sel-popup");
      await expect(popup).toContainText("NVIDIA H.264");
      await expect(popup).toContainText("NVIDIA H.265");
      await expect(popup).toContainText("VAAPI H.264");
      await expect(popup).not.toContainText("AMD H.");
      await picker.press("Escape");
      await expect(picker).toBeFocused();
      await chooseSelect(page, picker, encoder);
      await expect(page.locator("#preset-sel")).toHaveValue("p5");
      await expect(page.locator("#two-pass")).toBeDisabled();
      await page.getByRole("button", { name: "Compress this video" }).click();
      await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "enqueueWithOptions").length)).toBe(1);
      const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(c => c.method === "enqueueWithOptions")?.args[0]);
      expect(request).toMatchObject({ video_encoder: encoder, preset: "p5", two_pass: false, rate_control_method: "vbr" });
    });
  }
}

test("Linux rescans keep a selected NVENC encoder disabled when the driver is unavailable", async ({ page }) => {
  await startLinux(page, ["libx264", "h264_nvenc", "hevc_nvenc"]);
  await chooseSelect(page, page.locator("#enc-sel-trigger"), "h264_nvenc");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Media tools", exact: true }).click();
  await expect(page.locator("#settings-workspace")).toContainText("NVIDIA H.264");
  await page.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Encoder detection refreshed.");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator("#enc-sel-trigger").click();
  await expect(page.locator('#enc-sel-popup [data-value="h264_nvenc"]')).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator('#enc-sel-popup [data-value="h264_nvenc"]')).toContainText("unavailable");
});

test("Linux NVENC profiles preserve NVIDIA presets", async ({ page }) => {
  await startLinux(page, ["libx264", "h264_nvenc", "hevc_nvenc"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("NVIDIA clips");
  await chooseSelect(page, page.locator("#pe-enc-trigger"), "hevc_nvenc");
  await chooseSelect(page, page.locator("#pe-speed-trigger"), "best");
  await expect(page.locator("#pe-preset")).toHaveValue("p7");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "createProfile").length)).toBe(1);
  const payload = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(c => c.method === "createProfile")?.args[0]);
  expect(payload).toMatchObject({ video_encoder: "hevc_nvenc", preset: "p7", two_pass: false, rate_control_method: "cbr" });
});
