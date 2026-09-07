import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";

const VIDEO_A = "C:\\media\\Morning clip.mp4";
const VIDEO_B = "C:\\media\\very-long-name-".concat("x".repeat(80), "-日本語.mp4");
const AUDIO_A = "C:\\media\\Score – café.wav";

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

function editorFixture(): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO_A] };
  fixture.responses.pickAudioFiles = { ok: true, files: [AUDIO_A] };
  fixture.responses.probeFile = { ok: true, data: probeData() };
  fixture.responses.probeAudioFile = {
    ok: true,
    data: { duration: 20, file_size: 2048, channels: 2, sample_rate: 48000 },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/video", token: "token-a" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "data:image/png;base64,aaa" };
  fixture.responses.getWaveform = { ok: true, url: "https://media.test/wave", token: "wave-a" };
  fixture.responses.releaseMediaToken = { ok: true };
  return fixture;
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("adding a video probes, renders the filename as text, and enables preview controls", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c2").getByText("Morning clip.mp4", { exact: true })).toBeVisible();
  await expect(page.locator(".c-meta")).toContainText("0:12");
  await expect(page.locator(".c-meta")).toContainText("1920×1080");
  await expect(page.getByRole("button", { name: "Play/Pause" })).toBeEnabled();
  await expect(page.locator("#empty")).toBeHidden();
  expect(errors).toEqual([]);
});

test("queue progress becomes visible after compressing the selected video", async ({ page }) => {
  const fixture = editorFixture();
  fixture.queueStateAfterEnqueue = {
    items: [
      {
        duration: 12,
        id: "queue-item-1",
        progress: 42,
        progress_info: { eta_seconds: 18, speed: 1.5 },
        segment_count: 1,
        source: "Morning clip.mp4",
        source_path: VIDEO_A,
        state: "running",
      },
    ],
  };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.getByRole("button", { name: "Compress selected" })).toBeEnabled();
  await page.getByRole("button", { name: "Compress selected" }).click();

  await expect(page.locator("#qbar")).toBeVisible();
  await expect(page.locator("#qprog")).toHaveAttribute("value", "42");
  await expect(page.locator("#qfname")).toContainText("Morning clip.mp4");
});

test("the editor runs entirely from the single module entry with no classic scripts", async ({
  page,
}) => {
  const classicScripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script" && /\/legacy\//.test(request.url())) {
      classicScripts.push(request.url());
    }
  });
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c2")).toContainText("Morning clip.mp4");
  await expect(page.getByRole("button", { name: "Play/Pause" })).toBeEnabled();

  const moduleScripts = await page.$$eval("script", (nodes) =>
    nodes.filter((node) => node.getAttribute("src")).map((node) => node.getAttribute("type")),
  );
  expect(moduleScripts).toEqual(["module"]);
  expect(classicScripts).toEqual([]);
});

test("a failed probe keeps retry enabled and recovers without executing backend HTML", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  const fixture = editorFixture();
  fixture.responses.pickFiles = {
    ok: true,
    files: ["C:\\media\\<img src=x onerror=globalThis.__tuckProbePwned=true>.mp4"],
  };
  fixture.responseSequences = {
    probeFile: [
      { ok: false, error: '<img src=x onerror="globalThis.__tuckProbePwned=true"> malformed' },
      { ok: true, data: probeData() },
    ],
  };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c-meta")).toContainText("malformed");
  await expect(page.locator("#clips img")).toHaveCount(0);
  const retry = page.getByRole("button", { name: /Retry reading/ });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator(".c-meta")).toContainText("1920×1080");
  expect(await page.evaluate(() => Reflect.get(window, "__tuckProbePwned"))).toBeUndefined();
  expect(errors).toEqual([]);
});

test("switching clips during a pending preview ignores the stale media URL", async ({ page }) => {
  const fixture = editorFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO_A, VIDEO_B] };
  fixture.holdMethods = ["getMediaUrl"];
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c2").first()).toBeVisible();
  await page.locator(".clip").nth(1).click();
  await page.evaluate(() => {
    const held = (
      window as Window & {
        __tuckReleaseHeld?: (method: string, value: unknown) => void;
      }
    ).__tuckReleaseHeld;
    held?.("getMediaUrl", { ok: true, url: "https://media.test/stale-a", token: "token-stale-a" });
    held?.("getMediaUrl", { ok: true, url: "https://media.test/fresh-b", token: "token-b" });
  });

  await expect.poll(async () => page.locator("#vid").getAttribute("src")).toBe(
    "https://media.test/fresh-b",
  );
});

test("crop, rotation, and segment edits update the selected clip and undo restores them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c-meta")).toContainText("0:12");

  await page.locator("#insp-tab-edit").click();
  await page.getByRole("button", { name: "16:9" }).click();
  await expect(page.getByRole("button", { name: "16:9" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Rotate 90° clockwise" }).click();
  await expect(page.getByRole("button", { name: "Rotate 90° clockwise" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.locator("#stage-scrub").fill("500");
  const split = page.getByRole("button", { name: "Split at playhead" });
  await expect(split).toBeEnabled();
  await split.click();
  await expect(page.locator(".tl-segment")).toHaveCount(2);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".tl-segment")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".tl-segment")).toHaveCount(2);

  await page.getByRole("button", { name: "Remove Morning clip.mp4" }).click();
  await expect(page.getByText("Drop videos anywhere", { exact: true })).toBeVisible();
  await expect(page.locator(".tl-segment")).toHaveCount(0);
});

test("keyboard shortcuts, compact drawers, and audio import stay usable at 960 by 640", async ({
  page,
}) => {
  const fixture = editorFixture();
  await page.setViewportSize({ width: 960, height: 640 });
  await installFakeBackend(page, fixture);
  await page.goto("/");

  const libraryToggle = page.getByRole("button", { name: "Library" });
  await expect(libraryToggle).toHaveAttribute("aria-expanded", "false");
  await libraryToggle.click();
  await expect(libraryToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#left")).toHaveAttribute("role", "dialog");
  await expect(page.locator("#center")).toHaveAttribute("inert", "");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c2")).toContainText("Morning clip.mp4");
  await page.keyboard.press("Escape");
  await expect(libraryToggle).toBeFocused();
  await expect(libraryToggle).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "Library" }).click();
  await page.locator("#lib-tab-audio").click();
  await page.locator("#btn-add-audio").click();
  await expect(page.locator("#audio-lib-list")).toContainText("Score – café.wav");

  await page.keyboard.press("Control+/");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});

test("the audio source range picker sizes its window to the selection and stays draggable", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".c2").getByText("Morning clip.mp4", { exact: true })).toBeVisible();

  await page.locator("#insp-tab-audio").click();
  await page.locator("#lib-tab-audio").click();
  await page.locator("#btn-add-audio").click();
  await expect(page.locator("#audio-lib-list")).toContainText("Score – café.wav");

  const rangeHost = page.locator("#audio-clip-range");
  await expect(rangeHost).not.toHaveClass(/hid/);
  // millisecond precision only appears when AudioEditing.formatSourceTime is wired
  await expect(rangeHost).toContainText("0:00.000–0:12.000 / 0:20.000");

  // 12s clip inside a 20s source: the overview window is ~60% of the strip, not
  // a collapsed sliver. Regressed once when panels lost its AudioEditing wiring.
  const ratio = await page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>("#audio-clip-range .audio-source-overview");
    const win = document.querySelector<HTMLElement>(
      "#audio-clip-range .audio-source-overview-window",
    );
    if (!strip || !win) return 0;
    return win.getBoundingClientRect().width / strip.getBoundingClientRect().width;
  });
  expect(ratio).toBeGreaterThan(0.4);
  expect(ratio).toBeLessThan(0.85);

  // the detail strip only wires pointer drag when AudioEditing is present
  const detail = page.locator("#audio-clip-range .audio-source-detail");
  const box = await detail.boundingBox();
  if (!box) throw new Error("detail strip has no box");
  // drag the waveform left to move the in-point later into the source
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(rangeHost).not.toContainText("0:00.000–0:12.000 / 0:20.000");
  await expect(rangeHost).toContainText("/ 0:20.000");

  expect(errors).toEqual([]);
});
