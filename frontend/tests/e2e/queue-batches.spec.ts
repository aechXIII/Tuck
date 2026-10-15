import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, type FakeBackendFixture } from "../fixtures/fake-backend";

const A = "C:\\videos\\Alpha.mp4";
const B = "C:\\videos\\Bravo.mp4";
const C = "C:\\videos\\Charlie.mp4";

interface QueueWindow {
  __queue?: unknown[];
}

function fixtureFor(files: string[]): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.startup.files = files;
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  return fixture;
}

// the queue answers whatever the test last set, the way the backend reports its own progress
async function open(page: Page, fixture: FakeBackendFixture, count: number): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.addInitScript(() => {
    const queueWindow = window as unknown as QueueWindow;
    queueWindow.__queue = [];
    const install = (): void => {
      const client = window.tuckBackendClient;
      if (!client) return;
      client.getQueueState = async () => ({ ok: true, value: { items: queueWindow.__queue ?? [] } }) as never;
      // like the backend, clearing drops only completed exports
      client.clearCompleted = async () => {
        window.__tuckFakeBackendCalls?.push({ method: "clearCompleted", args: [] });
        const before = queueWindow.__queue ?? [];
        queueWindow.__queue = before.filter((entry) => (entry as { state?: string }).state !== "completed");
        return { ok: true, value: { count: before.length - queueWindow.__queue.length } } as never;
      };
    };
    install();
  });
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(count);
}

async function setQueue(page: Page, items: unknown[]): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as QueueWindow).__queue = next;
  }, items);
}

const item = (id: string, path: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ id, source: path.split("\\").pop(), source_path: path, state, ...extra });

test("a batch with failures says so once, and Show opens the first failed export", async ({ page }) => {
  await open(page, fixtureFor([A, B, C]), 3);
  await setQueue(page, [item("a", A, "running", { progress: 10 }), item("b", B, "pending"), item("c", C, "pending")]);
  await expect(page.locator("#qbar")).toBeVisible();
  await setQueue(page, [
    item("a", A, "completed", { result_path: "C:\\videos\\Alpha_small.mp4" }),
    item("b", B, "failed", { error: "Encoder stopped unexpectedly" }),
    item("c", C, "failed", { error: "Disk is full" }),
  ]);
  const summary = page.locator(".toast", { hasText: "2 of 3 exports failed." });
  await expect(summary).toBeVisible();
  // one message for the batch, not one per failed video
  await expect(page.locator(".toast")).toHaveCount(1);
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" }).locator(".c-status")).toHaveAttribute("data-tip", "Encoder stopped unexpectedly");
  await summary.getByRole("button", { name: "Show" }).click();
  await expect(page.locator("#exports-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Bravo.mp4" })).toBeFocused();
});

test("cancelling all exports reports a failure honestly and never claims completion", async ({ page }) => {
  const fixture = fixtureFor([A, B]);
  fixture.responseSequences = { cancelAllItems: [{ ok: false, error: "The queue is busy" }, { ok: true }] };
  await open(page, fixture, 2);
  await setQueue(page, [item("a", A, "running", { progress: 10 }), item("b", B, "pending")]);
  await page.locator("#qstatus").click();
  await page.getByRole("button", { name: "Cancel all" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel all exports?" });
  await expect(dialog.getByRole("button", { name: "Keep exporting" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel exports" }).click();
  const failure = page.locator(".toast", { hasText: "Couldn’t cancel the exports. The queue is busy." });
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "Dismiss notification" }).click();

  await page.getByRole("button", { name: "Cancel all" }).click();
  await dialog.getByRole("button", { name: "Cancel exports" }).click();
  await setQueue(page, [item("a", A, "cancelled"), item("b", B, "cancelled")]);
  await expect(page.locator(".toast", { hasText: "Exports canceled." })).toBeVisible();
  await expect(page.locator(".toast", { hasText: /completed/i })).toHaveCount(0);
});

test("clearing finished exports keeps their videos and edits in the Library", async ({ page }) => {
  const fixture = fixtureFor([A, B]);
  await open(page, fixture, 2);
  await setQueue(page, [item("a", A, "running", { progress: 50 })]);
  await expect(page.locator("#qbar")).toBeVisible();
  await setQueue(page, [item("a", A, "completed", { result_path: "C:\\videos\\Alpha_small.mp4", result_size: 1_000_000 })]);
  await expect(page.locator(".clip", { hasText: "Alpha.mp4" }).getByRole("button", { name: "Show" })).toBeVisible();
  await page.locator(".toast", { hasText: "Exported “Alpha.mp4”." }).getByRole("button", { name: "Dismiss notification" }).click();
  await page.locator("#qstatus").click();
  await page.getByRole("button", { name: "Clear done" }).click();
  await expect(page.locator(".toast", { hasText: "Cleared 1 finished export." })).toBeVisible();
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator(".clip", { hasText: "Alpha.mp4" }).getByRole("button", { name: "Show" })).toHaveCount(0);
});

test("clearing finished exports automatically waits for the batch and keeps the videos", async ({ page }) => {
  const fixture = fixtureFor([A, B]);
  fixture.responses.getSettings = { ...(fixture.responses.getSettings as object), clear_completed_automatically: true };
  await open(page, fixture, 2);
  await setQueue(page, [item("a", A, "running", { progress: 50 }), item("b", B, "pending")]);
  await expect(page.locator("#qbar")).toBeVisible();
  await setQueue(page, [item("a", A, "completed"), item("b", B, "running", { progress: 5 })]);
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" })).toHaveAttribute("data-queue-state", "running");
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.some((call) => call.method === "clearCompleted"))).toBe(false);
  await setQueue(page, [item("a", A, "completed"), item("b", B, "completed")]);
  await expect(page.locator(".toast", { hasText: "2 videos exported." })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter((call) => call.method === "clearCompleted").length)).toBe(1);
  await expect(page.locator(".clip")).toHaveCount(2);
});

test("finished videos leave the Library when the setting is on, and Undo brings them back", async ({ page }) => {
  const fixture = fixtureFor([A, B, C]);
  fixture.responses.getSettings = { ...(fixture.responses.getSettings as object), remove_after_export: true };
  await open(page, fixture, 3);
  await setQueue(page, [item("a", A, "running", { progress: 10 }), item("b", B, "pending"), item("c", C, "pending")]);
  await expect(page.locator("#qbar")).toBeVisible();
  await setQueue(page, [item("a", A, "completed"), item("b", B, "running", { progress: 5 }), item("c", C, "pending")]);
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" })).toHaveAttribute("data-queue-state", "running");
  // the batch isn't done yet, so nothing has left
  await expect(page.locator(".clip")).toHaveCount(3);
  // Alpha is the selected video; an edit after queueing means its export is out of date, so it stays
  await page.locator('[data-action-click="transform-rotation"][data-rotation="90"]')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await setQueue(page, [
    item("a", A, "completed", { result_path: "C:\\videos\\Alpha_small.mp4" }),
    item("b", B, "completed", { result_path: "C:\\videos\\Bravo_small.mp4" }),
    item("c", C, "failed", { error: "Disk is full" }),
  ]);
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" })).toHaveCount(0);
  await expect(page.locator(".clip", { hasText: "Alpha.mp4" })).toHaveCount(1);
  await expect(page.locator(".clip", { hasText: "Charlie.mp4" })).toHaveCount(1);

  // the batch message comes first, then one message for the removal
  const summary = page.locator(".toast", { hasText: "1 of 3 exports failed." });
  await summary.getByRole("button", { name: "Dismiss notification" }).click();
  await page.locator(".toast", { hasText: "Removed “Bravo.mp4”." }).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".clip")).toHaveCount(3);
});

test("finished videos stay in the Library while the setting is off", async ({ page }) => {
  await open(page, fixtureFor([A, B]), 2);
  await setQueue(page, [item("a", A, "running", { progress: 50 })]);
  await expect(page.locator("#qbar")).toBeVisible();
  await setQueue(page, [item("a", A, "completed", { result_path: "C:\\videos\\Alpha_small.mp4" })]);
  await expect(page.locator(".toast", { hasText: "Exported “Alpha.mp4”." })).toBeVisible();
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator(".toast", { hasText: "Removed" })).toHaveCount(0);
});
