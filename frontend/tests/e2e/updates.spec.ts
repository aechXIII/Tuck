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

async function savedCheckTimes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "saveSettings")
    .map((call) => (call.args[0] as { last_update_check?: string }).last_update_check)
    .filter((value): value is string => typeof value === "string"));
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
  await expect(page.locator("#toast-ct")).not.toContainText("Tuck is up to date.");
  // a check that got an answer is remembered for About
  await expect.poll(async () => savedCheckTimes(page)).toHaveLength(1);
  expect(Date.parse((await savedCheckTimes(page))[0]!)).toBeGreaterThan(Date.now() - 60_000);

  const failing = await page.context().newPage();
  await installFakeBackend(failing, updateFixture(true, { ok: true, available: false, error: "GitHub unreachable" }));
  await failing.goto("/");
  await expect.poll(async () => (await calledMethods(failing)).includes("checkForUpdates")).toBe(true);
  await expect(failing.locator("#toast-ct")).not.toContainText("Update check failed");
  expect(await savedCheckTimes(failing)).toEqual([]);
});

test("About says when updates were last checked and Check for updates refreshes it", async ({ page }) => {
  const fixture = updateFixture(false, { ok: true, available: false });
  const earlier = new Date();
  earlier.setDate(earlier.getDate() - 1);
  earlier.setHours(9, 30, 0, 0);
  fixture.responses.getSettings = {
    ...(fixture.responses.getSettings as Record<string, unknown>),
    last_update_check: earlier.toISOString(),
  };
  fixture.responses.saveSettings = { ok: true };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-about").click();

  const note = page.locator("#set-update-checked");
  await expect(note).toHaveText(/^Last checked yesterday at 9:30/);
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.locator("#toast-ct")).toContainText("Tuck is up to date.");
  await expect(note).toHaveText(/^Last checked today at \d{1,2}:\d{2}/);
  expect(await savedCheckTimes(page)).toHaveLength(1);
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

test("closing the update dialog during the download never installs by itself", async ({ page }) => {
  const fixture = updateFixture(true);
  fixture.responses.downloadUpdate = { ok: true };
  fixture.responseSequences = {
    getDownloadProgress: [
      { downloading: true, progress: 40 },
      { downloading: true, progress: 80 },
      { downloading: false, done: true, progress: 100 },
    ],
  };
  fixture.responses.installUpdate = { ok: true };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  const install = page.getByRole("button", { name: "Download & install" });
  await install.click();
  await expect(page.locator("#update-install")).toHaveText(/Starting download…|Downloading/);
  await page.keyboard.press("Escape");

  await expect(page.locator(".toast")).toContainText("The update is downloaded.");
  expect(await calledMethods(page)).not.toContain("installUpdate");
  await page.locator(".toast").getByRole("button", { name: "Install" }).click();
  await expect.poll(() => calledMethods(page)).toContain("installUpdate");
});
