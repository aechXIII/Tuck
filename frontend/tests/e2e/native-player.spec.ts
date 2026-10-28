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

// a small real video the webview can play, at the preview link every test video gets
async function serveMedia(page: Page): Promise<void> {
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
}

async function open(page: Page, nativePreview: "engine" | "off", mix?: unknown, queue?: unknown[]): Promise<void> {
  await serveMedia(page);
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Video.mp4"];
  if (queue) fixture.responses.getQueueState = { items: queue };
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

test("the diagnostic report carries the shell's report on the native player", async ({ page }) => {
  await open(page, "engine");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-nav-about").click();
  await page.getByRole("button", { name: "Copy diagnostic report" }).click();

  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "getDiagnostics").length)).toBe(1);
  const preview = await page.evaluate(() => {
    const context = window.__tuckFakeBackendCalls?.find((call) => call.method === "getDiagnostics")?.args[0];
    return typeof context === "object" && context !== null ? Reflect.get(context, "preview") : undefined;
  });
  expect(preview).toMatchObject({ mode: "engine", library: null, status: { durationSeconds: DURATION } });
});

test("the native picture stays visible in element fullscreen", async ({ page }) => {
  await open(page, "engine");
  await expect(page.locator("html")).toHaveClass(/\bnative-preview\b/);
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe("center");
  const painted = () => page.evaluate(() => {
    const stage = getComputedStyle(document.getElementById("stage")!);
    return {
      stageColor: stage.backgroundColor,
      stageImage: stage.backgroundImage,
      backdrop: getComputedStyle(document.getElementById("center")!, "::backdrop").backgroundColor,
      editor: getComputedStyle(document.getElementById("left")!).visibility,
    };
  });
  // the stage is a black frame around a see-through hole, and nothing between the window and the
  // card paints over the picture
  const inFullscreen = await painted();
  expect(inFullscreen.stageColor).toBe("rgba(0, 0, 0, 0)");
  expect(inFullscreen.stageImage).toContain("linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0))");
  expect(inFullscreen.backdrop).toBe("rgba(0, 0, 0, 0)");
  expect(inFullscreen.editor).toBe("hidden");

  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect((await painted()).editor).toBe("visible");
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

test("a video being opened shows its picture until the engine's first frame takes over", async ({ page }) => {
  await serveMedia(page);
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Video.mp4", "C:\\videos\\Second.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: DURATION, width: 64, height: 64, fps: 10, has_audio: true } };
  fixture.responses.getMediaUrl = { ok: true, url: "https://engine.test/media", token: "" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  // the engine takes a while to show a newly opened video, as a large file does
  await page.addInitScript({ content: fixtureEngineScript({ nativePreview: "engine", frameDelayMs: 1500 }) });
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() =>
    (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getThumbnail").length)).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#thumb")).toHaveCount(0, { timeout: 10_000 });

  // the old picture leaves at once; without its own picture the new video would show black
  await page.locator(".clip", { hasText: "Second.mp4" }).click();
  await expect(page.locator("#thumb")).toBeVisible();
  await expect.poll(async () => (await engineCalls(page)).filter((call) => call.command === "player_open").at(-1)?.path)
    .toBe("C:\\videos\\Second.mp4");
  await expect(page.locator("#thumb")).toHaveCount(0, { timeout: 5_000 });
});

interface Placement {
  viewport: { x: number; y: number; width: number; height: number };
  view: { x: number; y: number; width: number; height: number; quarterTurns: number; flipHorizontal: boolean; flipVertical: boolean; stretch: boolean };
}

// where the shell was last told the picture is, and which part of it shows there
function lastPlacement(page: Page): Promise<Placement | undefined> {
  return page.evaluate(() => (window.__fixtureSurface ?? [])
    .filter((call) => call.command === "preview_surface_viewport").at(-1)?.args as Placement | undefined);
}

async function transform(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((button) => (button as HTMLButtonElement).click());
}

test("the native picture follows the editor's turn and flips", async ({ page }) => {
  await openWithoutPreviewLink(page, false);
  const placed = async () => {
    const placement = await lastPlacement(page);
    if (!placement) return null;
    const { viewport, view } = placement;
    const round = (value: number) => Math.round(value * 100) / 100;
    return { aspect: round(viewport.width / viewport.height), ...view, x: round(view.x), y: round(view.y),
      width: round(view.width), height: round(view.height) };
  };
  const whole = { x: 0, y: 0, width: 1, height: 1, quarterTurns: 0, flipHorizontal: false, flipVertical: false, stretch: false };
  await expect.poll(placed).toEqual({ aspect: 1.78, ...whole });

  // turned right, the 64 by 36 picture stands up in a portrait box
  await transform(page, '[data-action-click="transform-rotation"][data-rotation="90"]');
  await expect.poll(placed).toEqual({ aspect: 0.56, ...whole, quarterTurns: 1 });
  await transform(page, '[data-action-click="transform-flip"][data-action-value="horizontal"]');
  await expect.poll(placed).toEqual({ aspect: 0.56, ...whole, quarterTurns: 1, flipHorizontal: true });

  // while cropping, the whole turned picture stays under the page's crop box, as in the HTML player
  await transform(page, '[data-action-click="transform-crop-aspect"][data-aspect="1:1"]');
  await expect(page.locator("#crop-ui")).toHaveClass(/on/);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(await placed()).toEqual({ aspect: 0.56, ...whole, quarterTurns: 1, flipHorizontal: true });

  await transform(page, '[data-action-click="transform-reset-all"]');
  await expect.poll(placed).toEqual({ aspect: 1.78, ...whole });
});

const REFUSED = "C:\\videos\\Refused.mp4";

// two videos; the engine refuses the first, as it would a file it can't decode
async function openWithRefusedVideo(page: Page): Promise<void> {
  await serveMedia(page);
  const fixture = healthyBackendFixture();
  fixture.startup.files = [REFUSED, "C:\\videos\\Video.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: DURATION, width: 64, height: 64, fps: 10, has_audio: true } };
  fixture.responses.getMediaUrl = { ok: true, url: "https://engine.test/media", token: "" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.addInitScript({ content: fixtureEngineScript({ nativePreview: "engine" }) });
  await page.addInitScript((refused) => {
    const shell = Reflect.get(window, "__TAURI_INTERNALS__") as { invoke: (command: string, args: unknown) => Promise<unknown> };
    const invoke = shell.invoke;
    shell.invoke = (command, args) =>
      command === "player_open" && (args as { request?: { path?: string } } | undefined)?.request?.path === refused
        ? Promise.reject({ code: "VIDEO_FAILED", message: "The video could not be decoded.", details: {} })
        : invoke(command, args);
  }, REFUSED);
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toBeVisible();
}

test("a video the native player can't open plays in the built-in player, and the next one goes back", async ({ page }) => {
  await openWithRefusedVideo(page);
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/native-preview/);
  await expect(page.locator("#vid")).toBeVisible();
  // the native surface draws nothing over the built-in player's picture
  await expect.poll(async () => (await lastPlacement(page))?.viewport.width).toBe(0);
  const play = page.locator("#btn-play");
  await play.click();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.3);
  await play.click();
  await expect(play).not.toHaveClass(/playing/);

  await page.locator("#clips .clip").nth(1).click();
  await expect(html).toHaveClass(/native-preview/);
  await expect.poll(async () => (await engineCalls(page)).filter((call) => call.command === "player_open").map((call) => call.path))
    .toContain("C:\\videos\\Video.mp4");
  await expect.poll(async () => (await lastPlacement(page))?.viewport.width ?? 0).toBeGreaterThan(0);
  // the first video stays with the built-in player
  await page.locator("#clips .clip").first().click();
  await expect(html).not.toHaveClass(/native-preview/);
  expect((await engineCalls(page)).filter((call) => call.command === "player_open" && call.path === REFUSED)).toEqual([]);
});

function calls(page: Page, method: string): Promise<(readonly unknown[])[]> {
  return page.evaluate((method) => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === method).map((call) => call.args), method);
}

test("Hardware playback saves for the next start and offers a restart", async ({ page }) => {
  await open(page, "engine");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const setting = page.getByRole("switch", { name: "Hardware playback", exact: true });
  const restart = page.getByRole("button", { name: "Restart Tuck", exact: true });
  await expect(setting).toBeChecked();
  await expect(restart).toBeHidden();
  await setting.setChecked(false);
  await expect(restart).toBeVisible();
  expect(await calls(page, "setHardwarePlayback")).toEqual([[false]]);
  // this run still plays with the native player, so turning it back on needs no restart
  await setting.setChecked(true);
  await expect(restart).toBeHidden();
  await setting.setChecked(false);
  await restart.click();
  await expect(page.locator("#app-closing")).toContainText("Restarting Tuck");
  await expect.poll(() => calls(page, "restartTuck")).toEqual([[]]);
  // the choice belongs to the shell, never to the backend's settings
  expect(JSON.stringify(await calls(page, "saveSettings"))).not.toContain("hardware");
});

test("restarting for Hardware playback asks before it stops running exports", async ({ page }) => {
  await open(page, "engine", undefined, [{ id: "run", source: "Video.mp4", source_path: "C:\\videos\\Video.mp4", state: "running", progress: 40 }]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Hardware playback", exact: true }).setChecked(false);
  await page.getByRole("button", { name: "Restart Tuck", exact: true }).click();
  await expect(page.getByText("Stop 1 export and restart Tuck?")).toBeVisible();
  expect(await calls(page, "restartTuck")).toEqual([]);
  await page.getByRole("button", { name: "Restart anyway", exact: true }).click();
  await expect.poll(() => calls(page, "restartTuck")).toEqual([[]]);
});

test("a plain browser has no Hardware playback switch", async ({ page }) => {
  test.skip(process.env.TUCK_E2E_NATIVE_PREVIEW === "engine", "the switch's own desktop stand-in plays natively");
  const fixture = healthyBackendFixture();
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Loop playback", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Hardware playback", exact: true })).toHaveCount(0);
});
