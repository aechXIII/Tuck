import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const RESULT = "C:\\videos\\録画 #1_small.mp4";

async function open(page: Page, options: { hold?: boolean; error?: boolean; width?: number } = {}) {
  await page.setViewportSize({ width: options.width ?? 1240, height: options.width === 960 ? 640 : 800 });
  const fixture = healthyBackendFixture();
  fixture.responses.getQueueState = { items: [
    { id: "done", source: "Recording with a longer filename.mp4", state: "completed", result_path: RESULT, duration: 12, result_size: 9_000_000 },
    { id: "failed", source: "Failed.mp4", state: "failed", error: "Encoder failed" },
    { id: "no-path", source: "No output.mp4", state: "completed" },
  ] };
  if (options.hold) fixture.holdMethods = ["copyFile"];
  if (options.error) fixture.responseSequences = { copyFile: [{ ok: false, error: "The exported file no longer exists." }, { ok: true }] };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#qstatus").click();
  await expect(page.locator("#exports-panel")).toBeVisible();
}

test("copy waits for native confirmation, preserves focus and ignores repeated presses", async ({ page }) => {
  await open(page, { hold: true });
  const copy = page.getByRole("button", { name: "Copy file for Recording with a longer filename.mp4", exact: true });
  await copy.press("Enter");
  await expect(copy).toHaveText("Copying...");
  await expect(copy).toHaveAttribute("aria-disabled", "true");
  await expect(copy).toBeFocused();
  await copy.press("Enter");
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "copyFile"))).toEqual([
    { method: "copyFile", args: [RESULT] },
  ]);
  await expect(page.locator(".toast", { hasText: "File copied" })).toHaveCount(0);
  await page.evaluate(() => {
    const release = Reflect.get(window, "__tuckReleaseHeld");
    if (typeof release !== "function") throw new Error("Held backend request is unavailable");
    release("copyFile", { ok: true });
  });
  await expect(copy).toHaveText("Copied");
  await expect(copy).not.toHaveAttribute("aria-disabled", "true");
  await expect(copy).toBeFocused();
  await expect(page.locator(".toast", { hasText: "File copied to clipboard." })).toBeVisible();
  await page.getByRole("button", { name: "Show Recording with a longer filename.mp4", exact: true }).click();
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "openOutputFolder").at(-1)?.args)).toEqual([RESULT]);
});

test("copy failures remain in the row after the toast and allow retry", async ({ page }) => {
  await open(page, { error: true });
  const row = page.locator('[data-export-id="done"]');
  const copy = row.getByRole("button", { name: /^Copy file for/ });
  await copy.click();
  await expect(row.locator(".exports-copy-error")).toContainText("The exported file no longer exists.");
  await expect(copy).toHaveText("Copy file");
  await expect(copy).not.toHaveAttribute("aria-disabled", "true");
  await expect(row.getByRole("button", { name: /^Show / })).toBeEnabled();
  await page.locator(".toast", { hasText: "The exported file no longer exists." }).getByRole("button", { name: "Dismiss notification" }).click();
  if (!await page.locator("#exports-panel").isVisible()) await page.locator("#qstatus").click();
  await expect(row.locator(".exports-copy-error")).toBeVisible();
  await copy.press("Enter");
  await expect(copy).toHaveText("Copied");
  await expect(row.locator(".exports-copy-error")).toHaveCount(0);
});

for (const width of [1240, 960]) {
  test(`completed export actions fit at ${width}px and unavailable outputs cannot be copied`, async ({ page }) => {
    await open(page, { width });
    await expect(page.locator('[data-export-id="failed"] button', { hasText: "Copy file" })).toHaveCount(0);
    await expect(page.locator('[data-export-id="no-path"] button', { hasText: "Copy file" })).toHaveCount(0);
    const actions = page.locator('[data-export-id="done"] .exports-actions');
    await expect(actions).toBeVisible();
    // polling redraws the list while it is open, so measure the row that is there now
    await expect.poll(() => page.evaluate(() => {
      const panel = document.getElementById("exports-panel")!.getBoundingClientRect();
      const box = document.querySelector('[data-export-id="done"] .exports-actions')!.getBoundingClientRect();
      return box.width > 0 && box.left >= panel.left && box.right <= panel.right;
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#qstatus")).toBeFocused();
  });
}
