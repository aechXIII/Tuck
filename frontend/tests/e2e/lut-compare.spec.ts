import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { nativePreview, sentLuts } from "../fixtures/lut-check";

type Rgb = [number, number, number];

// output red/green/blue come from input blue/green/red, so the two sides differ in color
function swapTable(): number[] {
  const table: number[] = [];
  for (let blue = 0; blue < 2; blue++) for (let green = 0; green < 2; green++) for (let red = 0; red < 2; red++) table.push(blue, green, red);
  return table;
}

async function openWithLut(page: Page): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: ["C:/swatch.mp4"] };
  fixture.responses.probeFile = { ok: true, data: { width: 160, height: 90, duration: 3, fps: 30, has_audio: false } };
  fixture.responses.getMediaUrl = { ok: false, error: "No media server in this test" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.pickLutFile = { path: "swap.cube" };
  fixture.responses.loadLut = { path: "swap.cube", name: "Swap", size: 2, table_url: "https://lut.test/table", token: "lut" };
  await page.route("https://lut.test/table", (route) => route.fulfill({
    body: Buffer.from(new Float32Array(swapTable()).buffer),
    headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  await expect(page.locator(".clip")).toHaveCount(1);
  if (!nativePreview) {
    await page.locator("#vid").evaluate(async (video: HTMLVideoElement) => {
      const source = document.createElement("canvas");
      source.width = 160;
      source.height = 90;
      const context = source.getContext("2d")!;
      context.fillStyle = "rgb(32,96,192)";
      context.fillRect(0, 0, 160, 90);
      video.srcObject = source.captureStream(0);
      await video.play();
      video.pause();
    });
  }
  await page.locator("#lut-panel > summary").click();
  await page.locator("#lut-import").click();
  await expect(page.locator("#lut-current-name")).toHaveText("Swap");
}

/** the color the page shows at a point, as a screenshot sees it */
async function screenPixel(page: Page, x: number, y: number): Promise<Rgb> {
  const shot = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return [red!, green!, blue!] as Rgb;
  }, shot.toString("base64"));
}

function near(actual: Rgb, expected: Rgb, tolerance = 6): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
}

/** the original shows left of the divider and the LUT right of it, measured on screen */
async function expectSplitOnScreen(page: Page): Promise<void> {
  const area = (await page.locator("#lut-compare").boundingBox())!;
  const divider = (await page.locator("#lut-compare-divider").boundingBox())!;
  const line = divider.x + divider.width / 2;
  const y = area.y + area.height * 0.7;
  await expect.poll(async () => near(await screenPixel(page, (area.x + line) / 2, y), [32, 96, 192])).toBe(true);
  await expect.poll(async () => near(await screenPixel(page, (line + area.x + area.width) / 2, y), [192, 96, 32])).toBe(true);
}

async function lastSplit(page: Page): Promise<number | null | undefined> {
  return (await sentLuts(page)).at(-1)?.split;
}

test("Compare splits the preview into the original and the LUT, and the divider follows keys and drags", async ({ page }) => {
  await openWithLut(page);
  const compare = page.getByRole("switch", { name: "Compare", exact: true });
  const overlay = page.locator("#lut-compare");
  const divider = page.getByRole("slider", { name: "Split between original and LUT" });
  const layer = page.locator("[data-lut-preview]");
  await expect(compare).toBeEnabled();
  await expect(compare).not.toBeChecked();
  await expect(overlay).toBeHidden();

  await compare.check();
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".lc-label-original")).toHaveText("Original");
  await expect(page.locator("#lut-compare-name")).toHaveText("Swap");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await expect(divider).toHaveAttribute("aria-valuetext", "50% original");

  // the divider covers exactly the picture and starts in its middle
  const video = (await page.locator("#vid").boundingBox())!;
  const area = (await overlay.boundingBox())!;
  const handle = (await divider.boundingBox())!;
  expect(Math.abs(area.width / area.height - 16 / 9)).toBeLessThan(0.02);
  expect(Math.abs(area.x + area.width / 2 - (video.x + video.width / 2))).toBeLessThan(1.5);
  expect(Math.abs(handle.x + handle.width / 2 - (area.x + area.width / 2))).toBeLessThan(1.5);

  if (nativePreview) {
    // the split travels with the LUT; the table already sent stays
    await expect.poll(() => lastSplit(page)).toBe(0.5);
    const last = (await sentLuts(page)).at(-1)!;
    expect([last.bytes, last.size]).toEqual([0, 2]);
  } else {
    await expect(layer).toHaveCSS("clip-path", "inset(0px 0px 0px 50%)");
    await expectSplitOnScreen(page);
  }

  // the divider's keys move it and don't also reach the editor's shortcuts
  await page.evaluate(() => {
    Reflect.set(window, "__keysSeen", 0);
    window.addEventListener("keydown", () => Reflect.set(window, "__keysSeen", Number(Reflect.get(window, "__keysSeen")) + 1));
  });
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuetext", "60% original");
  expect(await page.evaluate(() => Reflect.get(window, "__keysSeen"))).toBe(0);
  if (nativePreview) await expect.poll(async () => Math.round((await lastSplit(page) ?? 0) * 100)).toBe(60);
  else await expect(layer).toHaveCSS("clip-path", "inset(0px 0px 0px 60%)");

  // pressing without moving changes nothing; a drag follows the pointer from where it grabbed
  const grab = (await divider.boundingBox())!;
  const grabX = grab.x + grab.width / 2 + 4;
  const grabY = grab.y + grab.height * 0.8;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuetext", "60% original");
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - area.width * 0.3, grabY, { steps: 4 });
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuetext", "30% original");
  const dropped = (await divider.boundingBox())!;
  expect(Math.abs(dropped.x + dropped.width / 2 - (area.x + area.width * 0.3))).toBeLessThan(1.5);
  if (nativePreview) await expect.poll(async () => Math.round((await lastSplit(page) ?? 0) * 100)).toBe(30);
  else await expectSplitOnScreen(page);

  await divider.focus();
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("aria-valuetext", "100% original");
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuetext", "0% original");

  // turning Compare off shows the LUT on the whole picture again
  await compare.uncheck();
  await expect(overlay).toBeHidden();
  if (nativePreview) await expect.poll(() => lastSplit(page)).toBe(null);
  else await expect(layer).toHaveCSS("clip-path", "none");

  // a fresh comparison starts in the middle
  await compare.check();
  await expect(divider).toHaveAttribute("aria-valuetext", "50% original");
});

test("Compare follows a turned picture and turns off with the LUT", async ({ page }) => {
  await openWithLut(page);
  const compare = page.getByRole("switch", { name: "Compare", exact: true });
  const overlay = page.locator("#lut-compare");
  await compare.check();

  await page.locator("#insp-tab-edit").click();
  await page.getByRole("button", { name: "90° right", exact: true }).click();
  // the turned picture is tall, and the divider still splits it left and right on screen
  await expect.poll(async () => {
    const area = (await overlay.boundingBox())!;
    return Math.abs(area.width / area.height - 9 / 16) < 0.02;
  }).toBe(true);
  if (nativePreview) {
    expect(await lastSplit(page)).toBe(0.5);
  } else {
    // a quarter turn right puts the box's bottom edge on the left of the screen
    await expect(page.locator("[data-lut-preview]")).toHaveCSS("clip-path", "inset(0px 0px 50%)");
    await expectSplitOnScreen(page);
  }

  await page.locator("#insp-tab-export").click();
  const apply = page.getByRole("switch", { name: "Apply LUT", exact: true });
  await apply.uncheck();
  await expect(overlay).toBeHidden();
  await expect(compare).toBeDisabled();
  await expect(compare).not.toBeChecked();
  if (nativePreview) await expect.poll(async () => (await sentLuts(page)).at(-1)?.size).toBe(0);
  await apply.check();
  await expect(compare).toBeEnabled();
  await expect(compare).not.toBeChecked();
  await expect(overlay).toBeHidden();
});
