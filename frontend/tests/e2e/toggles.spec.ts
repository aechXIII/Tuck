import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`switches retain keyboard behavior and alignment at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installFakeBackend(page, healthyBackendFixture());
    await page.goto("/");
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await page.locator("#frame-blending-panel > summary").click();
    await page.getByText("Advanced settings", { exact: true }).click();
    const blend = page.getByRole("switch", { name: "Enable frame blending", exact: true });
    const linear = page.getByRole("switch", { name: "Blend in linear light", exact: true });
    await expect(linear).toBeDisabled();
    // focus rings only show after Tab, so reach the switch the way a keyboard user would
    await page.locator("#frame-blending-panel > summary").focus();
    await page.keyboard.press("Tab");
    await expect(blend).toBeFocused();
    await page.keyboard.press("Space");
    await expect(blend).toBeChecked();
    await expect(linear).toBeEnabled();
    await expect(page.locator("#blend-enabled + .toggle-track")).toHaveCSS("outline-style", "solid");
    await expect(page.locator("#blend-enabled + .toggle-track")).toHaveCSS("transition-duration", "0.16s, 0.16s");
    await page.getByText("Blend in linear light", { exact: true }).click();
    await expect(linear).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath(`effects-${width}.png`) });
    await page.locator("#lut-panel > summary").click();
    await expect(page.locator("#lut-adjustments")).toBeHidden();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page.getByRole("button", { name: "New profile", exact: true }).click();
    for (const name of ["Use source resolution", "Use source frame rate", "Apply transform settings from this profile", "Keep source audio"]) {
      const control = page.getByRole("switch", { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      await control.focus();
      const checked = await control.isChecked();
      await page.keyboard.press("Space");
      await expect(control).toBeChecked({ checked: !checked });
      const bounds = await control.locator("..").evaluate((label) => {
        const track = label.querySelector(".toggle-track")!.getBoundingClientRect();
        const text = label.querySelector("span")!.getBoundingClientRect();
        return { right: track.right, edge: label.getBoundingClientRect().right, gap: track.left - text.right };
      });
      // the switch sits at the row's inner edge, where every other control ends
      expect(bounds.edge - bounds.right).toBeCloseTo(16, 0);
      expect(bounds.gap).toBeGreaterThanOrEqual(11);
    }
    await page.screenshot({ path: testInfo.outputPath(`profile-${width}.png`) });
  });
}
