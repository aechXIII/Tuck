import { expect, test } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

test("a dragged trim edge shows the snap guide only while it is snapped", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Alpha.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  // pointer trims start from the segment's edge; #tl-in is its keyboard handle and reports the value
  const edge = page.locator(".tl-segment .clip-edge.start").first();
  const handle = page.locator("#tl-in");
  const guide = page.locator("#seq-snap-guide");
  await expect(edge).toBeVisible();
  const box = (await edge.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  // far from every snap point: the edge moves freely and no guide shows
  await page.mouse.move(x + 160, y, { steps: 8 });
  await expect(handle).not.toHaveAttribute("aria-valuenow", "0");
  await expect(guide).toBeHidden();
  await expect(page.locator("#timeline")).not.toHaveAttribute("data-snapped");
  // back within reach of the clip start: the edge lands on it and the guide marks it.
  // the edge keeps the spot it was grabbed by, so it is the edge, not the pointer, that comes near
  const track = (await page.locator("#tl-track").boundingBox())!;
  const grab = x - track.x;
  await page.mouse.move(track.x + grab + 4, y, { steps: 8 });
  await expect(handle).toHaveAttribute("aria-valuenow", "0");
  await expect(guide).toBeVisible();
  await expect(page.locator("#timeline")).toHaveAttribute("data-snapped", "start");
  await page.mouse.up();
  await expect(guide).toBeHidden();
  await expect(page.locator("#timeline")).not.toHaveAttribute("data-snapped");

  // keyboard trims never leave a guide behind
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(guide).toBeHidden();
});
