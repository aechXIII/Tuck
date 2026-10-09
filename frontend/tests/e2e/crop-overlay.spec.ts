import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Crop me.mp4";

async function openCrop(page: Page): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 1_048_576 },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/crop", token: "crop" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  fixture.responses.enqueueWithOptions = { ok: true };
  await page.route("https://media.test/**", (route) => route.abort());
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await expect(page.getByRole("button", { name: "Compress this video" })).toBeEnabled();
  await page.locator("#insp-tab-edit").click();
  await page.getByRole("group", { name: "Crop aspect ratio" }).getByRole("button", { name: "Free" }).click();
  await expect(page.locator("#crop-selection")).toBeVisible();
}

function rect(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width };
  });
}

test("crop handles sit on the selection and dragging one crops the export", async ({ page }) => {
  await openCrop(page);

  const handles = page.locator("#crop-selection [data-handle]");
  await expect(handles).toHaveCount(8);
  for (const handle of await handles.all()) await expect(handle).toBeVisible();
  const selection = await rect(page, "#crop-selection");
  const centre = async (name: string) => {
    const box = (await page.locator(`#crop-selection [data-handle="${name}"]`).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  // handles sit just inside their corner or edge, so they stay grabbable at the frame border
  const middleX = (selection.left + selection.right) / 2;
  const middleY = (selection.top + selection.bottom) / 2;
  const anchors: Record<string, { x: number; y: number }> = {
    nw: { x: selection.left, y: selection.top }, n: { x: middleX, y: selection.top },
    ne: { x: selection.right, y: selection.top }, e: { x: selection.right, y: middleY },
    se: { x: selection.right, y: selection.bottom }, s: { x: middleX, y: selection.bottom },
    sw: { x: selection.left, y: selection.bottom }, w: { x: selection.left, y: middleY },
  };
  for (const [name, anchor] of Object.entries(anchors)) {
    const point = await centre(name);
    expect(point.x, name).toBeGreaterThan(selection.left);
    expect(point.x, name).toBeLessThan(selection.right);
    expect(point.y, name).toBeGreaterThan(selection.top);
    expect(point.y, name).toBeLessThan(selection.bottom);
    expect(Math.hypot(point.x - anchor.x, point.y - anchor.y), name).toBeLessThan(16);
  }
  const se = await centre("se");

  const width = selection.right - selection.left;
  const height = selection.bottom - selection.top;
  await page.mouse.move(se.x, se.y);
  await page.mouse.down();
  await page.mouse.move(se.x - width / 4, se.y - height / 4, { steps: 8 });
  await page.mouse.up();

  const cropped = await rect(page, "#crop-selection");
  expect(cropped.left).toBeCloseTo(selection.left, 0);
  expect(cropped.width / width).toBeGreaterThan(0.68);
  expect(cropped.width / width).toBeLessThan(0.82);

  await page.locator("#insp-tab-export").click();
  await page.getByRole("button", { name: "Compress this video" }).click();
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "enqueueWithOptions").length))
    .toBe(1);
  const request = await page.evaluate(
    () => (window.__tuckFakeBackendCalls ?? []).find((call) => call.method === "enqueueWithOptions")!.args[0] as Record<string, unknown>,
  );
  const transform = request.transform as { crop: { x: number; y: number; width: number; height: number } };
  expect(transform).toMatchObject({ crop: { x: 0, y: 0 }, crop_aspect: "free", rotation: 0 });
  // the exported crop matches what the overlay shows, in source pixels
  expect(transform.crop.width / 1920).toBeCloseTo(cropped.width / width, 1);
  expect(transform.crop.height / 1080).toBeCloseTo((cropped.bottom - cropped.top) / height, 1);
});

test("the crop overlay follows the preview when the window resizes", async ({ page }) => {
  await openCrop(page);
  const se = (await page.locator('#crop-selection [data-handle="se"]').boundingBox())!;
  const before = await rect(page, "#crop-selection");
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x - before.width / 3, se.y - 40, { steps: 8 });
  await page.mouse.up();
  const share = async () => {
    const selection = await rect(page, "#crop-selection");
    const frame = await rect(page, "#crop-dim-bottom");
    return { share: selection.width / frame.width, width: selection.width };
  };
  const wide = await share();
  expect(wide.share).toBeLessThan(0.9);

  await page.setViewportSize({ width: 960, height: 640 });

  await expect.poll(async () => (await share()).width).toBeLessThan(wide.width - 1);
  expect((await share()).share).toBeCloseTo(wide.share, 2);
  const selection = await rect(page, "#crop-selection");
  const stage = await rect(page, "#stage");
  expect(selection.left).toBeGreaterThanOrEqual(stage.left - 1);
  expect(selection.right).toBeLessThanOrEqual(stage.right + 1);
});
