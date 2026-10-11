import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  for (const width of [1240, 960]) {
    test(`app motion stays enabled with ${reducedMotion} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
      await page.emulateMedia({ reducedMotion });
      await installFakeBackend(page, healthyBackendFixture());
      await page.goto("/");
      if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
      await page.locator("#insp-tabs").hover();
      expect(await page.locator("#insp-tabs").evaluate(element =>
        getComputedStyle(element, "::before").transitionDuration)).toBe("0.24s");
      await page.locator("#insp-tab-edit").click();
      await page.locator("#insp-tabs").evaluate(async element => {
        const animations = element.getAnimations({ subtree: true });
        if (!animations.length) throw new Error("The Inspector switch did not animate");
        await Promise.all(animations.map(animation => animation.finished));
      });
      await page.locator("#insp-tab-export").click();
      await page.locator("#prof-pick").click();
      await expect(page.locator("#prof-menu")).toHaveCSS("animation-name", /joined-reveal-(down|up)/);
      await expect(page.locator("#prof-menu")).toHaveCSS("opacity", "1");
      await expect(page.locator("#prof-menu")).toHaveCSS("transform", "none");
      await page.keyboard.press("Escape");
      await page.locator("#export-res-select-trigger").click();
      await expect(page.locator("#export-res-select-popup")).toHaveCSS("animation-name", /surface-(drop|rise)/);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.locator(".settings-dialog")).toHaveCSS("animation-name", "settings-enter");
      expect(await page.locator(".toggle-track").first().evaluate(element =>
        getComputedStyle(element, "::after").transitionDuration)).toContain("0.16s");
    });
  }
}
