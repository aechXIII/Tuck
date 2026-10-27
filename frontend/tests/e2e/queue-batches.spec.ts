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
      type Entry = { id?: string; state?: string };
      const clear = (method: "clearCompleted" | "clearFinished", states: readonly string[]) => async () => {
        window.__tuckFakeBackendCalls?.push({ method, args: [] });
        const before = (queueWindow.__queue ?? []) as Entry[];
        queueWindow.__queue = before.filter((entry) => !states.includes(entry.state ?? ""));
        return { ok: true, value: { count: before.length - queueWindow.__queue.length } } as never;
      };
      // like the backend: the setting clears completed exports, the button canceled ones too
      client.clearCompleted = clear("clearCompleted", ["completed"]);
      client.clearFinished = clear("clearFinished", ["completed", "cancelled"]);
      // like the backend, each export keeps its row and goes back to the queue in list order
      const requeue = (method: "retryAllItems" | "resumeExports", states: readonly string[]) => async () => {
        window.__tuckFakeBackendCalls?.push({ method, args: [] });
        const ids: string[] = [];
        queueWindow.__queue = ((queueWindow.__queue ?? []) as Entry[]).map((entry) => {
          if (!states.includes(entry.state ?? "")) return entry;
          ids.push(entry.id ?? "");
          return { ...entry, state: "pending", error: "" };
        });
        return { ok: true, value: { item_ids: ids, count: ids.length } } as never;
      };
      client.retryAllItems = requeue("retryAllItems", ["failed", "cancelled"]);
      client.resumeExports = requeue("resumeExports", ["paused"]);
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
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" }).locator(".c-reason")).toHaveText("Encoder stopped unexpectedly");
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
  await page.getByRole("button", { name: "Clear finished", exact: true }).click();
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

const calls = (page: Page, method: string): Promise<number> =>
  page.evaluate((name) => window.__tuckFakeBackendCalls?.filter((call) => call.method === name).length ?? 0, method);

test("Retry all sends every failed and canceled export back in order, and focus follows the first", async ({ page }) => {
  await open(page, fixtureFor([A, B, C]), 3);
  await setQueue(page, [item("a", A, "running", { progress: 10 }), item("b", B, "pending"), item("c", C, "pending")]);
  await expect(page.locator("#qbar")).toBeVisible();
  // Stop after this cancels what waits; each canceled export would otherwise need its own Retry
  await setQueue(page, [
    item("a", A, "completed", { result_path: "C:\\videos\\Alpha_small.mp4" }),
    item("b", B, "cancelled"),
    item("c", C, "failed", { error: "Disk is full" }),
  ]);
  await page.locator(".toast", { hasText: "1 of 3 exports failed." }).getByRole("button", { name: "Dismiss notification" }).click();
  await page.locator("#qstatus").click();
  const retryAll = page.getByRole("button", { name: "Retry all (2)" });
  await expect(retryAll).toBeVisible();
  await retryAll.focus();
  await page.keyboard.press("Enter");

  await expect.poll(() => calls(page, "retryAllItems")).toBe(1);
  await expect(page.locator("#btn-retry-all")).toBeHidden();
  await expect(page.locator(".exports-row.waiting")).toHaveText([/Bravo\.mp4/, /Charlie\.mp4/]);
  // the button went away with its exports, so focus moves to the first one it sent back
  await expect(page.getByRole("button", { name: "Cancel Bravo.mp4" })).toBeFocused();
  expect(await calls(page, "retryItem")).toBe(0);
});

test("Clear finished takes completed and canceled exports and leaves failed ones to retry", async ({ page }) => {
  await open(page, fixtureFor([A, B, C]), 3);
  await setQueue(page, [item("a", A, "running", { progress: 10 }), item("b", B, "pending"), item("c", C, "pending")]);
  await expect(page.locator("#qbar")).toBeVisible();
  await setQueue(page, [
    item("a", A, "completed", { result_path: "C:\\videos\\Alpha_small.mp4" }),
    item("b", B, "cancelled"),
    item("c", C, "failed", { error: "Disk is full" }),
  ]);
  await page.locator(".toast", { hasText: "1 of 3 exports failed." }).getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" })).toHaveAttribute("data-queue-state", "cancelled");
  await page.locator("#qstatus").click();
  const clear = page.getByRole("button", { name: "Clear finished", exact: true });
  await clear.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".toast", { hasText: "Cleared 2 finished exports." })).toBeVisible();
  await expect(page.locator(".exports-row")).toHaveCount(1);
  await expect(page.locator(".exports-row.failed")).toContainText("Charlie.mp4");
  await expect(clear).toBeDisabled();
  // focus lands on what is left rather than on the page
  await expect(page.getByRole("button", { name: "Retry Charlie.mp4" })).toBeFocused();
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" })).toHaveAttribute("data-queue-state", "ready");
  await expect(page.locator(".clip")).toHaveCount(3);
});

test("exports from before Tuck closed come back paused with one Resume and no dialog", async ({ page }) => {
  // the Library holds a fresh copy of Alpha; the restored export of it must not speak for it
  await open(page, fixtureFor([A]), 1);
  await setQueue(page, [
    item("old-a", A, "paused", { restored: true }),
    item("old-b", B, "paused", { restored: true }),
    item("old-c", C, "failed", {
      restored: true,
      error: "Tuck can't find this video any more. It may have been moved, renamed or deleted.",
    }),
  ]);
  await expect(page.locator("#qfname")).toHaveText("2 exports paused");
  await expect(page.locator("#qbar")).not.toHaveClass(/finished/);
  await expect(page.locator("#qbar .good")).toHaveCount(0);
  await expect(page.locator("#qactions").getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page.locator("[role=dialog]:visible")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.locator(".clip", { hasText: "Alpha.mp4" })).toHaveAttribute("data-queue-state", "ready");

  await page.locator("#qstatus").click();
  await expect(page.locator(".exports-group-paused")).toContainText("Paused when Tuck closed");
  await expect(page.locator(".exports-row.paused")).toHaveCount(2);
  await expect(page.locator(".exports-row.failed")).toContainText("Tuck can't find this video any more.");
  await expect(page.getByRole("button", { name: "Retry all (1)" })).toBeVisible();
  const resume = page.getByRole("button", { name: "Resume 2 paused exports" });
  await resume.focus();
  await page.keyboard.press("Enter");

  await expect.poll(() => calls(page, "resumeExports")).toBe(1);
  await expect(page.locator(".exports-group-paused")).toHaveCount(0);
  await expect(page.locator(".exports-row.waiting")).toHaveText([/Alpha\.mp4/, /Bravo\.mp4/]);
  await expect(page.getByRole("button", { name: "Cancel Alpha.mp4" })).toBeFocused();
  // still apart from the Library video with the same file
  await expect(page.locator(".clip", { hasText: "Alpha.mp4" })).toHaveAttribute("data-queue-state", "ready");
});

test("a paused export can leave the list on its own, and the rest stay paused", async ({ page }) => {
  await open(page, fixtureFor([A]), 1);
  await setQueue(page, [item("old-a", A, "paused", { restored: true }), item("old-b", B, "paused", { restored: true })]);
  await page.evaluate(() => {
    const queueWindow = window as unknown as { __queue?: { id?: string }[] };
    const client = window.tuckBackendClient;
    if (!client) return;
    client.removeItem = async (id: string) => {
      queueWindow.__queue = (queueWindow.__queue ?? []).filter((entry) => entry.id !== id);
      return { ok: true, value: {} } as never;
    };
  });
  await page.locator("#qstatus").click();
  await page.getByRole("button", { name: "Remove Alpha.mp4 from Exports" }).click();
  await expect(page.locator(".exports-row.paused")).toHaveCount(1);
  await expect(page.locator("#qfname")).toHaveText("1 export paused");
  await expect(page.getByRole("button", { name: "Resume 1 paused export" })).toBeVisible();
});

test("a resumed export from before Tuck closed never takes a Library video with it", async ({ page }) => {
  const fixture = fixtureFor([A, B]);
  fixture.responses.getSettings = { ...(fixture.responses.getSettings as object), remove_after_export: true };
  await open(page, fixture, 2);
  // resumed, so it waits in the same batch as Bravo's export
  await setQueue(page, [item("old-a", A, "pending", { restored: true }), item("b", B, "running", { progress: 5 })]);
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" })).toHaveAttribute("data-queue-state", "running");
  await setQueue(page, [
    item("old-a", A, "completed", { restored: true, result_path: "C:\\videos\\Alpha_tucked.mp4" }),
    item("b", B, "completed", { result_path: "C:\\videos\\Bravo_tucked.mp4" }),
  ]);
  // Bravo's own export finished, so it leaves; Alpha's export came from edits that are gone
  await expect(page.locator(".clip")).toHaveCount(1);
  await expect(page.locator(".clip", { hasText: "Alpha.mp4" })).toHaveAttribute("data-queue-state", "ready");
});
