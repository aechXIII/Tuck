import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FIRST = "C:\\media\\Round one.mp4";
const SECOND = "C:\\media\\Round two.mp4";
const SPRITE = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4800" height="84"><rect width="4800" height="84" fill="#345"/></svg>',
);

async function open(page: Page): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [FIRST, SECOND] };
  fixture.responses.probeFile = { ok: true, data: { duration: 64, width: 1920, height: 1080, fps: 60, has_audio: true } };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "media-token" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.releaseMediaToken = { ok: true };
  fixture.timelineSprites = { url: SPRITE, token: "pictures" };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  await expect(page.locator("#clips .clip")).toHaveCount(2);
}

const row = (page: Page, name: string) => page.locator("#clips .clip").filter({ hasText: name });
const card = (page: Page) => page.locator("#hover-preview");

async function hover(page: Page, name: string, share: number): Promise<void> {
  const box = (await row(page, name).boundingBox())!;
  await page.mouse.move(box.x + box.width * share, box.y + box.height / 2, { steps: 2 });
}

async function hoverRequests(page: Page): Promise<(readonly unknown[])[]> {
  return page.evaluate((path) => (window.__tuckFakeBackendCalls ?? [])
    .filter((call) => call.method === "getTimelineFrames" && call.args[0] === path)
    .map((call) => call.args), SECOND);
}

test("resting on a Library row shows its video, and moving across the row moves through it", async ({ page }) => {
  await open(page);

  await hover(page, "Round two", 0.25);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute("aria-hidden", "true");
  await expect(card(page).locator(".hover-preview-time")).toHaveText("0:161:04");
  // one request for the whole video: 32 pictures from the middle of each 2 second slot
  await expect.poll(() => hoverRequests(page)).toEqual([[SECOND, 1, 2, 32, "whole", false]]);
  const picture = card(page).locator(".hover-preview-picture");
  await expect(picture).toHaveCSS("background-position", "-1200px 0px");

  await hover(page, "Round two", 0.75);
  await expect(card(page).locator(".hover-preview-now")).toHaveText("0:48");
  await expect(picture).toHaveCSS("background-position", "-3600px 0px");

  // beside the Library, level with the row
  const cardBox = (await card(page).boundingBox())!;
  const library = (await page.locator("#left").boundingBox())!;
  const rowBox = (await row(page, "Round two").boundingBox())!;
  expect(cardBox.x).toBeGreaterThanOrEqual(library.x + library.width);
  expect(Math.abs(cardBox.y + cardBox.height / 2 - (rowBox.y + rowBox.height / 2))).toBeLessThan(2);

  // the video on screen gets no card, and leaving the Library hides it
  await hover(page, "Round one", 0.5);
  await expect(card(page)).toBeHidden();
  await hover(page, "Round two", 0.5);
  await expect(card(page)).toBeVisible();
  // the row's own tooltip waits while its card shows, or WebKitGTK draws it over the card
  await expect(row(page, "Round two")).not.toHaveAttribute("title");
  await page.mouse.move(800, 400);
  await expect(card(page)).toBeHidden();
  await expect(row(page, "Round two")).toHaveAttribute("title", /^Round two/);

  // a video seen once keeps its pictures
  await hover(page, "Round two", 0.1);
  await expect(card(page)).toBeVisible();
  expect(await hoverRequests(page)).toHaveLength(1);
});

test("passing over a row doesn't show its card", async ({ page }) => {
  await open(page);
  await hover(page, "Round two", 0.5);
  // its tooltip waits from the moment the pointer arrives, before the card is due
  await expect(row(page, "Round two")).not.toHaveAttribute("title");
  await page.mouse.move(800, 400);
  await expect(row(page, "Round two")).toHaveAttribute("title", /^Round two/);
  await page.waitForTimeout(600);
  await expect(card(page)).toHaveCount(0);
  expect(await hoverRequests(page)).toHaveLength(0);
});

test("after the list scrolls, the row under the pointer waits before its card shows", async ({ page }) => {
  await open(page);
  await hover(page, "Round two", 0.5);
  await expect(card(page)).toBeVisible();
  await page.locator("#clips").dispatchEvent("scroll");
  await expect(card(page)).toBeHidden();
  await hover(page, "Round two", 0.6);
  await page.waitForTimeout(150);
  await expect(card(page)).toBeHidden();
  await expect(card(page)).toBeVisible();
});
