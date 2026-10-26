import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, type FakeBackendFixture } from "../fixtures/fake-backend";

const MORNING = "C:\\videos\\Morning ride.mp4";
const EVENING = "C:\\videos\\Evening.mp4";
const BROKEN = "C:\\videos\\Broken.mp4";
const readable = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };

function fixtureFor(files: string[]): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.startup.files = files;
  fixture.responses.probeFile = readable;
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  return fixture;
}

async function open(page: Page, fixture: FakeBackendFixture, count: number): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(count);
  // timeline edits need decoded media metadata as well as probe data
  await page.locator("#vid").evaluate((video) => {
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
  });
}

const card = (page: Page, name: string) => page.locator(".clip", { hasText: name });

// a rotation is an undoable edit on the selected video; its control sits in a closed Inspector tab
async function rotate(page: Page): Promise<void> {
  await page.locator('[data-action-click="transform-rotation"][data-rotation="90"]').evaluate((button) => (button as HTMLButtonElement).click());
}

test("removing a video can be undone, edits and undo steps included", async ({ page }) => {
  await open(page, fixtureFor([MORNING, EVENING]), 2);
  await card(page, "Morning ride.mp4").click();
  await rotate(page);
  await expect(page.locator("#btn-undo")).toBeEnabled();
  await expect(card(page, "Morning ride.mp4")).toHaveAttribute("title", /90°/);

  await card(page, "Morning ride.mp4").getByRole("button", { name: "Remove Morning ride.mp4" }).click();
  await expect(page.locator(".clip")).toHaveCount(1);
  // the removed video's steps leave with it, so Undo can't reach into a video that isn't there
  await expect(page.locator("#btn-undo")).toBeDisabled();
  const note = page.locator(".toast", { hasText: "Removed “Morning ride.mp4”." });
  await note.getByRole("button", { name: "Undo", exact: true }).click();

  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator(".clip").first()).toContainText("Morning ride.mp4");
  await expect(card(page, "Morning ride.mp4")).toHaveClass(/sel/);
  await expect(card(page, "Morning ride.mp4")).toHaveAttribute("title", /90°/);
  await expect(page.locator("#btn-undo")).toBeEnabled();
  await page.locator("#btn-undo").click();
  await expect(card(page, "Morning ride.mp4")).not.toHaveAttribute("title", /90°/);
});

test("Ctrl+Delete and Ctrl+Backspace remove the current video, and Undo brings it back", async ({ page }) => {
  await open(page, fixtureFor([MORNING, EVENING]), 2);
  await card(page, "Morning ride.mp4").click();
  await rotate(page);
  // with a card focused its own Delete key answers, so start from nowhere in particular
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press("Control+Delete");
  await expect(page.locator(".clip")).toHaveCount(1);
  await expect(card(page, "Evening.mp4")).toHaveClass(/sel/);
  await page.locator(".toast", { hasText: "Removed “Morning ride.mp4”." })
    .getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(card(page, "Morning ride.mp4")).toHaveClass(/sel/);
  await expect(card(page, "Morning ride.mp4")).toHaveAttribute("title", /90°/);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+Backspace");
  await expect(page.locator(".clip")).toHaveCount(1);
  await expect(page.locator(".toast", { hasText: "Removed “Morning ride.mp4”." })).toBeVisible();
});

test("Ctrl+Backspace in a text field edits the text and keeps the video", async ({ page }) => {
  await open(page, fixtureFor([MORNING, EVENING]), 2);
  const size = page.locator("#sz-badge");
  await size.fill("42");
  await size.press("Control+Backspace");
  await size.press("Control+Delete");
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator(".toast", { hasText: "Removed" })).toHaveCount(0);
});

test("Remove all asks first when videos have edits, and can be undone", async ({ page }) => {
  await open(page, fixtureFor([MORNING, EVENING]), 2);
  await rotate(page);
  await page.locator("#btn-rmall").click();
  const dialog = page.getByRole("dialog", { name: "Remove all 2 videos?" });
  await expect(dialog).toContainText("Edits to 1 video go with it.");
  await expect(dialog.getByRole("button", { name: "Keep videos" })).toBeFocused();
  await dialog.getByRole("button", { name: "Keep videos" }).click();
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator("#btn-rmall")).toBeFocused();

  await page.locator("#btn-rmall").click();
  const remove = dialog.getByRole("button", { name: "Remove all" });
  await expect(remove).toHaveClass(/danger/);
  await remove.click();
  await expect(page.locator(".clip")).toHaveCount(0);
  await page.locator(".toast", { hasText: "Removed 2 videos." }).getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".clip")).toHaveCount(2);
  await expect(page.locator(".clip").first()).toContainText("Morning ride.mp4");
});

test("dialogs keep focus inside and leave the editor inert until they close", async ({ page }) => {
  await open(page, fixtureFor([MORNING, EVENING]), 2);
  await rotate(page);
  await page.locator("#btn-rmall").click();
  const dialog = page.getByRole("dialog", { name: "Remove all 2 videos?" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await page.locator("#editor-shell").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Remove all" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Keep videos" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.locator("#editor-shell").evaluate((node) => (node as HTMLElement).inert)).toBe(false);
  await expect(page.locator("#btn-rmall")).toBeFocused();
});

test("Compress all goes ahead without a video that can't be read, and names it", async ({ page }) => {
  const fixture = fixtureFor([MORNING, BROKEN, EVENING]);
  fixture.responseSequences = { probeFile: [readable, { ok: false, error: "moov atom not found" }, readable] };
  fixture.responses.enqueueBatch = { ok: true, enqueued: ["a", "b"], errors: [], count: 2 };
  await open(page, fixture, 3);
  await expect(card(page, "Broken.mp4")).toContainText("Can't read file");
  await page.locator(".export-actions > summary").click();
  const all = page.locator("#btn-all");
  await expect(all).toBeEnabled();
  await expect(all).toContainText("Compress all (2)");
  await expect(page.locator("#btn-all-note")).toHaveText("“Broken.mp4” can’t be read and will be skipped.");
  await all.click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.find((call) => call.method === "enqueueBatch")?.args[0])).toHaveLength(2);
  const sources = await page.evaluate(() =>
    (window.__tuckFakeBackendCalls?.find((call) => call.method === "enqueueBatch")?.args[0] as Array<{ source: string }>).map((request) => request.source));
  expect(sources).toEqual([MORNING, EVENING]);
});

test("a missing FFprobe is said once, and its videos point at Settings", async ({ page }) => {
  const fixture = fixtureFor([MORNING, EVENING]);
  fixture.responses.getSettings = { ...(fixture.responses.getSettings as object), ffmpeg_available: true, ffprobe_available: false };
  fixture.responses.probeFile = { ok: false, error: "ffprobe was not found" };
  await open(page, fixture, 2);
  await expect(page.locator(".toast", { hasText: "Tuck can’t find FFprobe, so videos can’t be read." })).toHaveCount(1);
  await expect(card(page, "Morning ride.mp4").locator(".c-status")).toHaveText("No FFprobe");
  await expect(card(page, "Morning ride.mp4").locator(".c-reason")).toHaveText(
    "Tuck can’t read videos without FFprobe. Choose it in Settings > Media tools.");
  await card(page, "Evening.mp4").getByRole("button", { name: "Set up FFprobe in Settings" }).click();
  await expect(page.getByRole("heading", { name: "Media tools" })).toBeVisible();
});

test("Add segment's tooltip follows its shortcut when the key changes", async ({ page }) => {
  const fixture = fixtureFor([MORNING]);
  fixture.responses.getSettings = { ...(fixture.responses.getSettings as object), shortcut_overrides: { "timeline.add-segment": ["N"] } };
  await open(page, fixture, 1);
  // a shorter segment leaves room for another, which is when the button names its key
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await page.getByRole("button", { name: "Remove active segment" }).click();
  await expect(page.locator("#btn-segment-add")).toHaveAttribute("aria-disabled", "false");
  await expect(page.locator("#btn-segment-add")).toHaveAttribute("data-tip", "Add segment (N)");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard", exact: true }).click();
  await page.getByRole("button", { name: "Change N for Add segment" }).click();
  await expect(page.locator(".kb-row.capturing")).toHaveCount(1);
  await page.keyboard.press("j");
  await expect(page.locator("#kb-status")).toContainText("now uses J");
  await page.keyboard.press("Escape");
  await expect(page.locator("#btn-segment-add")).toHaveAttribute("data-tip", "Add segment (J)");
});
