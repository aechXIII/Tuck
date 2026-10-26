import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FIRST = "C:\\media\\Pasted one.mp4";
const SECOND = "C:\\media\\録画 #2.mov";
const SONG = "C:\\media\\Song.mp3";

function calls(page: Page, method: string): Promise<(readonly unknown[])[]> {
  return page.evaluate(
    (name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args),
    method,
  );
}

async function openEditor(page: Page, clipboard: readonly string[]): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.readClipboardFiles = { files: clipboard };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true },
  };
  fixture.responses.probeAudioFile = { ok: true, data: { duration: 30, channels: 2, sample_rate: 48000 } };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/pasted", token: "pasted" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await page.route("https://media.test/**", (route) => route.abort());
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).some((call) => call.method === "getSettings")))
    .toBe(true);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
}

test("Ctrl+V adds copied videos to the Library the way dropping them does", async ({ page }) => {
  await openEditor(page, [FIRST, SECOND]);

  await page.keyboard.press("Control+v");
  await expect(page.locator(".clip").filter({ hasText: "Pasted one.mp4" })).toBeVisible();
  await expect(page.locator(".clip").filter({ hasText: "録画 #2.mov" })).toBeVisible();
  expect(await calls(page, "readClipboardFiles")).toEqual([[]]);
  await expect.poll(() => calls(page, "probeFile")).toEqual(expect.arrayContaining([[FIRST], [SECOND]]));

  // pasting the same videos again doesn't add them twice
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await calls(page, "readClipboardFiles")).length).toBe(2);
  await expect(page.locator(".clip")).toHaveCount(2);
});

test("copied audio goes to the audio panel, as it does when dropped", async ({ page }) => {
  await openEditor(page, [SONG]);

  await page.keyboard.press("Control+v");
  // the audio panel needs a video to put the sound under
  await expect(page.locator(".toast", { hasText: "Select a video before adding audio." })).toBeVisible();
  await expect(page.locator(".clip")).toHaveCount(0);
});

test("a clipboard without files adds nothing and shows no message", async ({ page }) => {
  await openEditor(page, []);

  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await calls(page, "readClipboardFiles")).length).toBe(1);
  await expect(page.locator(".clip")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("Ctrl+V in a text field pastes text there instead of adding videos", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openEditor(page, [FIRST]);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".clip")).toHaveCount(1);

  await page.evaluate(() => navigator.clipboard.writeText("256"));
  const size = page.getByRole("spinbutton", { name: "Target size in megabytes" });
  await size.fill("");
  await size.press("Control+v");
  await expect(size).toHaveValue("256");
  expect(await calls(page, "readClipboardFiles")).toEqual([[]]);
});

test("the keyboard shortcuts dialog lists Paste videos with Ctrl+V", async ({ page }) => {
  await openEditor(page, []);

  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Search keyboard shortcuts" }).fill("paste");
  const row = dialog.locator("#kbs-grid").getByText("Paste videos");
  await expect(row).toBeVisible();
  // Paste edits matches too, under Edit
  await expect(dialog.locator("#kbs-grid").getByText("Paste edits")).toBeVisible();
  await expect(dialog.locator("#kbs-match-count")).toContainText("2 results");
  expect(await calls(page, "readClipboardFiles")).toEqual([]);
});
