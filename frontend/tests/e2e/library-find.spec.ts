import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { chooseSelect } from "../fixtures/select";

// ten replays: the 10-30 ones are newer, and their lengths differ
const VIDEOS = [
  ["Replay 2026-10-29 18-43-42.mp4", 100, 66],
  ["Replay 2026-10-30 21-14-03.mp4", 900, 30],
  ["Replay 2026-10-29 19-56-58.mp4", 200, 125],
  ["Replay 2026-10-30 20-55-10.mp4", 700, 61],
  ["Clutch 1v4.mp4", 600, 12],
  ["Replay 2026-10-30 21-02-47.mp4", 800, 45],
  ["Replay 2026-10-29 20-11-09.mp4", 300, 90],
  ["Replay 2026-10-30 19-30-22.mp4", 500, 20],
  ["Replay 2026-10-30 20-41-36.mp4", 650, 75],
  ["Replay 2026-10-29 20-04-31.mp4", 250, 15],
] as const;

async function open(page: Page, count: number = VIDEOS.length): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  const videos = VIDEOS.slice(0, count);
  fixture.startup.files = videos.map(([name]) => `C:\\videos\\${name}`);
  fixture.responseSequences = {
    probeFile: videos.map(([, modified, duration]) => ({
      ok: true,
      data: { duration, width: 1920, height: 1080, fps: 60, has_audio: true, file_size: duration * 4_000_000, modified: 1_761_000_000 + modified },
    })),
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#clips .clip")).toHaveCount(count);
}

const names = (page: Page) => page.locator("#clips .clip .c2").allTextContents();

test("Find and Sort show once the Library is long, and Ctrl+F finds in a short one", async ({ page }) => {
  await open(page, 3);
  await expect(page.locator("#lib-find-row")).toBeHidden();
  await page.locator("body").click({ position: { x: 600, y: 300 } });
  await page.keyboard.press("Control+f");
  await expect(page.locator("#lib-find-input")).toBeFocused();
  await expect(page.locator("#lib-find-row")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#lib-find-row")).toBeHidden();
});

test("Sort puts the Library in order, and its menu is its width", async ({ page }) => {
  await open(page);
  await expect(page.locator("#lib-find-row")).toBeVisible();
  const trigger = page.locator("#lib-sort-trigger");
  await expect(trigger).toHaveText("Your order");
  await trigger.click();
  const popup = page.locator(".select-popup:popover-open");
  await expect(popup).toBeVisible();
  const [menu, button] = [(await popup.boundingBox())!, (await trigger.boundingBox())!];
  expect(Math.abs(menu.width - button.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(menu.x - button.x)).toBeLessThanOrEqual(1);
  await popup.locator('[role="option"][data-value="newest"]').click();
  await expect(trigger).toHaveText("Newest first");
  expect((await names(page)).slice(0, 3)).toEqual([
    "Replay 2026-10-30 21-14-03.mp4",
    "Replay 2026-10-30 21-02-47.mp4",
    "Replay 2026-10-30 20-55-10.mp4",
  ]);
  await chooseSelect(page, trigger, "longest");
  expect((await names(page))[0]).toBe("Replay 2026-10-29 19-56-58.mp4");
  await chooseSelect(page, trigger, "name");
  expect((await names(page))[0]).toBe("Clutch 1v4.mp4");
});

test("the search icon grows into a field that narrows the list, and Escape puts it back", async ({ page }) => {
  await open(page);
  await page.locator("#lib-find-open").click();
  const input = page.locator("#lib-find-input");
  await expect(input).toBeFocused();
  // the field takes the whole row, over Sort and the icon
  await expect(page.locator("#lib-sort-trigger")).toBeHidden();
  await expect(page.locator("#lib-find-open")).toBeHidden();
  const [field, row] = [(await page.locator("#lib-find-field").boundingBox())!, (await page.locator("#lib-find-row").boundingBox())!];
  expect(Math.abs(field.width - row.width)).toBeLessThanOrEqual(1);
  await input.fill("10-30");
  await expect(page.locator("#clips .clip")).toHaveCount(5);
  await expect(page.locator("#lib-find-count")).toHaveText("5 of 10");
  await expect(page.locator("#clips .clip .find-match").first()).toHaveText("10-30");

  // Enter goes to the first match
  await input.press("Enter");
  await expect(page.locator("#clips .clip.sel")).toContainText("2026-10-30");
  await expect(page.locator("#clips .clip.sel")).toBeFocused();

  await input.fill("CLUTCH");
  await expect(page.locator("#clips .clip")).toHaveCount(1);
  await input.press("Escape");
  await expect(page.locator("#lib-find-field")).toBeHidden();
  await expect(page.locator("#lib-find-open")).toBeFocused();
  await expect(page.locator("#clips .clip")).toHaveCount(10);
  await expect(page.locator("#lib-sort-trigger")).toBeVisible();
});

test("an emptied field closes when focus leaves it", async ({ page }) => {
  await open(page);
  await page.locator("#lib-find-open").click();
  await page.locator("#lib-find-input").fill("zz");
  await expect(page.locator("#lib-find-count")).toHaveText("0 of 10");
  await page.locator("#lib-find-input").fill("");
  await page.locator("#clips .clip").first().click();
  await expect(page.locator("#lib-find-field")).toBeHidden();
  await expect(page.locator("#lib-find-open")).toBeVisible();
});

test("dragging a row after a sort makes it your order again", async ({ page }) => {
  await open(page);
  const trigger = page.locator("#lib-sort-trigger");
  await chooseSelect(page, trigger, "name");
  await expect(trigger).toHaveText("Name");
  const cards = page.locator("#clips .clip");
  const moving = cards.nth(0);
  // the rows slide to their sorted places and hovering can scroll the list, so measure after both
  // a newer slide cancels the running one, and a cancelled animation's `finished` rejects, so wait for none to be left
  await expect.poll(() => page.locator("#clips").evaluate((list) => list.getAnimations({ subtree: true }).length)).toBe(0);
  await moving.hover();
  const target = (await cards.nth(2).boundingBox())!;
  const handle = (await moving.locator(".c-drag").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 5, { steps: 8 });
  await expect(cards.nth(2)).toHaveAttribute("data-drop-position", "after");
  await page.mouse.up();
  await expect(trigger).toHaveText("Your order");
  expect((await names(page))[2]).toBe("Clutch 1v4.mp4");
});
