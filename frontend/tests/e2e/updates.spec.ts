import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";

const UPDATE = {
  ok: true,
  available: true,
  version: "0.5.0",
  size_mb: 12.5,
  notes: "## Highlights\n- Faster startup",
};

function updateFixture(checkUpdates: boolean, check: unknown = UPDATE): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...(fixture.responses.getSettings as Record<string, unknown>),
    check_updates: checkUpdates,
    version: "0.4.0",
  };
  fixture.responses.checkForUpdates = check;
  return fixture;
}

async function calledMethods(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).map((call) => call.method));
}

test("startup offers an available update when update checks are on", async ({ page }) => {
  await installFakeBackend(page, updateFixture(true));
  await page.goto("/");

  await expect(page.locator("#update-version")).toHaveText("v0.5.0");
  await expect(page.locator("#update-notes")).toContainText("Faster startup");
  await expect(page.getByRole("button", { name: "Download & install" })).toBeEnabled();
});

test("startup never checks for updates when update checks are off", async ({ page }) => {
  await installFakeBackend(page, updateFixture(false));
  await page.goto("/");

  // the queue poll runs after the startup decision, so seeing it means the check was skipped
  await expect.poll(async () => (await calledMethods(page)).includes("getQueueState")).toBe(true);
  expect(await calledMethods(page)).not.toContain("checkForUpdates");
  await expect(page.locator("#update-version")).toHaveCount(0);
});

test("a startup check stays quiet when Tuck is current or the check fails", async ({ page }) => {
  const fixture = updateFixture(true);
  fixture.responseSequences = {
    checkForUpdates: [{ ok: true, available: false }],
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await expect.poll(async () => (await calledMethods(page)).includes("checkForUpdates")).toBe(true);
  await expect(page.locator("#update-version")).toHaveCount(0);
  await expect(page.locator("#toast-ct")).not.toContainText("Running latest version.");

  const failing = await page.context().newPage();
  await installFakeBackend(failing, updateFixture(true, { ok: true, available: false, error: "GitHub unreachable" }));
  await failing.goto("/");
  await expect.poll(async () => (await calledMethods(failing)).includes("checkForUpdates")).toBe(true);
  await expect(failing.locator("#toast-ct")).not.toContainText("Update check failed");
});

test("Download & install starts the installer and closes Tuck without asking again", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const fixture = updateFixture(true);
  fixture.responses.downloadUpdate = { ok: true };
  fixture.responseSequences = {
    getDownloadProgress: [
      { downloading: true, progress: 40 },
      { downloading: false, done: true, progress: 100 },
    ],
  };
  fixture.responses.installUpdate = { ok: true };
  fixture.responses.closeWindow = { ok: true };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Download & install" }).click();
  await expect
    .poll(async () => (await calledMethods(page)).filter((method) => /Update|Download|closeWindow/.test(method)))
    .toEqual([
      "checkForUpdates",
      "downloadUpdate",
      "getDownloadProgress",
      "getDownloadProgress",
      "installUpdate",
      "closeWindow",
    ]);
  expect(dialogs).toEqual([]);
  await expect(page.locator("#mod-box")).not.toContainText("Install now?");
});

test("a failed installer start keeps the update offer usable", async ({ page }) => {
  const fixture = updateFixture(true);
  fixture.responses.downloadUpdate = { ok: true };
  fixture.responses.getDownloadProgress = { downloading: false, done: true, progress: 100 };
  fixture.responses.installUpdate = { ok: false, error: "The installer could not start" };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  const install = page.getByRole("button", { name: "Download & install" });
  await install.click();
  await expect(page.getByRole("alert")).toContainText("Update failed: The installer could not start");
  await expect(install).toBeEnabled();
  await expect(page.getByRole("button", { name: "Later" })).toBeEnabled();
  expect(await calledMethods(page)).not.toContain("closeWindow");
});
