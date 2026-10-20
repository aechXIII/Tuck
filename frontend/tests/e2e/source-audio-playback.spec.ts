import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

declare global {
  interface Window {
    __sourceAudioNodes: Array<{ audio: HTMLMediaElement; gain: GainNode; analyser: AnalyserNode }>;
  }
}

async function levels(page: Page): Promise<number[]> {
  return page.evaluate(() => window.__sourceAudioNodes.map(({ analyser }) => {
    const values = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(values);
    return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  }));
}

for (const origin of [0, 5]) test(`preview plays each source stream with mute and gain, seek and rate at source origin ${origin}`, async ({ page }) => {
  test.skip(process.env.TUCK_E2E_NATIVE_PREVIEW === "engine", "the native player plays the sound in its own mix, so the page plays none");
  // the first stream is 440 Hz, the second is 880 Hz and marked as the default
  const prefix = origin ? "offset-" : "";
  const videoName = origin ? "two-source-tracks.mkv" : "two-source-tracks.mp4";
  const source = origin ? "C:\\media\\Two tracks.mkv" : "C:\\media\\Two tracks.mp4";
  const files = await Promise.all([videoName, "source-track-0.m4a", "source-track-1.m4a"]
    .map((name) => readFile(resolve("frontend/tests/fixtures/media", prefix + name))));
  await page.route("https://source.test/**", (route) => {
    const name = new URL(route.request().url()).pathname;
    const index = name === "/video" ? 0 : name === "/audio-0" ? 1 : 2;
    const body = files[index]!;
    const requested = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = requested ? Number(requested[1]) : 0;
    const end = requested?.[2] ? Math.min(Number(requested[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: requested ? 206 : 200, contentType: index === 0 ? (origin ? "video/x-matroska" : "video/mp4") : "audio/mp4", headers: {
      "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes",
      ...(requested ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}),
    }, body: body.subarray(start, end + 1) });
  });
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { files: [source] };
  fixture.responses.probeFile = { data: { duration: 16 + origin, width: 64, height: 64, fps: 10, has_audio: true, audio_stream_count: 2 } };
  fixture.responses.getThumbnail = { thumbnail: "" };
  fixture.responses.getWaveform = { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" };
  await installFakeBackend(page, fixture);
  await page.addInitScript(() => {
    window.__sourceAudioNodes = [];
    const originalSource = AudioContext.prototype.createMediaElementSource;
    const originalGain = AudioContext.prototype.createGain;
    let audio: HTMLMediaElement;
    AudioContext.prototype.createMediaElementSource = function (element) { audio = element; return originalSource.call(this, element); };
    AudioContext.prototype.createGain = function () {
      const gain = originalGain.call(this);
      const analyser = this.createAnalyser();
      analyser.fftSize = 8192;
      const silent = originalGain.call(this);
      silent.gain.value = 0;
      gain.connect(analyser).connect(silent).connect(this.destination);
      window.__sourceAudioNodes.push({ audio, gain, analyser });
      return gain;
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    window.tuckBackendClient!.getMediaUrl = async (_path, track) => ({ ok: true, value: {
      url: `https://source.test/${track === undefined ? "video" : `audio-${track}`}`,
      token: track === undefined ? "video" : `audio-${track}`,
    } });
  });
  await page.locator("#btn-add").click();
  await page.locator("#insp-tab-edit").click();
  await expect.poll(() => page.evaluate(() => window.__sourceAudioNodes.length)).toBe(2);
  await expect(page.locator("#source-audio-preview-status")).toBeHidden();
  await page.locator("#btn-play").click();
  await expect.poll(() => levels(page).then((values) => values.every((value) => value > 0.01))).toBe(true);
  expect(await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThanOrEqual(origin);
  expect(await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.volume)).toBe(0);
  const frequencies = await page.evaluate(() => window.__sourceAudioNodes.map(({ analyser }) => {
    const values = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(values);
    let maximum = 0;
    for (let i = 1; i < values.length; i++) if (values[i]! > values[maximum]!) maximum = i;
    return maximum * analyser.context.sampleRate / analyser.fftSize;
  }));
  expect(frequencies[0]).toBeCloseTo(440, -1);
  expect(frequencies[1]).toBeCloseTo(880, -1);

  const mixer = page.locator("#audio-track-mixer");
  await mixer.getByRole("button", { name: "Mute Source audio", exact: true }).click();
  await expect.poll(() => levels(page).then((values) => values[0])).toBeLessThan(0.001);
  const beforeGain = (await levels(page))[1]!;
  await mixer.locator(".mixer-row[data-mixer-id='source:1'] .mixer-gain").fill("6");
  await expect.poll(() => levels(page).then((values) => values[1]! / beforeGain)).toBeGreaterThan(1.8);
  await mixer.getByRole("button", { name: "Mute Source audio 2", exact: true }).click();
  await expect.poll(() => levels(page).then((values) => Math.max(...values))).toBeLessThan(0.001);
  await page.locator("#btn-undo").click();
  await expect.poll(() => levels(page).then((values) => values[1])).toBeGreaterThan(0.01);

  await page.locator("#vid").evaluate((video: HTMLVideoElement, time) => { video.currentTime = time; video.playbackRate = 1.5; }, origin + 7);
  await expect.poll(() => page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("#vid")!;
    return window.__sourceAudioNodes.every(({ audio }) => audio.playbackRate === 1.5 && Math.abs(audio.currentTime - video.currentTime) < 0.2);
  })).toBe(true);
  await page.locator("#btn-play").click();
  await expect.poll(() => page.evaluate(() => window.__sourceAudioNodes.every(({ audio }) => audio.paused))).toBe(true);
  await page.getByRole("button", { name: "Lossless cut", exact: true }).click();
  await page.locator("#btn-play").click();
  // a lossless cut keeps the original tracks, so export mixer mutes and gains step aside
  await expect.poll(() => levels(page).then((values) => values.every((value) => value > 0.01))).toBe(true);
  expect(await page.evaluate(() => window.__sourceAudioNodes.map(({ gain }) => gain.gain.value)))
    .toEqual([expect.closeTo(0.8, 4), expect.closeTo(0.8, 4)]);
  await page.getByRole("button", { name: origin ? "Remove Two tracks.mkv" : "Remove Two tracks.mp4" }).click();
  await expect.poll(() => page.evaluate(() => window.__sourceAudioNodes.every(({ audio }) => audio.paused && !audio.getAttribute("src")))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "releaseMediaToken").map((call) => call.args[0]))).toEqual(expect.arrayContaining(["audio-0", "audio-1", "video"]));
});
