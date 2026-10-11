import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";

const VIDEO = "C:\\media\\Harbour.mp4";
const PICTURE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function previewFixture(): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: [VIDEO] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true },
  };
  fixture.responses.releaseMediaToken = { ok: true };
  return fixture;
}

async function addVideo(page: Page): Promise<void> {
  await page.locator("#btn-add").click();
  await expect(page.locator(".clip").filter({ hasText: "Harbour.mp4" })).toBeVisible();
}

test("a video without a playable preview shows its picture instead", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#thumb")).toHaveCount(0);

  await addVideo(page);

  const picture = page.locator("#media-viewport #thumb");
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("src", PICTURE);
  await expect(page.locator("#vid")).toBeHidden();
});

test("no picture element appears when the video has neither preview nor picture", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: false, error: "The preview could not be served" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await installFakeBackend(page, fixture);
  await page.goto("/");

  await addVideo(page);

  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "getThumbnail").length))
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator("#thumb")).toHaveCount(0);
});

test("a preview that fails to play falls back to the picture, and removal clears both", async ({ page }) => {
  const fixture = previewFixture();
  fixture.responses.getMediaUrl = { ok: true, url: "https://media.test/harbour", token: "token-harbour" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  await page.route("https://media.test/**", (route) => route.abort());
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await addVideo(page);
  await expect.poll(() => page.locator("#vid").getAttribute("src")).toBe("https://media.test/harbour");
  await expect(page.locator("#media-viewport #thumb")).toHaveAttribute("src", PICTURE);

  await page.getByRole("button", { name: "Remove Harbour.mp4" }).click();

  await expect(page.getByText("Drop videos anywhere", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? [])
      .filter((call) => call.method === "releaseMediaToken")
      .map((call) => call.args)))
    .toEqual([["token-harbour"]]);
  await expect(page.locator("#vid")).not.toHaveAttribute("src", /./);
  await expect(page.locator("#thumb")).toHaveCount(0);
  await expect(page.locator(".tl-segment")).toHaveCount(0);
});
