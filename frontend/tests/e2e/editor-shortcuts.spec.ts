import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Keys.mp4";

declare global {
  interface Window {
    __playRequests?: number;
  }
}

async function openEditor(page: Page): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true },
  };
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/keys", token: "keys" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  // the test video has no media, so count play requests instead of decoding anything
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function play(): Promise<void> {
      window.__playRequests = (window.__playRequests ?? 0) + 1;
      return Promise.resolve();
    };
  });
  await page.route("https://media.test/**", (route) => route.abort());
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).some((call) => call.method === "getSettings")))
    .toBe(true);
}

async function focusEditor(page: Page): Promise<void> {
  await page.locator("body").click({ position: { x: 5, y: 5 } });
}

test("command buttons announce the keys that run them", async ({ page }) => {
  await openEditor(page);

  const hints = await page.locator("[data-shortcut-commands]").evaluateAll((elements) =>
    elements.map((element) => ({
      commands: (element as HTMLElement).dataset.shortcutCommands,
      keys: element.getAttribute("aria-keyshortcuts"),
    })),
  );
  expect(hints.length).toBeGreaterThan(0);
  for (const hint of hints) expect(hint.keys, hint.commands).toBeTruthy();
  // the player controls are hidden until a video is open, so find them by their command
  const button = (command: string) => page.locator(`[data-shortcut-commands="${command}"]`).first();
  await expect(button("playback.toggle")).toHaveAttribute("aria-keyshortcuts", "Space");
  await expect(button("playback.step-backward")).toHaveAttribute("aria-keyshortcuts", "ArrowLeft");
  await expect(button("timeline.fit")).toHaveAttribute("aria-keyshortcuts", "Control+0");
  await expect(button("help.shortcuts")).toHaveAttribute("aria-keyshortcuts", "? Control+/");
});

test("default editor keys run the same commands as the buttons", async ({ page }) => {
  await openEditor(page);
  await focusEditor(page);

  await page.keyboard.press("Control+o");
  await expect(page.locator(".clip").filter({ hasText: "Keys.mp4" })).toBeVisible();
  await expect(page.locator(".tl-segment")).toHaveCount(1);

  await focusEditor(page);
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => window.__playRequests ?? 0)).toBe(1);

  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
  await focusEditor(page);
  await page.keyboard.press("s");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Remove active segment" })).toBeEnabled();
  await page.keyboard.press("Delete");
  await expect(page.locator(".tl-segment")).toHaveCount(1);

  const zoom = page.locator("#tl-zoom-slider");
  await expect(zoom).toHaveValue("1");
  await page.keyboard.press("Control+=");
  await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(1);
  const zoomedIn = Number(await zoom.inputValue());
  await page.keyboard.press("Control+-");
  await expect.poll(async () => Number(await zoom.inputValue())).toBeLessThan(zoomedIn);
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+0");
  await expect(zoom).toHaveValue("1");

  await page.keyboard.press("Control+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
});
