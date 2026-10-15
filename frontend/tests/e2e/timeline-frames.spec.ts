import { expect, test, type Page } from "@playwright/test";
import {
  healthyBackendFixture,
  installFakeBackend,
} from "../fixtures/fake-backend";
import type { JsonObject } from "../../src/backend/types.ts";

const spriteUrl = "http://127.0.0.1:4173/timeline-test-sprite.svg";
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="84">${Array.from({ length: 16 }, (_, i) => `<rect x="${i * 150}" width="150" height="84" fill="${i % 2 ? "#ece5d8" : "#303a48"}"/><circle cx="${i * 150 + 75}" cy="42" r="19" fill="${i % 2 ? "#5f6b7a" : "#c6beb0"}"/>`).join("")}</svg>`;

async function open(
  page: Page,
  options: {
    hold?: boolean;
    enabled?: boolean;
    error?: boolean;
    width?: number;
    cut?: boolean;
    style?: "graphite" | "violet";
  } = {},
) {
  await page.setViewportSize({
    width: options.width ?? 1240,
    height: options.width === 960 ? 640 : 800,
  });
  await page.route(spriteUrl, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: sprite }),
  );
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Alpha.mp4"];
  fixture.timelineSprites = { url: spriteUrl, token: "frames-a" };
  fixture.responses.getSettings = {
    ...(fixture.responses.getSettings as Record<string, unknown>),
    timeline_frames: options.enabled !== false,
    timeline_frame_mode: "center",
    timeline_style: options.style ?? "graphite",
    last_task: options.cut ? "cut" : "compression",
  };
  fixture.responses.probeFile = {
    data: {
      duration: 20,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      file_size: 1000000,
    },
  };
  if (options.cut) {
    const time = (seconds: number) => ({ ticks: String(seconds * 100), time_base_num: 1, time_base_den: 100 });
    const analysis = {
      work_id: "scan", status: "ready", progress: 1, coverage_end: time(20),
      keyframes: Array.from({ length: 80 }, (_, index) => time(index / 4)), issue: null,
      analysis: { duration: time(20), frame_duration: { ticks: "1", time_base_num: 1, time_base_den: 30 },
        exact_available: false, exact_reason: "Exact cutting is not available yet.", issues: [], version: "1", streams: [] },
    };
    fixture.responses.getCutAnalysis = analysis;
    fixture.responses.analyzeCut = analysis;
    fixture.responses.createPlan = { data: {
      operation: "cut", precision: "keyframes", container: "mp4", include_audio: true,
      output_path: "C:\\videos\\Alpha_cut.mp4", exported_duration: time(20), estimated_bytes: 1000000,
      fingerprint: "a".repeat(64), issues: [], exact_available: false,
      exact_reason: analysis.analysis.exact_reason, unverified: [], tracks: [], chapter_count: 0,
      source_identity: { path: "C:\\videos\\Alpha.mp4", size: 1000000, mtime_ns: "1", signature: "b".repeat(64) },
      segments: [{ requested: { start: time(0), end: time(20) }, resolved: { start: time(0), end: time(20) },
        start_kind: "at_start", end_frames_moved: 0, audio_source: null, audio_output: null, audio_packet_count: 0, copied: null }],
    } };
  }
  if (options.hold) fixture.holdMethods = ["getTimelineFrames"];
  if (options.error)
    fixture.responses.getTimelineFrames = {
      ok: false,
      error: "Pictures unavailable",
    };
  await installFakeBackend(page, fixture);
  await page.addInitScript(() => {
    const backend = window.tuckBackendClient!;
    let saved: JsonObject = {};
    const get = backend.getSettings.bind(backend),
      save = backend.saveSettings.bind(backend);
    backend.getSettings = async () => {
      const r = await get();
      return r.ok ? { ...r, value: { ...r.value, ...saved } } : r;
    };
    backend.saveSettings = async (settings) => {
      const r = await save(settings);
      if (r.ok) saved = { ...saved, ...settings };
      return r;
    };
  });
  await page.goto("/");
  await expect(page.locator(".tl-segment").first()).toBeVisible();
}

test("pictures arrive without placeholders and keep segment controls readable", async ({
  page,
}) => {
  await open(page, { hold: true });
  await expect(page.locator(".tl-frames")).toHaveCount(0);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getTimelineFrames"));
  await expect(page.locator(".tl-segment.has-frames")).toHaveCount(1);
  await expect(page.locator(".tl-frame").first()).toBeVisible();
  const colors = await page
    .locator(".tl-segment-copy")
    .evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      position: getComputedStyle(el).position,
    }));
  expect(colors.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.position).toBe("relative");
  await expect(page.locator(".tl-segment").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Show frames off restores the plain track and releases sprite tokens", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".tl-segment.has-frames")).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-general").click();
  await page.locator("#set-timeline-frames").uncheck();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(page.locator(".tl-frames")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__tuckFakeBackendCalls?.some(
          (c) => c.method === "releaseMediaToken" && c.args[0] === "frames-a",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#set-timeline-frames")).not.toBeChecked();
});

test("crop preference and zoom request the matching source frames", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".tl-frames")).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-general").click();
  await page.getByRole("radio", { name: "Whole frame", exact: true }).check();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__tuckFakeBackendCalls?.some(
          (c) => c.method === "getTimelineFrames" && c.args[4] === "whole",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__tuckFakeBackendCalls?.some(
          (c) => c.method === "getTimelineFrames" && c.args[5] === true,
        ),
      ),
    )
    .toBe(true);
});

test("unavailable pictures leave editing usable without repeated requests", async ({
  page,
}) => {
  await open(page, { error: true });
  await expect(page.locator(".tl-frames")).toHaveCount(0);
  await expect(page.locator(".tl-segment .clip-edge.start")).toBeVisible();
  await page.locator(".tl-segment").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#timeline")).toHaveAttribute(
    "aria-disabled",
    "false",
  );
});

test("pictures preserve click-and-drag trim behavior in compact layouts", async ({
  page,
}) => {
  await open(page, { width: 960 });
  await expect(page.locator(".tl-frames")).toHaveCount(1);
  const edge = (await page
    .locator(".tl-segment .clip-edge.start")
    .boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow", "0");
  await page.mouse.down();
  await page.mouse.move(
    edge.x + edge.width / 2 + 100,
    edge.y + edge.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await page.locator("#tl-in").getAttribute("aria-valuenow")),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".tl-segment.has-frames")).toHaveCount(1);
});

test("About opens only local documents and retains failures for retry", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-about").click();
  await page.getByRole("button", { name: "Open license", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__tuckFakeBackendCalls?.some(
          (c) => c.method === "openLocalDocument" && c.args[0] === "license",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.tuckBackendClient!.openLocalDocument = async () => ({
      ok: false,
      error: {
        code: "OPEN_FAILED",
        message: "Could not open the bundled document",
        details: {},
      },
    });
  });
  await page
    .getByRole("button", { name: "Open third-party notices", exact: true })
    .click();
  await expect(page.locator("#set-third_party_notices-error")).toContainText(
    "Could not open the bundled document",
  );
  await expect(
    page.getByRole("button", { name: "Open third-party notices", exact: true }),
  ).toBeEnabled();
});

test("frame pictures keep the range label on a solid chip during hover and drag", async ({ page }) => {
  await open(page);
  const segment = page.locator(".tl-segment.has-frames");
  await expect(segment).toHaveCount(1);
  await segment.hover();
  const range = segment.locator(".tl-segment-time");
  await expect(range).toBeVisible();
  expect(await range.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  const box = (await segment.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 3 });
  expect(await range.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Escape");
  await page.mouse.up();
});

for (const style of ["graphite", "violet"] as const) {
  for (const width of [1240, 960]) {
    test(`${style} segment text paints above keyframes at ${width}px`, async ({ page }) => {
      await open(page, { cut: true, style, width });
      const segment = page.locator(".tl-segment.has-frames");
      await expect(segment).toHaveCount(1);
      await expect(page.locator(".kf-lane .kf").first()).toBeAttached();
      await segment.hover();
      await expect(segment.locator(".tl-segment-time")).toBeVisible();
      const order = await page.evaluate(() => {
        const segment = document.querySelector<HTMLElement>(".tl-segment")!;
        const ticks = [...document.querySelectorAll<HTMLElement>(".kf-lane .kf")];
        const guide = document.querySelector<HTMLElement>(".kf-guides .kf-guide")!;
        const previousLeft = guide.style.left;
        // hit testing exposes paint order for the normally noninteractive visual layers
        const probe = document.createElement("style");
        probe.textContent = ".tl-segment *, .kf-lane *, .kf-guides * { pointer-events: auto !important; } .kf-lane .kf { width: 1px; }";
        document.head.append(probe);
        try {
          const chips = [".tl-segment-badge", ".tl-segment-copy", ".tl-segment-time"].map(selector => {
            const chip = segment.querySelector<HTMLElement>(selector)!;
            const rect = chip.getBoundingClientRect();
            const tick = ticks.find(item => {
              const x = item.getBoundingClientRect().left;
              return x > rect.left + 2 && x < rect.right - 2;
            });
            if (!tick) throw new Error("No keyframe crosses " + selector);
            guide.style.left = tick.style.left;
            const x = tick.getBoundingClientRect().left + 0.25;
            const stack = document.elementsFromPoint(x, rect.top + rect.height / 2);
            return { selector, text: stack.indexOf(chip), tick: stack.indexOf(tick), guide: stack.indexOf(guide) };
          });
          const rect = segment.getBoundingClientRect();
          const tick = ticks.find(item => item.getBoundingClientRect().left > rect.left + rect.width / 2)!;
          guide.style.left = tick.style.left;
          const stack = document.elementsFromPoint(tick.getBoundingClientRect().left + 0.25, rect.top + 3);
          return { chips, outside: { tick: stack.indexOf(tick), guide: stack.indexOf(guide), picture: stack.findIndex(item => item.classList.contains("tl-frame")) } };
        } finally {
          guide.style.left = previousLeft;
          probe.remove();
        }
      });
      for (const chip of order.chips) {
        expect(chip.text, chip.selector).toBeGreaterThanOrEqual(0);
        expect(chip.tick, chip.selector).toBeGreaterThan(chip.text);
        expect(chip.guide, chip.selector).toBeGreaterThan(chip.text);
      }
      expect(order.outside.tick).toBeGreaterThanOrEqual(0);
      expect(order.outside.guide).toBeGreaterThanOrEqual(0);
      expect(order.outside.picture).toBeGreaterThan(order.outside.tick);
      expect(order.outside.picture).toBeGreaterThan(order.outside.guide);
      await segment.focus();
      await expect(segment).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator("#timeline")).toHaveAttribute("aria-disabled", "false");
    });
  }
}

async function holdDocumentOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as Window & { completeDocumentOpen?: () => void };
    window.tuckBackendClient!.openLocalDocument = () => new Promise((resolve) => {
      host.completeDocumentOpen = () => resolve({
        ok: false,
        error: { code: "OPEN_FAILED", message: "Could not open this document. Try again.", details: {} },
      });
    });
  });
}

async function completeDocumentOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const complete = (window as Window & { completeDocumentOpen?: () => void }).completeDocumentOpen;
    if (!complete) throw new Error("No document request is waiting");
    complete();
  });
}

test("a failed document open restores keyboard focus for retry", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-about").click();
  await holdDocumentOpen(page);
  const notices = page.getByRole("button", { name: "Open third-party notices", exact: true });
  await notices.focus();
  await page.keyboard.press("Enter");
  await expect(notices).toBeDisabled();
  await completeDocumentOpen(page);
  await expect(notices).toBeEnabled();
  await expect(page.locator("#set-third_party_notices-error")).toBeVisible();
  await expect(notices).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notices).toBeDisabled();
  await completeDocumentOpen(page);
  await expect(notices).toBeFocused();
});

test("a finished document request leaves focus on another control", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-about").click();
  await holdDocumentOpen(page);
  const notices = page.getByRole("button", { name: "Open third-party notices", exact: true });
  const license = page.getByRole("button", { name: "Open license", exact: true });
  await notices.focus();
  await page.keyboard.press("Enter");
  await expect(notices).toBeDisabled();
  await license.focus();
  await completeDocumentOpen(page);
  await expect(notices).toBeEnabled();
  await expect(license).toBeFocused();
});
