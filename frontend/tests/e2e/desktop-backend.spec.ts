import { expect, test } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Late start.mp4";

declare global {
  interface Window {
    __lateBackendClient?: Window["tuckBackendClient"];
  }
}

test("a backend that connects after the editor loads still starts it with the launch files", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.startup.files = [VIDEO];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true } };
  await installFakeBackend(page, fixture);
  // hold the client back so the launch request arrives before any backend is attached
  await page.addInitScript(() => {
    window.__lateBackendClient = window.tuckBackendClient;
    delete window.tuckBackendClient;
  });
  await page.goto("/");

  const unavailable = page.locator("#backend-unavailable");
  await expect(unavailable).toBeVisible();
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");
  expect(await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).length)).toBe(0);

  await page.evaluate(() => window.attachBackendClient?.(window.__lateBackendClient!));

  await expect(unavailable).toHaveCount(0);
  await expect(page.locator("#editor-shell")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".clip").filter({ hasText: "Late start.mp4" })).toBeVisible();
  const methods = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).map((call) => call.method));
  expect(methods).toContain("getSettings");
  expect(methods).toContain("probeFile");
});

test("the exit shortcut asks the desktop backend to close the window", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.closeWindow = { ok: true };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#btn-add")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).some((call) => call.method === "getSettings")))
    .toBe(true);

  await page.keyboard.press("Control+q");

  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "closeWindow").length))
    .toBe(1);
});
