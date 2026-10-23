import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";

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
