import {expect, test, type Page} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";

async function start(page: Page, settings: Record<string, unknown> = {}) {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {...fixture.responses.getSettings as object, ...settings};
  fixture.responses.saveSettings = {ok:true};
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.getByRole("button", {name:"Settings", exact:true})).toBeVisible();
}

async function openKeyboardPage(page: Page) {
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await page.getByRole("button", {name:"Keyboard", exact:true}).click();
  await expect(page.getByRole("heading", {name:"Keyboard shortcuts", exact:true})).toBeVisible();
}

const lastSaved = (page: Page) => page.evaluate(() =>
  window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0]);

for (const width of [1240, 960]) {
  test(`the toolbar opens the visual shortcut guide and restores focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await start(page);
    const opener = page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAttribute("aria-keyshortcuts", /Control\+\//);
    await opener.click();
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
    await expect(guide).toBeVisible();
    await expect(guide.locator(".kbs-keyboard")).toBeVisible();
    const search = guide.getByRole("searchbox", { name: "Search keyboard shortcuts" });
    await expect(search).toBeFocused();
    await search.fill("split");
    await expect(guide.locator(".kbs-row")).toHaveCount(1);
    await expect(guide.locator(".kbs-row")).toContainText("Split at playhead");
    await page.keyboard.press("Escape");
    await expect(guide).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(guide).toBeVisible();
    await guide.getByRole("button", { name: "Close keyboard shortcuts" }).click();
    await expect(opener).toBeFocused();
  });

  test(`Keyboard settings opens the guide without losing its place at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await start(page);
    await openKeyboardPage(page);
    const opener = page.getByRole("button", { name: "Shortcut guide", exact: true });
    await expect(opener).toBeVisible();
    await opener.click();
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
    await expect(guide).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await guide.getByRole("button", { name: "Change shortcuts", exact: true }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change S for Split at playhead" })).toBeVisible();
    expect(await lastSaved(page)).toBeUndefined();
  });
}

test("new keys apply straight away, are saved and update button hints", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  await page.getByRole("button", {name:"Change S for Split at playhead"}).click();
  await expect(page.locator(".kb-row.capturing")).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(page.locator("#kb-status")).toHaveText("Split at playhead now uses X.");
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"timeline.split":["X"]}});
  await expect(page.getByRole("button", {name:"Reset Split at playhead to its default keys"})).toBeVisible();
  await expect(page.getByRole("button", {name:"Change X for Split at playhead"})).toBeFocused();
  await expect(page.locator("#btn-seq-split")).toHaveAttribute("aria-keyshortcuts", "X");
  await expect(page.locator("#btn-seq-split")).toHaveAttribute("data-tip", "Split (X)");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", {name:"Settings"})).toBeHidden();
});

test("taking keys from another action asks first and leaves that action without them", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  await page.getByRole("button", {name:"Change Ctrl+O for Add videos"}).click();
  await page.keyboard.press("Control+q");
  const conflict = page.locator(".kb-conflict");
  await expect(conflict).toContainText("Ctrl+Q is used by Exit Tuck.");
  await expect(conflict.getByRole("button", {name:"Use here"})).toBeFocused();
  await conflict.getByRole("button", {name:"Use here"}).click();
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"file.add-videos":["Ctrl+Q"], "app.exit":[]}});
  await expect(page.locator('[data-command="app.exit"]')).toContainText("No keys");
  await page.locator("#settings-page").getByRole("button", {name:"Reset all"}).click();
  await page.getByRole("dialog", {name:"Reset keyboard shortcuts?"}).getByRole("button", {name:"Reset all"}).click();
  await expect.poll(() => lastSaved(page)).toEqual({shortcut_overrides:{}});
  await expect(page.locator('[data-command="app.exit"]')).not.toContainText("No keys");
});

test("a command keeps its other keys: one can be changed, added or removed on its own", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  const redo = page.locator('[data-command="edit.redo"]');
  await expect(redo.locator(".kb-change")).toHaveCount(2);

  // changing one key leaves the other
  await page.getByRole("button", {name:"Change Ctrl+Shift+Z for Redo"}).click();
  await page.keyboard.press("Control+r");
  await expect(page.locator("#kb-status")).toHaveText("Redo now uses Ctrl+R or Ctrl+Y.");
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"edit.redo":["Ctrl+R", "Ctrl+Y"]}});
  await expect(page.getByRole("button", {name:"Change Ctrl+R for Redo"})).toBeFocused();

  // Add keys appends, up to the three a command can keep
  await page.getByRole("button", {name:"Add keys for Redo"}).click();
  await expect(redo).toHaveClass(/capturing/);
  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator("#kb-status")).toHaveText("Redo now uses Ctrl+R or Ctrl+Y or Ctrl+Shift+Z.");
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"edit.redo":["Ctrl+R", "Ctrl+Y", "Ctrl+Shift+Z"]}});
  await expect(page.getByRole("button", {name:"Add keys for Redo"})).toBeDisabled();

  // removing one key keeps the rest, and focus stays in the row
  await page.getByRole("button", {name:"Remove Ctrl+R from Redo"}).click();
  await expect(page.locator("#kb-status")).toHaveText("Redo no longer uses Ctrl+R.");
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"edit.redo":["Ctrl+Y", "Ctrl+Shift+Z"]}});
  await expect(page.getByRole("button", {name:"Change Ctrl+Y for Redo"})).toBeFocused();
  await expect(page.locator("#btn-redo")).toHaveAttribute("aria-keyshortcuts", "Control+Y Control+Shift+Z");

  // a key the command already has is not added twice
  await page.getByRole("button", {name:"Add keys for Redo"}).click();
  await page.keyboard.press("Control+y");
  await expect(page.locator("#kb-status")).toHaveText("Redo already uses Ctrl+Y.");
  await expect(redo.locator(".kb-change")).toHaveCount(2);

  // taking every key away leaves No keys and an Add keys button
  const del = page.locator('[data-command="edit.delete-selection"]');
  await page.getByRole("button", {name:"Remove Del from Delete selected item"}).click();
  await expect(del.locator(".kb-change")).toHaveCount(1);
  await page.getByRole("button", {name:"Remove Backspace from Delete selected item"}).click();
  await expect(del).toContainText("No keys");
  await expect(page.getByRole("button", {name:"Add keys for Delete selected item"})).toBeFocused();
  expect(await lastSaved(page)).toEqual({shortcut_overrides:{"edit.redo":["Ctrl+Y", "Ctrl+Shift+Z"], "edit.delete-selection":[]}});
});

// how far a row's keys, down to each key cap, or the page reach past the right edge of the card
const keysPastCard = (page: Page, id: string) => page.evaluate((command) => {
  const row = document.querySelector<HTMLElement>(`#kb-list [data-command="${command}"]`)!;
  const edge = row.closest<HTMLElement>(".set-card")!.getBoundingClientRect().right;
  const parts = [...row.querySelectorAll<HTMLElement>(".kb-actions *"), ...document.querySelectorAll<HTMLElement>(".kb-conflict *")]
    .filter(part => part.getClientRects().length);
  const page = document.getElementById("settings-page")!;
  return Math.max(0, page.scrollWidth - page.clientWidth, ...parts.map(part => Math.ceil(part.getBoundingClientRect().right - edge)));
}, id);

for (const width of [960, 1240]) {
  test(`a command's keys wrap onto a new line instead of leaving the card at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: width === 960 ? 640 : 800});
    await start(page, {shortcut_overrides:{"edit.redo":["Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+Alt+Shift+F12"]}});
    await page.addStyleTag({content: ':root { --font: Arial, "Liberation Sans"; }'});
    await openKeyboardPage(page);
    const redo = page.locator('[data-command="edit.redo"]');
    await expect(redo.locator(".kb-change")).toHaveCount(3);
    expect(await keysPastCard(page, "edit.redo")).toBe(0);

    // a key being added, and the question when another action has it, stay inside too
    await page.getByRole("button", {name:"Add keys for Add videos"}).click();
    await page.keyboard.press("Control+Shift+Z");
    await expect(page.locator(".kb-conflict")).toContainText("Ctrl+Shift+Z is used by Redo.");
    expect(await keysPastCard(page, "file.add-videos")).toBe(0);
  });
}

test("saved keys from older versions still load, including several keys for one command", async ({page}) => {
  await start(page, {shortcut_overrides:{"edit.redo":["Ctrl+Y"], "edit.delete-selection":["Delete", "X", "Backspace"]}});
  await openKeyboardPage(page);
  await expect(page.locator('[data-command="edit.redo"] .kb-change')).toHaveCount(1);
  await expect(page.locator('[data-command="edit.delete-selection"] .kb-change')).toHaveCount(3);
  await expect(page.getByRole("button", {name:"Add keys for Delete selected item"})).toBeDisabled();
});

test("Esc cancels choosing keys and reserved keys are refused", async ({page}) => {
  await start(page);
  await openKeyboardPage(page);
  await page.getByRole("button", {name:"Change Ctrl+Z for Undo"}).click();
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
