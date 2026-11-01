import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FOLDER = "C:\\Videos\\Replays";

function replays(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${FOLDER}\\Replay ${String(index + 1).padStart(3, "0")}.mp4`);
}

function calls(page: Page, method: string): Promise<(readonly unknown[])[]> {
  return page.evaluate(
    (name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args),
    method,
  );
}

async function openEditor(page: Page, videos: readonly string[], folder = FOLDER): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFolder = { path: folder };
  fixture.responses.listFolderVideos = { folders: [folder], videos: [...videos], truncated: false };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/replay", token: "replay" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await page.route("https://media.test/**", (route) => route.abort());
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).some((call) => call.method === "getSettings")))
    .toBe(true);
}

test("the arrow next to Add videos opens a menu at the width of the pair", async ({ page }) => {
  await openEditor(page, []);
  const arrow = page.getByRole("button", { name: "More ways to add" });
  await arrow.click();
  const menu = page.getByRole("menu", { name: "Add" });
  await expect(menu).toBeVisible();
  await expect(arrow).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText([/Add videos…\s*Ctrl\+O/, "Add a folder…", /Paste videos\s*Ctrl\+V/]);

  const pair = await page.locator(".add-split").boundingBox();
  const box = await menu.boundingBox();
  expect(pair && box).toBeTruthy();
  expect(Math.abs(box!.x - pair!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - pair!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.y - (pair!.y + pair!.height))).toBeLessThanOrEqual(1);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(arrow).toBeFocused();
  await expect(arrow).toHaveAttribute("aria-expanded", "false");
});

test("Add a folder adds the videos inside it", async ({ page }) => {
  const found = replays(3);
  await openEditor(page, found);
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "Add a folder…" }).click();
  await expect(page.getByRole("menu", { name: "Add" })).toBeHidden();
  await expect(page.locator(".clip")).toHaveCount(3);
  expect(await calls(page, "listFolderVideos")).toEqual([[[FOLDER]]]);
  await expect(page.locator(".toast", { hasText: "Added 3 videos." })).toBeVisible();
});

test("the menu works from the keyboard", async ({ page }) => {
  await openEditor(page, replays(2));
  const arrow = page.getByRole("button", { name: "More ways to add" });
  await arrow.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Add videos…" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Add a folder…" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".clip")).toHaveCount(2);
});

test("more than 50 videos from a folder are added only after a yes", async ({ page }) => {
  await openEditor(page, replays(60));
  const addFolder = async () => {
    await page.getByRole("button", { name: "More ways to add" }).click();
    await page.getByRole("menuitem", { name: "Add a folder…" }).click();
  };
  await addFolder();
  const dialog = page.getByRole("dialog", { name: "Add 60 videos?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("From Replays.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".clip")).toHaveCount(0);

  await addFolder();
  await page.getByRole("dialog", { name: "Add 60 videos?" }).getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".clip")).toHaveCount(60);
});

test("a folder with no videos says so", async ({ page }) => {
  await openEditor(page, [], "C:\\Users\\me\\Documents");
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "Add a folder…" }).click();
  await expect(page.locator(".toast", { hasText: "No videos in Documents." })).toBeVisible();
  await expect(page.locator(".clip")).toHaveCount(0);
});

test("the arrow stays put when videos come in, so Remove all never takes its place", async ({ page }) => {
  await openEditor(page, replays(3));
  const arrow = page.getByRole("button", { name: "More ways to add" });
  const removeAll = page.getByRole("button", { name: "Remove all videos" });
  await expect(removeAll).toBeDisabled();
  const before = await arrow.boundingBox();
  await arrow.click();
  await page.getByRole("menuitem", { name: "Add a folder…" }).click();
  await expect(page.locator(".clip")).toHaveCount(3);
  await expect(removeAll).toBeEnabled();
  expect(await arrow.boundingBox()).toEqual(before);
});
