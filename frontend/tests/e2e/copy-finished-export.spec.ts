import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FIRST = "C:\\videos\\Round one.mp4";
const SECOND = "C:\\videos\\Round two.mp4";
const RESULT = "C:\\videos\\Round one_tucked_20MB.mp4";

async function open(page: Page, copy: boolean): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = [FIRST, SECOND];
  fixture.responses.getSettings = { ...(fixture.responses.getSettings as object), copy_finished_export: copy };
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 40_000_000 } };
  fixture.responses.enqueueWithOptions = { ok: true, item_id: "one" };
  fixture.responses.enqueueBatch = { ok: true, enqueued: ["a", "b"], errors: [], count: 2 };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(2);
  // the queue answers with whatever the test puts in window.__queueItems
  await page.evaluate(() => {
    Reflect.set(window, "__queueItems", []);
    const client = Reflect.get(window, "tuckBackendClient") as { getQueueState: () => Promise<unknown> };
    client.getQueueState = async () => ({ ok: true, value: { items: Reflect.get(window, "__queueItems") } });
  });
}

async function setQueue(page: Page, items: unknown[]): Promise<void> {
  await page.evaluate((next) => {
    Reflect.set(window, "__queueItems", next);
  }, items);
}

function copies(page: Page): Promise<(readonly unknown[])[]> {
  return page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "copyFile").map((call) => call.args));
}

function done(id: string, source: string, result: string) {
  return { id, source: source.split("\\").pop(), source_path: source, state: "completed", progress: 100, result_path: result, result_size: 9_000_000 };
}

test("a video exported on its own is copied when it finishes, and a batch is not", async ({ page }) => {
  await open(page, true);
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#btn-one").click();
  await setQueue(page, [{ id: "one", source: "Round one.mp4", source_path: FIRST, state: "running", progress: 40 }]);
  await expect.poll(() => copies(page), { timeout: 8000 }).toEqual([]);
  await setQueue(page, [done("one", FIRST, RESULT)]);
  await expect.poll(() => copies(page), { timeout: 8000 }).toEqual([[RESULT]]);
  // it follows the note that the export finished
  await expect(page.locator(".toast").filter({ hasText: "File copied to clipboard." })).toBeVisible({ timeout: 15000 });

  // Compress all finishes without touching the clipboard
  await page.locator(".export-actions > summary").click();
  await page.locator("#btn-all").click();
  await setQueue(page, [
    done("one", FIRST, RESULT),
    done("a", FIRST, "C:\\videos\\Round one_tucked_20MB (2).mp4"),
    done("b", SECOND, "C:\\videos\\Round two_tucked_20MB.mp4"),
  ]);
  await page.waitForTimeout(2500);
  expect(await copies(page)).toEqual([[RESULT]]);
});

test("with the setting off nothing is copied", async ({ page }) => {
  await open(page, false);
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#btn-one").click();
  await setQueue(page, [done("one", FIRST, RESULT)]);
  await page.waitForTimeout(2500);
  expect(await copies(page)).toEqual([]);
});

test("the switch is first under When exports finish and is saved", async ({ page }) => {
  await open(page, false);
  await page.locator("#settings-toggle").click();
  await page.locator("#settings-nav-queue").click();
  const toggle = page.getByRole("switch", { name: "Copy the exported video" });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("#settings-page")).toContainText("Only when you export one video. Ready to paste into a chat.");
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "saveSettings")
    .some((call) => (call.args[0] as Record<string, unknown>).copy_finished_export === true))).toBe(true);
});
