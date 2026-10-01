import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const MB = 1024 * 1024;

async function open(page: Page, video = { width: 1920, height: 1080, fps: 30 }) {
  const fixture = healthyBackendFixture();
  const base = { workflow: "compression", resolution_mode: "source", fps_mode: "source", video_encoder: "libx264", preset: "medium", audio_bitrate: 128000 };
  fixture.startup.files = ["C:\\videos\\Morning ride.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, ...video, has_audio: true, file_size: 15_000_000 } };
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    default_profile_id: "discord",
    profiles: [
      { ...base, profile_id: "discord", name: "Discord", target_size_bytes: 10 * MB },
      { ...base, profile_id: "email", name: "Email", target_size_bytes: 20 * MB },
    ],
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#prof-name")).toHaveText("Discord");
}

async function setSize(page: Page, mb: string) {
  await page.locator("#sz-badge").fill(mb);
  await page.locator("#sz-badge").dispatchEvent("change");
}

test("the card says what the profile does and its menu switches profile", async ({ page }) => {
  await open(page);
  await expect(page.locator("#prof-sub")).toHaveText("Target 10 MB · source size and frame rate");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await page.locator("#prof-pick").click();
  await expect(page.locator("#prof-menu")).toBeVisible();
  await expect(page.locator("#prof-pick")).toHaveAttribute("aria-expanded", "true");
  const options = page.locator("#prof-options [role=option]");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(1)).toContainText("Target 20 MB · source size and frame rate");
  await options.nth(1).click();
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-name")).toHaveText("Email");
  await expect(page.locator("#prof-sel")).toHaveValue("email");
  await expect(page.locator("#sz-badge")).toHaveValue("20");
  await expect(page.locator("#prof-pick")).toBeFocused();
});

test("a video whose size and frame rate differ from the defaults leaves the profile unchanged", async ({ page }) => {
  await open(page, { width: 3840, height: 2160, fps: 60 });
  await expect(page.locator("#video-selection-meta")).toContainText("3840×2160");
  await expect(page.locator("#prof-sub")).toHaveText("Target 10 MB · source size and frame rate");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await page.locator("#prof-pick").click();
  await expect(page.locator('#prof-options [data-profile-id="discord"]')).not.toContainText("Changed");
});

test("a changed setting shows what moved, and Discard puts the profile back", async ({ page }) => {
  await open(page);
  await setSize(page, "25");
  await expect(page.locator("#prof-sub")).toHaveText("Target 25 MB, was 10 MB");
  await expect(page.locator("#prof-changed")).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator("#sz-badge")).toHaveValue("10");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await expect(page.locator("#prof-sub")).toHaveText("Target 10 MB · source size and frame rate");
});

test("Save to profile writes the changed settings to that profile", async ({ page }) => {
  await open(page);
  await setSize(page, "25");
  await page.getByRole("button", { name: "Save to profile", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "updateProfile")?.args))
    .toEqual(["discord", expect.objectContaining({ name: "Discord", target_size_mb: 25 })]);
  await expect(page.locator(".toast")).toContainText("Changes saved to \"Discord\".");
});

test("switching away from unsaved changes can be undone", async ({ page }) => {
  await open(page);
  await setSize(page, "25");
  await page.locator("#prof-pick").click();
  await expect(page.locator('#prof-options [data-profile-id="discord"]')).toContainText("Changed, not saved");
  await page.locator('#prof-options [data-profile-id="email"]').click();
  await expect(page.locator("#prof-name")).toHaveText("Email");
  await expect(page.locator("#sz-badge")).toHaveValue("20");
  await expect(page.locator("#prof-changed")).toBeHidden();
  const note = page.locator(".toast", { hasText: "Changes to Discord discarded." });
  await note.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#prof-name")).toHaveText("Discord");
  await expect(page.locator("#prof-sel")).toHaveValue("discord");
  await expect(page.locator("#sz-badge")).toHaveValue("25");
  await expect(page.locator("#prof-sub")).toHaveText("Target 25 MB, was 10 MB");
  await expect(page.locator("#prof-changed")).toBeVisible();
});

test("the profile menu works from the keyboard", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#prof-menu")).toBeVisible();
  await expect(page.locator('#prof-options [data-profile-id="discord"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('#prof-options [data-profile-id="email"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-pick")).toBeFocused();
  await expect(page.locator("#prof-sel")).toHaveValue("discord");
  await page.keyboard.press("Enter");
  await expect(page.locator("#prof-menu")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.locator("#prof-name")).toHaveText("Email");
  await expect(page.locator("#prof-pick")).toBeFocused();
});

test("at 960 wide Escape closes the profile menu and leaves the Inspector open", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await open(page);
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.locator("#prof-pick").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-pick")).toBeVisible();
  await expect(page.locator("#prof-pick")).toBeFocused();
  // a second Escape closes the Inspector as before
  await page.keyboard.press("Escape");
  await expect(page.locator("#prof-pick")).toBeHidden();
});

test("clicking outside closes the profile menu without changing profile", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").click();
  await expect(page.locator("#prof-menu")).toBeVisible();
  // the middle of the window is the player
  await page.mouse.click(600, 360);
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-sel")).toHaveValue("discord");
});
