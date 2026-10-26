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
  await page.locator("#btn-add").click();
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

function cropNumbers(page: Page) {
  return Promise.all(
    ["#crop-left", "#crop-top", "#crop-width", "#crop-height"].map((id) => page.locator(id).inputValue()),
  );
}

test("crop numbers and the crop box follow each other, and each change is one undo step", async ({ page }) => {
  await openCrop(page);
  const group = page.getByRole("group", { name: "Crop in source pixels" });
  await expect(group).toBeVisible();
  expect(await cropNumbers(page)).toEqual(["0", "0", "1920", "1080"]);

  // typing waits for Enter, then the box takes the new size
  const before = await rect(page, "#crop-selection");
  await page.locator("#crop-width").fill("960");
  expect((await rect(page, "#crop-selection")).width).toBeCloseTo(before.width, 0);
  await page.locator("#crop-width").press("Enter");
  await expect.poll(async () => (await rect(page, "#crop-selection")).width).toBeCloseTo(before.width / 2, 0);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo crop");

  // a position past the frame stops at its edge, and an odd size becomes even
  await page.locator("#crop-left").fill("5000");
  await page.locator("#crop-left").press("Enter");
  await page.locator("#crop-height").fill("501");
  await page.locator("#crop-height").press("Tab");
  expect(await cropNumbers(page)).toEqual(["960", "0", "960", "502"]);
  // something that isn't a number puts the current value back
  await page.locator("#crop-top").fill("");
  await page.locator("#crop-top").press("Enter");
  await expect(page.locator("#crop-top")).toHaveValue("0");

  // dragging the box updates the numbers
  const box = (await page.locator("#crop-selection").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - box.width / 2, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const [left, top] = await cropNumbers(page);
  expect(Number(left)).toBeLessThan(960);
  expect(Number(top)).toBeGreaterThan(0);

  await page.locator("#btn-undo").click();
  expect(await cropNumbers(page)).toEqual(["960", "0", "960", "502"]);
});

test("arrow keys move the focused crop box, Shift takes bigger steps and Alt resizes", async ({ page }) => {
  await openCrop(page);
  await page.locator("#crop-width").fill("800");
  await page.locator("#crop-width").press("Enter");
  await page.locator("#crop-height").fill("600");
  await page.locator("#crop-height").press("Enter");
  await page.locator("#crop-left").fill("100");
  await page.locator("#crop-left").press("Enter");
  await page.locator("#crop-top").fill("80");
  await page.locator("#crop-top").press("Enter");

  const playhead = () => page.locator("#seq-playhead").evaluate((element) => (element as HTMLElement).style.left);
  const playheadBefore = await playhead();
  const crop = page.getByRole("group", { name: "Crop box" });
  await crop.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  expect(await cropNumbers(page)).toEqual(["101", "90", "800", "600"]);
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+Shift+ArrowUp");
  expect(await cropNumbers(page)).toEqual(["101", "90", "802", "580"]);
  // the box keeps the arrows: the playhead and the Library selection don't move
  expect(await playhead()).toBe(playheadBefore);
  await expect(crop).toBeFocused();
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo crop");
  await page.locator("#btn-undo").click();
  expect(await cropNumbers(page)).toEqual(["101", "90", "802", "600"]);

  // a locked ratio sets the other side to match
  await page.getByRole("group", { name: "Crop aspect ratio" }).getByRole("button", { name: "16:9" }).click();
  await page.locator("#crop-width").fill("1280");
  await page.locator("#crop-width").press("Enter");
  const [, , width, height] = await cropNumbers(page);
  expect(Number(width) / Number(height)).toBeCloseTo(16 / 9, 2);
  expect(width).toBe("1280");
});

test("crop numbers hide when crop is off", async ({ page }) => {
  await openCrop(page);
  await page.getByRole("group", { name: "Crop aspect ratio" }).getByRole("button", { name: "Off" }).click();
  await expect(page.locator("#crop-numbers")).toBeHidden();
});
