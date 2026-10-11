import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FIRST = "C:\\videos\\Harbour walk.mp4";
const SECOND = "C:\\videos\\Sunset bridge.mp4";

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = [FIRST, SECOND];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(2);
}

async function select(page: Page, name: string): Promise<void> {
  await page.locator(".clip").filter({ hasText: name }).click();
  await expect(page.locator(".clip.sel")).toContainText(name);
}

async function seekOnRuler(page: Page, ratio: number): Promise<void> {
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * ratio, ruler.y + ruler.height / 2);
}

test("Undo only changes the video on screen, and names the step it undoes", async ({ page }) => {
  await open(page);
  await select(page, "Harbour walk.mp4");
  await expect(page.locator(".tl-segment")).toHaveCount(1);
  await seekOnRuler(page, 0.5);
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  const undo = page.locator("#btn-undo");
  await expect(undo).toHaveAttribute("aria-label", "Undo split");

  // the other video has nothing of its own to undo, so Ctrl+Z leaves the first one alone
  await select(page, "Sunset bridge.mp4");
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveAttribute("aria-label", "Undo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");

  await select(page, "Harbour walk.mp4");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator(".tl-segment")).toHaveCount(1);
  await expect(page.locator("#btn-redo")).toHaveAttribute("aria-label", "Redo split");
});
