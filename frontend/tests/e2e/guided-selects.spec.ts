import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { chooseSelect } from "../fixtures/select";

for (const width of [1240, 960]) {
  test(`menus align with their fields at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = healthyBackendFixture();
    fixture.responses.getSettings = {
      ...fixture.responses.getSettings as object,
      profiles: [{ profile_id: "review", name: "Review with a long descriptive name", workflow: "compression" }],
    };
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const checkWidth = async (triggerId: string, popupId: string, anchor = `#${triggerId}`) => {
      const trigger = page.locator(`#${triggerId}`);
      await trigger.click();
      const popup = page.locator(`#${popupId}`);
      await expect(popup).toBeVisible();
      const field = (await page.locator(anchor).boundingBox())!;
      const menu = (await popup.boundingBox())!;
      expect(menu.width).toBeCloseTo(field.width, 0);
      expect(menu.x).toBeCloseTo(field.x, 0);
      expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
    };
    await checkWidth("export-res-select-trigger", "export-res-select-popup");
    await checkWidth("export-fps-select-trigger", "export-fps-select-popup");
    await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
    await checkWidth("enc-sel-trigger", "enc-sel-popup");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await checkWidth("set-dp-trigger", "set-dp-popup");
    await checkWidth("set-ds-trigger", "set-ds-popup");
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page.getByRole("button", { name: "New profile", exact: true }).click();
    await checkWidth("pe-enc-trigger", "pe-enc-popup");
    await checkWidth("pe-speed-trigger", "pe-speed-popup");
  });
}

test("custom dropdowns use the existing settings values and keyboard path", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trigger = page.locator("#set-start-task-trigger");
  await expect(page.locator("#set-dp-trigger")).toBeDisabled();
  await expect(page.locator("#set-dp-trigger")).toHaveText("No profiles available");
  await expect(trigger).toBeVisible();
  await expect(page.locator("#set-start-task")).toBeHidden();
  await trigger.focus();
  await trigger.press("ArrowDown");
  const popup = page.locator("#set-start-task-popup");
  await expect(popup).toBeVisible();
  await trigger.press("Home");
  await trigger.press("ArrowDown");
  await trigger.press("Enter");
  await expect(page.locator("#set-start-task")).toHaveValue("compression");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Compress");
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.some(call => call.method === "saveSettings" &&
      (call.args[0] as Record<string, unknown>).start_task === "compression"),
  )).toBe(true);
  await trigger.click();
  await trigger.press("Escape");
  await expect(popup).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await trigger.click();
  await trigger.press("Tab");
  await expect(popup).toBeHidden();
  await expect(page.locator("#set-inspector-start-trigger")).toBeFocused();
});

test("repeated initials cycle choices while a longer prefix selects its match", async ({ page }) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trigger = page.locator("#set-ds-trigger");
  await trigger.focus();
  await trigger.press("b");
  await trigger.press("b");
  await trigger.press("Enter");
  await expect(page.locator("#set-ds")).toHaveValue("Bicubic");
  await chooseSelect(page, trigger, "Point");
  await trigger.press("b");
  await trigger.press("i");
  await trigger.press("c");
  await trigger.press("Enter");
  await expect(page.locator("#set-ds")).toHaveValue("Bicubic");
});

test("profile speed and preset controls stay synchronized after programmatic updates", async ({ page }) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await chooseSelect(page, page.locator("#pe-enc-trigger"), "libx264");
  await chooseSelect(page, page.locator("#pe-speed-trigger"), "fast");
  await expect(page.locator("#pe-preset")).toHaveValue("veryfast");
  await expect(page.locator("#pe-preset-trigger")).toHaveAttribute("data-value", "veryfast");
  await page.locator("#pe-advanced-button").click();
  await chooseSelect(page, page.locator("#pe-preset-trigger"), "veryslow");
  await expect(page.locator("#pe-speed")).toHaveValue("best");
  await expect(page.locator("#pe-speed-trigger")).toHaveAttribute("data-value", "best");
});

test("Escape closes a dropdown before the compact Inspector", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  const trigger = page.locator("#export-fps-select-trigger");
  await trigger.click();
  await expect(page.locator("#export-fps-select-popup")).toBeVisible();
  await trigger.press("Escape");
  await expect(page.locator("#export-fps-select-popup")).toBeHidden();
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("button", { name: "Inspector", exact: true })).toHaveAttribute("aria-expanded", "true");
});

test("long profile lists support search, empty results, and repeated Settings navigation", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = healthyBackendFixture();
  const profiles = Array.from({ length: 12 }, (_, index) => ({
    profile_id: `profile-${index}`, name: index === 11 ? "Review <draft> with a long descriptive name" : `Profile ${index}`,
    workflow: "compression",
  }));
  fixture.responses.getSettings = { ...fixture.responses.getSettings as object, profiles, default_profile_id: "profile-0" };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const picker = page.locator("#set-dp-trigger");
  await picker.click();
  const popup = page.locator("#set-dp-popup");
  const search = popup.getByRole("combobox", { name: "Search profiles", exact: true });
  await expect(search).toBeFocused();
  await search.fill("missing profile");
  await expect(popup.getByRole("status")).toBeVisible();
  await search.fill("<draft>");
  await expect(popup.getByRole("option")).toHaveCount(1);
  await expect(popup.getByRole("option")).toHaveText(profiles[11]!.name);
  await search.press("Enter");
  await expect(picker).toBeFocused();
  await expect(picker).toHaveText(profiles[11]!.name);
  await picker.click();
  await expect(popup.getByRole("option")).toHaveCount(12);
  const fits = await popup.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 8 && bounds.bottom <= innerHeight - 8 && bounds.left >= 8 && bounds.right <= innerWidth - 8;
  });
  expect(fits).toBe(true);
  expect(await popup.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await search.press("Escape");
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "Output & naming", exact: true }).click();
    await expect(page.locator("#set-dp-popup")).toHaveCount(0);
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.locator("#set-dp-trigger")).toHaveCount(1);
    await expect(page.locator("#settings-workspace select:not([hidden])")).toHaveCount(0);
  }
});

test("frame blending dropdowns reflect disabled fieldsets and keep selections", async ({ page }) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.locator("#frame-blending-panel > summary").click();
  const curve = page.locator("#blend-curve-trigger");
  await expect(curve).toBeDisabled();
  await page.getByLabel("Enable frame blending", { exact: true }).check();
  await expect(curve).toBeEnabled();
  await chooseSelect(page, curve, "gaussian");
  await page.getByLabel("Enable frame blending", { exact: true }).uncheck();
  await expect(curve).toBeDisabled();
  await expect(curve).toHaveAttribute("data-value", "gaussian");
  await page.getByLabel("Enable frame blending", { exact: true }).check();
  await expect(curve).toBeEnabled();
  await curve.click();
  await expect(page.locator('#blend-curve-popup [data-value="gaussian"]')).toHaveAttribute("aria-selected", "true");
});

test("encoder rescans retain unavailable choices without allowing selection", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.refreshEncoders = { ok: true, available_encoders: ["libx264", "libx265"] };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
  await chooseSelect(page, page.locator("#enc-sel-trigger"), "h264_nvenc");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "System & support", exact: true }).click();
  await page.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Encoder detection refreshed.");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  const picker = page.locator("#enc-sel-trigger");
  await picker.click();
  const unavailable = page.locator('#enc-sel-popup [data-value="h264_nvenc"]');
  await expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await expect(unavailable).toContainText("(unavailable)");
  // the handler must reject a pointer event even if a caller bypasses the disabled attribute
  await unavailable.click({ force: true });
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  await picker.press("End");
  await picker.press("Enter");
  await expect(page.locator("#enc-sel")).toHaveValue("libx265");
  await expect(picker).toHaveAttribute("data-value", "libx265");
});
