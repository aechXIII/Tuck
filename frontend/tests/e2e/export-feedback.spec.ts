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

const running = (progress: number) => ({
  items: [{ id: "a", source: "Alpha.mp4", source_path: VIDEO, state: "running", progress }],
});

test("the export button shows a queued video's export and opens it, and a copy is one step away", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.queueStateAfterEnqueue = running(40);
  await open(page, fixture);
  const exportButton = page.locator("#btn-one");

  await exportButton.click();
  await expect(exportButton).toHaveText("Exporting · 40%");
  await expect(exportButton).toHaveAttribute("aria-label", "Exporting · 40%. Show in Exports");
  await exportButton.click();
  await expect(page.locator("#exports-panel")).toBeVisible();
  expect(await callCount(page, "enqueueWithOptions")).toBe(1);

  await page.keyboard.press("Escape");
  await page.locator(".export-actions > summary").click();
  await page.getByRole("button", { name: "Export another copy" }).click();
  await expect.poll(() => callCount(page, "enqueueWithOptions")).toBe(2);
  await expect(page.locator(".export-actions")).not.toHaveAttribute("open", "");
  await expect(page.locator(".toast")).toContainText("Added another copy of “Alpha.mp4”.");
});

test("a batch with a failure shows a warning, never the success check", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.responses.getQueueState = {
    items: [
      { id: "a", source: "Alpha.mp4", source_path: VIDEO, state: "completed", result_size: 9_000_000 },
      { id: "b", source: "Bravo.mp4", source_path: "C:\videos\Bravo.mp4", state: "failed", error: "FFmpeg stopped" },
    ],
  };
  await open(page, fixture);
  await expect(page.locator("#qbar")).toHaveClass(/has-failed/);
  await expect(page.locator("#qbar .qstatus-warn")).toBeVisible();
  await expect(page.locator("#qbar .qstatus-done")).toBeHidden();
});

test("starting an export is announced through a status region that was there before it", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.queueStateAfterEnqueue = running(5);
  await open(page, fixture);
  const status = page.locator("#live-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toBeEmpty();

  await page.locator("#btn-one").click();
  await expect(status).toHaveText("Exporting “Alpha.mp4”.");
});

test("an export request that times out is checked against the queue before it is called a failure", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.responses.enqueueWithOptions = { ok: false, error: "The Python backend did not respond in time.", code: "BACKEND_TIMEOUT" };
  fixture.queueStateAfterEnqueue = running(5);
  await open(page, fixture);

  await page.locator("#btn-one").click();
  await expect(page.locator("#btn-one")).toHaveText("Exporting · 5%");
  await expect(page.locator(".toast.err")).toHaveCount(0);
});

test("a step with no percentage sweeps, and with Animations off shows a still dashed track", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.queueStateAfterEnqueue = {
    items: [{ id: "a", source: "Alpha.mp4", source_path: VIDEO, state: "running", progress: 0, status_text: "Saving file", progress_info: { stage: "saving", indeterminate: true } }],
  };
  await open(page, fixture);
  await page.locator("#btn-one").click();
  await expect(page.locator("#btn-one")).toHaveText("Saving file");
  const fill = page.locator(".clip .c-progress.is-indeterminate .c-progress-fill");
  await expect(fill).toHaveCSS("animation-name", "card-progress-sweep");
  await expect(page.locator("#qprog")).toHaveCSS("animation-name", "progress-sweep");

  await page.evaluate(() => { document.documentElement.dataset.motion = "off"; });
  await expect(fill).toHaveCSS("animation-name", "none");
  await expect(fill).toHaveCSS("width", /^\d/);
});

test("a failed export offers its details and can leave the list; a cancelled one can leave too", async ({ page }) => {
  const fixture = fixtureWith([VIDEO]);
  fixture.responses.getQueueState = {
    items: [
      { id: "f1", source: "Alpha.mp4", source_path: VIDEO, state: "failed", error: "FFmpeg stopped" },
      { id: "c1", source: "Bravo.mp4", source_path: "C:\videos\Bravo.mp4", state: "cancelled" },
    ],
  };
  fixture.responses.getDiagnostics = { ok: true, text: "diagnostics for f1" };
  await open(page, fixture);
  await page.locator("#qstatus").click();
  const list = page.locator("#exports-list");

  await expect(list.getByRole("button", { name: "Copy details for Alpha.mp4" })).toBeVisible();
  await expect(list.getByRole("button", { name: "Copy details for Bravo.mp4" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Remove Bravo.mp4 from Exports" })).toBeVisible();

  await list.getByRole("button", { name: "Copy details for Alpha.mp4" }).click();
  await expect.poll(() => callCount(page, "getDiagnostics")).toBe(1);

  await list.getByRole("button", { name: "Remove Alpha.mp4 from Exports" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.find((call) => call.method === "removeItem")?.args[0])).toBe("f1");
});
