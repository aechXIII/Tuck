import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\recordings\\Stream archive.mp4";

async function open(page: Page, duration: number): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = [VIDEO];
  fixture.responses.probeFile = {
    ok: true,
    data: { duration, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 900_000_000 },
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toHaveCount(1);
}

// how many seconds of the video the timeline shows across its visible width
function secondsOnScreen(page: Page, duration: number): Promise<number> {
  return page.evaluate((full) => {
    const frame = document.getElementById("sequence-frame")!.getBoundingClientRect();
    const track = document.getElementById("tl-track")!.getBoundingClientRect();
    return ((frame.right - Math.max(frame.left, track.left)) / track.width) * full;
  }, duration);
}

function timeAt(page: Page, clientX: number, duration: number): Promise<number> {
  return page.evaluate(
    ({ x, full }) => {
      const track = document.getElementById("tl-track")!.getBoundingClientRect();
      return ((x - track.left) / track.width) * full;
    },
    { x: clientX, full: duration },
  );
}

test("an hour-long recording zooms in until a screen shows a few seconds", async ({ page }) => {
  await open(page, 3600);
  const slider = page.locator("#tl-zoom-slider");
  await expect(slider).toHaveValue("0");
  // the slider reaches as deep as the zoom goes, ten doublings for an hour
  expect(Number(await slider.getAttribute("max"))).toBeGreaterThan(9);

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (let press = 0; press < 12; press += 1) await page.keyboard.press("Control+=");
  const shown = await secondsOnScreen(page, 3600);
  expect(shown).toBeGreaterThan(2);
  expect(shown).toBeLessThan(6);
  await expect(slider).toHaveAttribute("aria-valuetext", /seconds on screen$/);
  // the ruler draws only the ticks near the screen, not tens of thousands
  expect(await page.locator(".seq-tick").count()).toBeLessThan(400);
  expect(await page.locator(".seq-tick span").count()).toBeGreaterThan(1);

  // scrolling far along draws the ruler there too
  await page.locator("#sequence-frame").evaluate((frame) => { frame.scrollLeft = frame.scrollWidth / 2; });
  await expect.poll(async () => {
    const labels = await page.locator(".seq-tick span").allTextContents();
    return labels.some((label) => label.startsWith("30:") || label.startsWith("29:"));
  }).toBe(true);

  await page.keyboard.press("Control+0");
  await expect(slider).toHaveValue("0");
  expect(await secondsOnScreen(page, 3600)).toBeGreaterThan(3500);
});

test("Ctrl+wheel zooms around the pointer and a plain wheel still scrolls", async ({ page }) => {
  await open(page, 600);
  const slider = page.locator("#tl-zoom-slider");
  const track = (await page.locator("#tl-track").boundingBox())!;
  const x = track.x + track.width * 0.3;
  const y = track.y + track.height / 2;
  await page.mouse.move(x, y);
  const before = await timeAt(page, x, 600);

  await page.mouse.wheel(0, -300);
  await expect(slider).toHaveValue("0");

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -400);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(1);
  // the moment under the pointer stays under it
  expect(Math.abs((await timeAt(page, x, 600)) - before)).toBeLessThan(0.5);

  // turning back out stops at the whole video
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 4000);
  await page.keyboard.up("Control");
  await expect(slider).toHaveValue("0");
  expect(await secondsOnScreen(page, 600)).toBeGreaterThan(590);
});
