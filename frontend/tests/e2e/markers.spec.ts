import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FIRST = "C:\\media\\Round one.mp4";
const SECOND = "C:\\media\\Round two.mp4";

async function open(page: Page): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [FIRST, SECOND] };
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 60, has_audio: true } };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "media-token" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.releaseMediaToken = { ok: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  await expect(page.locator(".tl-segment")).toHaveCount(1);
}

async function seek(page: Page, share: number): Promise<void> {
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * share, ruler.y + ruler.height / 2);
}

const flags = (page: Page) => page.locator("#seq-marker-layer .seq-marker-flag");
const playhead = (page: Page) => page.locator("#tl-corner-time");

test("M and the Marker button mark the playhead, and a flag seeks, moves and goes with Delete", async ({ page }) => {
  await open(page);
  await seek(page, 0.25);
  await expect(playhead(page)).not.toHaveText("0:00.00");
  const first = (await playhead(page).textContent())!;
  await page.keyboard.press("m");
  await expect(flags(page)).toHaveCount(1);
  await expect(flags(page).first()).toHaveAccessibleName(`Marker at ${first}`);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo add marker");
  // the same moment gets one marker
  await page.keyboard.press("m");
  await expect(flags(page)).toHaveCount(1);

  await seek(page, 0.75);
  await expect(playhead(page)).not.toHaveText(first);
  const second = (await playhead(page).textContent())!;
  await page.locator("#btn-marker").click();
  await expect(flags(page)).toHaveCount(2);

  // the cut point keys stop at markers; the test video has no media, so each seek is finished
  // the way a loaded video would
  const time = () => page.evaluate(() => {
    const video = document.getElementById("vid") as HTMLVideoElement;
    video.dispatchEvent(new Event("seeked"));
    return video.currentTime;
  });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(time).toBe(0);
  await page.keyboard.press(".");
  await expect.poll(time).toBeCloseTo(3, 1);
  await expect(playhead(page)).toHaveText(first);
  await page.keyboard.press(".");
  await expect.poll(time).toBeCloseTo(9, 1);
  await expect(playhead(page)).toHaveText(second);
  await page.keyboard.press(",");
  await expect.poll(time).toBeCloseTo(3, 1);

  // a click on a flag moves the playhead there and changes nothing
  await flags(page).nth(1).click();
  await expect(playhead(page)).toHaveText(second);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo add marker");

  // a drag follows the pointer from where the flag was grabbed
  const layer = (await page.locator("#seq-marker-layer").boundingBox())!;
  const box = (await flags(page).first().boundingBox())!;
  const before = box.x + box.width / 2;
  await page.mouse.move(before, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(before + layer.width * 0.1, box.y + 4, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo move marker");
  const moved = (await flags(page).first().boundingBox())!;
  expect(Math.abs(moved.x - (box.x + layer.width * 0.1))).toBeLessThan(1.5);

  // Escape puts a dragged marker back
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 4);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2 + 60, moved.y + 4, { steps: 3 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(async () => (await flags(page).first().boundingBox())!.x).toBeCloseTo(moved.x, 0);

  await flags(page).first().focus();
  await page.keyboard.press("Delete");
  await expect(flags(page)).toHaveCount(1);
  // focus moves to the marker that took its place
  await expect(flags(page).first()).toBeFocused();
  await page.locator("#btn-undo").click();
  await expect(flags(page)).toHaveCount(2);
});

test("Split at all markers cuts the video at each one, and Clear markers removes them", async ({ page }) => {
  await open(page);
  for (const share of [0.25, 0.5, 0.75]) {
    await seek(page, share);
    await page.keyboard.press("m");
  }
  await expect(flags(page)).toHaveCount(3);

  await flags(page).nth(1).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Split at all markers", "Remove markerDelete", "Clear markers"]);
  await expect(flags(page).nth(1)).toHaveClass(/menu-target/);
  await menu.getByRole("menuitem", { name: "Split at all markers" }).click();
  await expect(page.locator(".tl-segment")).toHaveCount(4);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo split at markers");
  await expect(flags(page)).toHaveCount(3);

  // once every marker is a cut, there is nothing left to split
  await flags(page).first().focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "Split at all markers" })).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByRole("menuitem", { name: "Remove marker" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(flags(page).first()).toBeFocused();

  await flags(page).first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Clear markers" }).click();
  await expect(flags(page)).toHaveCount(0);
  await expect(page.locator(".tl-segment")).toHaveCount(4);
  await page.keyboard.press("Control+z");
  await expect(flags(page)).toHaveCount(3);
});

test("markers belong to their video", async ({ page }) => {
  await open(page);
  await seek(page, 0.5);
  await page.keyboard.press("m");
  await expect(flags(page)).toHaveCount(1);
  await page.locator(".clip").filter({ hasText: "Round two" }).click();
  await expect(flags(page)).toHaveCount(0);
  await page.locator(".clip").filter({ hasText: "Round one" }).click();
  await expect(flags(page)).toHaveCount(1);
});
