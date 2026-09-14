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

async function textContrast(page: Page, textSelector: string, fillSelector: string): Promise<number> {
  return page.locator(textSelector).first().evaluate((textEl, fillSel) => {
    const fillEl = document.querySelector(fillSel);
    if (!(fillEl instanceof HTMLElement)) return 0;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    const sample = (color: string): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    };
    const toLinear = (channel: number): number => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: [number, number, number]): number =>
      0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    const bg = sample(getComputedStyle(fillEl).backgroundColor);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = `rgb(${bg[0]} ${bg[1]} ${bg[2]})`;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(textEl).color;
    ctx.fillRect(0, 0, 1, 1);
    const fgData = ctx.getImageData(0, 0, 1, 1).data;
    const fg: [number, number, number] = [fgData[0] ?? 0, fgData[1] ?? 0, fgData[2] ?? 0];
    const high = Math.max(luminance(fg), luminance(bg));
    const low = Math.min(luminance(fg), luminance(bg));
    return (high + 0.05) / (low + 0.05);
  }, fillSelector);
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

test("selected segment and library card text stays readable on the accent fill", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator(".tl-segment.active .tl-segment-label")).toBeVisible();

  expect(
    await textContrast(
      page,
      ".tl-segment.active .tl-segment-label",
      "#video-track.selected .tl-segment.active .tl-segment-surface",
    ),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await textContrast(
      page,
      ".tl-segment.active .tl-segment-range",
      "#video-track.selected .tl-segment.active .tl-segment-surface",
    ),
  ).toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(page, ".clip.sel .c2", ".clip.sel")).toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(page, ".clip.sel .c-meta", ".clip.sel")).toBeGreaterThanOrEqual(4.5);

  await page.locator("#stage-scrub").fill("400");
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  expect(
    await textContrast(
      page,
      ".tl-segment.active .tl-segment-label",
      "#video-track.selected .tl-segment.active .tl-segment-surface",
    ),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await textContrast(
      page,
      ".tl-segment:not(.active) .tl-segment-label",
      ".tl-segment:not(.active) .tl-segment-surface",
    ),
  ).toBeGreaterThanOrEqual(4.5);
  await page.locator(".tl-segment:not(.active)").hover();
  await page.locator(".tl-segment:not(.active) .tl-segment-surface").evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
  });
  expect(
    await textContrast(page, ".tl-segment:not(.active) .tl-segment-range", ".tl-segment:not(.active) .tl-segment-surface"),
  ).toBeGreaterThanOrEqual(4.5);
});

test("primary actions and timeline labels retain contrast in normal and hover states", async ({ page }) => {
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  for (const selector of ["#btn-one", "#btn-play", ".export-actions > summary"]) {
    expect(await textContrast(page, selector, selector), selector).toBeGreaterThanOrEqual(4.5);
    await page.locator(selector).hover();
    await page.locator(selector).evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    expect(await textContrast(page, selector, selector), `${selector} hover`).toBeGreaterThanOrEqual(4.5);
  }
  expect(await textContrast(page, ".seq-tick span", "#audio-editor")).toBeGreaterThanOrEqual(4.5);
  expect(await textContrast(page, "#source-audio-head .seq-track-name", "#audio-editor")).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  await expect(page.locator(".seq-audio-clip.imported")).toBeVisible();
  expect(await textContrast(page, ".audio-clip-label", ".seq-audio-clip.imported")).toBeGreaterThanOrEqual(4.5);
  await page.locator(".seq-audio-clip.imported").hover();
  expect(await textContrast(page, ".audio-clip-label", ".seq-audio-clip.imported")).toBeGreaterThanOrEqual(4.5);
});

test("track header controls stay readable and usable at desktop and compact sizes", async ({ page }) => {
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator("#video-track-head .seq-track-name")).toHaveText("Video");
  await expect(page.locator("#source-audio-head .seq-track-name")).toHaveText("Source audio");
  for (const width of [1240, 960]) {
    await page.setViewportSize({ width, height: 640 });
    const header = await page.locator("#source-audio-head").boundingBox();
    const lane = await page.locator("#source-audio-lane").boundingBox();
    expect(lane!.x).toBeGreaterThan(header!.x + header!.width);
    expect(Math.abs(lane!.y + lane!.height / 2 - header!.y - header!.height / 2)).toBeLessThan(1);
    const name = page.locator("#source-audio-head .seq-track-name");
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const mute = page.getByRole("button", { name: "Mute source audio", exact: true });
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    const bounds = await mute.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(28);
    expect(bounds?.height).toBeGreaterThanOrEqual(28);
    await mute.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Unmute source audio", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Unmute source audio", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await textContrast(page, "#source-audio-head .seq-track-name", "#audio-editor")).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("Enter");
  }
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  await page.getByRole("button", { name: "Fit timeline height to tracks" }).click();
  const importedMute = page.locator("#imported-audio-tracks .seq-track-mute");
  await importedMute.focus();
  await page.keyboard.press("Enter");
  await expect(importedMute).toBeFocused();
  await expect(importedMute).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(importedMute).toBeFocused();
  await expect(importedMute).toHaveAttribute("aria-pressed", "false");
});

test("source audio without an audio stream has a disabled mute control", async ({ page }) => {
  const fixture = editorFixture();
  fixture.responses.probeFile = { ok: true, data: probeData({ has_audio: false }) };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.getByRole("button", { name: "Mute source audio", exact: true })).toBeDisabled();
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
  await detail.scrollIntoViewIfNeeded();
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

test("track additions and removals resize a manually sized timeline", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  const separator = page.getByRole("separator", { name: "Resize timeline" });
  await separator.focus();
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "170");
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const expandedHeight = Number(await separator.getAttribute("aria-valuenow"));
  expect(expandedHeight).toBeGreaterThan(170);
  const overflow = () => page.locator("#sequence-frame").evaluate(el => el.scrollHeight - el.clientHeight);
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await page.locator("#imported-audio-tracks .seq-track-remove").click();
  await page.locator("#confirm-accept").click();
  await expect.poll(async () => Number(await separator.getAttribute("aria-valuenow"))).toBeLessThan(expandedHeight);
  await expect.poll(overflow).toBeLessThanOrEqual(1);
});

test("Inspector content aligns with tabs and footer without empty scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  const libraryEdges = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { card: rect(".clip").left, tab: rect("#lib-tab-media").left, add: rect("#btn-add").left };
  });
  expect(libraryEdges.card).toBeCloseTo(libraryEdges.tab, 0);
  expect(libraryEdges.add).toBeCloseTo(libraryEdges.tab, 0);
  for (const width of [1240, 960]) {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await page.locator("#insp-tab-edit").click();
    const transform = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>("#right-scroll")!;
      const details = document.querySelector("#clip-details-card")!.getBoundingClientRect();
      return { overflow: scroll.scrollHeight - scroll.clientHeight, bottomGap: scroll.getBoundingClientRect().bottom - details.bottom };
    });
    expect(transform.overflow).toBeLessThanOrEqual(1);
    expect(transform.bottomGap).toBeCloseTo(12, 0);
    await page.screenshot({ path: testInfo.outputPath(`transform-${width}.png`) });
    await page.locator("#insp-tab-audio").click();
    expect(await page.locator("#right-scroll").evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await page.locator("#insp-tab-export").click();
    await expect(async () => {
      const edges = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return { tab: rect("#insp-tab-export").right, field: rect(".profile-select-row").right, footer: rect(".export-actions").right, start: rect("#insp-tab-edit").left, contentStart: rect("#profile-card").left };
      });
      expect(edges.tab).toBeCloseTo(edges.field, 0);
      expect(edges.footer).toBeCloseTo(edges.field, 0);
      expect(edges.start).toBeCloseTo(edges.contentStart, 0);
    }).toPass({ timeout: 3000 });
    await page.screenshot({ path: testInfo.outputPath(`export-${width}.png`) });
  }
});

test("export controls have balanced insets and timeline text shares a baseline", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const tabs = rect("#insp-tabs"), tab = rect("#insp-tab-export");
    const modes = rect("#task-wf"), first = rect("#wf-c"), last = rect("#wf-u");
    const footer = rect("#right-foot"), button = rect("#btn-one"), actions = rect(".export-actions");
    return {
      tabInsets: { top: tab.top-tabs.top, bottom: tabs.bottom-tab.bottom },
      rowGap: modes.top-tabs.bottom,
      modeInsets: [first.top-modes.top,modes.bottom-first.bottom,first.left-modes.left,modes.right-last.right],
      footerInsets: [button.top-footer.top,footer.bottom-button.bottom,button.left-footer.left,footer.right-actions.right],
    };
  });
  expect(geometry.tabInsets.top).toBeCloseTo(geometry.tabInsets.bottom, 0);
  expect(geometry.rowGap).toBeGreaterThanOrEqual(8);
  for (const inset of geometry.modeInsets) expect(inset).toBeCloseTo(4, 0);
  for (const [index, inset] of geometry.footerInsets.entries()) expect(inset).toBeCloseTo(index < 2 ? 12 : 22, 0);
  const baselines = await page.evaluate(() => {
    const selectors = ['.timeline-tool-group[aria-label="Segment actions"] .timeline-tool-label', '#btn-seq-split .timeline-command-label', '.timeline-tool-group[aria-label="Audio actions"] .timeline-tool-label', '#audio-add .timeline-command-label'];
    return selectors.map(selector => {
      const marker = document.createElement("span");
      marker.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
      document.querySelector(selector)!.append(marker);
      const baseline = marker.getBoundingClientRect().top;
      marker.remove();
      return baseline;
    });
  });
  const firstBaseline = baselines[0];
  if (firstBaseline === undefined) throw new Error("Timeline labels are missing");
  for (const baseline of baselines) expect(baseline).toBeCloseTo(firstBaseline, 0);
  await page.screenshot({ path: testInfo.outputPath("balanced-controls.png") });
});


test("preview icons retain their geometry through playback events", async ({ page }) => {
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.locator("#btn-play .play-icon")).toBeVisible();
  await expect(page.locator("#btn-play .pause-icon")).toBeHidden();
  await page.locator("#vid").dispatchEvent("play");
  await expect(page.locator("#btn-play .pause-icon")).toBeVisible();
  await expect(page.locator("#btn-play .play-icon")).toBeHidden();
  await page.locator("#vid").dispatchEvent("pause");
  await expect(page.locator("#btn-play .play-icon")).toBeVisible();
});

test("custom export fields share edges and selected clips have matching handles", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await page.locator("#export-res-select").selectOption({ label: "Custom…" });
  const geometry = await page.evaluate(() => {
    const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const select = document.querySelector("#export-res-select")!;
    return {
      starts: [rect("#export-res-select").left, rect("#res-cust input").left, rect("#scaler-row select").left],
      ends: [rect("#export-res-select").right, rect("#res-cust input:last-child").right, rect("#scaler-row select").right],
      arrow: getComputedStyle(select).backgroundPosition,
      selection: getComputedStyle(document.querySelector(".tl-segment.active .tl-segment-surface")!).boxShadow,
      handles: [".tl-segment.active .clip-edge.start", ".seq-audio-clip .clip-edge.start"].map(s => {
        const c = getComputedStyle(document.querySelector(s)!, "::before");
        return [c.width, c.borderRadius, c.left, c.backgroundColor];
      }),
    };
  });
  for (const x of geometry.starts) expect(x).toBeCloseTo(geometry.starts[0]!, 0);
  for (const x of geometry.ends) expect(x).toBeCloseTo(geometry.ends[0]!, 0);
  expect(geometry.arrow).toContain("10px");
  expect(geometry.selection).toContain("inset");
  expect(geometry.handles[0]).toEqual(geometry.handles[1]);
  await page.screenshot({ path: testInfo.outputPath("aligned-fields-and-handles.png") });
});


test("export label centers across the split button and toolbar dividers are centered", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  for (const mode of ["#wf-c", "#wf-u"]) {
    await page.locator(mode).click();
    const geometry = await page.evaluate(() => {
      const button = document.querySelector("#btn-one")!;
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      const start = button.getBoundingClientRect();
      const end = document.querySelector(".export-actions")!.getBoundingClientRect();
      const group = document.querySelector('.timeline-tool-group[aria-label="Audio actions"]')!;
      const divider = getComputedStyle(group, "::before");
      return {
        textCenter: (text.left + text.right) / 2,
        buttonCenter: (start.left + end.right) / 2,
        dividerTop: parseFloat(divider.top),
        groupHeight: group.getBoundingClientRect().height,
        dividerHeight: divider.height,
      };
    });
    expect(geometry.textCenter).toBeCloseTo(geometry.buttonCenter, 0);
    expect(geometry.dividerTop).toBeCloseTo(geometry.groupHeight / 2, 0);
    expect(geometry.dividerHeight).toBe("16px");
  }
});


test("Audio cards and headings share the Inspector edges", async ({ page }) => {
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await page.locator("#insp-tab-audio").click();
  const edges = await page.evaluate(() => ["#audio-master-card", ".audio-section-heading", "#audio-track-mixer"].map(s => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return [r.left, r.right];
  }));
  expect(edges[1]).toEqual(edges[0]);
  expect(edges[2]).toEqual(edges[0]);
});


test("panel edges stay aligned when scrollbars reserve no space", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.addStyleTag({ content: "#right-scroll, #clips { scrollbar-gutter: auto; scrollbar-width: none; } #right-scroll::-webkit-scrollbar, #clips::-webkit-scrollbar { width: 0; }" });
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect.poll(() => page.evaluate(() => {
    const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    return Math.abs(rect("#profile-card").left - rect("#insp-tab-edit").left)
      + Math.abs(rect("#profile-card").right - rect(".export-actions").right)
      + Math.abs(rect(".clip").left - rect("#btn-add").left);
  })).toBeLessThan(1);
});


test("Inspector reserves scrollbar space without moving its controls", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 900 });
  await installFakeBackend(page, editorFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  const measure = () => page.evaluate(() => {
    const field = document.querySelector("#profile-card")!.getBoundingClientRect();
    const scroll = document.querySelector<HTMLElement>("#right-scroll")!;
    return { left: field.left, right: field.right, overflow: scroll.scrollHeight > scroll.clientHeight };
  });
  await expect.poll(async () => (await measure()).overflow).toBe(false);
  const before = await measure();
  await page.setViewportSize({ width: 1240, height: 640 });
  await expect.poll(async () => (await measure()).overflow).toBe(true);
  await expect.poll(async () => {
    const after = await measure();
    return Math.abs(after.left - before.left) + Math.abs(after.right - before.right);
  }).toBeLessThan(1);
  const gap = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>("#right-scroll")!;
    return parseFloat(getComputedStyle(scroll).paddingRight);
  });
  expect(gap).toBeGreaterThanOrEqual(12);
  await page.setViewportSize({ width: 1240, height: 900 });
  await expect.poll(async () => {
    const after = await measure();
    return Math.abs(after.left - before.left) + Math.abs(after.right - before.right);
  }).toBeLessThan(1);
});
