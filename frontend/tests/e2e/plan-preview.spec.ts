import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Estimate.mp4";

function planCalls(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (window.__tuckFakeBackendCalls ?? [])
      .filter((call) => call.method === "createPlan")
      .map((call) => call.args[0] as Record<string, unknown>),
  );
}

// answers held plans in the order they were asked, each with its own request id
async function answerPlans(page: Page, requests: Array<Record<string, unknown>>, target: number, estimate: number): Promise<void> {
  await page.evaluate(({ requests, target, estimate }) => {
    for (const request of requests) {
      window.__tuckReleaseHeld?.("createPlan", {
        ok: true,
        _request_id: request._request_id,
        data: { workflow: "compression", video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12,
          target_size_mb: target, estimated_size_mb: estimate },
      });
    }
  }, { requests, target, estimate });
  // held answers resolve as promise jobs, which all run before the next frame
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

test("a plan answered after the settings changed never shows its estimate", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 1_048_576 },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/estimate", token: "estimate" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.holdMethods = ["createPlan"];
  await page.route("https://media.test/**", (route) => route.abort());
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  const row = page.locator(".clip").filter({ hasText: "Estimate.mp4" });
  await expect(row).toBeVisible();

  await expect.poll(async () => (await planCalls(page)).length).toBeGreaterThan(0);
  const stale = await planCalls(page);
  await page.locator("#sz-badge").fill("50");
  await page.locator("#sz-badge").dispatchEvent("change");
  await expect.poll(async () => (await planCalls(page)).length).toBeGreaterThan(stale.length);
  const fresh = (await planCalls(page)).slice(stale.length);
  expect(fresh.every((request) => request.target_size_bytes === 52_428_800)).toBe(true);

  await answerPlans(page, stale, 10, 9.5);
  await expect(row.locator(".c-to")).toHaveCount(0);

  await answerPlans(page, fresh, 50, 48);
  await expect(row.locator(".c-to")).toHaveText("48.0 MB");
});

test("while new settings are planned the row keeps a placeholder, and a slider drag asks once", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 1_048_576 },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/estimate", token: "estimate" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.holdMethods = ["createPlan"];
  await page.route("https://media.test/**", (route) => route.abort());
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  const row = page.locator(".clip").filter({ hasText: "Estimate.mp4" });

  await expect.poll(async () => (await planCalls(page)).length).toBeGreaterThan(0);
  await answerPlans(page, await planCalls(page), 10, 9.5);
  await expect(row.locator(".c-to")).toHaveText("9.5 MB");

  // twenty values in quick succession, as a drag sends them, become one plan request
  const before = (await planCalls(page)).length;
  await page.locator("#sz-slider").evaluate((slider: HTMLInputElement) => {
    for (let value = 20; value <= 39; value += 1) {
      slider.value = String(value);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect.poll(async () => (await planCalls(page)).length).toBe(before + 1);
  await page.waitForTimeout(300);
  expect((await planCalls(page)).length).toBe(before + 1);

  // the old estimate is gone, but the row keeps its place for the new one
  await expect(row.locator(".c-to")).toHaveCount(0);
  await expect(row.locator(".c-pending")).toHaveText("…");
  await answerPlans(page, (await planCalls(page)).slice(before), 39, 37);
  await expect(row.locator(".c-to")).toHaveText("37.0 MB");
  await expect(row.locator(".c-pending")).toHaveCount(0);
});
