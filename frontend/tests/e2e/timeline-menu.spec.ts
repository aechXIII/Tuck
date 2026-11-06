import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

// a 12 second video, so a share of the timeline is a round number of seconds
const LENGTH = 12;

async function open(page: Page, options: { sound?: boolean; cut?: boolean } = {}): Promise<void> {
  const sound = options.sound ?? true;
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: ["C:\\media\\Round one.mp4"] };
  fixture.responses.probeFile = { ok: true, data: { duration: LENGTH, width: 1920, height: 1080, fps: 60, has_audio: sound } };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "media-token" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.releaseMediaToken = { ok: true };
  fixture.responses.pickAudioFiles = { ok: true, files: ["C:\\music\\Outro.wav"] };
  fixture.responses.probeAudioFile = { ok: true, data: { duration: 4, channels: 2, sample_rate: 48000 } };
  // the file stays where it is, so the timeline can be checked after Shift+Delete on its row
  fixture.responses.moveVideosToTrash = [{ path: "C:\\media\\Round one.mp4", outcome: "failed" }];
  if (options.cut) {
    // Lossless cut reads the keyframes first; a real reading keeps the task from stopping halfway
    const time = (seconds: number) => ({ ticks: String(Math.round(seconds * 10)), time_base_num: 1, time_base_den: 10 });
    const analysis = {
      work_id: "scan", status: "ready", progress: 1, coverage_end: time(LENGTH), keyframes: [time(0), time(4), time(8)], issue: null,
      analysis: { duration: time(LENGTH), frame_duration: { ticks: "1", time_base_num: 1, time_base_den: 60 }, exact_available: false, exact_reason: "", issues: [], version: "1", streams: [] },
    };
    fixture.responses.getCutAnalysis = analysis;
    fixture.responses.analyzeCut = analysis;
    fixture.responses.getSettings = { ...fixture.responses.getSettings as object, last_task: "cut" };
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  await expect(page.locator(".tl-segment")).toHaveCount(1);
}

async function seek(page: Page, seconds: number): Promise<void> {
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + (ruler.width * seconds) / LENGTH, ruler.y + ruler.height / 2);
}

async function rightClick(page: Page, seconds: number, lane = "#tl-track"): Promise<void> {
  const track = (await page.locator("#tl-track").boundingBox())!;
  const row = (await page.locator(lane).first().boundingBox())!;
  await page.mouse.click(track.x + (track.width * seconds) / LENGTH, row.y + row.height / 2, { button: "right" });
}

const menu = (page: Page) => page.locator("#timeline-edit-menu");
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name, exact: true });
const preview = (page: Page, kind: string) => page.locator(`#seq-edit-preview .edit-preview-${kind}`);
const undo = (page: Page) => page.locator("#btn-undo");

// each segment's place on the timeline in seconds, read from where it is drawn
function segments(page: Page): Promise<[number, number][]> {
  return page.locator(".tl-segment").evaluateAll((items, length) => items.map((item) => {
    const left = parseFloat((item as HTMLElement).style.left) / 100 * length;
    const width = parseFloat((item as HTMLElement).style.width) / 100 * length;
    return [Math.round(left * 100) / 100, Math.round((left + width) * 100) / 100] as [number, number];
  }), LENGTH);
}

async function splitThreeWays(page: Page): Promise<void> {
  await seek(page, 0.5);
  for (const at of [3, 6]) {
    await rightClick(page, at);
    await item(page, "Split here").click();
  }
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 6], [6, 12]]);
}

test("Split here splits at the pointer, and each item shows what it will do while it is lit", async ({ page }) => {
  await open(page);
  await seek(page, 0.5);
  await rightClick(page, 3);
  // one segment: nothing to delete, so Delete and Ripple delete aren't offered; keys only where they do the same
  await expect(menu(page).getByRole("menuitem")).toHaveText([
    "Split here", "Trim start to here", "Trim end to here", "Cut out from the playhead", "Add marker here", "Mute segmentShift+M",
  ]);
  // a line marks where the menu acts, with its time, until an item that acts elsewhere is lit
  await expect(preview(page, "here")).toHaveCount(1);
  await expect(preview(page, "time")).toHaveText("0:03.00");
  await item(page, "Split here").hover();
  await expect(preview(page, "cut")).toHaveCount(1);
  await expect(preview(page, "here")).toHaveCount(0);
  await expect(preview(page, "time")).toHaveText("0:03.00");
  await item(page, "Split here").click();
  await expect(menu(page)).toBeHidden();
  await expect(page.locator("#seq-edit-preview > *")).toHaveCount(0);
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 12]]);
  await expect(page.locator("#tl-corner-time")).toHaveText("0:03.00");
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo split");

  await rightClick(page, 6);
  await item(page, "Delete").hover();
  await expect(preview(page, "gone")).not.toHaveCount(0);
  // the whole segment goes, so the line where the menu was opened doesn't show
  await expect(preview(page, "here")).toHaveCount(0);
  await expect(preview(page, "land")).toHaveCount(0);
  // a timeline that plays its segments back to back leaves no black behind
  await expect(preview(page, "black")).toHaveCount(0);
  await item(page, "Ripple delete").hover();
  await expect(preview(page, "gone")).not.toHaveCount(0);
  await expect(preview(page, "land")).toHaveCount(1);
  await expect(preview(page, "time")).toHaveText("\u22129.00s");
  await page.keyboard.press("Escape");
  await expect(page.locator("#seq-edit-preview > *")).toHaveCount(0);
});

test("Delete leaves a gap, and the gap's menu closes it", async ({ page }) => {
  await open(page);
  await splitThreeWays(page);
  await rightClick(page, 4);
  await item(page, "Delete").click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [6, 12]]);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo remove segment");

  await rightClick(page, 4.5, "#source-audio-lane");
  // the only gap: Close all gaps isn't offered
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Close gap"]);
  await item(page, "Close gap").hover();
  await expect(preview(page, "cut")).toHaveCount(2);
  await expect(preview(page, "land")).toHaveCount(1);
  await expect(preview(page, "time")).toHaveText("\u22123.00s");
  await item(page, "Close gap").click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 9]]);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo close gap");
  await undo(page).click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [6, 12]]);
});

test("Ripple delete slides what comes after it, markers too, as one undo step", async ({ page }) => {
  await open(page);
  await splitThreeWays(page);
  await seek(page, 9);
  await page.locator("#btn-marker").click();
  const flag = page.locator("#seq-marker-layer .seq-marker-flag");
  await expect(flag).toHaveAccessibleName("Marker at 0:09.00");

  await rightClick(page, 4);
  await item(page, "Ripple delete").hover();
  await expect(preview(page, "land")).toHaveCount(1);
  await item(page, "Ripple delete").click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 9]]);
  await expect(flag).toHaveAccessibleName("Marker at 0:06.00");
  await expect(page.locator("#tl-corner-time")).toHaveText("0:03.00");
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo ripple delete");
  await undo(page).click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 6], [6, 12]]);
  await expect(flag).toHaveAccessibleName("Marker at 0:09.00");
});

test("Cut out takes out the stretch from the playhead to the pointer", async ({ page }) => {
  await open(page);
  await seek(page, 3);
  await rightClick(page, 5);
  await item(page, "Cut out from the playhead").hover();
  await expect(preview(page, "from")).toHaveCount(1);
  // the line keeps its time at the far end, and the move is shown where the rest lands
  await expect(preview(page, "time")).toHaveText(["0:05.00", "\u22122.00s"]);
  await item(page, "Cut out from the playhead").click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 10]]);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo cut out");

  // the playhead is on the cut now, not inside the second segment, so there's nothing to cut out from it
  await rightClick(page, 7);
  await expect(item(page, "Split here")).toBeVisible();
  await expect(item(page, "Cut out from the playhead")).toHaveCount(0);
});

test("Shift+F10 opens the menu on a focused segment, and Shift+Delete ripples it", async ({ page }) => {
  await open(page);
  await splitThreeWays(page);
  const middle = page.locator('.tl-segment[data-segment-index="1"]');
  await middle.focus();
  await page.keyboard.press("Shift+F10");
  // like a right-click, the menu selects the segment it acts on
  await expect(middle).toHaveAttribute("aria-pressed", "true");
  await expect(item(page, "Split here")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "Delete")).toBeFocused();
  await expect(preview(page, "gone")).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(middle).toBeFocused();

  await page.keyboard.press("Shift+Delete");
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 9]]);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo ripple delete");

  // on a Library row the same keys are for the Trash, and the timeline stays as it is
  await page.locator("#clips .clip").first().focus();
  await page.keyboard.press("Shift+Delete");
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "moveVideosToTrash").length)).toBe(1);
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 9]]);
});

test("added audio has Split here and Delete", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const clips = page.locator(".seq-audio-clip.imported");
  await expect(clips).toHaveCount(1);
  await seek(page, 10);
  await rightClick(page, 2, ".seq-audio-clip.imported");
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Split here", "DeleteDelete"]);
  await item(page, "Split here").click();
  await expect(clips).toHaveCount(2);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo split audio");
  await rightClick(page, 3, ".seq-audio-clip.imported");
  await item(page, "Delete").hover();
  await expect(preview(page, "gone")).toHaveCount(1);
  await item(page, "Delete").click();
  await expect(clips).toHaveCount(1);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo delete audio clip");
});

test("the menu opens above the ruler, beside the line where it acts", async ({ page }) => {
  await open(page);
  await rightClick(page, 4);
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  const box = (await menu(page).boundingBox())!;
  const line = (await preview(page, "here").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(ruler.y);
  expect(Math.abs(box.x - (line.x + 10))).toBeLessThan(2);
  // the line runs down the video and its sound
  const sound = (await page.locator("#source-audio-lane").boundingBox())!;
  expect(line.y + line.height).toBeGreaterThanOrEqual(sound.y + sound.height - 1);
});

test("Trim start and Trim end to here cut the segment at the line and close up behind it", async ({ page }) => {
  await open(page);
  await seek(page, 1);
  await rightClick(page, 6);
  await item(page, "Split here").click();
  await expect.poll(() => segments(page)).toEqual([[0, 6], [6, 12]]);

  await rightClick(page, 8);
  await item(page, "Trim start to here").hover();
  await expect(preview(page, "gone")).not.toHaveCount(0);
  await expect(preview(page, "time").filter({ hasText: "\u2212" })).toHaveText("\u22122.00s");
  await item(page, "Trim start to here").click();
  await expect.poll(() => segments(page)).toEqual([[0, 6], [6, 10]]);
  await expect(page.locator('.tl-segment[data-segment-index="1"]')).toHaveAttribute("aria-pressed", "true");
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo trim start");

  await rightClick(page, 4);
  await item(page, "Trim end to here").hover();
  // the rest lands on the line, so the move takes the place of the line's time
  await expect(preview(page, "time")).toHaveText("\u22122.00s");
  await item(page, "Trim end to here").click();
  await expect.poll(() => segments(page)).toEqual([[0, 4], [4, 8]]);
  await expect(page.locator('.tl-segment[data-segment-index="0"]')).toHaveAttribute("aria-pressed", "true");
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo trim end");
  await undo(page).click();
  await expect.poll(() => segments(page)).toEqual([[0, 6], [6, 10]]);
});

test("Add marker here adds one where you right-clicked, on a segment or on the ruler", async ({ page }) => {
  await open(page);
  await rightClick(page, 5);
  await item(page, "Add marker here").hover();
  await expect(preview(page, "marker")).toHaveCount(1);
  await item(page, "Add marker here").click();
  const flags = page.locator("#seq-marker-layer .seq-marker-flag");
  await expect(flags).toHaveCount(1);
  await expect(flags.first()).toHaveAccessibleName("Marker at 0:05.00");
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo add marker");
  // one is already there
  await rightClick(page, 5);
  await expect(item(page, "Add marker here")).toHaveCount(0);
  await page.keyboard.press("Escape");

  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + (ruler.width * 9) / LENGTH, ruler.y + ruler.height / 2, { button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Add marker here", "Split here"]);
  await item(page, "Add marker here").click();
  await expect(flags).toHaveCount(2);
  await expect(flags.nth(1)).toHaveAccessibleName("Marker at 0:09.00");
});

test("Mute segment mutes the right-clicked segment's sound, and then offers Unmute", async ({ page }) => {
  await open(page);
  await seek(page, 1);
  await rightClick(page, 6);
  await item(page, "Split here").click();
  await rightClick(page, 2);
  await item(page, "Mute segment").hover();
  await expect(preview(page, "quiet")).not.toHaveCount(0);
  await expect(preview(page, "here")).toHaveCount(0);
  await item(page, "Mute segment").click();
  const first = page.locator('#source-audio-lane .seq-audio-clip[data-segment-index="0"]');
  await expect(first).toHaveClass(/\bmuted\b/);
  await expect(page.locator('#source-audio-lane .seq-audio-clip[data-segment-index="1"]')).not.toHaveClass(/\bmuted\b/);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo mute segment");
  await rightClick(page, 2);
  await item(page, "Unmute segment").click();
  await expect(first).not.toHaveClass(/\bmuted\b/);
  await expect(undo(page)).toHaveAttribute("aria-label", "Undo unmute segment");
});

test("Delete says when it leaves black in the export", async ({ page }) => {
  await open(page);
  await splitThreeWays(page);
  // a ripple delete places the timeline, so a gap left open from then on exports as black
  await rightClick(page, 4);
  await item(page, "Ripple delete").click();
  await expect.poll(() => segments(page)).toEqual([[0, 3], [3, 9]]);
  await rightClick(page, 1);
  await item(page, "Delete").hover();
  await expect(preview(page, "black")).toHaveText("3.00s of black");
  // the last segment leaves nothing after it to play
  await page.keyboard.press("Escape");
  await rightClick(page, 6);
  await item(page, "Delete").hover();
  await expect(preview(page, "black")).toHaveCount(0);
});

test("a video without sound has nothing to mute, so Mute segment isn't offered", async ({ page }) => {
  await open(page, { sound: false });
  await rightClick(page, 4);
  await expect(item(page, "Split here")).toBeVisible();
  await expect(item(page, "Mute segment")).toHaveCount(0);
});

test("Lossless cut keeps the sound as it is, so its menu offers no Mute segment", async ({ page }) => {
  await open(page, { cut: true });
  await rightClick(page, 6);
  await expect(item(page, "Split here")).toBeVisible();
  await expect(item(page, "Mute segment")).toHaveCount(0);
});
