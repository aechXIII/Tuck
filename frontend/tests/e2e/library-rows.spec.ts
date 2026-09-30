import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const BEACH = "C:\\videos\\Beach day.mp4";
const TRAIL = "C:\\videos\\Trail run.mp4";
const BROKEN = "C:\\videos\\Broken.mp4";
const PICTURE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function probe(width: number, height: number, size: number) {
  return { ok: true, data: { duration: 182, width, height, fps: 30, has_audio: true, file_size: size } };
}

async function open(page: Page) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = [BEACH, TRAIL, BROKEN];
  fixture.responseSequences = { probeFile: [probe(1920, 1080, 1_288_490_189), probe(2704, 1520, 1_210_000_000), { ok: false, error: "moov atom not found" }] };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  // Lossless cut reads keyframes; the real client only passes a complete analysis on
  const time = (seconds: number) => ({ ticks: String(seconds * 10), time_base_num: 1, time_base_den: 10 });
  const analysis = { work_id: "scan", status: "ready", progress: 1, coverage_end: time(182), keyframes: [time(0), time(60), time(120)], issue: null,
    analysis: { duration: time(182), frame_duration: { ticks: "1", time_base_num: 1, time_base_den: 30 }, exact_available: false, exact_reason: "", issues: [], version: "1", streams: [] } };
  fixture.responses.getCutAnalysis = analysis;
  fixture.responses.analyzeCut = analysis;
  // plans answer by hand, so each can echo its request and carry the task's numbers
  fixture.holdMethods = ["createPlan"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(3);
}

let released = 0;
async function answerPlans(page: Page, data: Record<string, unknown>): Promise<void> {
  const pending = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan").map((call) => call.args[0]));
  await page.evaluate(({ requests, data }) => {
    for (const request of requests) {
      window.__tuckReleaseHeld?.("createPlan", { ok: true, _request_id: (request as Record<string, unknown>)._request_id, data });
    }
  }, { requests: pending.slice(released), data });
  released = pending.length;
}

const row = (page: Page, name: string) => page.locator(".clip").filter({ hasText: name });

test.beforeEach(() => {
  released = 0;
});

test("each readable video gets its own picture and length; an unreadable one gets neither", async ({ page }) => {
  await open(page);
  await expect(row(page, "Beach day.mp4").locator(".c-thumb img")).toHaveAttribute("src", PICTURE);
  await expect(row(page, "Trail run.mp4").locator(".c-thumb img")).toHaveAttribute("src", PICTURE);
  await expect(row(page, "Beach day.mp4").locator(".c-dur")).toHaveText("3:02");
  await expect(row(page, "Broken.mp4").locator(".c-thumb")).toHaveClass(/unreadable/);
  await expect(row(page, "Broken.mp4").locator(".c-thumb img")).toHaveCount(0);
  // the player may ask again for the selected video; nobody asks for the unreadable one
  const asked = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getThumbnail").map((call) => call.args[0]));
  expect([...new Set(asked)].sort()).toEqual([BEACH, TRAIL].sort());
});

test("the second line says what each task makes of every video", async ({ page }) => {
  await open(page);
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan").length)).toBeGreaterThan(0);
  await answerPlans(page, { workflow: "compression", estimated_size_mb: 9.6, target_size_mb: 10, target_width: 1920, target_height: 1080, segment_count: 1, selected_duration: 182 });
  await answerPlans(page, { workflow: "compression", estimated_size_mb: 9.6, target_size_mb: 10, target_width: 1920, target_height: 1080, segment_count: 1, selected_duration: 182 });
  await expect(row(page, "Beach day.mp4").locator(".c-line")).toHaveText("1.2 GB→9.6 MB");
  await expect(row(page, "Trail run.mp4").locator(".c-line")).toHaveText("1.1 GB→9.6 MB");
  await expect(row(page, "Broken.mp4").locator(".c-line")).toContainText("Can't read file");

  // Lossless cut reads the kept length from the timeline, with no plan needed
  await page.locator("#wf-l").click();
  await expect(row(page, "Beach day.mp4").locator(".c-line")).toHaveText("Whole video");

  await page.locator("#wf-u").click();
  await expect(row(page, "Beach day.mp4").locator(".c-line")).toHaveText("1080p");
  await expect.poll(async () => {
    await answerPlans(page, { workflow: "upscale", target_width: 3840, target_height: 2160, segment_count: 1, selected_duration: 182 });
    return row(page, "Trail run.mp4").locator(".c-line").textContent();
  }).toBe("2704×1520→4K");
  await expect(row(page, "Beach day.mp4").locator(".c-line")).toHaveText("1080p→4K");
});
