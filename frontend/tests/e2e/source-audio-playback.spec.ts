import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { fixtureEngineScript } from "../fixtures/fixture-engine";
import { answerMixes, mixAnswers, newestMixRequest } from "../fixtures/native-mix";

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

interface EngineCommand { command: string; kind?: string; seconds?: number; rate?: number; durationSeconds?: number }

function engineCommands(page: Page): Promise<EngineCommand[]> {
  return page.evaluate(() => (window.__fixtureEngine?.calls ?? []).map((call) => {
    const command = call.args.command;
    const request = call.args.request;
    return {
      command: call.command,
      ...(typeof command === "object" && command !== null ? command : {}),
      ...(call.command === "player_open" && typeof request === "object" && request !== null ? request : {}),
    };
  }));
}

// the native player reads every stream from the file itself and plays the mix Python compiles,
// so what it gets is checked instead of what the page hears
for (const origin of [0, 5]) test(`the native player gets each source stream's mute and gain, a seek and a speed at source origin ${origin}`, async ({ page }) => {
  const source = origin ? "C:\\media\\Two tracks.mkv" : "C:\\media\\Two tracks.mp4";
  const duration = 16 + origin;
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { files: [source] };
  fixture.responses.probeFile = { data: { duration, width: 64, height: 64, fps: 10, has_audio: true, audio_stream_count: 2 } };
  fixture.responses.getThumbnail = { thumbnail: "" };
  fixture.responses.getWaveform = { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" };
  fixture.responses.getMediaUrl = { url: "", token: "video" };
  fixture.responses.releaseMediaToken = { ok: true };
  await installFakeBackend(page, fixture);
  await page.addInitScript({ content: fixtureEngineScript({ nativePreview: "engine" }) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await answerMixes(page, duration);
  await page.locator("#btn-add").click();
  await page.locator("#insp-tab-edit").click();
  await expect.poll(async () => (await engineCommands(page)).find((call) => call.command === "player_open")?.durationSeconds).toBe(duration);

  // each change is mixed again, and the engine plays the answer to the newest request
  const mixed = async (expected: Record<string, unknown>) => {
    await expect.poll(() => newestMixRequest(page)).toMatchObject(expected);
    await expect.poll(async () => {
      const { asked, playing } = await mixAnswers(page);
      return asked > 0 && playing === asked;
    }).toBe(true);
  };
  await mixed({ source, source_audio_muted: false, source_audio_gain_db: 0, source_audio_extra_tracks: [{ muted: false, gain_db: 0 }] });
  const mixer = page.locator("#audio-track-mixer");
  await mixer.getByRole("button", { name: "Mute Source audio", exact: true }).click();
  await mixed({ source_audio_muted: true });
  await mixer.locator(".mixer-row[data-mixer-id='source:1'] .mixer-gain").fill("6");
  await mixed({ source_audio_extra_tracks: [{ muted: false, gain_db: 6 }] });
  await mixer.getByRole("button", { name: "Mute Source audio 2", exact: true }).click();
  await mixed({ source_audio_extra_tracks: [{ muted: true, gain_db: 6 }] });
  await page.locator("#btn-undo").click();
  await mixed({ source_audio_muted: true, source_audio_extra_tracks: [{ muted: false, gain_db: 6 }] });

  // the engine's clock starts at the file's first frame whatever its timestamps say
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * (7 / duration), ruler.y + ruler.height / 2);
  await expect.poll(async () => (await engineCommands(page)).filter((call) => call.kind === "seek").at(-1)?.seconds ?? 0).toBeCloseTo(7, 0);
  await page.keyboard.press(">");
  await expect.poll(async () => (await engineCommands(page)).filter((call) => call.kind === "rate").at(-1)?.rate).toBe(1.5);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).toHaveClass(/playing/);
  await page.locator("#btn-play").click();
  await expect(page.locator("#btn-play")).not.toHaveClass(/playing/);

  // a lossless cut keeps the original tracks, so its own request is mixed, mutes left aside
  await page.getByRole("button", { name: "Lossless cut", exact: true }).click();
  await mixed({ operation: "cut", source, include_audio: true });
  expect(await newestMixRequest(page)).not.toHaveProperty("source_audio_muted");

  // the engine was paused already, so the video leaving asks nothing more of it
  const asked = (await engineCommands(page)).length;
  await page.getByRole("button", { name: origin ? "Remove Two tracks.mkv" : "Remove Two tracks.mp4" }).click();
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "releaseMediaToken").map((call) => call.args[0]))).toContain("video");
  // no stream of the file was ever fetched for the page to play
  expect(await page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "getMediaUrl" && call.args.length === 2).length)).toBe(0);
  await page.waitForTimeout(300);
  expect((await engineCommands(page)).slice(asked)).toEqual([]);
});
