import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const DURATION = 12;

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Alpha.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: DURATION, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".tl-segment .clip-edge.start").first()).toBeVisible();
}

async function edgeCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".tl-segment .clip-edge.start").first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const inPoint = async (page: Page): Promise<number> =>
  Number(await page.locator("#tl-in").getAttribute("aria-valuenow"));

test("pressing a trim edge without moving it leaves the cut where it was", async ({ page }) => {
  await open(page);
  const { x, y } = await edgeCentre(page);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();

  expect(await inPoint(page)).toBe(0);
  await expect(page.locator("#btn-undo")).toBeDisabled();
});

test("a dragged trim edge keeps the spot it was grabbed by", async ({ page }) => {
  await open(page);
  const { x, y } = await edgeCentre(page);
  const track = (await page.locator("#tl-track").boundingBox())!;
  const secondsPerPixel = DURATION / track.width;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y, { steps: 6 });
  await page.mouse.up();

  // the edge moved as far as the pointer did, not to where the pointer sits inside the edge
  expect(Math.abs((await inPoint(page)) - 120 * secondsPerPixel)).toBeLessThan(2 * secondsPerPixel);
  await expect(page.locator("#btn-undo")).toBeEnabled();
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo trim start");
});

test("Esc during a trim puts the edge back and records nothing", async ({ page }) => {
  await open(page);
  const { x, y } = await edgeCentre(page);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y, { steps: 5 });
  expect(await inPoint(page)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();

  expect(await inPoint(page)).toBe(0);
  await expect(page.locator("#btn-undo")).toBeDisabled();
});
