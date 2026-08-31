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

  await expect(page.getByRole("button", { name: "Add videos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator("#vid")).toHaveAttribute("aria-label", /preview/i);
  await expect(page.getByText("Drop videos anywhere", { exact: true })).toBeVisible();

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
  await expect(page.getByRole("button", { name: "Add videos" })).toBeVisible();
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

  await expect(page.getByRole("alert")).toContainText("Desktop backend unavailable");
  await expect(page.getByRole("alert")).toContainText("reopen Tuck");
  await expect(page.locator("#tb")).toHaveAttribute("inert", "");

  await page.evaluate(() => {
    const host = window as Window & { pywebview?: { api: object } };
    host.pywebview = { api: {} };
    window.dispatchEvent(
      new CustomEvent(["pywebview", "ready"].join("")),
    );
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("#tb")).not.toHaveAttribute("inert", "");
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

  const addVideos = page.getByRole("button", { name: "Add videos" });
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

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(
    page.locator(".c-meta").getByText("Probe failed safely", { exact: true }),
  ).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry reading broken.mp4" });
  await expect(retry).toBeEnabled();
  await retry.click();

  await expect(
    page.locator(".c-meta").getByText(/0:12.*1920\u00d71080/),
  ).toBeVisible();
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
  const openOutput = page.getByRole("checkbox", {
    name: "Open output folder when queue finishes",
  });
  await page
    .getByText("Open output folder when queue finishes", { exact: true })
    .click();
  await expect(openOutput).toBeChecked();
  const save = page
    .locator("#settings-actions")
    .getByRole("button", { name: "Save changes" });
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByRole("alert")).toContainText(
    "Settings could not be saved",
  );
  await expect(save).toBeEnabled();
  await expect(save).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(failures.pageErrors).toEqual([]);
});
