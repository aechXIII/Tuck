import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const lut = { enabled: true, path: "C:/another-computer/film.cube", name: "Warm Film", strength: 0.4 };
const base = { workflow: "compression", target_size_bytes: 20971520, resolution_mode: "source", fps_mode: "source", video_encoder: "libx264", preset: "medium", audio_bitrate: 128000 };

for (const width of [1240, 960]) {
  test(`profile export explains LUT sharing at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = healthyBackendFixture();
    const name = 'Delete <img src=x onerror=alert(1)> ' + "LongFilmName".repeat(12);
    const profiles = [
      { ...base, profile_id: "plain", name: "Plain" },
      { ...base, profile_id: "look", name: "Look", lut: { ...lut, name } },
      { ...base, profile_id: "off", name: "Disabled look", lut: { ...lut, enabled: false } },
    ];
    fixture.responses.getSettings = { ...fixture.responses.getSettings as object, profiles };
    fixture.responses.getProfilesJson = profiles;
    fixture.responses.pickSaveFile = { path: "C:/shared/profile.json" };
    fixture.responses.exportProfileToFile = { ok: true };
    await installFakeBackend(page, fixture);
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page.getByLabel("More actions for Look", { exact: true }).click();
    const exportButton = page.locator('[data-profile-action="export"][data-profile-id="look"]');
    await exportButton.click();
    const dialog = page.getByRole("dialog", { name: "LUT file isn’t included" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(name);
    await expect(dialog.locator("img")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Export profile" })).not.toHaveClass(/danger/);
    await expect(dialog).toHaveAttribute("aria-describedby", "confirm-copy");
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.some(c => c.method === "pickSaveFile"))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("lut-export-warning.png") });
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Export profile" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#mod-box")).not.toHaveAttribute("aria-describedby");
    await expect(exportButton).toBeFocused();
    await exportButton.click();
    await dialog.getByRole("button", { name: "Export profile" }).click();
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "exportProfileToFile").length)).toBe(1);
    await page.getByLabel("More actions for Look", { exact: true }).click();
    await page.getByLabel("More actions for Disabled look", { exact: true }).click();
    await page.locator('[data-profile-action="export"][data-profile-id="off"]').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByLabel("More actions for Disabled look", { exact: true }).click();
    await page.getByLabel("More actions for Plain", { exact: true }).click();
    await page.locator('[data-profile-action="export"][data-profile-id="plain"]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "exportProfileToFile").length)).toBe(2);
  });

  test(`missing profile LUT offers recovery at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = healthyBackendFixture();
    fixture.responses.getSettings = { ...fixture.responses.getSettings as object, profiles: [
      { ...base, profile_id: "plain", name: "Plain" },
      { ...base, profile_id: "look", name: "Look", lut },
    ] };
    fixture.responses.pickFiles = { files: ["C:/source.mp4"] };
    fixture.responses.probeFile = { data: { duration: 12, width: 1920, height: 1080, fps: 60, has_audio: true } };
    fixture.responses.enqueueWithOptions = { ok: true };
    fixture.responses.pickLutFile = { path: "C:/replacement.cube" };
    fixture.responseSequences = { loadLut: [
      { ok: false, error: "File not found: film.cube" },
      { path: "C:/managed/replacement.cube", name: "Replacement", size: 2, table_url: "https://lut.test/table", token: "lut" },
    ] };
    await page.route("https://lut.test/table", route => route.fulfill({ body: Buffer.from(new Float32Array(24).buffer), headers: { "Access-Control-Allow-Origin": "*" } }));
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("button", { name: "Add videos", exact: true }).click();
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await page.locator("#prof-pick").click();
    await page.locator('#prof-options [data-profile-id="look"]').click();
    const error = page.locator("#lut-error");
    await expect(error).toContainText("This profile’s LUT could not be loaded.");
    await expect(error).toContainText("File not found: film.cube");
    await expect(error).toContainText("turn off “Apply LUT”");
    await expect(page.locator("#lut-panel")).toHaveAttribute("open", "");
    await expect(page.getByRole("button", { name: "Compress this video", exact: true })).toBeDisabled();
    await error.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("missing-lut.png") });
    expect(await page.locator("#lut-panel").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole("switch", { name: "Apply LUT", exact: true }).uncheck();
    await expect(error).toContainText("The LUT is off.");
    await page.getByRole("button", { name: "Compress this video", exact: true }).click();
    const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(c => c.method === "enqueueWithOptions")?.args[0]);
    expect(request).toMatchObject({ lut: { ...lut, enabled: false }, target_size_bytes: 20971520 });
    await page.locator("#lut-import").click();
    await expect(error).toBeHidden();
    await expect(page.getByRole("switch", { name: "Apply LUT", exact: true })).toBeChecked();
    await expect(page.locator("#lut-current-name")).toHaveText("Replacement");
    await expect(page.locator("#lut-strength-value")).toHaveText("40%");
    await page.locator("#prof-pick").click();
    await page.locator('#prof-options [data-profile-id="plain"]').click();
    await expect(error).toBeHidden();
    await expect(page.locator("#lut-current-name")).toHaveText("No LUT selected");
  });
}
