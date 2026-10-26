import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
} from "../fixtures/fake-backend";

function collectLoadFailures(page: Page): {
  badResponses: string[];
  failedRequests: string[];
  pageErrors: string[];
} {
  const badResponses: string[] = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(response.url());
  });
  return { badResponses, failedRequests, pageErrors };
}

test("generated entry loads relative assets and exposes the empty editor", async ({
  page,
}) => {
  const failures = collectLoadFailures(page);
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");

  await expect(page.locator("#btn-add")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator("#vid")).toHaveAttribute("aria-label", /preview/i);
  await expect(page.getByRole("heading", { name: "Drop a video to compress it" })).toBeVisible();

  expect(
    await page.evaluate(
      () => typeof (window as Window & { initApp?: unknown }).initApp,
    ),
  ).toBe("function");

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & {
            __tuckFakeBackendCalls?: Array<{ method: string }>;
          }
        ).__tuckFakeBackendCalls?.some((call) => call.method === "getSettings"),
      ),
    )
    .toBe(true);
  expect(failures).toEqual({ badResponses: [], failedRequests: [], pageErrors: [] });
});

test("settings returns focus to its opener", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");

  const opener = page.getByRole("button", { name: "Settings" });
  await opener.click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

test("the editor remains usable at the 960 by 640 minimum", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");

  const libraryToggle = page.getByRole("button", { name: "Library" });
  await expect(libraryToggle).toBeVisible();
  await libraryToggle.click();
  await expect(libraryToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#btn-add")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator("#timeline")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test("missing desktop backend is a visible startup error", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.goto("/");

  // the notification area keeps an empty alert region ready, so the startup error is found by its text
  const startupError = page.getByRole("alert").filter({ hasText: "Tuck couldn't start" });
  await expect(startupError).toBeVisible();
  await expect(startupError).toContainText("Restart Tuck");
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");
  // the window's own title bar controls stay usable so the window can still be moved and closed
  await expect(page.locator("#window-caption")).toBeVisible();
  await expect(page.locator("#window-caption")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#tb-editor-start")).toHaveAttribute("inert", "");
});

test("rejected file selection is visible, recoverable, and rendered as text", async ({
  page,
}) => {
  const failures = collectLoadFailures(page);
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = {
    ok: false,
    code: "VALIDATION_ERROR",
    error: '<img src=x onerror="globalThis.__tuckSensitiveExecuted=true"> rejected',
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  const addVideos = page.locator("#btn-add");
  await addVideos.click();

  await expect(page.getByRole("alert")).toContainText(
    '<img src=x onerror="globalThis.__tuckSensitiveExecuted=true"> rejected',
  );
  await expect(addVideos).toBeEnabled();
  await expect(addVideos).toBeFocused();
  await expect(page.locator("#toast-ct img")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "__tuckSensitiveExecuted"),
    ),
  ).toBeUndefined();
  expect(failures.pageErrors).toEqual([]);
});

test("a failed probe exposes an enabled retry and recovers", async ({ page }) => {
  const failures = collectLoadFailures(page);
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: ["C:\\broken.mp4"] };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "" };
  fixture.responseSequences = {
    probeFile: [
      { ok: false, error: "Probe failed safely" },
      {
        ok: true,
        data: {
          duration: 12,
          file_size: 1024,
          height: 1080,
          width: 1920,
        },
      },
    ],
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.locator("#btn-add").click();
  // the card names the problem with its reason under it, and reads the reason out with it
  await expect(page.locator(".lib-group-attention .c-status")).toHaveText("Can't read file");
  await expect(page.locator(".lib-group-attention .c-reason")).toHaveText("Probe failed safely");
  await expect(page.locator(".lib-group-attention .clip")).toHaveAttribute("aria-description", "Probe failed safely");
  const retry = page.getByRole("button", { name: "Retry reading broken.mp4" });
  await expect(retry).toBeEnabled();
  await retry.click();

  await expect(page.locator(".clip")).toHaveAttribute("title", /0:12 · 1920\u00d71080/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__tuckFakeBackendCalls?.filter(
            (call) => call.method === "probeFile",
          ).length,
      ),
    )
    .toBe(2);
  expect(failures.pageErrors).toEqual([]);
});

test("settings save errors remain visible and leave recovery enabled", async ({
  page,
}) => {
  const failures = collectLoadFailures(page);
  const fixture = healthyBackendFixture();
  fixture.responses.saveSettings = {
    ok: false,
    error: "Settings could not be saved",
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Exports", exact: true }).click();
  const openOutput = page.getByRole("switch", {
    name: "Show the last export in its folder",
  });
  await page
    .getByText("Show the last export in its folder", { exact: true })
    .click();
  await expect(openOutput).toBeChecked();

  // the change is saved as it is made; a failure is reported and the choice stays for a retry
  await expect(page.getByRole("alert")).toContainText(
    "Settings could not be saved",
  );
  await expect(openOutput).toBeChecked();
  await expect(openOutput).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(failures.pageErrors).toEqual([]);
});

test("a settings change that didn't save says so until Try again saves it", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responseSequences = {
    saveSettings: [{ ok: false, error: "Settings could not be saved" }, { ok: true }],
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Exports", exact: true }).click();
  const openOutput = page.getByRole("switch", { name: "Show the last export in its folder" });
  await page.getByText("Show the last export in its folder", { exact: true }).click();

  const status = page.locator("#settings-status");
  const retry = page.getByRole("button", { name: "Try again" });
  // the choice stays on screen for the retry, and the header says it isn't saved
  await expect(status).toHaveText("Not saved");
  await expect(retry).toBeVisible();
  await expect(openOutput).toBeChecked();

  await retry.click();
  await expect(status).toHaveText("Saved");
  await expect(retry).toBeHidden();
  await expect(openOutput).toBeChecked();
});
