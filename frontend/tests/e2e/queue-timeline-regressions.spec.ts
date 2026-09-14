import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

test.beforeEach(async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: ["C:\\media\\clip.mp4"] };
  fixture.responses.pickAudioFiles = { ok: true, files: ["C:\\media\\music.wav"] };
  fixture.responseSequences = { pickAudioFiles: [
    { ok: true, files: ["C:\\media\\music.wav"] },
    { ok: true, files: ["C:\\media\\voice.wav"] },
  ] };
  fixture.responses.probeFile = { ok: true, data: { path: "/mnt/exchange/clip.mp4", duration: 12, file_size: 1048576, width: 1920, height: 1080, fps: 30, has_audio: true } };
  fixture.responses.probeAudioFile = { ok: true, data: { duration: 20, channels: 2, sample_rate: 48000 } };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.holdMethods = ["getQueueState"];
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.clock.install();
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
});

test("queue errors preserve the last successful queue display", async ({ page }) => {
  const release = async (value: unknown) => page.evaluate((response) => {
    (window as Window & { __tuckReleaseHeld?: (method: string, value: unknown) => void }).__tuckReleaseHeld?.("getQueueState", response);
  }, value);
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0)).toBeGreaterThan(0);
  const count = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0);
  await release({ ok: true, items: [{ id: "done", state: "completed", progress: 100 }] });
  await expect(page.locator("#qbar")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0)).toBeGreaterThan(count);
  await release({ ok: false, error: "Temporary backend error" });
  await page.screenshot({ path: "build/queue-error-after.png" });
  await expect(page.locator("#qbar")).toBeVisible();
});

test("track actions align and automatic height fits added and removed tracks", async ({ page }) => {
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Add audio", exact: true }).click();
    await expect(page.locator("#imported-audio-tracks .seq-row")).toHaveCount(i + 1);
  }
  await expect(page.locator("#imported-audio-tracks .seq-row")).toHaveCount(2);
  await page.screenshot({ path: "build/timeline-after.png" });
  const source = await page.locator("#source-audio-track .seq-track-mute").boundingBox();
  const imported = await page.locator("#imported-audio-tracks .seq-track-mute").first().boundingBox();
  expect.soft(source && imported && Math.abs(source.x - imported.x)).toBeLessThan(1);
  const overflow = () => page.locator("#sequence-frame").evaluate(el => el.scrollHeight - el.clientHeight);
  expect.soft(await overflow()).toBeLessThanOrEqual(1);
  await page.locator("#imported-audio-tracks .seq-track-remove").last().click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator("#imported-audio-tracks .seq-row")).toHaveCount(1);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "build/timeline-compact-after.png" });
  await page.locator("#imported-audio-tracks .seq-track-mute").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#imported-audio-tracks .seq-track-mute")).toHaveAttribute("aria-pressed", "true");
});

test("queue polling waits for the current request to finish", async ({ page }) => {
  await page.clock.fastForward(2500);
  const count = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0);
  expect(count).toBe(1);
});

test("running queue snapshots update progress and ETA throughout an export", async ({ page }) => {
  for (const [index, progress] of [0, 25, 60, 95].entries()) {
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0)).toBeGreaterThan(index);
    await page.evaluate((percent) => {
      (window as Window & { __tuckReleaseHeld?: (method: string, value: unknown) => void }).__tuckReleaseHeld?.("getQueueState", {
        ok: true,
        items: [{ id: "running", source: "clip.mp4", source_path: "C:\\media\\clip.mp4", state: "running", progress: percent, status_text: "Pass 1 of 2", progress_info: { speed: 1.2, eta_seconds: 100 - percent } }],
      });
    }, progress);
    await expect(page.locator("#qprog")).toHaveAttribute("value", String(progress));
  }
  await expect(page.locator("#qeta")).toHaveText("ETA 00:05");
  await page.screenshot({ path: "build/queue-progress.png" });
});

test("Library matches queue items to the resolved probe path", async ({ page }) => {
  for (const [index, state] of ["running", "completed"].entries()) {
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0)).toBeGreaterThan(index);
    await page.evaluate((state) => {
      (window as Window & { __tuckReleaseHeld?: (method: string, value: unknown) => void }).__tuckReleaseHeld?.("getQueueState", {
        ok: true, items: [{ id: "resolved", source_path: "/mnt/exchange/clip.mp4", state, progress: state === "running" ? 35 : 100, result_path: "/mnt/exchange/export.mp4", status_text: state === "running" ? "Encoding" : "Completed" }],
      });
    }, state);
    await expect(page.locator("#clips")).toContainText(state === "running" ? "Encoding" : "Completed");
  }
  await expect(page.locator("#clips").getByRole("button", { name: "Show", exact: true })).toBeVisible();
});

test("hovered completed cards survive unchanged queue polls", async ({ page }) => {
  for (let index = 0; index < 4; index++) {
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c => c.method === "getQueueState").length ?? 0)).toBeGreaterThan(index);
    await page.evaluate(() => {
      (window as Window & { __tuckReleaseHeld?: (method: string, value: unknown) => void }).__tuckReleaseHeld?.("getQueueState", {
        ok: true, items: [{ id: "finished", source_path: "/mnt/exchange/clip.mp4", state: "completed", progress: 100, result_path: "/mnt/exchange/export.mp4" }],
      });
    });
    const show = page.locator("#clips").getByRole("button", { name: "Show", exact: true });
    await expect(show).toBeVisible();
    if (index === 0) {
      await show.hover();
      await show.focus();
      await show.evaluate(el => el.setAttribute("data-retained-node", "true"));
    } else {
      await expect(show).toHaveAttribute("data-retained-node", "true");
      await expect(show).toBeFocused();
    }
  }
});
