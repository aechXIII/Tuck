import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
} from "../fixtures/fake-backend";

const legacyStyles = [
  "styles.css",
  "library.css",
  "inspector.css",
  "export.css",
  "shortcuts.css",
  "settings.css",
  "player.css",
  "audio.css",
  "timeline.css",
  "queue.css",
  "transform.css",
];

const legacyScripts = [
  "dom.js",
  "delegated-events.js",
  "crop.js",
  "notifications.js",
  "segments.js",
  "probe-state.js",
  "layout.js",
  "inspector-ui.js",
  "encoding-ui.js",
  "shortcuts.js",
  "clip-card.js",
  "app.js",
  "audio.js",
  "clip-details.js",
  "panels.js",
  "player.js",
  "timeline.js",
  "queue.js",
  "settings-state.js",
  "settings-profiles.js",
  "settings.js",
  "transform.js",
  "history.js",
  "ui-bindings.js",
];

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

  const styleHrefs = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(styleHrefs.slice(0, legacyStyles.length)).toEqual(
    legacyStyles.map((name) => `./legacy/${name}`),
  );

  const scriptSources = await page
    .locator('script[src]:not([type="module"])')
    .evaluateAll((scripts) => scripts.map((script) => script.getAttribute("src")));
  expect(scriptSources).toEqual(
    legacyScripts.map((name) => `./legacy/${name}`),
  );
  await expect(page.locator('script[type="module"]')).toHaveAttribute(
    "src",
    /^\.\/assets\/index-[^/]+\.js$/,
  );
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
    window.dispatchEvent(new CustomEvent("pywebviewready"));
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("#tb")).not.toHaveAttribute("inert", "");
});
