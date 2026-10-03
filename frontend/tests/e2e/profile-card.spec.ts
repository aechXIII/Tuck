import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const MB = 1024 * 1024;

async function open(page: Page, video = { width: 1920, height: 1080, fps: 30 }, profileCount = 2, profileName = "Discord", saveError = "", saveInUpscale = false) {
  const fixture = healthyBackendFixture();
  const base = { workflow: "compression", resolution_mode: "source", fps_mode: "source", video_encoder: "libx264", preset: "medium", audio_bitrate: 128000 };
  fixture.startup.files = ["C:\\videos\\Morning ride.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, ...video, has_audio: true, file_size: 15_000_000 } };
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  const settings = {
    ...fixture.responses.getSettings as object,
    default_profile_id: "discord",
    profiles: [
      { ...base, profile_id: "discord", name: profileName, target_size_bytes: 10 * MB },
      { ...base, profile_id: "email", name: "Email", target_size_bytes: 20 * MB },
      { ...base, profile_id: "upscale-4k", name: "4K", workflow: "upscale", resolution_mode: "custom", custom_width: 3840, custom_height: 2160, rate_control: "quality", quality: 20 },
      ...Array.from({ length: Math.max(0, profileCount - 2) }, (_, index) => ({
        ...base, profile_id: `extra-${index}`, name: `Extra profile ${index}`, target_size_bytes: 30 * MB,
      })),
    ],
  };
  fixture.responses.getSettings = settings;
  if (saveInUpscale) {
    fixture.responseSequences = { getSettings: [settings, {
      ...settings,
      last_task: "upscale",
      last_upscale_profile_id: "upscale-4k",
      profiles: settings.profiles.map(profile => profile.profile_id === "upscale-4k"
        ? { ...profile, custom_width: 2560, custom_height: 1440 } : profile),
    }] };
  }
  if (saveError) fixture.responses.updateProfile = { ok: false, error: saveError };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#prof-name")).toHaveText(profileName);
}

async function setSize(page: Page, mb: string) {
  await page.locator("#sz-badge").fill(mb);
  await page.locator("#sz-badge").dispatchEvent("change");
}

for (const width of [1240, 960]) {
  test(`the integrated card adapts to Upscale without a target size at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, undefined, 2, "Discord", "", true);
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const card = page.locator("#profile-card");
    await expect(card.locator("#sz-grp")).toBeVisible();
    await expect(page.locator("#prof-sub")).toHaveText("Source size and frame rate");
    const compressHeight = (await card.boundingBox())!.height;
    await page.locator("#wf-u").click();
    if (width === 960 && await page.getByRole("button", { name: "Inspector", exact: true }).getAttribute("aria-expanded") !== "true") {
      await page.getByRole("button", { name: "Inspector", exact: true }).click();
    }
    await expect(page.locator("#prof-name")).toHaveText("4K");
    await expect(card.locator("#sz-grp")).toBeHidden();
    await expect(page.locator("#prof-sub")).toHaveText("4K · source frame rate");
    await expect(page.locator("#btn-one")).toHaveText("Upscale this video");
    const upscaleBounds = (await card.boundingBox())!;
    const videoTop = (await page.locator("#export-video-panel").boundingBox())!.y;
    expect(upscaleBounds.height).toBeLessThan(compressHeight - 80);
    await page.locator("#prof-pick").click();
    await expect(page.locator("#prof-options")).toHaveAccessibleName("Upscale profiles");
    await expect(page.locator("#prof-options").getByRole("option")).toHaveCount(1);
    await expect(page.locator("#prof-options").getByRole("option", { name: "4K", exact: true })).toHaveAccessibleDescription("4K · source frame rate");
    await page.keyboard.press("Escape");
    await page.locator("#export-res-select-trigger").click();
    await page.locator("#export-res-select-popup").getByRole("option", { name: "1920 × 1080", exact: true }).click();
    await expect(page.locator("#prof-changed")).toBeVisible();
    expect((await card.boundingBox())!.height).toBeCloseTo(upscaleBounds.height, 2);
    expect((await page.locator("#export-video-panel").boundingBox())!.y).toBeCloseTo(videoTop, 2);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator("#prof-changed")).toBeHidden();
    await expect(page.locator("#res-w")).toHaveValue("3840");
    await expect(page.locator("#prof-pick")).toBeFocused();
    await page.locator("#export-res-select-trigger").click();
    await page.locator("#export-res-select-popup").getByRole("option", { name: "2560 × 1440", exact: true }).click();
    await page.getByRole("button", { name: "Save to profile", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "updateProfile")?.args))
      .toEqual(["upscale-4k", expect.objectContaining({ workflow: "upscale", custom_width: 2560, custom_height: 1440 })]);
    await expect(page.locator("#prof-changed")).toBeHidden();
    await expect(card.locator("#sz-grp")).toBeHidden();
    await expect(page.locator("#res-w")).toHaveValue("2560");
    expect((await card.boundingBox())!.height).toBeCloseTo(upscaleBounds.height, 2);
    await page.locator("#wf-c").click();
    if (width === 960 && await page.getByRole("button", { name: "Inspector", exact: true }).getAttribute("aria-expanded") !== "true") {
      await page.getByRole("button", { name: "Inspector", exact: true }).click();
    }
    await expect(card.locator("#sz-grp")).toBeVisible();
    await expect(page.locator("#prof-name")).toHaveText("Discord");
    expect((await card.boundingBox())!.height).toBeCloseTo(compressHeight, 2);
  });
}

test("an empty Upscale profile list keeps the picker commands without save or target-size controls", async ({ page }) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.locator("#wf-u").click();
  await expect(page.locator("#prof-name")).toHaveText("No profile");
  await expect(page.locator("#prof-sub")).toHaveText("Current settings");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await expect(page.locator("#sz-grp")).toBeHidden();
  await page.locator("#prof-pick").click();
  await expect(page.locator("#prof-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save current settings as new…", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage profiles…", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});

for (const width of [1240, 960]) {
  test(`short profile names open from the header and keep a card-width menu at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const cardBounds = (await page.locator("#prof-card").boundingBox())!;
    const widgetBounds = (await page.locator("#profile-card").boundingBox())!;
    const triggerBounds = (await page.locator("#prof-pick").boundingBox())!;
    await page.mouse.click(cardBounds.x + cardBounds.width / 2, triggerBounds.y + triggerBounds.height / 2);
    const menu = page.locator("#prof-menu");
    await expect(menu).toBeVisible();
    const menuBounds = (await menu.boundingBox())!;
    expect(menuBounds.width).toBeCloseTo(cardBounds.width, 0);
    expect(menuBounds.x).toBeCloseTo(cardBounds.x, 0);
    expect(menuBounds.y).toBeCloseTo(cardBounds.y + cardBounds.height, 2);
    expect((await page.locator("#profile-card").boundingBox())!.height).toBeCloseTo(widgetBounds.height, 2);
    const surfaces = await page.evaluate(() => {
      const header = getComputedStyle(document.querySelector("#prof-card")!);
      const popup = getComputedStyle(document.querySelector("#prof-menu")!);
      return { header: header.backgroundColor, popup: popup.backgroundColor,
        headerCorner: header.borderBottomLeftRadius, popupCorner: popup.borderTopLeftRadius };
    });
    expect(surfaces.header).toBe(surfaces.popup);
    expect(surfaces.headerCorner).toBe("0px");
    expect(surfaces.popupCorner).toBe("0px");
    expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.locator("#prof-search")).toBeHidden();
    await expect(menu.getByRole("option", { name: "Discord", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator("#prof-name")).toHaveText("Email");
    await expect(page.locator("#sz-badge")).toHaveValue("20");
    await expect(page.locator("#prof-pick")).toBeFocused();
    await page.locator("#prof-pick").click();
    const nextBounds = (await menu.boundingBox())!;
    expect(nextBounds.width).toBeCloseTo(cardBounds.width, 0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.locator("#prof-card")).not.toHaveAttribute("data-menu-side");
    await expect(page.locator("#prof-pick")).toBeVisible();
  });
}

test("the card says what the profile does and its menu switches profile", async ({ page }) => {
  await open(page);
  await expect(page.locator("#prof-sub")).toHaveText("Source size and frame rate");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await page.locator("#prof-pick").click();
  await expect(page.locator("#prof-menu")).toBeVisible();
  await expect(page.locator("#prof-pick")).toHaveAttribute("aria-expanded", "true");
  const options = page.locator("#prof-options [role=option]");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(1)).toHaveAccessibleName("Email");
  await expect(options.nth(1)).toHaveAttribute("title", "Email: Target 20 MB · source size and frame rate");
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
  await expect(page.locator("#prof-sub")).toHaveText("Source size and frame rate");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await page.locator("#prof-pick").click();
  await expect(page.locator('#prof-options [data-profile-id="discord"]')).not.toContainText("Changed");
});

test("a changed setting keeps its details and Discard puts the profile back", async ({ page }) => {
  await open(page);
  await setSize(page, "25");
  await expect(page.locator("#prof-sub")).toHaveAttribute("title", "Target 25 MB, was 10 MB");
  await expect(page.locator("#prof-changed")).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#sz-badge")).toHaveValue("10");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await expect(page.locator("#prof-sub")).toHaveText("Source size and frame rate");
  await expect(page.locator("#prof-pick")).toBeFocused();
});

test("Save to profile writes the changed settings to that profile", async ({ page }) => {
  await open(page);
  await setSize(page, "25");
  await page.getByRole("button", { name: "Save to profile", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "updateProfile")?.args))
    .toEqual(["discord", expect.objectContaining({ name: "Discord", target_size_mb: 25 })]);
  await expect(page.locator(".toast")).toContainText("Changes saved to \"Discord\".");
  await expect(page.locator("#prof-changed")).toBeHidden();
  await expect(page.locator("#prof-pick")).toBeFocused();
});

for (const width of [1240, 960]) {
  test(`profile changes keep the layout stable with a long name at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, undefined, 2, "Discord · detailed review with original source audio");
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const card = page.locator("#prof-card");
    const savedBounds = (await card.boundingBox())!;
    const savedTargetTop = (await page.locator("#sz-grp").boundingBox())!.y;
    await card.screenshot({ path: `.scratch/profile-card-polish/clean-${width}.png` });
    await setSize(page, "25");
    await expect(card.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await expect(page.locator("#prof-sub")).toHaveAttribute("title", "Target 25 MB, was 10 MB");
    await expect(card.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Save to profile", exact: true })).toBeVisible();
    const changedBounds = (await card.boundingBox())!;
    const changedTargetTop = (await page.locator("#sz-grp").boundingBox())!.y;
    expect(changedBounds.height).toBeCloseTo(savedBounds.height, 2);
    expect(changedTargetTop).toBeCloseTo(savedTargetTop, 2);
    const layout = await card.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { fits: element.scrollWidth <= element.clientWidth,
        buttons: [...element.querySelectorAll<HTMLButtonElement>("#prof-changed button")].map(button => {
          const box = button.getBoundingClientRect();
          return { fits: button.scrollWidth <= button.clientWidth,
            inside: box.left >= bounds.left && box.right <= bounds.right };
        }) };
    });
    expect(layout.fits).toBe(true);
    expect(layout.buttons.every(button => button.fits && button.inside)).toBe(true);
    await page.screenshot({ path: `.scratch/profile-card-polish/full-${width}.png` });
    await card.screenshot({ path: `.scratch/profile-card-polish/changed-${width}.png` });
    await card.getByRole("button", { name: "Discard", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Save to profile", exact: true })).toBeFocused();
    await card.screenshot({ path: `.scratch/profile-card-polish/focus-${width}.png` });
    await card.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator("#prof-changed")).toBeHidden();
    expect((await card.boundingBox())!.height).toBeCloseTo(savedBounds.height, 2);
    expect((await page.locator("#sz-grp").boundingBox())!.y).toBeCloseTo(savedTargetTop, 2);
    await expect(card.getByText("Source size and frame rate", { exact: true })).toBeVisible();
    await setSize(page, "30");
    await card.getByRole("button", { name: "Save to profile", exact: true }).click();
    await expect(page.locator("#prof-changed")).toBeHidden();
    expect((await card.boundingBox())!.height).toBeCloseTo(savedBounds.height, 2);
    expect((await page.locator("#sz-grp").boundingBox())!.y).toBeCloseTo(savedTargetTop, 2);
  });
}

test("a failed profile save keeps the unsaved settings and its actions available", async ({ page }) => {
  await open(page, undefined, 2, "Discord", "Could not write the profile.");
  await setSize(page, "25");
  const save = page.getByRole("button", { name: "Save to profile", exact: true });
  await save.click();
  await expect(page.locator(".toast")).toContainText("Could not write the profile.");
  await expect(page.locator("#sz-badge")).toHaveValue("25");
  await expect(page.locator("#prof-sub")).toHaveAttribute("title", "Target 25 MB, was 10 MB");
  await expect(page.locator("#prof-changed")).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(save).toBeFocused();
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
  await expect(page.locator("#prof-sub")).toHaveAttribute("title", "Target 25 MB, was 10 MB");
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

for (const width of [1240, 960]) {
  test(`long profile menus keep the focused option visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    const fixture = healthyBackendFixture();
    fixture.responses.getSettings = {
      ...fixture.responses.getSettings as object,
      default_profile_id: "profile-19",
      profiles: Array.from({ length: 20 }, (_, index) => ({
        profile_id: `profile-${index}`, name: index === 19 ? "Zebra" : `Profile ${index}`,
        workflow: "compression", resolution_mode: "source", fps_mode: "source",
      })),
    };
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const trigger = page.locator("#prof-pick");
    const menu = page.locator("#prof-menu");
    const last = menu.getByRole("option", { name: "Zebra", exact: true });
    const inspectorScroll = await page.locator("#right-scroll").evaluate(element => element.scrollTop);
    const expectLastVisible = async () => {
      await expect(last).toBeFocused();
      const bounds = (await menu.boundingBox())!;
      const row = (await last.boundingBox())!;
      expect(row.y).toBeGreaterThanOrEqual(bounds.y + 6);
      expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height - 6);
      expect(await page.locator("#right-scroll").evaluate(element => element.scrollTop)).toBe(inspectorScroll);
    };
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expectLastVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("z");
    await expectLastVisible();
    await page.keyboard.press("Escape");
    await trigger.click();
    const search = page.locator("#prof-search");
    await expect(search).toBeFocused();
    const popupBounds = (await menu.boundingBox())!;
    const searchBounds = (await search.boundingBox())!;
    expect(searchBounds.y).toBeGreaterThanOrEqual(popupBounds.y + 6);
    expect(searchBounds.y + searchBounds.height).toBeLessThanOrEqual(popupBounds.y + popupBounds.height - 6);
    expect(await page.locator("#right-scroll").evaluate(element => element.scrollTop)).toBe(inspectorScroll);
    await search.fill("Zebra");
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test("at 960 wide Escape closes the profile menu and leaves the Inspector open", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await open(page);
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.locator("#prof-pick").click();
  await expect(page.locator("#prof-menu")).toBeVisible();
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

test("profiles can be searched without losing the menu commands", async ({ page }) => {
  await open(page, undefined, 8);
  await page.locator("#prof-pick").click();
  await page.getByRole("searchbox", { name: "Search profiles", exact: true }).fill("EMAIL");
  await expect(page.locator('#prof-options [data-profile-id="discord"]')).toBeHidden();
  await expect(page.locator('#prof-options [data-profile-id="email"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage profiles…", exact: true })).toBeVisible();
  await page.locator("#prof-search").fill("no matching profile");
  await expect(page.locator("#prof-empty")).toBeVisible();
  await page.locator("#prof-search").fill("Email");
  await page.locator("#prof-search").press("Enter");
  await expect(page.locator("#prof-name")).toHaveText("Email");
  await expect(page.locator("#prof-pick")).toBeFocused();
});

test("Enter on an empty profile search keeps the menu and current profile", async ({ page }) => {
  await open(page, undefined, 8);
  await page.locator("#prof-pick").click();
  const search = page.getByRole("searchbox", { name: "Search profiles", exact: true });
  await search.fill("no matching profile");
  await expect(page.locator("#prof-empty")).toBeVisible();
  await search.press("Enter");
  await expect(page.locator("#prof-menu")).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.locator("#prof-sel")).toHaveValue("discord");
  await expect(page.locator("#sz-badge")).toHaveValue("10");
});

test("Escape on an open profile trigger closes its menu before the Inspector", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await open(page);
  const inspector = page.getByRole("button", { name: "Inspector", exact: true });
  await inspector.click();
  const trigger = page.locator("#prof-pick");
  await trigger.click();
  await expect(page.locator("#prof-menu")).toBeVisible();
  await trigger.focus();
  await trigger.press("Escape");
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(inspector).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toBeFocused();
  await trigger.press("Escape");
  await expect(inspector).toHaveAttribute("aria-expanded", "false");
});
