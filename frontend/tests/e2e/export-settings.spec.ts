import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Clip one.mp4";

function probeData(overrides: Record<string, unknown> = {}) {
  return {
    duration: 12,
    file_size: 1_048_576,
    height: 1080,
    width: 1920,
    fps: 30,
    has_audio: true,
    format: "mp4",
    video_codec: "h264",
    audio_codec: "aac",
    ...overrides,
  };
}

function exportFixture(): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = { ok: true, data: probeData() };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/v", token: "t" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "data:image/png;base64,aaa" };
  fixture.responses.createPlan = {
    ok: true,
    data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 },
  };
  fixture.responses.enqueueWithOptions = { ok: true };
  return fixture;
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function addVideo(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.getByRole("button", { name: "Compress selected" })).toBeEnabled();
}

async function calls(page: Page, method: string): Promise<Array<{ args: readonly unknown[] }>> {
  return page.evaluate(
    (name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name),
    method,
  );
}

test("compress selected builds a typed plan request from the export form", async ({ page }) => {
  const errors = pageErrors(page);
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, exportFixture());
  await page.goto("/");
  await addVideo(page);

  await page.getByRole("button", { name: "Compress selected" }).click();

  await expect.poll(async () => (await calls(page, "enqueueWithOptions")).length).toBe(1);
  const [enqueue] = await calls(page, "enqueueWithOptions");
  const request = enqueue!.args[0] as Record<string, unknown>;
  expect(request).toMatchObject({
    source: VIDEO,
    workflow: "compression",
    rate_control: "target_size",
    resolution_mode: "source",
    fps_mode: "source",
    keep_audio: false,
    video_encoder: "auto_compression",
    target_size_bytes: 10 * 1024 * 1024,
    audio_bitrate: 128000,
  });
  expect(request._request_id).toBeUndefined();
  expect(errors).toEqual([]);
});

test("a rejected enqueue surfaces the backend error without an unhandled failure", async ({
  page,
}) => {
  const errors = pageErrors(page);
  const fixture = exportFixture();
  fixture.responses.enqueueWithOptions = { ok: false, error: "Queue is full right now" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await addVideo(page);

  await page.getByRole("button", { name: "Compress selected" }).click();

  await expect(page.getByRole("alert")).toContainText("Queue is full right now");
  await expect(page.getByRole("button", { name: "Compress selected" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("shared export changes clear outdated Library size estimates", async ({ page }) => {
  const fixture = exportFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO, "C:\\media\\Clip two.mp4"] };
  fixture.holdMethods = ["createPlan"];
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  let released = 0;
  async function finishPlans(): Promise<void> {
    await expect.poll(async () => (await calls(page, "createPlan")).length).toBeGreaterThan(released);
    const pending = await calls(page, "createPlan");
    await page.evaluate((requests) => {
      const release = (window as Window & {
        __tuckReleaseHeld?: (method: string, value: unknown) => void;
      }).__tuckReleaseHeld;
      if (!release) throw new Error("The plan fixture is not installed");
      for (const call of requests) {
        const request = call.args[0] as Record<string, unknown>;
        release("createPlan", {
          ok: true,
          _request_id: request._request_id,
          data: {
            workflow: "compression", video_bitrate_kbps: 1200,
            segment_count: 1, selected_duration: 12,
            target_size_mb: request.target_size_bytes === 52_428_800 ? 50 : 10,
            estimated_size_mb: request.target_size_bytes === 52_428_800 ? 48 : 9.5,
          },
        });
      }
    }, pending.slice(released));
    released = pending.length;
  }
  await page.goto("/");
  await addVideo(page);
  const first = page.locator(".clip").filter({ hasText: "Clip one.mp4" });
  const second = page.locator(".clip").filter({ hasText: "Clip two.mp4" });
  await first.click();
  await finishPlans();
  await expect(first.locator(".c-proj")).toHaveText("→ 9.5 MB");
  await second.click();
  await finishPlans();
  await expect(second.locator(".c-proj")).toHaveText("→ 9.5 MB");
  await expect(first.locator(".c-proj")).toBeVisible();
  await page.locator("#sz-badge").fill("50");
  await page.locator("#sz-badge").dispatchEvent("change");
  await finishPlans();
  await expect(second.locator(".c-proj")).toHaveText("→ 48.0 MB");
  await expect(first.locator(".c-proj")).toHaveCount(0);
  await first.click();
  await finishPlans();
  await expect(first.locator(".c-proj")).toHaveText("→ 48.0 MB");
});

test("the size panel shows only the chosen target, never a fabricated estimate", async ({
  page,
}) => {
  const fixture = exportFixture();
  // the real backend's estimate can land anywhere relative to the target
  // (it's a bitrate budget, not a measured result) — the panel must never
  // present that number as if it were the actual output size
  fixture.responses.createPlan = {
    ok: true,
    data: {
      video_bitrate_kbps: 6000,
      estimated_size_mb: 340,
      target_size_mb: 10,
      segment_count: 1,
      selected_duration: 12,
    },
  };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#sz-badge")).toHaveValue("10");

  await addVideo(page);
  await expect(page.locator("#sz-of")).toHaveCount(0);
  await expect(page.locator("#sz-meter")).toHaveCount(0);
  await expect(page.locator("#calc-br")).toHaveCount(0);
  // the plan response's wildly different estimate must never overwrite this
  await expect(page.locator("#sz-badge")).toHaveValue("10");

  await page.locator("#sz-badge").fill("50");
  await page.locator("#sz-badge").dispatchEvent("change");
  await expect(page.locator("#sz-badge")).toHaveValue("50");
});

test("a running job drives the queue bar count, progress, eta, and controls", async ({ page }) => {
  const fixture = exportFixture();
  fixture.queueStateAfterEnqueue = {
    items: [
      {
        id: "job-1",
        source: "Clip one.mp4",
        source_path: VIDEO,
        state: "running",
        progress: 40,
        progress_info: { eta_seconds: 12 },
        segment_count: 1,
        duration: 12,
      },
    ],
  };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await addVideo(page);

  await page.getByRole("button", { name: "Compress selected" }).click();
  await expect(page.locator("#qbar")).toBeVisible();
  await expect(page.locator("#qprog")).toHaveAttribute("value", "40");
  await expect(page.locator("#qcnt")).toHaveText("1/1");
  await expect(page.locator("#qeta")).toContainText("ETA 00:12");
  await expect(page.locator("#qfname")).toContainText("Clip one.mp4");
  await expect(page.getByRole("button", { name: "Cancel processing" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop after current job" })).toBeEnabled();
});

test("stop-after-current failure keeps the queue controls usable", async ({ page }) => {
  const fixture = exportFixture();
  fixture.queueStateAfterEnqueue = {
    items: [
      {
        id: "job-1",
        source: "Clip one.mp4",
        source_path: VIDEO,
        state: "running",
        progress: 20,
        segment_count: 1,
      },
    ],
  };
  fixture.responses.stopAfterCurrent = { ok: false, error: "Runner already stopping" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await addVideo(page);
  await page.getByRole("button", { name: "Compress selected" }).click();

  const stop = page.getByRole("button", { name: "Stop after current job" });
  await expect(stop).toBeEnabled();
  await stop.click();
  await page.locator("#confirm-accept").click();
  await expect(page.getByRole("alert")).toContainText("Runner already stopping");
  await expect(stop).toBeEnabled();
});

test("profile manager renders an untrusted profile name as inert text", async ({ page }) => {
  const errors = pageErrors(page);
  const hostile = '<img src=x onerror="globalThis.__tuckProfilePwned=true">';
  const fixture = exportFixture();
  fixture.responses.getProfilesJson = [
    {
      profile_id: "p1",
      name: hostile,
      workflow: "compression",
      target_size_bytes: 10 * 1024 * 1024,
      resolution_mode: "source",
      fps_mode: "source",
    },
  ];
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-nav-profiles").click();
  await expect(page.locator("#pm-list")).toContainText(hostile);
  await expect(page.locator("#pm-list img")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "__tuckProfilePwned"))).toBeUndefined();
  expect(errors).toEqual([]);
});

test("failed profile import reports the backend error", async ({ page }) => {
  const fixture = exportFixture();
  fixture.responses.pickImportFile = { ok: true, path: "C:\\profiles.json" };
  fixture.responses.importProfilesFromFile = { ok: false, error: "File is not valid JSON" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-nav-profiles").click();
  await page.locator("#settings-actions").getByRole("button", { name: "Import" }).click();
  await expect(page.getByRole("alert")).toContainText("File is not valid JSON");
});

test("the update check renders release notes as plain text", async ({ page }) => {
  const fixture = exportFixture();
  fixture.responses.getSettings = {
    ...(healthyBackendFixture().responses.getSettings as Record<string, unknown>),
    version: "0.4.0",
  };
  fixture.responses.checkForUpdates = {
    ok: true,
    available: true,
    version: "0.5.0",
    size_mb: 12.5,
    notes: "## Highlights\n- Fixed **the crash** and a [tracked issue](https://example.test)\n- Faster startup",
  };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-nav-system").click();
  await page.locator("#settings-page").getByRole("button", { name: "Check now" }).click();

  const notes = page.locator("#update-notes");
  await expect(notes).toContainText("Fixed the crash and a tracked issue");
  await expect(notes.locator("a")).toHaveCount(0);
  await expect(notes.locator("strong")).toHaveCount(0);
  await expect(page.locator("#update-version")).toHaveText("v0.5.0");
});

test("update check failures fall back to a visible error toast", async ({ page }) => {
  const fixture = exportFixture();
  fixture.responses.checkForUpdates = { ok: true, available: false, error: "GitHub unreachable" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-nav-system").click();
  await page.locator("#settings-page").getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("alert")).toContainText("Update check failed: GitHub unreachable");
});

test("the settings dialog traps Tab focus inside the dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, exportFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 25; i += 1) await page.keyboard.press("Tab");
  const focusInside = await page.evaluate(() => {
    const dialogEl = document.querySelector(".settings-dialog");
    return !!dialogEl && dialogEl.contains(document.activeElement);
  });
  expect(focusInside).toBe(true);
});

test("the editor still renders when settings fail to load at startup", async ({ page }) => {
  const errors = pageErrors(page);
  const fixture = exportFixture();
  fixture.responses.getSettings = { ok: false, error: "settings backend offline" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Add videos" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("target size edits inline and stays in sync with presets and slider", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, exportFixture());
  await page.goto("/");
  await addVideo(page);
  const size = page.locator("#sz-badge");
  expect(await size.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(24);
  await size.fill("75");
  await size.press("Enter");
  await expect(page.locator("#sz-slider")).toHaveValue("75");
  await size.fill("99");
  await size.press("Escape");
  await expect(size).toHaveValue("75");
  await size.fill("1200");
  await size.press("Tab");
  await expect(page.locator("#sz-slider")).toHaveValue("1200");
  await page.locator("#sz-presets").getByRole("button", { name: "200 MB", exact: true }).click();
  await expect(size).toHaveValue("200");
  await size.fill("1");
  await size.press("Enter");
  await expect(size).toHaveValue("200");
});

test("Inspector content keeps its right edge aligned while resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, exportFixture());
  await page.goto("/");
  await addVideo(page);
  const edge = async (selector: string) => page.locator(selector).evaluate(el => el.getBoundingClientRect().right);
  expect(Math.abs(await edge("#sz-grp") - await edge("#panel-toggle-inspector"))).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(page.locator("#panel-toggle-inspector")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#panel-toggle-inspector").click();
  await page.locator("#insp-tab-export").click();
  for (const height of [640, 700, 780, 900, 1100, 780, 640]) {
    await page.setViewportSize({ width: 960, height });
    if (await page.locator("#panel-toggle-inspector").getAttribute("aria-expanded") === "false") {
      await page.locator("#panel-toggle-inspector").click();
    }
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    });
    const widths = await page.locator("#right-scroll").evaluate(async el => {
      const values: number[] = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        values.push(el.clientWidth);
      }
      return values;
    });
    expect(new Set(widths.slice(4)).size).toBe(1);
    expect(Math.abs(await edge("#sz-grp") - await edge("#panel-toggle-inspector"))).toBeLessThanOrEqual(1);
  }
});
