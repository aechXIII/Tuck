import { expect, test, type Page } from "@playwright/test";

import {
  healthyBackendFixture,
  installFakeBackend,
  type FakeBackendFixture,
} from "../fixtures/fake-backend";

const RANKED = "C:\\Videos\\Ranked match clutch.mp4";

function fixtureWith(settings: Record<string, unknown> = {}): FakeBackendFixture {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...(fixture.responses.getSettings as Record<string, unknown>),
    ...settings,
  };
  return fixture;
}

async function open(page: Page, fixture: FakeBackendFixture): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).some((call) => call.method === "getSettings")))
    .toBe(true);
}

test("the start screen says what each task does and follows task switches", async ({ page }) => {
  await open(page, fixtureWith({ last_task: "upscale" }));
  const title = page.locator("#empty-title");
  await expect(title).toHaveText("Drop a video to upscale it");
  await expect(page.locator("#empty-note")).toHaveText("It is re-encoded at a higher resolution.");
  await expect(page.locator("#empty-add")).toBeVisible();

  await page.locator("#wf-l").click();
  await expect(title).toHaveText("Drop a video to cut it");
  await expect(page.locator("#empty-note")).toHaveText("Cuts keep the original quality.");

  await page.locator("#wf-c").click();
  await expect(title).toHaveText("Drop a video to compress it");
  await expect(page.locator("#empty-note")).toHaveText("It will fit the size you pick, like 20 MB for Discord.");
});

test("with no videos the Inspector and timeline say where their controls will be", async ({ page }) => {
  const fixture = fixtureWith();
  fixture.responses.pickFiles = { ok: true, files: [RANKED] };
  await open(page, fixture);

  await expect(page.getByText("Export settings show up here once a video is added.")).toBeVisible();
  await expect(page.locator("#insp-tabs")).toBeHidden();
  await expect(page.locator("#right-scroll")).toBeHidden();
  await expect(page.locator("#export-go")).toBeHidden();
  await expect(page.getByText("Your timeline shows up here.")).toBeVisible();
  await expect(page.getByText("No video selected")).toBeHidden();
  await expect(page.getByRole("button", { name: "Split at playhead" })).toBeHidden();
  const toolbarHeight = await page.locator("#timeline-row").evaluate((row) => row.getBoundingClientRect().height);

  await page.locator("#empty-add").click();
  await expect(page.locator(".clip")).toHaveCount(1);
  await expect(page.getByText("Export settings show up here once a video is added.")).toBeHidden();
  await expect(page.locator("#insp-tabs")).toBeVisible();
  await expect(page.locator("#export-go")).toBeVisible();
  await expect(page.getByText("Your timeline shows up here.")).toBeHidden();
  await expect(page.getByRole("button", { name: "Split at playhead" })).toBeVisible();
  // the toolbar kept its place, so the tracks don't jump when the first video arrives
  expect(await page.locator("#timeline-row").evaluate((row) => row.getBoundingClientRect().height)).toBe(toolbarHeight);

  await page.getByRole("button", { name: "Remove Ranked match clutch.mp4" }).click();
  await expect(page.getByText("Export settings show up here once a video is added.")).toBeVisible();
  await expect(page.getByText("Your timeline shows up here.")).toBeVisible();
});
