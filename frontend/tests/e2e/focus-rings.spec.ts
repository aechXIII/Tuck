import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

async function open(page: Page) {
  const fixture = healthyBackendFixture();
  // the fake answers every plan with the Compress shape, so switching tasks keeps plans pending
  fixture.holdMethods = ["createPlan"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#wf-c")).toHaveAttribute("aria-pressed", "true");
}

const ring = (page: Page) => page.evaluate(() => {
  const focused = document.activeElement as HTMLElement | null;
  return { id: focused?.id ?? "", outline: focused ? getComputedStyle(focused).outlineStyle : "none" };
});

test("a click never leaves a focus ring, even when a shortcut follows it", async ({ page }) => {
  await open(page);
  await page.locator("#wf-u").click();
  expect(await ring(page)).toEqual({ id: "wf-u", outline: "none" });
  // a key press after a click is where browsers usually bring the ring back
  await page.keyboard.press("1");
  await expect(page.locator("#wf-c")).toHaveAttribute("aria-pressed", "true");
  expect(await ring(page)).toEqual({ id: "wf-u", outline: "none" });
});

test("Tab shows the focus ring until the next click", async ({ page }) => {
  await open(page);
  await page.locator("#wf-u").click();
  await page.keyboard.press("Tab");
  expect(await ring(page)).toEqual({ id: "wf-l", outline: "solid" });
  await page.keyboard.press("Shift+Tab");
  expect(await ring(page)).toEqual({ id: "wf-u", outline: "solid" });

  await page.locator("#wf-c").click();
  expect(await ring(page)).toEqual({ id: "wf-c", outline: "none" });
});
