import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend, type FakeBackendFixture } from "../fixtures/fake-backend";

const VIDEO = "C:\\videos\\Alpha.mp4";

function fixtureWith(files: string[]): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.startup.files = files;
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  return fixture;
}

async function open(page: Page, fixture: FakeBackendFixture): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
}

const callCount = (page: Page, method: string): Promise<number> =>
  page.evaluate((name) => window.__tuckFakeBackendCalls?.filter((call) => call.method === name).length ?? 0, method);

async function release(page: Page, method: string): Promise<void> {
  await page.evaluate((name) => {
    (window as Window & { __tuckReleaseHeld?: (method: string, value?: unknown) => void }).__tuckReleaseHeld?.(name, { ok: true });
  }, method);
}

test("a second Export press while the first is with the backend queues nothing more", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.holdMethods = ["enqueueWithOptions"];
  await open(page, fixture);
  const exportButton = page.locator("#btn-one");
  await expect(exportButton).toBeEnabled();

  await exportButton.click();
  await exportButton.click({ force: true });
  // a slow request says what it's doing instead of looking ignored
  await expect(exportButton).toHaveText("Adding to queue…");
  await expect(exportButton).toBeDisabled();
  expect(await callCount(page, "enqueueWithOptions")).toBe(1);

  await release(page, "enqueueWithOptions");
  await expect(exportButton).toHaveText("Compress this video");
  await expect(exportButton).toBeEnabled();
  expect(await callCount(page, "enqueueWithOptions")).toBe(1);
});

test("Cancel on an export says it is waiting and ignores repeat presses", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.holdMethods = ["cancelItem"];
  fixture.responses.getQueueState = {
    items: [{ id: "a", source: "Alpha.mp4", source_path: VIDEO, state: "running", progress: 20 }],
  };
  await open(page, fixture);
  await page.locator("#qstatus").click();
  const cancel = page.locator('#exports-list [data-item-id="a"]');
  await expect(cancel).toHaveText("Cancel");

  await cancel.click();
  await expect(cancel).toHaveText("Cancelling…");
  await expect(cancel).toHaveAttribute("aria-disabled", "true");
  // forced: the button stays focusable while waiting, so a real press still reaches it
  await cancel.click({ force: true });
  expect(await callCount(page, "cancelItem")).toBe(1);

  await release(page, "cancelItem");
  await expect(cancel).toHaveText("Cancel");
  await expect(cancel).not.toHaveAttribute("aria-disabled", "true");
});

test("the drop target stays hidden until files are dragged in, and hides again when they leave", async ({ page }) => {
  await open(page, fixtureWith([]));
  const overlay = page.locator("#drag-overlay");
  await expect(overlay).toBeHidden();

  const drag = (type: string): Promise<void> => page.evaluate((eventType) => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "clip.mp4", { type: "video/mp4" }));
    document.body.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, type);
  await drag("dragenter");
  await expect(overlay).toBeVisible();
  await drag("dragleave");
  await expect(overlay).toBeHidden();
});

test("the empty screen offers Add videos, even with the Library closed", async ({ page }) => {
  const fixture = fixtureWith([]);
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  await installFakeBackend(page, fixture);
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");

  const add = page.locator("#empty-add");
  await expect(add).toBeVisible();
  await add.click();
  await expect(page.locator(".clip")).toHaveCount(1);
  await expect(page.locator("#empty")).toBeHidden();
});
