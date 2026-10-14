import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`profile sizing help describes Fit without padding at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installFakeBackend(page, healthyBackendFixture());
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page.getByRole("button", { name: "New profile", exact: true }).click();
    await page.locator("#pe-transform-enabled").check();
    const trigger = page.locator("#pe-sizing-trigger");
    await trigger.click();
    const fit = page.locator("#pe-sizing-popup").getByRole("option", { name: "Fit", exact: true });
    await expect(fit).toHaveAccessibleDescription("Fit: Keep the whole frame within the output dimensions; no padding");
    await fit.hover();
    await expect(fit).toHaveAttribute("title", "Fit: Keep the whole frame within the output dimensions; no padding");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowDown");
    await expect(fit).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}
