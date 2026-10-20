import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Recording.mkv";
const WAVEFORM = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><path d="M20 4v16M60 2v20" stroke="white"/></svg>',
);

async function open(page: Page, audioStreamCount: number | undefined, waveform = WAVEFORM): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: {
      duration: 12, width: 1920, height: 1080, fps: 60, has_audio: true,
      ...(audioStreamCount === undefined ? {} : { audio_stream_count: audioStreamCount }),
    },
  };
  fixture.responses.getWaveform = { ok: true, url: waveform, token: "waveform-token" };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "media-token" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.releaseMediaToken = { ok: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
}

// the newest export request the page asked the backend to plan
async function lastPlanRequest(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const calls = (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan");
    const last = calls[calls.length - 1];
    return last ? (last.args[0] as Record<string, unknown>) : null;
  });
}

test("each of a video's audio tracks has a timeline row with its own waveform", async ({ page }) => {
  await open(page, 3);

  const rows = page.locator("#source-extra-tracks .seq-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".seq-track-name")).toHaveText(["Source audio 2", "Source audio 3"]);
  await expect(rows.nth(1).locator(".audio-waveform").first()).toHaveCSS("mask-image", `url("${WAVEFORM}")`);
  const asked = await page.evaluate(() =>
    (window.__tuckFakeBackendCalls ?? [])
      .filter((call) => call.method === "getWaveform")
      .map((call) => call.args),
  );
  expect(asked).toEqual(expect.arrayContaining([[expect.any(String)], [expect.any(String), 1], [expect.any(String), 2]]));

  // the other tracks follow the video's segments, like the first one
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.4, ruler.y + ruler.height / 2);
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator("#source-audio-lane .seq-audio-clip")).toHaveCount(2);
  await expect(rows.nth(0).locator(".seq-audio-clip")).toHaveCount(2);
});

test("multitrack preview asks for each exact audio stream and reports unavailable audio", async ({ page }) => {
  test.skip(process.env.TUCK_E2E_NATIVE_PREVIEW === "engine", "the native player plays the sound in its own mix, so the page plays none");
  await open(page, 2);
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "getMediaUrl" && call.args.length === 2)
    .map((call) => call.args))).toEqual([[VIDEO, 0], [VIDEO, 1]]);
  await expect(page.locator("#source-audio-preview-status")).toContainText("Could not preview source audio");
});

test("an empty waveform response leaves the mixer responsive and does not retry itself", async ({ page }) => {
  await open(page, 2, "");
  await page.locator("#insp-tab-edit").click({ timeout: 3000 });
  await page.locator("#audio-track-mixer").getByRole("button", { name: "Mute Source audio 2", exact: true }).click({ timeout: 3000 });
  await expect(page.locator("#source-extra-tracks .seq-row")).toHaveClass(/muted/);
  expect(await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getWaveform").length)).toBeLessThan(10);
});

test("a muted track is left out of the export and the mute can be undone", async ({ page }) => {
  await open(page, 3);

  const mute = page.getByRole("button", { name: "Mute Source audio 2", exact: true });
  await mute.click();
  const unmute = page.getByRole("button", { name: "Unmute Source audio 2", exact: true }).first();
  await expect(unmute).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#source-extra-tracks .seq-row").first()).toHaveClass(/muted/);
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.source_audio_extra_tracks))
    .toEqual([{ muted: true, gain_db: 0 }, { muted: false, gain_db: 0 }]);

  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo mute track");
  await page.locator("#btn-undo").click();
  await expect(page.getByRole("button", { name: "Mute Source audio 2", exact: true }).first())
    .toHaveAttribute("aria-pressed", "false");
});

test("the Inspector mixer lists every source track before added audio", async ({ page }) => {
  await open(page, 3);
  await page.locator("#insp-tab-edit").click();

  const mixer = page.locator("#audio-track-mixer");
  await expect(mixer.locator(".mixer-name")).toHaveText(["Source audio", "Source audio 2", "Source audio 3"]);
  await expect(mixer.locator(".mixer-track-code")).toHaveText(["A1", "A2", "A3"]);

  await mixer.getByRole("button", { name: "Mute Source audio 3", exact: true }).click();
  await expect(page.locator("#source-extra-tracks .seq-row").nth(1)).toHaveClass(/muted/);

  const gain = mixer.locator(".mixer-row[data-mixer-id='source:1'] .mixer-gain");
  await gain.fill("-6");
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.source_audio_extra_tracks))
    .toEqual([{ muted: false, gain_db: -6 }, { muted: true, gain_db: 0 }]);
});

test("a video with one audio track shows no extra rows and sends no track settings", async ({ page }) => {
  await open(page, undefined);
  await expect(page.locator("#source-audio-lane .seq-audio-clip")).toHaveCount(1);
  await expect(page.locator("#source-extra-tracks .seq-row")).toHaveCount(0);
  await expect.poll(() => lastPlanRequest(page)).not.toBeNull();
  expect(await lastPlanRequest(page)).not.toHaveProperty("source_audio_extra_tracks");
});

test("a lossless cut keeps every track, so their mute buttons step aside", async ({ page }) => {
  await open(page, 2);
  await page.getByRole("button", { name: "Lossless cut", exact: true }).click();
  const mute = page.locator("#source-extra-tracks .seq-track-mute");
  await expect(mute).toBeDisabled();
  await expect(mute).toBeHidden();
  await expect(page.locator("#source-extra-tracks .seq-row")).not.toHaveClass(/muted/);
});
