import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Recording.mkv";
const WAVEFORM = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><path d="M20 4v16M60 2v20" stroke="white"/></svg>',
);

async function open(page: Page, audioStreamCount?: number): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: {
      duration: 12, width: 1920, height: 1080, fps: 60, has_audio: true,
      ...(audioStreamCount === undefined ? {} : { audio_stream_count: audioStreamCount }),
    },
  };
  fixture.responses.getWaveform = { ok: true, url: WAVEFORM, token: "waveform-token" };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "media-token" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.releaseMediaToken = { ok: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  await expect(page.locator("#source-audio-lane .seq-audio-clip")).toHaveCount(1);
}

async function lastPlanRequest(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const calls = (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan");
    const last = calls[calls.length - 1];
    return last ? (last.args[0] as Record<string, unknown>) : null;
  });
}

// Shift-drag across a lane, from and to a share of its width
async function chooseStretch(page: Page, lane: string, from: number, to: number): Promise<void> {
  const box = (await page.locator(lane).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from + to) / 2), y, { steps: 3 });
  await page.mouse.move(box.x + box.width * to, y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

test("Export as shows only when more than one track is kept, and mixes by default", async ({ page }) => {
  await open(page, 2);
  await page.locator("#insp-tab-edit").click();
  const row = page.locator("#audio-layout-row");
  await expect(row).toBeVisible();
  const one = row.getByRole("button", { name: "One track" });
  const separate = row.getByRole("button", { name: "Separate tracks" });
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#audio-layout-note")).toContainText("Discord and phones play both");
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.mix_audio_tracks)).toBe(true);

  await separate.click();
  await expect(separate).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#audio-layout-note")).toContainText("most players only play the first");
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.mix_audio_tracks)).toBe(false);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo export as separate tracks");
  await page.locator("#btn-undo").click();
  await expect(one).toHaveAttribute("aria-pressed", "true");

  // with one track left there is nothing to mix
  await page.locator("#audio-track-mixer").getByRole("button", { name: "Mute Source audio 2", exact: true }).click();
  await expect(row).toBeHidden();

  await page.getByRole("button", { name: "Lossless cut", exact: true }).click();
  await page.locator("#audio-track-mixer").waitFor({ state: "attached" });
  await expect(row).toBeHidden();
  await expect(page.locator("#audio-loudness-row")).toBeHidden();
});

test("a video with one audio track has no Export as choice", async ({ page }) => {
  await open(page);
  await page.locator("#insp-tab-edit").click();
  await expect(page.locator("#audio-loudness-row")).toBeVisible();
  await expect(page.locator("#audio-layout-row")).toBeHidden();
});

test("Even out loudness is off until switched on, and the switch is one undo step", async ({ page }) => {
  await open(page);
  await page.locator("#insp-tab-edit").click();
  const toggle = page.getByRole("switch", { name: "Even out loudness" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#audio-loudness-note")).toContainText("The preview plays without it.");
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.even_out_loudness)).toBe(false);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.even_out_loudness)).toBe(true);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo even out loudness");

  // with no audio in the export there is nothing to even out
  await page.getByRole("switch", { name: "Include audio in export" }).click();
  await expect(toggle).toBeDisabled();
});

test("a chosen stretch is muted as one undo step and shows as a quiet gap", async ({ page }) => {
  await open(page);
  await chooseStretch(page, "#source-audio-lane", 0.25, 0.5);
  await expect(page.locator("#source-audio-lane .audio-range-selection")).toHaveCount(1);
  const mute = page.locator("#audio-fragment-mute");
  await expect(mute).toHaveText(/Mute selection/);
  // choosing a stretch is not an edit
  await expect(page.locator("#btn-undo")).toBeDisabled();

  await page.keyboard.press("m");
  const stretch = page.locator("#source-audio-lane .audio-mute-range");
  await expect(stretch).toHaveCount(1);
  await expect(page.locator("#source-audio-lane .audio-range-selection")).toHaveCount(0);
  await expect(stretch).toHaveAttribute("aria-pressed", "true");
  await expect(mute).toHaveText(/Mute audio/);
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo mute range");
  await expect.poll(async () => {
    const ranges = (await lastPlanRequest(page))?.source_audio_mute_ranges as { start: number; end: number }[] | undefined;
    return ranges?.map((range) => [Math.round(range.start), Math.round(range.end)]);
  }).toEqual([[3, 6]]);

  await page.locator("#btn-undo").click();
  await expect(stretch).toHaveCount(0);
  await expect.poll(() => lastPlanRequest(page).then((request) => request?.source_audio_mute_ranges)).toBeUndefined();
  await page.locator("#btn-redo").click();
  await expect(stretch).toHaveCount(1);

  // picked again, Delete unmutes it
  await stretch.click();
  await page.keyboard.press("Delete");
  await expect(stretch).toHaveCount(0);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo unmute range");
  // the video's segment was never touched
  await expect(page.locator("#source-audio-lane .seq-audio-clip")).toHaveCount(1);
});

test("a stretch is marked from the keyboard with Shift+I and Shift+O and muted with M", async ({ page }) => {
  await open(page);
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  const seek = (share: number) => page.mouse.click(ruler.x + ruler.width * share, ruler.y + ruler.height / 2);
  const band = page.locator("#source-audio-lane .audio-range-selection");
  const mute = page.locator("#audio-fragment-mute");

  // from the playhead to the end, then its end brought back to the playhead
  await seek(0.25);
  await page.keyboard.press("Shift+I");
  await expect(band).toHaveCount(1);
  await expect(mute).toHaveText(/Mute selection/);
  // marking is not an edit, and plain I and O still belong to trimming
  await expect(page.locator("#btn-undo")).toBeDisabled();
  await seek(0.5);
  await page.keyboard.press("Shift+O");
  await page.keyboard.press("m");
  await expect(band).toHaveCount(0);
  await expect(page.locator("#source-audio-lane .audio-mute-range")).toHaveCount(1);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo mute range");
  await expect.poll(async () => {
    const ranges = (await lastPlanRequest(page))?.source_audio_mute_ranges as { start: number; end: number }[] | undefined;
    return ranges?.map((range) => [Math.round(range.start), Math.round(range.end)]);
  }).toEqual([[3, 6]]);

  // Shift+O alone marks from the start to the playhead
  await page.keyboard.press("Escape");
  await seek(0.75);
  await page.keyboard.press("Shift+O");
  await expect(band).toHaveCount(1);
  const shown = await band.evaluate((element) => ({ left: element.style.left, width: Number.parseFloat(element.style.width) }));
  expect(shown.left).toBe("0%");
  expect(shown.width).toBeCloseTo(75, 0);
});

test("a muted stretch on the second track is sent with that track and its end follows O", async ({ page }) => {
  await open(page, 2);
  await chooseStretch(page, "#source-extra-tracks .audio-lane", 0.5, 0.75);
  await page.locator("#audio-fragment-mute").click();
  await expect(page.locator("#source-extra-tracks .audio-mute-range")).toHaveCount(1);
  await expect(page.locator("#source-audio-lane .audio-mute-range")).toHaveCount(0);
  const extraRanges = async () => {
    const tracks = (await lastPlanRequest(page))?.source_audio_extra_tracks as { mute_ranges?: { start: number; end: number }[] }[] | undefined;
    return tracks?.[0]?.mute_ranges?.map((range) => [Math.round(range.start), Math.round(range.end)]);
  };
  await expect.poll(extraRanges).toEqual([[6, 9]]);

  // the playhead moves to 10 s and O sets the picked stretch's end there
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * (10 / 12), ruler.y + ruler.height / 2);
  await page.locator("#source-extra-tracks .audio-mute-range").click();
  await page.keyboard.press("o");
  await expect.poll(extraRanges).toEqual([[6, 10]]);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo trim mute range");
});

test("Escape lets go of a chosen stretch without muting it", async ({ page }) => {
  await open(page);
  await chooseStretch(page, "#source-audio-lane", 0.2, 0.4);
  await expect(page.locator(".audio-range-selection")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".audio-range-selection")).toHaveCount(0);
  await expect(page.locator("#audio-fragment-mute")).toHaveText(/Mute audio/);
});
