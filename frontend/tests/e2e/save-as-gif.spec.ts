import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, withVideo } from "../fixtures/fake-backend";

const MB = 1024 * 1024;
// one grey pixel, so the picture decodes without a media server
const PICTURE = "data:image/gif;base64,R0lGODlhAQABAIAAAICAgP///ywAAAAAAQABAAACAkQBADs=";

interface Request {
  readonly plan: Record<string, unknown>;
  readonly gif: Record<string, unknown>;
}

async function open(page: Page, preview: unknown = undefined, size = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  const fixture = withVideo(healthyBackendFixture(), "C:\\videos\\Replay.mp4");
  fixture.responses.makeGifPreview = preview ?? {
    url: PICTURE, size_bytes: 2.5 * MB, width: 480, height: 270, fps: 15, frames: 180, seconds: 12,
    lowered: false, fits: true, estimated: false, start_width: 480, start_fps: 15, name: "Replay_tucked.gif",
  };
  fixture.responses.enqueueGif = { item_id: "gif1" };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#clips .clip")).toHaveCount(1);
}

const calls = (page: Page, method: string) =>
  page.evaluate((name) => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === name).map((call) => call.args[0] as Request), method);

async function fromExportMenu(page: Page) {
  await page.locator(".export-actions > summary").click();
  await page.getByRole("button", { name: "Save as GIF…" }).click();
  await expect(page.getByRole("dialog", { name: "Save as GIF" })).toBeVisible();
}

test("Save as GIF makes the real GIF of the timeline and saves it with the settings shown", async ({ page }) => {
  await open(page);
  await fromExportMenu(page);
  const dialog = page.getByRole("dialog", { name: "Save as GIF" });
  await expect(dialog.locator("#gif-n")).toHaveText("2.5");
  await expect(dialog.locator("#gif-from")).toHaveText("Timeline · 12.0 s");
  await expect(dialog.locator("#gif-detail")).toHaveText("480 × 270 · 15 fps · 180 frames");
  await expect(dialog.locator("#gif-name")).toHaveText("Replay_tucked.gif");
  const first = (await calls(page, "makeGifPreview"))[0]!;
  expect(first.plan.source).toBe("C:\\videos\\Replay.mp4");
  expect(first.gif).toMatchObject({ width: 480, fps: 15, colors: 256, plays: 0, size_limit: 0 });

  await dialog.getByRole("group", { name: "Width" }).getByRole("button", { name: "640" }).click();
  await expect(dialog.locator("#gif-state")).toHaveText("Making preview");
  await expect.poll(async () => (await calls(page, "makeGifPreview")).at(-1)?.gif.width).toBe(640);

  // a value no GIF can have is pulled back, and the line under the size says why
  const fps = dialog.getByRole("textbox", { name: "Custom frame rate" });
  await fps.fill("60");
  await fps.press("Enter");
  await expect(dialog.locator("#gif-detail")).toHaveText("A GIF plays at most 50 fps.");
  await expect.poll(async () => (await calls(page, "makeGifPreview")).at(-1)?.gif.fps).toBe(50);
  await expect(dialog.getByRole("group", { name: "Frame rate" }).locator(".gif-custom")).toHaveClass(/\bon\b/);

  await dialog.getByRole("group", { name: "Size limit" }).getByRole("button", { name: "10 MB" }).click();
  await dialog.getByRole("button", { name: "Save GIF" }).click();
  await expect(dialog).toBeHidden();
  const saved = (await calls(page, "enqueueGif"))[0]!;
  expect(saved.gif).toMatchObject({ width: 640, fps: 50, size_limit: 10 * MB });
  expect(saved.plan.source).toBe("C:\\videos\\Replay.mp4");
  expect((await calls(page, "cancelGifPreview")).length).toBeGreaterThan(0);

  // the next time, from the Library's menu, it opens with what it saved with
  await page.locator("#clips .clip").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Save as GIF…" }).click();
  await expect(dialog.getByRole("group", { name: "Width" }).getByRole("button", { name: "640" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("textbox", { name: "Custom frame rate" })).toHaveValue("50");
  // a dialog opened again answers each click once
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await expect(dialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByRole("group", { name: "Dithering" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the preview waits for the exports, and a failure says what happened", async ({ page }) => {
  await open(page, { ok: false, code: "export_running", error: "Tuck makes the preview once the exports finish." });
  await fromExportMenu(page);
  const dialog = page.getByRole("dialog", { name: "Save as GIF" });
  await expect(dialog.locator("#gif-state")).toHaveText("After export");
  // Save still adds it to Exports, after what is running
  await expect(dialog.getByRole("button", { name: "Save GIF" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // the menu's button went with the menu, so focus is back on the arrow
  await expect(page.locator(".export-actions > summary")).toBeFocused();

  await page.evaluate(() => {
    const backend = window.tuckBackendClient as unknown as Record<string, unknown>;
    backend.makeGifPreview = async () => ({ ok: false, error: { code: "FFMPEG_UNAVAILABLE", message: "FFmpeg stopped at 0.4 s.", details: {} } });
  });
  await fromExportMenu(page);
  await expect(dialog.locator("#gif-state")).toHaveText("No preview");
  await expect(dialog.locator("#gif-detail")).toHaveText("FFmpeg stopped at 0.4 s.");
});

test("at the smallest window the dialog fits, every cell lines up and nothing is cut off", async ({ page }) => {
  await open(page, undefined, { width: 960, height: 640 });
  await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans", sans-serif; }' });
  await fromExportMenu(page);
  const dialog = page.getByRole("dialog", { name: "Save as GIF" });
  await expect(dialog.locator("#gif-n")).toHaveText("2.5");
  await dialog.evaluate((box) => Promise.all(box.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(960);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  const layout = await dialog.evaluate((element) => {
    const settings = element.querySelector<HTMLElement>("#gif-settings")!;
    const five = [...element.querySelectorAll<HTMLElement>(".gif-cells")].filter((group) => group.children.length === 5);
    const stage = element.querySelector<HTMLElement>("#gif-stage")!.getBoundingClientRect();
    const picture = element.querySelector<HTMLElement>("#gif-pic")!;
    const shown = picture.getBoundingClientRect();
    return {
      // the GIF is fitted inside the whole stage, whatever its shape
      fitted: [shown.width === stage.width, shown.height === stage.height, getComputedStyle(picture).objectFit],
      // the settings fit beside the picture until Advanced opens
      scrolls: settings.scrollHeight > settings.clientHeight + 1,
      widths: five.map((group) => Math.round((group.firstElementChild as HTMLElement).getBoundingClientRect().width)),
      clipped: [...element.querySelectorAll<HTMLElement>(".gif-cells button, .gif-label")]
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map((cell) => cell.textContent),
    };
  });
  expect(layout.scrolls).toBe(false);
  expect(layout.fitted).toEqual([true, true, "contain"]);
  expect(new Set(layout.widths).size).toBe(1);
  expect(layout.clipped).toEqual([]);
});
