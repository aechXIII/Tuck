import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, withVideo } from "../fixtures/fake-backend";
import { chooseSelect } from "../fixtures/select";

for (const width of [1240, 960]) {
  test(`menus align with their fields at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = withVideo(healthyBackendFixture());
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
    await checkWidth("prof-pick", "prof-menu", "#prof-card");
    await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
    await checkWidth("enc-sel-trigger", "enc-sel-popup");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await checkWidth("set-start-task-trigger", "set-start-task-popup");
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await checkWidth("set-ds-trigger", "set-ds-popup");
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
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
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
  await installFakeBackend(page, withVideo(healthyBackendFixture()));
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

test("Settings dropdowns don't linger after moving between pages", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const picker = page.locator("#set-start-task-trigger");
  await picker.click();
  const popup = page.locator("#set-start-task-popup");
  await expect(popup).toBeVisible();
  const fits = await popup.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 8 && bounds.bottom <= innerHeight - 8 && bounds.left >= 8 && bounds.right <= innerWidth - 8;
  });
  expect(fits).toBe(true);
  expect(await popup.evaluate(element => getComputedStyle(element).animationName)).toMatch(/^surface-(drop|rise)$/);
  await picker.press("Escape");
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "Files & names", exact: true }).click();
    await expect(page.locator("#set-start-task-popup")).toHaveCount(0);
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.locator("#set-start-task-trigger")).toHaveCount(1);
    await expect(page.locator("#settings-workspace select:not([hidden])")).toHaveCount(0);
  }
});

test("frame blending dropdowns reflect disabled fieldsets and keep selections", async ({ page }) => {
  await installFakeBackend(page, withVideo(healthyBackendFixture()));
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
  const fixture = withVideo(healthyBackendFixture());
  fixture.responses.refreshEncoders = { ok: true, available_encoders: ["libx264", "libx265"] };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
  await chooseSelect(page, page.locator("#enc-sel-trigger"), "h264_nvenc");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Media tools", exact: true }).click();
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

test("dropdown focus suppresses editor deletion shortcuts", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    profiles: [{ profile_id: "review", name: "Review", workflow: "compression" }],
  };
  fixture.startup.files = ["C:\\media\\dropdown-shortcuts.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true } };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/v", token: "t" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toHaveCount(1);
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
  await page.getByRole("button", { name: "Split at playhead", exact: true }).click();
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
  const encoder = page.locator("#enc-sel-trigger");
  await expect(encoder).toHaveAttribute("role", "button");
  await encoder.focus();
  await encoder.press("Backspace");
  await encoder.press("Delete");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await page.locator("#prof-pick").focus();
  await page.locator("#prof-pick").press("Delete");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await page.locator("#prof-pick").press("ArrowDown");
  const search = page.locator("#prof-search");
  await expect(search).toBeFocused();
  const mute = page.getByRole("button", { name: "Mute source audio", exact: true });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await search.press("m");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await search.press("Backspace");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await search.press("Escape");
  await page.locator("#lut-panel > summary").click();
  await page.locator("#lut-name").focus();
  await page.locator("#lut-name").press("Backspace");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  // the same shortcut still removes a segment once focus returns to the timeline
  await page.locator("#timeline").focus();
  await page.keyboard.press("Delete");
  await expect(page.locator(".tl-segment")).toHaveCount(1);
});

test("a long profile menu closes when its Inspector anchor scrolls out of view", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  const fixture = withVideo(healthyBackendFixture());
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    profiles: Array.from({ length: 20 }, (_, index) => ({
      profile_id: `profile-${index}`, name: `Profile ${index}`, workflow: "compression",
    })),
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
  await page.locator("#frame-blending-panel > summary").click();
  await page.locator("#lut-panel > summary").click();
  await page.locator("#prof-pick").click();
  const menu = page.locator("#prof-menu");
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 8 && bounds.bottom <= innerHeight - 8;
  })).toBe(true);
  const inspector = (await page.locator("#right-scroll").boundingBox())!;
  await page.mouse.move(inspector.x + inspector.width - 4, inspector.y + inspector.height / 2);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.locator("#prof-card").evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThan(8);
  await expect(menu).toBeHidden();
  await expect(page.locator("#prof-pick")).toHaveAttribute("aria-expanded", "false");
});

test("a dropdown lights one row: the pointer's row goes dark when it leaves, the keyboard's stays", async ({ page }) => {
  await installFakeBackend(page, withVideo(healthyBackendFixture()));
  await page.goto("/");
  await page.locator("#export-fps-select-trigger").click();
  const popup = page.locator("#export-fps-select-popup");
  await expect(popup).toBeVisible();
  const options = popup.getByRole("option");
  const lit = () => options.evaluateAll(rows => rows.map(row => row.hasAttribute("data-active")));
  // a click opens with nothing lit; the checkmark alone shows the chosen option
  expect((await lit()).some(Boolean)).toBe(false);
  await options.nth(1).hover();
  expect((await lit()).map((on, index) => on && index)).toContain(1);
  await page.mouse.move(5, 5);
  expect((await lit()).some(Boolean)).toBe(false);
  // with nothing lit, the arrow keys start from the chosen option, and that row stays lit
  const chosen = await options.evaluateAll(rows => rows.findIndex(row => row.getAttribute("aria-selected") === "true"));
  await page.keyboard.press("ArrowDown");
  expect((await lit()).indexOf(true)).toBe(chosen);
  await page.keyboard.press("ArrowDown");
  expect((await lit()).indexOf(true)).toBe(chosen + 1);
});
