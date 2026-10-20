import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { fixtureEngineScript, type FixtureEngine } from "../fixtures/fixture-engine";

declare global {
  interface Window {
    __fixtureEngine?: FixtureEngine;
    __fixtureSurface?: Array<{ command: string; args: Record<string, unknown> }>;
  }
}

const DURATION = 16;

interface Call {
  command: string;
  kind?: string;
  requestId?: number;
  seconds?: number;
  durationSeconds?: number;
  path?: string | null;
}

async function open(page: Page, nativePreview: "engine" | "off", mix?: unknown): Promise<void> {
  const body = await readFile(resolve("frontend/tests/fixtures/media/two-source-tracks.mp4"));
  await page.route("https://engine.test/media", (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", headers: {
      "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}),
    }, body: body.subarray(start, end + 1) });
  });
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Video.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: DURATION, width: 64, height: 64, fps: 10, has_audio: true } };
  fixture.responses.getMediaUrl = { ok: true, url: "https://engine.test/media", token: "" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  if (mix) fixture.responses.compilePreviewMix = { data: mix };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.addInitScript({ content: fixtureEngineScript({ nativePreview }) });
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toBeVisible();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
}

function engineCalls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window.__fixtureEngine?.calls ?? []).map((call) => {
    const command = call.args.command;
    const fields = typeof command === "object" && command !== null ? command : {};
    const request = call.args.request;
    const opened = call.command === "player_open" && typeof request === "object" && request !== null ? request : {};
    return { command: call.command, ...fields, ...opened };
  }));
}

async function seeks(page: Page): Promise<Call[]> {
  return (await engineCalls(page)).filter((call) => call.kind === "seek");
}

// the playhead's place on the timeline, in seconds
async function playhead(page: Page): Promise<number> {
  const left = await page.locator("#seq-playhead").evaluate((element: HTMLElement) => element.style.left);
  return (Number.parseFloat(left) / 100) * DURATION;
}

test("the native engine drives playback, seeks and frame steps", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "engine");
  await expect.poll(async () => (await engineCalls(page)).find((call) => call.command === "player_open")?.durationSeconds).toBe(DURATION);
  expect((await engineCalls(page)).find((call) => call.command === "player_open")?.path).toBe("C:\\videos\\Video.mp4");
  await expect.poll(() => page.evaluate(() => (window.__fixtureSurface ?? []).some((call) => call.command === "preview_surface_viewport"
    && Number((call.args.viewport as { width?: number } | undefined)?.width) > 0))).toBe(true);

  const play = page.locator("#btn-play");
  await play.click();
  await expect(play).toHaveClass(/playing/);
  const startCalls = (await engineCalls(page)).length;
  await page.waitForTimeout(1000);
  const played = await playhead(page);
  expect(played).toBeGreaterThan(0.7);
  expect(played).toBeLessThan(1.6);
  // the playhead follows the page's clock; the engine is only asked about ten times a second
  const during = (await engineCalls(page)).slice(startCalls);
  expect(during.every((call) => call.command === "player_status")).toBe(true);
  expect(during.length).toBeGreaterThanOrEqual(5);
  expect(during.length).toBeLessThanOrEqual(14);
  expect(await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);

  await play.click();
  await expect(play).not.toHaveClass(/playing/);
  const paused = await playhead(page);
  await page.waitForTimeout(300);
  expect(await playhead(page)).toBeCloseTo(paused, 3);

  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await seeks(page)).at(-1)?.seconds).toBeCloseTo(paused + 0.1, 3);

  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  const y = ruler.y + ruler.height / 2;
  await page.mouse.click(ruler.x + ruler.width / 4, y);
  await expect.poll(async () => (await seeks(page)).at(-1)?.seconds ?? 0).toBeGreaterThan(3);
  expect(await playhead(page)).toBeCloseTo((await seeks(page)).at(-1)!.seconds!, 2);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo((await seeks(page)).at(-1)!.seconds!, 2);

  // a fast scrub sends at most one seek per frame, newest last, with rising request IDs
  const before = (await seeks(page)).length;
  await page.mouse.move(ruler.x + ruler.width / 8, y);
  await page.mouse.down();
  await page.mouse.move(ruler.x + ruler.width * 0.75, y, { steps: 30 });
  await page.mouse.up();
  await expect.poll(async () => (await seeks(page)).at(-1)?.seconds ?? 0).toBeGreaterThan(DURATION * 0.7);
  const scrub = (await seeks(page)).slice(before);
  expect(scrub.length).toBeGreaterThan(1);
  expect(scrub.length).toBeLessThanOrEqual(31);
  const ids = (await seeks(page)).map((call) => call.requestId!);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(ids.length);
  expect(await playhead(page)).toBeCloseTo(scrub.at(-1)!.seconds!, 2);
  expect(await page.evaluate(() => window.__fixtureEngine?.mostInFlight)).toBe(1);

  await page.keyboard.press("Space");
  await expect(play).toHaveClass(/playing/);
  await page.keyboard.press("Space");
  await expect(play).not.toHaveClass(/playing/);
  expect(errors).toEqual([]);
});

test("the engine plays the timeline and the sound compiled from the export request", async ({ page }) => {
  const mix = { duration: DURATION, voices: [{ path: "C:\\videos\\Video.mp4", stream: 0, pieces: [
    { start: 0, end: DURATION, sourceIn: 0, gain: 1, fadeIn: 0, fadeOut: 0, loopStart: 0, loopSpan: 0 }] }] };
  await open(page, "engine", mix);
  const compiles = () => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "compilePreviewMix")
    .map((call) => (call.args[0] as { source?: unknown }).source));
  await expect.poll(() => page.evaluate(() => window.__fixtureEngine?.mixes.length)).toBe(1);
  expect(await page.evaluate(() => window.__fixtureEngine?.mixes[0])).toEqual(mix);
  expect(await page.evaluate(() => window.__fixtureEngine?.edits)).toEqual([{ duration: DURATION, segments: [] }]);
  expect(await compiles()).toEqual(["C:\\videos\\Video.mp4"]);

  // muting the source audio changes what the export would play, so the sound is compiled again
  await page.locator("#source-audio-label").click();
  await expect.poll(() => page.evaluate(() => window.__fixtureEngine?.mixes.length)).toBe(2);
  expect(await compiles()).toHaveLength(2);
  expect(await page.evaluate(() => window.__fixtureEngine?.edits)).toHaveLength(1);
});

test("with the switch off the HTML player plays as before", async ({ page }) => {
  await open(page, "off");
  const play = page.locator("#btn-play");
  await play.click();
  await expect(play).toHaveClass(/playing/);
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.3);
  expect(await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await play.click();
  await expect(play).not.toHaveClass(/playing/);
  expect(await engineCalls(page)).toEqual([]);
  expect(await page.evaluate(() => window.__fixtureSurface ?? [])).toEqual([]);
  await expect(page.locator("html")).not.toHaveClass(/native-preview/);
});

// the native player reads the file itself, so the stage follows its answer, not the webview's
async function openWithoutPreviewLink(page: Page, refuseOpen: boolean): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Video.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: DURATION, width: 64, height: 36, fps: 10, has_audio: false } };
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.addInitScript({ content: fixtureEngineScript({ nativePreview: "engine" }) });
  if (refuseOpen) {
    await page.addInitScript(() => {
      const shell = Reflect.get(window, "__TAURI_INTERNALS__") as { invoke: (command: string, args: unknown) => Promise<unknown> };
      const invoke = shell.invoke;
      shell.invoke = (command, args) => command === "player_open"
        ? Promise.reject({ code: "PLAYER_OPEN_FAILED", message: "The video could not be opened.", details: {} })
        : invoke(command, args);
    });
  }
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toBeVisible();
}

test("a video without a preview link still plays in the native player, placed by its probed size", async ({ page }) => {
  await openWithoutPreviewLink(page, false);
  await expect.poll(async () => (await engineCalls(page)).find((call) => call.command === "player_open")?.path).toBe("C:\\videos\\Video.mp4");
  await expect.poll(() => page.evaluate(() => {
    const viewports = (window.__fixtureSurface ?? []).filter((call) => call.command === "preview_surface_viewport");
    const last = viewports.at(-1)?.args.viewport as { width?: number; height?: number } | undefined;
    return last && last.width && last.height ? Math.round((last.width / last.height) * 100) / 100 : 0;
  })).toBe(1.78);
  await expect(page.locator("#preview-status")).toBeHidden();
  await page.locator("#btn-play").click();
  await expect.poll(async () => (await engineCalls(page)).some((call) => call.kind === "play")).toBe(true);
});

test("a video the native player can't open shows its picture and why", async ({ page }) => {
  await openWithoutPreviewLink(page, true);
  await expect(page.locator("#media-viewport #thumb")).toBeVisible();
  await expect(page.locator("#preview-status")).toContainText("can’t be shown here");
});
