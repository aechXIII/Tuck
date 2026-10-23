import { expect, test, type Locator, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const MB = 1024 * 1024;

async function open(page: Page, video = { width: 1920, height: 1080, fps: 30 }, profileCount = 2, profileName = "Discord", saveError = "", saveInUpscale = false, customResolution = false, preferencesInUpscale = false) {
  const fixture = healthyBackendFixture();
  const base = { workflow: "compression", resolution_mode: customResolution ? "custom" : "source", ...(customResolution ? { custom_width: 1920, custom_height: 1080 } : {}), fps_mode: "source", video_encoder: "libx264", preset: "medium", audio_bitrate: 128000 };
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
  if (preferencesInUpscale) {
    fixture.responses.getSettings = {
      ...settings, last_task: "upscale", last_upscale_profile_id: "upscale-4k",
    };
    fixture.responseSequences = { getSettings: [settings] };
  }
  if (saveError) fixture.responses.updateProfile = { ok: false, error: saveError };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#prof-name")).toHaveText(profileName);
}

// focus stays in the menu's search field; the lit row is the field's active descendant
async function expectLit(page: Page, option: Locator) {
  const search = page.locator("#prof-search");
  await expect(search).toBeFocused();
  await expect(option).toHaveAttribute("data-active", "");
  await expect(search).toHaveAttribute("aria-activedescendant", (await option.getAttribute("id"))!);
}

async function setSize(page: Page, mb: string) {
  await page.locator("#sz-badge").fill(mb);
  await page.locator("#sz-badge").dispatchEvent("change");
}

test("saving General preferences keeps incomplete custom export settings", async ({ page }) => {
  await open(page);
  await page.locator("#export-res-select-trigger").click();
  await page.locator("#export-res-select-popup").getByRole("option", { name: "Custom\u2026", exact: true }).click();
  await page.locator("#res-w").fill("1");
  await page.locator("#res-h").fill("720");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Time format", exact: true })
    .getByRole("radio", { name: "1902 f", exact: true }).check();
  await expect(page.locator("#settings-status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.locator("#res-w")).toHaveValue("1");
  await expect(page.locator("#res-h")).toHaveValue("720");
  await expect(page.locator("#use-source-res")).not.toBeChecked();
  await expect(page.locator("#prof-changed")).toBeVisible();
  await expect(page.locator("#btn-one")).toBeDisabled();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator("#use-source-res")).toBeChecked();
  await expect(page.locator("#btn-one")).toBeEnabled();
});

for (const width of [1240, 960]) {
  for (const upscale of [false, true]) {
    test(`saving preferences preserves unsaved ${upscale ? "Upscale" : "Compress"} export settings at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
      await open(page, { width: 2560, height: 1440, fps: 60 }, 2, "Discord", "", false, false, upscale);
      if (upscale) await page.locator("#wf-u").click();
      if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
      if (!upscale) await setSize(page, "25");
      await page.locator("#export-res-select-trigger").click();
      await page.locator("#export-res-select-popup").getByRole("option", { name: "1280 \u00d7 720", exact: true }).click();
      const dirty = page.locator("#prof-changed");
      await expect(dirty).toBeVisible();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.getByRole("radiogroup", { name: "Layout density", exact: true })
        .getByRole("radio", { name: "Compact", exact: true }).check();
      await expect(page.locator("#settings-status")).toHaveText("Saved");
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(page.locator("#res-w")).toHaveValue("1280");
      await expect(page.locator("#res-h")).toHaveValue("720");
      await expect(page.locator("#use-source-res")).not.toBeChecked();
      if (!upscale) await expect(page.locator("#sz-badge")).toHaveValue("25");
      await expect(dirty).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls
        ?.filter(call => call.method === "createPlan").at(-1)?.args[0]))
        .toMatchObject({ resolution_mode: "custom", custom_width: 1280, custom_height: 720 });
      expect(await page.evaluate(() => window.__tuckFakeBackendCalls
        ?.filter(call => call.method === "updateProfile"))).toHaveLength(0);
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(dirty).toBeHidden();
      await expect(page.locator("#res-w")).toHaveValue(upscale ? "3840" : "2560");
      if (!upscale) await expect(page.locator("#sz-badge")).toHaveValue("10");
    });
  }
}

for (const width of [1240, 960]) {
  for (const source of [true, false]) {
    test(`Appearance changes preserve the ${source ? "source" : "custom"} resolution summary at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
      await open(page, { width: 2560, height: 1440, fps: 60 }, 2, "Discord", "", false, !source);
      if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
      const resolution = source ? "2560×1440" : "1920×1080";
      await expect(page.locator("#export-summary-detail")).toContainText(resolution);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.getByRole("radiogroup", { name: "Layout density", exact: true })
        .getByRole("radio", { name: "Compact", exact: true }).check();
      await expect(page.locator("#settings-status")).toHaveText("Saved");
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(page.locator("#use-source-res")).toBeChecked({ checked: source });
      await expect(page.locator("#res-w")).toHaveValue(source ? "2560" : "1920");
      await expect(page.locator("#res-h")).toHaveValue(source ? "1440" : "1080");
      await expect(page.locator("#export-summary-detail")).toContainText(resolution);
      const request = await page.evaluate(() => window.__tuckFakeBackendCalls
        ?.filter(call => call.method === "createPlan").at(-1)?.args[0]);
      expect(request).toMatchObject({ resolution_mode: source ? "source" : "custom" });
      if (source) {
        expect(request).not.toHaveProperty("custom_width");
        expect(request).not.toHaveProperty("custom_height");
      } else {
        expect(request).toMatchObject({ custom_width: 1920, custom_height: 1080 });
      }
    });
  }
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
    await expect(page.locator("#prof-options").getByRole("group", { name: "Upscale", exact: true }).getByRole("option")).toHaveCount(1);
    await expect(page.locator("#prof-options").getByRole("group", { name: "Compress, switches to Compress", exact: true }).getByRole("option")).toHaveCount(2);
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
  test(`the profile menu opens over the card, its header turned into search, at the card's width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await page.locator("#right").evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    const cardBounds = (await page.locator("#prof-card").boundingBox())!;
    const widgetBounds = (await page.locator("#profile-card").boundingBox())!;
    const triggerBounds = (await page.locator("#prof-pick").boundingBox())!;
    await page.mouse.click(cardBounds.x + cardBounds.width / 2, triggerBounds.y + triggerBounds.height / 2);
    const menu = page.locator("#prof-menu");
    await expect(menu).toBeVisible();
    const menuBounds = (await menu.boundingBox())!;
    expect(menuBounds.width).toBeCloseTo(cardBounds.width, 0);
    expect(menuBounds.x).toBeCloseTo(cardBounds.x, 0);
    // the search field takes the header's place and the list hangs from it
    expect(menuBounds.y).toBeCloseTo(cardBounds.y, 0);
    const fieldBounds = (await page.locator("#prof-menu .profile-search-row").boundingBox())!;
    expect(fieldBounds.y).toBeCloseTo(cardBounds.y, 0);
    expect(fieldBounds.width).toBeCloseTo(cardBounds.width, 0);
    expect((await page.locator("#profile-card").boundingBox())!.height).toBeCloseTo(widgetBounds.height, 2);
    const surfaces = await page.evaluate(() => {
      const header = getComputedStyle(document.querySelector("#profile-card")!);
      const popup = getComputedStyle(document.querySelector("#prof-menu")!);
      return { header: header.backgroundColor, popup: popup.backgroundColor };
    });
    expect(surfaces.header).toBe(surfaces.popup);
    expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole("combobox", { name: "Search profiles", exact: true })).toBeFocused();
    await expect(page.locator("#prof-search")).toHaveAttribute("placeholder", "Search 3 profiles");
    await expect(page.locator("#prof-search")).not.toHaveAttribute("aria-activedescendant");
    // a click opens with nothing lit; the first arrow press lands on the chosen profile
    await page.keyboard.press("ArrowDown");
    await expectLit(page, menu.getByRole("option", { name: "Discord", exact: true }));
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
  const options = page.getByRole("group", { name: "Compress", exact: true }).getByRole("option");
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
    await card.getByRole("button", { name: "Discard", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Save to profile", exact: true })).toBeFocused();
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
  const option = (id: string) => page.locator(`#prof-options [data-profile-id="${id}"]`);
  await page.locator("#prof-pick").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#prof-menu")).toBeVisible();
  await expectLit(page, option("discord"));
  await page.keyboard.press("ArrowDown");
  await expectLit(page, option("email"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-pick")).toBeFocused();
  await expect(page.locator("#prof-sel")).toHaveValue("discord");
  await page.keyboard.press("Enter");
  await expect(page.locator("#prof-menu")).toBeVisible();
  // with nothing typed, End and Home move through the whole list, the other task's profiles included
  await page.keyboard.press("End");
  await expectLit(page, option("upscale-4k"));
  await page.keyboard.press("Home");
  await expectLit(page, option("discord"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#prof-name")).toHaveText("Email");
  await expect(page.locator("#prof-pick")).toBeFocused();
});

test("an Upscale profile picked from the keyboard in Compress switches the task", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").focus();
  await page.keyboard.press("ArrowDown");
  const upscale = page.getByRole("group", { name: "Upscale, switches to Upscale", exact: true });
  await expect(upscale.locator(".profile-group-head")).toHaveText("Upscaleswitches to Upscale");
  await expect(upscale.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectLit(page, upscale.getByRole("option", { name: "4K", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#wf-u")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#btn-one")).toHaveText("Upscale this video");
  await expect(page.locator("#prof-name")).toHaveText("4K");
  await expect(page.locator("#prof-sel")).toHaveValue("upscale-4k");
  await expect(page.locator("#sz-grp")).toBeHidden();
  await expect(page.locator("#res-w")).toHaveValue("3840");
  await expect(page.locator("#prof-pick")).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0]))
    .toEqual(expect.objectContaining({ last_task: "upscale", last_upscale_profile_id: "upscale-4k", last_compress_profile_id: "discord" }));
  // the Compress profiles now switch back, and Compress keeps the profile it had
  await page.locator("#prof-pick").click();
  const compress = page.getByRole("group", { name: "Compress, switches to Compress", exact: true });
  await expect(page.locator("#prof-options > [role=group]").first()).toHaveAccessibleName("Upscale");
  await expect(compress.getByRole("option", { name: "Discord", exact: true })).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await page.locator("#wf-c").click();
  await expect(page.locator("#prof-name")).toHaveText("Discord");
});

test("searching finds a profile of the other task by its details and marks the match", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").click();
  const search = page.getByRole("combobox", { name: "Search profiles", exact: true });
  await expect(search).toHaveAttribute("aria-controls", "prof-options");
  const option = page.locator('#prof-options [data-profile-id="upscale-4k"]');
  // the name is only "4K"; the details carry the rest
  await search.pressSequentially("4k ·");
  await expect(page.locator("#prof-options").getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Compress", exact: true })).toHaveCount(0);
  await expectLit(page, option);
  const marks = option.locator("mark");
  await expect(marks).toHaveText(["4K ·"]);
  const style = await marks.first().evaluate((mark) => {
    const computed = getComputedStyle(mark);
    return { weight: computed.fontWeight, line: computed.textDecorationLine, background: computed.backgroundColor };
  });
  expect(style).toEqual({ weight: "700", line: "underline", background: "rgba(0, 0, 0, 0)" });
  await search.press("Enter");
  await expect(page.locator("#wf-u")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#prof-name")).toHaveText("4K");
});

test("an empty search says what found nothing and Escape puts the card back", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").click();
  const search = page.locator("#prof-search");
  await search.fill("tiktok");
  await expect(page.locator("#prof-empty")).toHaveText("No profile matches “tiktok”.");
  await expect(page.locator("#prof-options").getByRole("option")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save current settings as new…", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage profiles…", exact: true })).toBeVisible();
  await search.press("Escape");
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-pick")).toBeFocused();
  await expect(page.locator("#prof-pick")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#prof-name")).toHaveText("Discord");
  // it opens fresh next time
  await page.locator("#prof-pick").click();
  await expect(search).toHaveValue("");
  await expect(page.locator("#prof-options").getByRole("option")).toHaveCount(3);
});

test("a hidden task's profiles stay out of the profile menu", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    hidden_ui: ["upscale"],
    default_profile_id: "discord",
    profiles: [
      { profile_id: "discord", name: "Discord", workflow: "compression", resolution_mode: "source", fps_mode: "source" },
      { profile_id: "upscale-4k", name: "4K", workflow: "upscale", resolution_mode: "custom", custom_width: 3840, custom_height: 2160 },
    ],
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#prof-pick").click();
  await expect(page.locator("#prof-options .profile-option-name")).toHaveText(["Discord"]);
  await expect(page.locator("#prof-options").getByRole("group")).toHaveCount(1);
  await expect(page.locator("#prof-options").getByRole("group")).toHaveAccessibleName("Compress");
});

for (const width of [1240, 960]) {
  test(`long profile menus keep the lit option visible at ${width}px`, async ({ page }) => {
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
    const list = menu.locator(".profile-menu-list");
    const first = menu.getByRole("option", { name: "Profile 0", exact: true });
    const last = menu.getByRole("option", { name: "Zebra", exact: true });
    const inspectorScroll = await page.locator("#right-scroll").evaluate(element => element.scrollTop);
    const expectVisible = async (option: Locator) => {
      await expectLit(page, option);
      const bounds = (await list.boundingBox())!;
      const row = (await option.boundingBox())!;
      expect(row.y).toBeGreaterThanOrEqual(bounds.y);
      expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      expect(await page.locator("#right-scroll").evaluate(element => element.scrollTop)).toBe(inspectorScroll);
    };
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expectVisible(last);
    await page.keyboard.press("Home");
    await expectVisible(first);
    await page.keyboard.press("End");
    await expectVisible(last);
    // the search field stays in place while the list scrolls under it
    const search = page.locator("#prof-search");
    const popupBounds = (await menu.boundingBox())!;
    const searchBounds = (await search.boundingBox())!;
    expect(searchBounds.y).toBeGreaterThanOrEqual(popupBounds.y);
    expect(searchBounds.y + searchBounds.height).toBeLessThanOrEqual(popupBounds.y + popupBounds.height);
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(search).toBeFocused();
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
  await page.getByRole("combobox", { name: "Search profiles", exact: true }).fill("EMAIL");
  await expect(page.locator('#prof-options [data-profile-id="discord"]')).toBeHidden();
  await expect(page.locator('#prof-options [data-profile-id="email"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage profiles…", exact: true })).toBeVisible();
  await page.locator("#prof-search").fill("no matching profile");
  await expect(page.locator("#prof-empty")).toHaveText("No profile matches “no matching profile”.");
  await page.locator("#prof-search").fill("Email");
  await page.locator("#prof-search").press("Enter");
  await expect(page.locator("#prof-name")).toHaveText("Email");
  await expect(page.locator("#prof-pick")).toBeFocused();
});

test("Enter on an empty profile search keeps the menu and current profile", async ({ page }) => {
  await open(page, undefined, 8);
  await page.locator("#prof-pick").click();
  const search = page.getByRole("combobox", { name: "Search profiles", exact: true });
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

test("discarding unsaved changes can be undone, the video's transform included", async ({ page }) => {
  await open(page);
  await setSize(page, "25");
  await page.locator('[data-action-click="transform-rotation"][data-rotation="90"]').evaluate((button) => (button as HTMLButtonElement).click());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator("#sz-badge")).toHaveValue("10");
  const note = page.locator(".toast", { hasText: "Changes to Discord discarded." });
  await note.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#sz-badge")).toHaveValue("25");
  await expect(page.locator("#prof-changed")).toBeVisible();
  await expect(page.locator('[data-action-click="transform-rotation"][data-rotation="90"]')).toHaveAttribute("aria-pressed", "true");
});

test("saving as a new profile is a labelled dialog that keeps a dismissed name", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").click();
  await page.getByRole("button", { name: "Save current settings as new…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save profile as" });
  const name = dialog.getByRole("textbox", { name: "Profile name" });
  await expect(name).toBeFocused();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("Enter a name for the profile.");
  await expect(page.locator(".toast")).toHaveCount(0);
  await name.fill("Small clips");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#prof-pick")).toBeFocused();
  await page.locator("#prof-pick").click();
  await page.getByRole("button", { name: "Save current settings as new…" }).click();
  await expect(name).toHaveValue("Small clips");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.locator("#prof-pick").click();
  await page.getByRole("button", { name: "Save current settings as new…" }).click();
  await expect(name).toHaveValue("");
});

test("the plan's warnings show quietly under the profile card", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\videos\Morning ride.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15_000_000 } };
  await installFakeBackend(page, fixture);
  // plans echo their request id, the way the backend ties an answer to its request
  await page.addInitScript(() => {
    const client = window.tuckBackendClient!;
    (window as unknown as { __planWarnings: string[] }).__planWarnings = [
      "HDR colours can’t be converted with this FFmpeg, so they may look washed out.",
      "2 extra audio tracks will be left out.",
    ];
    client.createPlan = (async (request: { _request_id?: number }) => ({
      ok: true,
      value: { _request_id: request._request_id, data: { video_bitrate_kbps: 1200, warnings: (window as unknown as { __planWarnings: string[] }).__planWarnings } },
    })) as never;
  });
  await page.goto("/");
  const notes = page.getByRole("list", { name: "Export notes" });
  await expect(notes.getByRole("listitem")).toHaveText([
    "HDR colours can’t be converted with this FFmpeg, so they may look washed out.",
    "2 extra audio tracks will be left out.",
  ]);
  await page.evaluate(() => { (window as unknown as { __planWarnings: string[] }).__planWarnings = []; });
  await setSize(page, "25");
  await expect(notes).toBeHidden();
});

test("the profile menu lights one row: the pointer's row goes dark when it leaves, the keyboard's stays", async ({ page }) => {
  await open(page, undefined, 3);
  await page.locator("#prof-pick").click();
  const options = page.locator("#prof-options [role=option]");
  await expect(options).toHaveCount(4);
  const lit = () => options.evaluateAll(rows => rows.map(row => getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)"));
  // a click opens with nothing lit; the checkmark alone shows the chosen profile
  expect(await lit()).toEqual([false, false, false, false]);
  await options.nth(1).hover();
  expect(await lit()).toEqual([false, true, false, false]);
  await expect(page.locator("#prof-search")).toHaveAttribute("aria-activedescendant", (await options.nth(1).getAttribute("id"))!);
  await page.mouse.move(5, 5);
  expect(await lit()).toEqual([false, false, false, false]);
  await expect(page.locator("#prof-search")).not.toHaveAttribute("aria-activedescendant");
  // with nothing lit, the arrow keys start from the chosen profile, and that row stays lit
  await page.keyboard.press("ArrowDown");
  await expectLit(page, options.nth(0));
  expect(await lit()).toEqual([true, false, false, false]);
  await page.keyboard.press("ArrowDown");
  await expectLit(page, options.nth(1));
  expect(await lit()).toEqual([false, true, false, false]);
  // a click on a row keeps focus out of the list and picks it
  await options.nth(2).click();
  await expect(page.locator("#prof-menu")).toBeHidden();
  await expect(page.locator("#prof-sel")).toHaveValue("extra-0");
});
