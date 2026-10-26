import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { fixtureEngineScript } from "../fixtures/fixture-engine";
import { answerMixes, mixAnswers, newestMixRequest } from "../fixtures/native-mix";
import type { JsonObject } from "../../src/backend/types.ts";

const nativeMix = process.env.TUCK_E2E_NATIVE_PREVIEW === "engine";
const NATIVE_MIX = "the native player plays the sound in its own mix, so the page plays none";

declare global { interface Window { __clipPlacementAudio: HTMLAudioElement[] } }

async function open(page: Page, width = 1240, media = false, native = false) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Video.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: media ? 16 : 60, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15000000 } };
  fixture.responses.pickAudioFiles = { ok: true, files: ["C:\\audio\\Song.wav"] };
  fixture.responses.probeAudioFile = { ok: true, data: { duration: 90, channels: 2, sample_rate: 48000 } };
  fixture.responses.getMediaUrl = { ok: true, url: media ? "https://placement.test/media" : "", token: "" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
  if (media) {
    await page.addInitScript(() => {
      window.__clipPlacementAudio = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this instanceof HTMLAudioElement && !window.__clipPlacementAudio.includes(this))
          window.__clipPlacementAudio.push(this);
        return play.call(this);
      };
    });
    const body = await readFile(resolve("frontend/tests/fixtures/media/two-source-tracks.mp4"));
    await page.route("https://placement.test/media", route => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", headers: {
        "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}),
      }, body: body.subarray(start, end + 1) });
    });
  }
  await installFakeBackend(page, fixture);
  // this spec's own shell stand-in, so the native versions run in every e2e run
  if (native) await page.addInitScript({ content: fixtureEngineScript({ nativePreview: "engine" }) });
  await page.addInitScript(() => {
    const backend = window.tuckBackendClient!;
    let saved: JsonObject = {};
    const get = backend.getSettings.bind(backend), save = backend.saveSettings.bind(backend);
    backend.getSettings = async () => {
      const result = await get();
      return result.ok ? { ...result, value: { ...result.value, ...saved } } : result;
    };
    backend.saveSettings = async (settings) => {
      const result = await save(settings);
      if (result.ok) saved = { ...saved, ...settings };
      return result;
    };
  });
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toBeVisible();
  await page.locator("#btn-snap-toggle").click();
}

test("Alt-drag slips footage and Escape cancels without moving the clip", async ({ page }) => {
  await open(page);
  const source = await trimAndMove(page);
  const before = (await page.locator(".tl-segment").boundingBox())!;
  const track = (await page.locator("#tl-track").boundingBox())!;
  const slip = async () => {
    await page.keyboard.down("Alt");
    await page.mouse.move(before.x + 100, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 100 - track.width / 12, before.y + before.height / 2, { steps: 5 });
  };
  await slip();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(source, 4);
  await slip();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(source - 5, 4);
  const after = (await page.locator(".tl-segment").boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 4);
  expect(after.width).toBeCloseTo(before.width, 4);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo slip segment");
  await page.locator("#btn-undo").click();
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(source, 4);
});

test("positioned preview seeks retained footage and music uses project time", async ({ page }) => {
  test.skip(nativeMix, NATIVE_MIX);
  await open(page, 1240, true);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const source = await trimAndMove(page);
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width / 16, ruler.y + ruler.height / 2);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(source + 1, 1);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).toHaveClass(/playing/);
  await expect.poll(() => page.evaluate(() => window.__clipPlacementAudio.at(-1)?.currentTime ?? 0)).toBeGreaterThan(1);
  const clocks = await page.evaluate(() => ({
    video: document.querySelector<HTMLVideoElement>("#vid")!.currentTime,
    music: window.__clipPlacementAudio.at(-1)!.currentTime,
  }));
  expect(clocks.video - clocks.music).toBeCloseTo(source, 0);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).not.toHaveClass(/playing/);
});

test("music continues through a black gap and the video resumes at its retained source", async ({ page }) => {
  test.skip(nativeMix, NATIVE_MIX);
  await open(page, 1240, true);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const source = await trimAndMove(page);
  const clip = (await page.locator(".tl-segment").boundingBox())!;
  const track = (await page.locator("#tl-track").boundingBox())!;
  await page.mouse.move(clip.x + 100, clip.y + clip.height / 2);
  await page.mouse.down();
  await page.mouse.move(clip.x + 100 + track.width / 8, clip.y + clip.height / 2, { steps: 5 });
  await page.mouse.up();
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + 1, ruler.y + ruler.height / 2);
  await expect(page.locator("#timeline-gap-caption")).toBeVisible();
  await expect(page.locator("#btn-save-frame")).toBeDisabled();
  await page.locator("#btn-play").click();
  await expect.poll(() => page.evaluate(() => window.__clipPlacementAudio.at(-1)?.currentTime ?? 0)).toBeGreaterThan(0.2);
  expect(await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await expect(page.locator("#timeline-gap-caption")).toBeHidden();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(source);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-save-frame")).toBeEnabled();
});

// the native player plays the timeline and the mix Python compiles, so what it gets is checked
function lastEdits(page: Page) {
  return page.evaluate(() => window.__fixtureEngine?.edits.at(-1));
}

function lastSeek(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const seeks = (window.__fixtureEngine?.calls ?? []).map((call) => call.args.command as { kind?: string; seconds?: number } | undefined)
      .filter((command) => command?.kind === "seek");
    return seeks.at(-1)?.seconds;
  });
}

async function playsNothingItself(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__clipPlacementAudio.length)).toBe(0);
  expect(await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
}

test("the native player gets moved footage and added music in project time", async ({ page }) => {
  await open(page, 1240, true, true);
  await answerMixes(page, 16);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const source = await trimAndMove(page);
  // the retained footage starts the engine's timeline, and the music is mixed where it sits
  await expect.poll(() => lastEdits(page)).toEqual({
    duration: 16, segments: [{ start: 0, end: expect.closeTo(16 - source, 3), sourceStart: expect.closeTo(source, 3) }],
  });
  await expect.poll(() => newestMixRequest(page)).toMatchObject({
    segments: [{ start: expect.closeTo(source, 3), timeline_start: expect.closeTo(0, 4) }],
    audio_tracks: [{ clips: [{ source_in: 0, timeline_start: 0 }] }],
  });
  await expect.poll(async () => {
    const { asked, playing } = await mixAnswers(page);
    return asked > 0 && playing === asked;
  }).toBe(true);

  // a seek is in project time, and the hidden video keeps the footage shown there
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width / 16, ruler.y + ruler.height / 2);
  await expect.poll(() => lastSeek(page)).toBeCloseTo(1, 1);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(source + 1, 1);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).toHaveClass(/playing/);
  await playsNothingItself(page);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).not.toHaveClass(/playing/);
});

test("the native player plays through a black gap into the moved clip", async ({ page }) => {
  await open(page, 1240, true, true);
  await answerMixes(page, 16);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const source = await trimAndMove(page);
  const clip = (await page.locator(".tl-segment").boundingBox())!;
  const track = (await page.locator("#tl-track").boundingBox())!;
  await page.mouse.move(clip.x + 100, clip.y + clip.height / 2);
  await page.mouse.down();
  await page.mouse.move(clip.x + 100 + track.width / 8, clip.y + clip.height / 2, { steps: 5 });
  await page.mouse.up();
  // two seconds of black before the clip, which keeps its footage
  await expect.poll(async () => (await lastEdits(page))?.segments[0]?.start ?? 0).toBeCloseTo(2, 1);
  expect((await lastEdits(page))?.segments[0]?.sourceStart).toBeCloseTo(source, 3);
  await expect.poll(() => newestMixRequest(page)).toMatchObject({
    segments: [{ timeline_start: expect.closeTo(2, 1) }], audio_tracks: [{ clips: [{ timeline_start: 0 }] }],
  });

  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + 1, ruler.y + ruler.height / 2);
  await expect(page.locator("#timeline-gap-caption")).toBeVisible();
  await expect(page.locator("#btn-save-frame")).toBeDisabled();
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).toHaveClass(/playing/);
  // the music plays in the engine's mix through the gap, and the picture comes in with the clip
  await expect(page.locator("#timeline-gap-caption")).toBeHidden({ timeout: 5000 });
  await playsNothingItself(page);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-save-frame")).toBeEnabled();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(source);
});

test("keyboard moves preserve footage and focus even when preview is unavailable", async ({ page }) => {
  await open(page);
  const source = await trimAndMove(page);
  const clip = page.locator(".tl-segment");
  await clip.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow", "0.1");
  await expect(clip).toBeFocused();
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(source, 4);
});

test("source-audio slipping and undo refresh the actual preview frame", async ({ page }) => {
  await open(page, 1240, true);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  const source = await trimAndMove(page);
  const block = (await page.locator("#source-audio-lane .seq-audio-clip").boundingBox())!;
  const track = (await page.locator("#tl-track").boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(block.x + 100, block.y + block.height / 2);
  await page.mouse.down();
  await page.mouse.move(block.x + 100 - track.width / 32, block.y + block.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(source - 0.5, 1);
  await expect(page.locator("#seq-playhead")).toHaveAttribute("style", /left: 0%;/);
  await page.locator("#btn-undo").click();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(source, 1);
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.95, ruler.y + ruler.height / 2);
  await expect(page.locator("#timeline-gap-caption")).toBeVisible();
  await page.locator("#btn-segments-reset").click();
  await expect(page.locator("#timeline-gap-caption")).toBeHidden();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0, 1);
});

async function trimAndMove(page: Page) {
  const track = (await page.locator("#tl-track").boundingBox())!;
  const edge = (await page.locator(".tl-segment .clip-edge.start").boundingBox())!;
  const distance = track.width / 6;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + distance, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  const sourceStart = Number(await page.locator("#tl-in").getAttribute("aria-valuenow"));
  const clip = (await page.locator(".tl-segment").boundingBox())!;
  await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
  await page.mouse.down();
  await page.mouse.move(clip.x + clip.width / 2 - distance, clip.y + clip.height / 2, { steps: 6 });
  await page.mouse.up();
  return sourceStart;
}

async function lastPlan(page: Page) {
  return page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "createPlan").at(-1)?.args[0] as {
    segments?: { start: number; end: number; timeline_start?: number }[];
    audio_tracks?: { clips: { source_in: number; timeline_start: number }[] }[];
  } | undefined);
}

for (const width of [1240, 960]) {
  test(`the movement setting restores old dragging and switches back at ${width}px`, async ({ page }) => {
    await open(page, width);
    await setPreserveSource(page, false);
    const trimmed = await trimAndMove(page);
    await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(0, 4);
    const legacy = (await lastPlan(page))!.segments![0]!;
    expect(legacy.end).toBeCloseTo(60 - trimmed, 4);
    expect(legacy.timeline_start).toBeUndefined();

    await setPreserveSource(page, true);
    expect((await lastPlan(page))!.segments![0]).toEqual(legacy);
    await page.locator(".tl-segment").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.timeline_start).toBeCloseTo(0.1, 4);
    expect((await lastPlan(page))!.segments![0]!.start).toBeCloseTo(0, 4);
    await page.locator("#btn-undo").click();
    await expect.poll(async () => (await lastPlan(page))?.segments?.[0]).toEqual(legacy);
  });

  test(`a trimmed video moves to the song beginning without restoring footage at ${width}px`, async ({ page }) => {
    await open(page, width);
    await page.getByRole("button", { name: "Add audio", exact: true }).click();
    await expect(page.locator(".seq-row.imported")).toHaveCount(1);
    const sourceStart = await trimAndMove(page);
    await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.timeline_start).toBeCloseTo(0, 5);
    const request = (await lastPlan(page))!;
    expect(request.segments![0]!.start).toBeCloseTo(sourceStart, 4);
    expect(request.segments![0]!.end).toBeCloseTo(60, 4);
    expect(request.audio_tracks![0]!.clips[0]!.source_in).toBe(0);
    expect(request.audio_tracks![0]!.clips[0]!.timeline_start).toBe(0);
    await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo move segment");
    await page.locator("#btn-undo").click();
    await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow", String(sourceStart));
    await page.locator("#btn-redo").click();
    await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow", "0");
  });
}

async function setPreserveSource(page: Page, enabled: boolean) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-general").click();
  const setting = page.getByRole("switch", { name: "Preserve footage when moving clips", exact: true });
  await expect(setting).toBeChecked({ checked: !enabled });
  await setting.setChecked(enabled);
  await expect.poll(() => page.evaluate((enabled) => window.__tuckFakeBackendCalls
    ?.filter(call => call.method === "saveSettings")
    .some(call => (call.args[0] as { timeline_preserve_source?: boolean }).timeline_preserve_source === enabled), enabled)).toBe(true);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
}

test("legacy movement preserves existing edits until moving and keeps Alt slipping available", async ({ page }) => {
  await open(page);
  const source = await trimAndMove(page);
  const placed = (await lastPlan(page))!.segments![0]!;
  await setPreserveSource(page, false);
  expect((await lastPlan(page))!.segments![0]).toEqual(placed);
  const block = (await page.locator("#source-audio-lane .seq-audio-clip").boundingBox())!;
  const track = (await page.locator("#tl-track").boundingBox())!;
  await page.mouse.move(block.x + 100, block.y + block.height / 2);
  await page.mouse.down();
  await page.mouse.move(block.x + 100 + track.width / 12, block.y + block.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]).toEqual(placed);

  const clip = page.locator(".tl-segment");
  await clip.focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(source - 0.1, 4);
  expect((await lastPlan(page))!.segments![0]!.timeline_start).toBeCloseTo(0, 4);
  await clip.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await lastPlan(page))?.segments?.[0]?.start).toBeCloseTo(source, 4);
  expect((await lastPlan(page))!.segments![0]!.timeline_start).toBeCloseTo(0.1, 4);
});
