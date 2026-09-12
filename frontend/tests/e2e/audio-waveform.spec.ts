import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Morning clip.mp4";
const AUDIO = "C:\\media\\Background music.wav";
const WAVEFORM = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><path d="M0 12h120M20 4v16M40 8v8M60 2v20M80 6v12M100 4v16" stroke="white"/></svg>',
);

async function waitForWaveformRequest(page: Page, path: string): Promise<void> {
  await expect.poll(() => page.evaluate((source) =>
    window.__tuckFakeBackendCalls?.some((call) =>
      call.method === "getWaveform" && call.args[0] === source,
    ) ?? false, path,
  )).toBe(true);
}

async function releaseWaveform(page: Page): Promise<void> {
  await page.evaluate((url) => {
    const release = (window as Window & {
      __tuckReleaseHeld?: (method: string, value: unknown) => void;
    }).__tuckReleaseHeld;
    if (!release) throw new Error("The waveform fixture is not installed");
    release("getWaveform", { ok: true, url, token: "waveform-token" });
  }, WAVEFORM);
}

test.beforeEach(async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.holdMethods = ["getWaveform"];
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.pickAudioFiles = { ok: true, files: [AUDIO] };
  fixture.responses.probeFile = {
    ok: true,
    data: {
      duration: 12, file_size: 1_048_576, width: 1920, height: 1080, fps: 30,
      has_audio: true, format: "mp4", video_codec: "h264", audio_codec: "aac",
    },
  };
  fixture.responses.probeAudioFile = {
    ok: true,
    data: { duration: 20, file_size: 2048, channels: 2, sample_rate: 48000, codec: "pcm_s16le" },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "media-token" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.releaseMediaToken = { ok: true };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await waitForWaveformRequest(page, VIDEO);
});

test("source waveform appears after audio state changes during loading", async ({ page }) => {
  const waveform = page.locator("#source-audio-lane .audio-waveform");
  await expect(waveform).toHaveCount(0);

  await page.locator("#source-audio-label").click();
  await releaseWaveform(page);

  await expect(waveform).toBeVisible();
  await expect(waveform).toHaveCSS("background-image", `url("${WAVEFORM}")`);
  await page.locator("#source-audio-label").click();
  await expect(waveform).toBeVisible();
});

test("imported waveform appears after undo replaces its track during loading", async ({ page }) => {
  await releaseWaveform(page);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  await waitForWaveformRequest(page, AUDIO);
  const waveform = page.locator("#imported-audio-tracks .audio-waveform");
  await expect(waveform).toHaveCSS("background-image", "none");

  await page.locator("#imported-audio-tracks .seq-track-mute").click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#imported-audio-tracks .seq-track-mute")).toHaveAttribute("aria-pressed", "false");
  await releaseWaveform(page);

  await expect(waveform).toBeVisible();
  await expect(waveform).toHaveCSS("background-image", `url("${WAVEFORM}")`);
  await page.locator("#imported-audio-tracks .seq-track-mute").click();
  await expect(waveform).toBeVisible();
});
