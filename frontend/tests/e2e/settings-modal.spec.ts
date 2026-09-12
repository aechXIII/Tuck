import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as Record<string, unknown>,
    default_profile_id: "everyday",
    profiles: [
      { profile_id: "everyday", name: "Everyday", workflow: "compression" },
      { profile_id: "sharing", name: "Sharing", workflow: "compression" },
    ],
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
});

test("show-export preference saves through the existing settings key", async ({ page }, testInfo) => {
  const option = page.getByRole("checkbox", { name: /Show the last export in its folder/ });
  await page.getByText("Show the last export in its folder", { exact: true }).click();
  await expect(option).toBeChecked();
  for (const width of [1240, 960]) {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    const label = page.getByText("Show the last export in its folder", { exact: true });
    await label.scrollIntoViewIfNeeded();
    await expect(label).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`show-export-${width}.png`) });
  }
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "saveSettings")
      .some((call) => (call.args[0] as Record<string, unknown>).open_output_folder_after_queue === true),
  )).toBe(true);
});

test("the default profile picker only offers profiles that can be saved", async ({ page }) => {
  const picker = page.getByLabel("Default profile", { exact: true });
  await expect(picker).toHaveValue("everyday");
  expect(await picker.locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  )).toEqual(["everyday", "sharing"]);
  await picker.selectOption("sharing");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "saveSettings")
      .some((call) => (call.args[0] as Record<string, unknown>).default_profile_id === "sharing"),
  )).toBe(true);
});

test("settings keeps a visible sidebar and footer at the minimum window size", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(page.locator("#settings-nav-general")).toBeFocused();
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "System & support" }).click();
  await dialog.getByText("Advanced system settings", { exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save changes" })).toBeInViewport();
  await expect(page.locator("#settings-nav-general")).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await expect(page.locator("#editor-shell")).not.toHaveAttribute("inert", "");
});

test("changing sections preserves unsaved settings until discard is confirmed", async ({ page }) => {
  await page.getByText("Clear completed jobs automatically", { exact: true }).click();
  await page.getByRole("button", { name: "Output & naming" }).click();
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Discard changes" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#set-auto-clear")).toBeChecked();
  await page.getByRole("button", { name: "Output & naming" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("heading", { name: "Output & naming", exact: true })).toBeVisible();
  await expect(page.locator("#settings-nav-output")).toHaveAttribute("aria-current", "page");
});

test("profile editing keeps keyboard focus and respects the selected sidebar section", async ({ page }) => {
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await expect(page.getByLabel("Profile name", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("Weekend clips");
  await page.getByRole("button", { name: "Output & naming", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Profile name", { exact: true })).toHaveValue("Weekend clips");
  await page.getByRole("button", { name: "Output & naming", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("heading", { name: "Output & naming", exact: true })).toBeVisible();
});

test("discard confirmation text stays readable in normal and hover states", async ({ page }) => {
  await page.getByText("Clear completed jobs automatically", { exact: true }).click();
  await page.getByRole("button", { name: "Output & naming" }).click();
  const discard = page.getByRole("button", { name: "Discard changes" });
  for (const hover of [false, true]) {
    if (hover) await discard.hover();
    const contrast = await discard.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
      const luminance = (color: string): number => {
        const channels = color.match(/[\d.]+/g) ?? [];
        return channels.slice(0, 3).reduce((sum, channel, index) => {
          const value = Number(channel) / 255;
          const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
        }, 0);
      };
      const style = getComputedStyle(el);
      const text = luminance(style.color);
      const fill = luminance(style.backgroundColor);
      return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
    });
    expect(contrast, hover ? "hover contrast" : "normal contrast").toBeGreaterThanOrEqual(4.5);
  }
});
