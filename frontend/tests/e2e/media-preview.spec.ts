import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";
import { fixtureEngineScript, type FixtureEngine } from "../fixtures/fixture-engine";

declare global {
  interface Window {
    __fixtureEngine?: FixtureEngine;
    __fixtureSurface?: Array<{ command: string; args: Record<string, unknown> }>;
  }
}

// these are the webview player's fallbacks; with the native player the stage follows its own
// answer instead, which native-player.spec.ts covers
const nativePreview = process.env.TUCK_E2E_NATIVE_PREVIEW === "engine";
const WEBVIEW_FALLBACK = "the native player decides what the stage shows";

const VIDEO = "C:\\media\\Harbour.mp4";
const PICTURE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function previewFixture(): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true },
  };
  fixture.responses.releaseMediaToken = { ok: true };
  return fixture;
}

async function addVideo(page: Page): Promise<void> {
  await page.locator("#btn-add").click();
  await expect(page.locator(".clip").filter({ hasText: "Harbour.mp4" })).toBeVisible();
}

test("a video without a playable preview shows its picture instead", async ({ page }) => {
  test.skip(nativePreview, WEBVIEW_FALLBACK);
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#thumb")).toHaveCount(0);

  await addVideo(page);

  const picture = page.locator("#media-viewport #thumb");
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("src", PICTURE);
  await expect(page.locator("#vid")).toBeHidden();
});

test("no picture element appears when the video has neither preview nor picture", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await addVideo(page);

  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getThumbnail").length))
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator("#thumb")).toHaveCount(0);
});

test("a preview that fails to play falls back to the picture, and removal clears both", async ({ page }) => {
  test.skip(nativePreview, WEBVIEW_FALLBACK);
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/harbour", token: "token-harbour" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await page.route("https://media.test/**", (route) => route.abort());
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await addVideo(page);
  await expect.poll(() => page.locator("#vid").getAttribute("src")).toBe("https://media.test/harbour");
  await expect(page.locator("#media-viewport #thumb")).toHaveAttribute("src", PICTURE);

  await page.getByRole("button", { name: "Remove Harbour.mp4" }).click();

  await expect(page.getByRole("heading", { name: "Drop a video to compress it" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
      .filter((call) => call.method === "releaseMediaToken")
      .map((call) => call.args)))
    .toEqual([["token-harbour"]]);
  await expect(page.locator("#vid")).not.toHaveAttribute("src", /./);
  await expect(page.locator("#thumb")).toHaveCount(0);
  await expect(page.locator(".tl-segment")).toHaveCount(0);
});

// a WAV plays like an HEVC video does in WebView2 without its extension: sound, no picture
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("a preview that plays sound but no picture keeps the picture and says why", async ({ page }) => {
  test.skip(nativePreview, WEBVIEW_FALLBACK);
  const fixture = previewFixture();
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 2, width: 1920, height: 1080, fps: 30, has_audio: true, video_codec: "hevc" },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/harbour", token: "token-harbour" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await page.route("https://media.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav(2) }));
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await addVideo(page);

  await expect(page.locator("#preview-status")).toContainText(
    "Previewing HEVC needs the HEVC Video Extensions from the Microsoft Store. Export still works.",
  );
  await expect(page.locator("#media-viewport #thumb")).toHaveAttribute("src", PICTURE);
});

test("switching videos shows the new video's own picture while its preview loads, never the last video", async ({ page }) => {
  const fixture = previewFixture();
  fixture.startup.files = [VIDEO, "C:\\media\\Sunset.mp4"];
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  fixture.holdMethods = ["getMediaUrl"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(2);
  const release = (url: string): Promise<void> => page.evaluate((value) => {
    window.__tuckReleaseHeld?.("getMediaUrl", { ok: true, url: value, token: value });
  }, url);
  await release("https://media.test/harbour");
  await expect.poll(() => page.locator("#vid").getAttribute("src")).toBe("https://media.test/harbour");
  // wait for the second video's picture, so the switch has one to show
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getThumbnail").length)).toBeGreaterThanOrEqual(2);

  await page.locator(".clip").filter({ hasText: "Sunset.mp4" }).click();

  await expect(page.locator("#vid")).not.toHaveAttribute("src", /./);
  await expect(page.locator("#media-viewport #thumb")).toHaveAttribute("src", PICTURE);
  await expect(page.locator("#preview-status")).toContainText("Loading preview…");

  await release("https://media.test/sunset");
  await expect.poll(() => page.locator("#vid").getAttribute("src")).toBe("https://media.test/sunset");
});

test("a video with neither a preview nor a picture says so and offers Retry", async ({ page }) => {
  test.skip(nativePreview, WEBVIEW_FALLBACK);
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await addVideo(page);

  await expect(page.locator("#preview-status")).toContainText("Can’t show a preview of this video.");
  const retry = page.locator("#preview-status").getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  const asked = () => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getMediaUrl").length);
  const before = await asked();
  await retry.click();
  await expect.poll(asked).toBeGreaterThan(before);
});

// the native player reads the file itself, so these fallbacks of the webview's preview link
// don't decide what the stage shows; the shell stand-in is this spec's own in every run
async function openNative(page: Page, fixture: FakeBackendFixture, refuseOpen = false): Promise<void> {
  await installFakeBackend(page, fixture);
  await page.addInitScript({ content: fixtureEngineScript({ nativePreview: "engine" }) });
  if (refuseOpen) {
    await page.addInitScript(() => {
      const shell = Reflect.get(window, "__TAURI_INTERNALS__") as { invoke: (command: string, args: unknown) => Promise<unknown> };
      const invoke = shell.invoke;
      shell.invoke = (command, args) => command === "player_open"
        ? Promise.reject({ code: "VIDEO_FAILED", message: "The video could not be decoded.", details: {} })
        : invoke(command, args);
    });
  }
  await page.goto("/");
  await addVideo(page);
}

function engineCommands(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__fixtureEngine?.calls ?? []).map((call) => {
    const command = call.args.command;
    const kind = typeof command === "object" && command !== null ? Reflect.get(command, "kind") : undefined;
    return typeof kind === "string" ? `${call.command}:${kind}` : call.command;
  }));
}

// a status that is still hidden after the stage's loading delay (250 ms) stays hidden
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(400);
}

// the width the shell was last told to give the native picture; 0 hides it
function pictureWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const placed = (window.__fixtureSurface ?? []).filter((call) => call.command === "preview_surface_viewport").at(-1);
    return Number((placed?.args.viewport as { width?: number } | undefined)?.width ?? 0);
  });
}

test("a video without a playable preview plays in the native player, not as its picture", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await openNative(page, fixture);

  await expect.poll(() => engineCommands(page)).toContain("player_open");
  await expect(page.locator("html")).toHaveClass(/\bnative-preview\b/);
  await expect.poll(() => pictureWidth(page)).toBeGreaterThan(0);
  await settled(page);
  // the still picture would cover the native one
  await expect(page.locator("#media-viewport #thumb")).toBeHidden();
  await expect(page.locator("#preview-status")).toBeHidden();
});

test("a preview link that fails doesn't stop the native player, and removal stops it and clears the stage", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/harbour", token: "token-harbour" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await page.route("https://media.test/**", (route) => route.abort());
  await openNative(page, fixture);
  await expect.poll(() => page.locator("#vid").getAttribute("src")).toBe("https://media.test/harbour");
  await expect.poll(() => pictureWidth(page)).toBeGreaterThan(0);
  await settled(page);
  await expect(page.locator("#media-viewport #thumb")).toBeHidden();
  await expect(page.locator("#preview-status")).toBeHidden();
  const play = page.locator("#btn-play");
  await play.click();
  await expect(play).toHaveClass(/playing/);

  await page.getByRole("button", { name: "Remove Harbour.mp4" }).click();

  await expect(page.getByRole("heading", { name: "Drop a video to compress it" })).toBeVisible();
  // the engine has no close, so the video that left is paused and nothing asks about it after
  await expect.poll(async () => (await engineCommands(page)).filter((command) => command !== "player_status").at(-1))
    .toBe("player_command:pause");
  const asked = (await engineCommands(page)).length;
  await expect.poll(() => pictureWidth(page)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "releaseMediaToken").map((call) => call.args))).toEqual([["token-harbour"]]);
  await expect(page.locator("#thumb")).toHaveCount(0);
  await expect(page.locator(".tl-segment")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect((await engineCommands(page)).slice(asked)).toEqual([]);
});

test("a video the webview plays as sound only shows its picture in the native player, with no codec note", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 2, width: 1920, height: 1080, fps: 30, has_audio: true, video_codec: "hevc" },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/harbour", token: "token-harbour" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await page.route("https://media.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav(2) }));
  await openNative(page, fixture);

  await expect.poll(() => engineCommands(page)).toContain("player_open");
  // the webview has the sound and found no picture, which is when its own player says why
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => pictureWidth(page)).toBeGreaterThan(0);
  await settled(page);
  await expect(page.locator("#preview-status")).toBeHidden();
  await expect(page.locator("#media-viewport #thumb")).toBeHidden();
});

test("with neither a preview link nor a picture the native player still shows the video", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await openNative(page, fixture);

  await expect.poll(() => engineCommands(page)).toContain("player_open");
  await expect.poll(() => pictureWidth(page)).toBeGreaterThan(0);
  await settled(page);
  await expect(page.locator("#preview-status")).toBeHidden();
});

test("when the native player refuses a video that has neither a preview nor a picture, Retry asks again", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await openNative(page, fixture, true);

  await expect(page.locator("html")).not.toHaveClass(/native-preview/);
  await expect(page.locator("#preview-status")).toContainText("Can’t show a preview of this video.");
  const retry = page.locator("#preview-status").getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  const asked = () => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getMediaUrl").length);
  const before = await asked();
  await retry.click();
  await expect.poll(asked).toBeGreaterThan(before);
});
