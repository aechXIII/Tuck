import {expect, test, type Page} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";

async function start(page: Page, settings: Record<string, unknown> = {}) {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {...fixture.responses.getSettings as object, ...settings};
  fixture.responses.saveSettings = {ok:true};
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.getByRole("button", {name:"Add videos"}).first()).toBeVisible();
}

async function openKeyboardPage(page: Page) {
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await page.getByRole("button", {name:"Keyboard", exact:true}).click();
  await expect(page.getByRole("heading", {name:"Keyboard shortcuts", exact:true})).toBeVisible();
}

const lastSaved = (page: Page) => page.evaluate(() =>
  window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0]);

test("new keys apply straight away, are saved and update button hints", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  await page.getByRole("button", {name:"Change keys for Split at playhead"}).click();
  await expect(page.locator(".kb-row.capturing")).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(page.locator("#kb-status")).toHaveText("Split at playhead now uses X.");
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"timeline.split":["X"]}});
  await expect(page.getByRole("button", {name:"Reset Split at playhead to its default keys"})).toBeVisible();
  await expect(page.getByRole("button", {name:"Change keys for Split at playhead"})).toBeFocused();
  await expect(page.locator("#btn-seq-split")).toHaveAttribute("aria-keyshortcuts", "X");
  await expect(page.locator("#btn-seq-split")).toHaveAttribute("data-tip", "Split (X)");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", {name:"Settings"})).toBeHidden();
});

test("taking keys from another action asks first and leaves that action without them", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  await page.getByRole("button", {name:"Change keys for Add videos"}).click();
  await page.keyboard.press("Control+q");
  const conflict = page.locator(".kb-conflict");
  await expect(conflict).toContainText("Ctrl+Q is used by Exit Tuck.");
  await expect(conflict.getByRole("button", {name:"Use here"})).toBeFocused();
  await conflict.getByRole("button", {name:"Use here"}).click();
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"file.add-videos":["Ctrl+Q"], "app.exit":[]}});
  await expect(page.locator('[data-command="app.exit"]')).toContainText("No keys");
  await page.locator("#settings-actions").getByRole("button", {name:"Reset all"}).click();
  await page.getByRole("dialog", {name:"Reset keyboard shortcuts?"}).getByRole("button", {name:"Reset all"}).click();
  await expect.poll(() => lastSaved(page)).toEqual({shortcut_overrides:{}});
  await expect(page.locator('[data-command="app.exit"]')).not.toContainText("No keys");
});

test("Esc cancels choosing keys and reserved keys are refused", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  await page.getByRole("button", {name:"Change keys for Undo"}).click();
  await page.keyboard.press("Tab");
  await expect(page.locator("#kb-status")).toContainText("cannot be used");
  await expect(page.locator(".kb-row.capturing")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".kb-row.capturing")).toHaveCount(0);
  await expect(page.getByRole("dialog", {name:"Settings"})).toBeVisible();
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.some(call => call.method === "saveSettings"))).toBe(false);
});

test("saved keys apply on launch and the guide links to the Keyboard page", async ({page}) => {
  await start(page, {shortcut_overrides:{"timeline.split":["X"], "help.shortcuts":["F1"]}});
  await expect(page.locator("#btn-seq-split")).toHaveAttribute("data-tip", "Split (X)");
  await page.keyboard.press("F1");
  const guide = page.getByRole("dialog", {name:"Keyboard shortcuts"});
  await expect(guide).toBeVisible();
  await expect(guide.locator(".kbs-row", {hasText:"Split at playhead"})).toContainText("X");
  await guide.getByRole("button", {name:"Change shortcuts"}).click();
  await expect(page.getByRole("heading", {name:"Keyboard shortcuts", exact:true})).toBeVisible();
});
