import { chooseSelect } from "../fixtures/select";
import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const profiles = [
  { profile_id: "everyday", name: "Everyday", workflow: "compression", builtin: true },
  { profile_id: "sharing", name: "Sharing", workflow: "compression", builtin: false },
];

async function start(page: Page, settings: Record<string, unknown> = {}, responses: Record<string, unknown> = {}) {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as Record<string, unknown>,
    default_profile_id: "everyday",
    profiles,
    ...settings,
  };
  fixture.responses.getProfilesJson = profiles;
  Object.assign(fixture.responses, responses);
  await installFakeBackend(page, fixture);
  await keepSavedSettings(page);
  await page.goto("/");
}

// the sidecar reads saved settings back; the fake returns its fixture unless told otherwise
async function keepSavedSettings(page: Page) {
  await page.addInitScript(() => {
    const backend = window.tuckBackendClient!;
    let saved: Record<string, unknown> = {};
    const get = backend.getSettings.bind(backend);
    const save = backend.saveSettings.bind(backend);
    backend.getSettings = async () => {
      const result = await get();
      return result.ok ? { ...result, value: { ...result.value, ...saved } as typeof result.value } : result;
    };
    backend.saveSettings = async (settings) => {
      const result = await save(settings);
      if (result.ok) saved = { ...saved, ...(settings as Record<string, unknown>) };
      return result;
    };
  });
}

async function openSettings(page: Page, section?: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  if (section) await page.locator(`#settings-nav-${section}`).click();
}

const savedWith = (page: Page, key: string, value: unknown) =>
  expect.poll(() => page.evaluate(([name, expected]) =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "saveSettings")
      .some((call) => JSON.stringify((call.args[0] as Record<string, unknown>)[name as string]) === JSON.stringify(expected)),
  [key, value] as const)).toBe(true);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
});

test("show-export preference saves through the existing settings key", async ({ page }, testInfo) => {
  await start(page);
  await openSettings(page, "queue");
  await expect(page.locator("#settings-autosave")).toHaveText("Changes save automatically");
  const option = page.getByRole("switch", { name: "Show the last export in its folder" });
  await page.getByText("Show the last export in its folder", { exact: true }).click();
  await expect(option).toBeChecked();
  for (const width of [1240, 960]) {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await expect(page.getByText("Show the last export in its folder", { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`show-export-${width}.png`) });
  }
  // there is no Save button; the change is saved as it is made, and the header says so
  await savedWith(page, "open_output_folder_after_queue", true);
  await expect(page.locator("#settings-status")).toHaveText("Saved");
  await expect(page.locator("#settings-autosave")).toBeHidden();
  await expect(page.locator("#settings-autosave")).toBeVisible();
  await expect(page.locator("#settings-status")).toHaveText("");
});

test("removing videos after they export is off by default, found by search, and saved", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("remove videos");
  await page.locator(".set-result", { hasText: "Remove videos after they export" }).click();
  await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible();
  const option = page.getByRole("switch", { name: "Remove videos after they export" });
  await expect(option).not.toBeChecked();
  await page.getByText("Remove videos after they export", { exact: true }).click();
  await expect(option).toBeChecked();
  await savedWith(page, "remove_after_export", true);
});

test("a rejected save keeps the change visible and explains why", async ({ page }) => {
  await start(page, {}, { saveSettings: { ok: false, error: "Settings could not be written." } });
  await openSettings(page, "appearance");
  await page.getByRole("radio", { name: "Teal" }).check();
  await expect(page.getByText("Settings could not be written.")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", "teal");
  await expect(page.locator("#settings-status")).toHaveText("");
});

test("the dialog keeps one size on every page and fits the minimum window", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(page.locator("#settings-nav-general")).toBeFocused();
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");
  const size = async () => dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
  const first = await size();
  for (const section of ["keyboard", "about", "tools", "profiles"]) {
    await page.locator(`#settings-nav-${section}`).click();
    expect(await size()).toEqual(first);
  }
  expect(first.height).toBeLessThanOrEqual(640 - 32);
  await expect(page.locator("#settings-nav-about")).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // long pages scroll inside the dialog and leave the header in place
  await page.locator("#settings-nav-keyboard").click();
  await page.locator("#settings-page").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator("#settings-close")).toBeInViewport();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe("settings-enter");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await expect(page.locator("#editor-shell")).not.toHaveAttribute("inert", "");
});

test("the sidebar groups its pages under Workspace, Export, and System", async ({ page }) => {
  await start(page);
  await openSettings(page);
  for (const [group, pages] of [
    ["Workspace", ["General", "Appearance", "Tasks & tools", "Keyboard"]],
    ["Export", ["Files & names", "Queue", "Profiles"]],
    ["System", ["File Explorer", "Media tools", "About"]],
  ] as const) {
    const section = page.getByRole("group", { name: group, exact: true });
    for (const name of pages) await expect(section.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Media tools", exact: true }).click();
  await expect(page.locator("#settings-nav-media")).toHaveAttribute("aria-current", "page");
});

test("search finds settings on every page and opens the one chosen", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const search = page.getByRole("searchbox", { name: "Search settings" });
  await search.fill("folder");
  await expect(page.getByRole("heading", { name: "Results for “folder”" })).toBeVisible();
  await expect(page.locator(".set-result")).toHaveCount(4);
  await expect(page.locator("#settings-nav-queue .settings-nav-count")).toHaveText("1");
  await expect(page.locator("#settings-nav-general")).toHaveClass(/dimmed/);
  await page.locator(".set-result", { hasText: "Show the last export in its folder" }).click();
  await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Show the last export in its folder" })).toBeFocused();
  await expect(search).toHaveValue("");

  await search.fill("hdr");
  await expect(page.getByText("No settings match “hdr”.")).toBeVisible();
  // Esc clears the search first and keeps Settings open
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible();
});

test("keyboard shortcuts can be found from settings search", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("split");
  await page.locator(".set-result", { hasText: "Split at playhead" }).click();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change keys for Split at playhead" })).toBeFocused();
});

test("appearance applies at once and is saved", async ({ page }) => {
  await start(page);
  await openSettings(page, "appearance");
  await page.getByRole("radio", { name: "Teal" }).check();
  await savedWith(page, "accent_color", "teal");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "teal");
  const button = page.locator(".set-accent-preview .set-btn");
  expect(await button.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(9, 123, 119)");

  await page.getByText("Animations", { exact: true }).click();
  await savedWith(page, "animations", false);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");

  await page.getByRole("radio", { name: "Large" }).check();
  await savedWith(page, "interface_size", "large");
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "setInterfaceSize").map((call) => call.args[0]))).toEqual(["large"]);
});

test("the saved look comes back at launch", async ({ page }) => {
  await start(page, { accent_color: "rose", animations: false, interface_size: "compact" });
  await expect(page.locator("html")).toHaveAttribute("data-accent", "rose");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "setInterfaceSize").map((call) => call.args[0]))).toEqual(["compact"]);
});

test("exports can go into a folder next to each source", async ({ page }) => {
  await start(page);
  await openSettings(page, "files");
  const name = page.getByLabel("Folder name", { exact: true });
  await expect(name).toBeHidden();
  await page.getByRole("radio", { name: "In a subfolder" }).check();
  await expect(name).toHaveValue("Tucked");
  await savedWith(page, "output_location", "subfolder");
  await name.fill("Small");
  await name.press("Tab");
  await savedWith(page, "output_subfolder", "Small");
});

test("choosing one folder asks for the folder and keeps the old choice when none is picked", async ({ page }) => {
  await start(page, {}, { pickFolder: { path: "" } });
  await openSettings(page, "files");
  await page.getByRole("radio", { name: "One folder" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.some((call) => call.method === "pickFolder"))).toBe(true);
  await expect(page.getByRole("radio", { name: "Next to source" })).toBeChecked();
  await expect(page.getByLabel("Folder name", { exact: true })).toBeHidden();
  expect(await page.evaluate(() =>
    window.__tuckFakeBackendCalls?.some((call) => call.method === "saveSettings"))).toBe(false);
});

test("a rejected file name shows its message beside the field", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.tuckBackendClient!.saveSettings = async () =>
      ({ ok: false, error: { code: "BACKEND_REJECTED", message: "The lossless cut suffix cannot use tokens like {size}.", details: {} } });
  });
  await openSettings(page, "files");
  const field = page.getByLabel("Lossless cut suffix", { exact: true });
  await field.fill("_cut{size}");
  await expect(page.locator(`[data-setting="suffix-cut"] .set-desc`)).toHaveText("Morning ride_cut{size}.mp4");
  await field.press("Tab");
  await expect(page.locator("#set-cuts-error")).toHaveText("The lossless cut suffix cannot use tokens like {size}.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
});

test("name tokens are inserted from the token menu", async ({ page }) => {
  await start(page);
  await openSettings(page, "files");
  const field = page.getByLabel("Upscale suffix", { exact: true });
  await field.fill("_big_");
  await page.locator('[data-setting="suffix-upscale"] summary').click();
  await page.getByRole("menuitem", { name: "{height}" }).click();
  await expect(field).toHaveValue("_big_{height}");
  await expect(field).toBeFocused();
  await savedWith(page, "upscale_suffix", "_big_{height}");
});

test("a profile becomes the default from its menu", async ({ page }) => {
  await start(page);
  await openSettings(page, "profiles");
  await expect(page.getByRole("list", { name: "Your profiles" })).toContainText("Sharing");
  await expect(page.getByRole("list", { name: "Built-in profiles" })).toContainText("Everyday");
  await expect(page.locator(".set-tag.default")).toHaveCount(1);
  await page.getByLabel("More actions for Sharing", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Set as default" }).click();
  await savedWith(page, "default_profile_id", "sharing");
  // the list is rebuilt, and focus stays on the same profile's menu
  await expect(page.getByLabel("More actions for Sharing", { exact: true })).toBeFocused();
});

test("Esc closes an open profile menu before it closes Settings", async ({ page }) => {
  await start(page);
  await openSettings(page, "profiles");
  const menuButton = page.getByLabel("More actions for Sharing", { exact: true });
  await menuButton.click();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeHidden();
  await expect(menuButton).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});

test("settings back up to a file, come back from one, and reset", async ({ page }) => {
  await start(page, {}, { pickSaveFile: { path: "C:/backup.json" }, pickImportFile: { path: "C:/backup.json" } });
  await openSettings(page, "about");
  await page.getByRole("button", { name: "Export settings to a file" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.find((call) => call.method === "exportSettingsToFile")?.args)).toEqual(["C:/backup.json"]);
  await page.getByRole("button", { name: "Import settings from a file" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.find((call) => call.method === "importSettingsFromFile")?.args)).toEqual(["C:/backup.json"]);
  await page.getByRole("button", { name: "Reset settings" }).click();
  await page.getByRole("dialog", { name: "Reset settings?" }).getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.some((call) => call.method === "resetSettings"))).toBe(true);
});

test("last session's videos come back when reopening is on", async ({ page }) => {
  await start(page, { reopen_last_videos: true, last_session_files: ["C:/videos/Kept.mp4"] });
  await expect(page.locator('[data-clip-path="C:/videos/Kept.mp4"]')).toHaveCount(1);
});

test("files sent to Tuck win over last session's videos", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:/videos/Sent.mp4"];
  fixture.responses.getSettings = { ...fixture.responses.getSettings as object, reopen_last_videos: true, last_session_files: ["C:/videos/Kept.mp4"] };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator('[data-clip-path="C:/videos/Sent.mp4"]')).toHaveCount(1);
  await expect(page.locator('[data-clip-path="C:/videos/Kept.mp4"]')).toHaveCount(0);
});

test("turning reopening on remembers the Library", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:/videos/One.mp4"];
  await installFakeBackend(page, fixture);
  await keepSavedSettings(page);
  await page.goto("/");
  await expect(page.locator('[data-clip-path="C:/videos/One.mp4"]')).toHaveCount(1);
  await openSettings(page);
  await page.getByText("Reopen last videos", { exact: true }).click();
  await savedWith(page, "reopen_last_videos", true);
  await savedWith(page, "last_session_files", ["C:/videos/One.mp4"]);
});

test("time format changes the timeline readout", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:/videos/One.mp4"];
  fixture.responses.probeFile = { data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15000000 } };
  fixture.responses.getSettings = { ...fixture.responses.getSettings as object, time_format: "frames" };
  await installFakeBackend(page, fixture);
  await keepSavedSettings(page);
  await page.goto("/");
  await expect(page.locator("#tl-corner-time")).toHaveText("0 f");
  await expect(page.locator("#tl-corner-time")).toHaveAttribute("aria-label", "Playhead at 0 f of 360 f");
  await openSettings(page);
  await page.getByRole("radio", { name: "00:01:03:12" }).check();
  await savedWith(page, "time_format", "timecode");
  await expect(page.locator("#tl-corner-time")).toHaveText("00:00:00:00");
  await expect(page.locator("#tl-corner-time")).toHaveAttribute("aria-label", "Playhead at 00:00:00:00 of 00:00:12:00");
});

test("a setting that could not be saved asks before leaving the section", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.tuckBackendClient!.saveSettings = async () =>
      ({ ok: false, error: { code: "BACKEND_REJECTED", message: "Settings could not be saved", details: {} } });
  });
  await openSettings(page, "queue");
  await page.getByText("Clear finished jobs", { exact: true }).click();
  await page.getByRole("button", { name: "Files & names" }).click();
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Discard changes" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#set-auto-clear")).toBeChecked();
  await page.getByRole("button", { name: "Files & names" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("heading", { name: "Files & names", exact: true })).toBeVisible();
  await expect(page.locator("#settings-nav-files")).toHaveAttribute("aria-current", "page");
});

test("profile editing keeps keyboard focus and respects the selected sidebar section", async ({ page }) => {
  await start(page);
  await openSettings(page, "profiles");
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await expect(page.getByLabel("Profile name", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await page.getByLabel("Profile name", { exact: true }).fill("Weekend clips");
  await expect(page.locator("#settings-editor-note")).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Files & names", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Profile name", { exact: true })).toHaveValue("Weekend clips");
  await page.getByRole("button", { name: "Files & names", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("heading", { name: "Files & names", exact: true })).toBeVisible();
});

test("discard confirmation text stays readable in normal and hover states", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.tuckBackendClient!.saveSettings = async () =>
      ({ ok: false, error: { code: "BACKEND_REJECTED", message: "Settings could not be saved", details: {} } });
  });
  await openSettings(page, "queue");
  await page.getByText("Clear finished jobs", { exact: true }).click();
  await page.getByRole("button", { name: "Files & names" }).click();
  const discard = page.getByRole("button", { name: "Discard changes" });
  for (const hover of [false, true]) {
    if (hover) await discard.hover();
    const contrast = await discard.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
      const luminance = (color: string): number => {
        const channels = color.match(/[\d.]+/g) ?? [];
        return channels.slice(0, 3).reduce((sum, channel, index) => {
          const value = Number(channel) / 255;
          const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
        }, 0);
      };
      const style = getComputedStyle(el);
      const text = luminance(style.color);
      const fill = luminance(style.backgroundColor);
      return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
    });
    expect(contrast, hover ? "hover contrast" : "normal contrast").toBeGreaterThanOrEqual(4.5);
  }
});

test("Settings dropdowns have inset arrows and room for their text", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const styles = await page.locator(".settings-dialog .select-trigger").evaluateAll((elements) => elements.map((el) => {
    const bounds = el.getBoundingClientRect();
    const icon = el.querySelector("svg")!.getBoundingClientRect();
    const text = el.querySelector("span")!.getBoundingClientRect();
    return { inset: bounds.right - icon.right, iconWidth: icon.width, gap: icon.left - text.right, height: bounds.height };
  }));
  expect(styles.length).toBeGreaterThan(0);
  for (const style of styles) {
    expect(style.inset).toBeCloseTo(10, 0);
    expect(style.iconWidth).toBe(12);
    expect(style.gap).toBeGreaterThanOrEqual(10);
    expect(style.height).toBeCloseTo(33, 2);
  }
});

test("rows line up: every control ends at the same edge of its card", async ({ page }) => {
  await start(page);
  await openSettings(page);
  for (const section of ["general", "appearance", "tools", "files", "queue", "media", "about"]) {
    await page.locator(`#settings-nav-${section}`).click();
    const gaps = await page.locator("#settings-page .set-card").evaluateAll((cards) => cards.flatMap((card) => {
      const edge = card.getBoundingClientRect().right;
      return Array.from(card.querySelectorAll(":scope > .set-row:not(.set-profile-row)"))
        .filter((row) => (row as HTMLElement).offsetParent)
        .map((row) => {
          const controls = Array.from(row.querySelectorAll(":scope > .set-row-control > *, :scope > .toggle-track"))
            .filter((element) => element.getBoundingClientRect().width > 0 && !element.classList.contains("set-row-error"));
          const right = Math.max(...controls.map((element) => element.getBoundingClientRect().right));
          return controls.length ? Math.round(edge - right) : 16;
        });
    }));
    expect(new Set(gaps), section).toEqual(new Set([16]));
  }
});

test("Send To shortcuts are switched on and off one at a time", async ({ page }) => {
  await start(page, { hidden_ui: ["cut"] }, {
    listSendtoShortcuts: { shortcuts: [
      { name: "Tuck", type: "generic", kind: "open", status: "ok" },
      { name: "Tuck Upscale", type: "generic", kind: "upscale", status: "broken" },
    ] },
    installGenericSendto: { ok: true },
  });
  await openSettings(page, "explorer");
  await expect(page.getByRole("switch", { name: "Tuck", exact: true })).toBeChecked();
  const compress = page.getByRole("switch", { name: "Tuck Compress" });
  await expect(compress).not.toBeChecked();
  await expect(page.locator('[data-setting="st-upscale"]')).toContainText("Needs repair");
  await expect(page.locator("#st-fixed")).not.toContainText("Lossless Cut");
  await page.getByText("Tuck Compress", { exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.find((call) => call.method === "installGenericSendto")?.args)).toEqual(["compress"]);
  // turning one off asks first and stays on until confirmed
  await page.getByText("Opens the videos in Tuck.", { exact: true }).click();
  await expect(page.getByRole("switch", { name: "Tuck", exact: true })).toBeChecked();
  await page.getByRole("dialog", { name: "Remove shortcut?" }).getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.find((call) => call.method === "removeGenericSendto")?.args)).toEqual(["open"]);
});

test("the default scaler is set from Profiles", async ({ page }) => {
  await start(page);
  await openSettings(page, "profiles");
  await chooseSelect(page, page.locator("#set-ds-trigger"), "Bicubic");
  await savedWith(page, "default_scaler", "bicubic");
});

test("a change made while the previous one is still saving is saved too", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.holdMethods = ["saveSettings"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await openSettings(page, "queue");
  await page.getByText("Clear finished jobs", { exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "saveSettings").length)).toBe(1);
  // the first save is still on its way to disk
  await page.getByText("Keep the PC awake", { exact: true }).click();
  await page.evaluate(() => window.__tuckReleaseHeld?.("saveSettings"));
  await expect.poll(() => page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "saveSettings").length)).toBe(2);
  await page.evaluate(() => window.__tuckReleaseHeld?.("saveSettings"));
  const saves = await page.evaluate(() =>
    window.__tuckFakeBackendCalls?.filter((call) => call.method === "saveSettings").map((call) => call.args[0]));
  expect(saves?.at(-1)).toMatchObject({ clear_completed_automatically: true, keep_awake: false });
});

test("the profile editor can't be replaced by a search halfway through an edit", async ({ page }) => {
  await start(page);
  await openSettings(page, "profiles");
  await page.getByRole("button", { name: "Edit Sharing", exact: true }).click();
  await expect(page.locator("#pe-name")).toBeVisible();
  await page.locator("#pe-name").fill("Sharing changed");
  await expect(page.getByPlaceholder("Search settings")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard", exact: false }).click();
  await expect(page.getByPlaceholder("Search settings")).toBeEnabled();
});

test("an empty export folder name is explained beside the field", async ({ page }) => {
  await start(page, {}, { saveSettings: { ok: true } });
  await openSettings(page, "files");
  await page.getByRole("radio", { name: "In a subfolder" }).check();
  await savedWith(page, "output_location", "subfolder");
  await page.evaluate(() => {
    const backend = window.tuckBackendClient!;
    backend.saveSettings = async () => ({ ok: false, error: { code: "INTERNAL_ERROR", message: "Enter a name for the export folder." } } as never);
  });
  const name = page.getByLabel("Folder name", { exact: true });
  await name.fill("");
  await name.press("Tab");
  await expect(page.locator("#set-subfolder-error")).toHaveText("Enter a name for the export folder.");
  await expect(name).toHaveAttribute("aria-invalid", "true");
});

test("loop, skip length and what happens to a taken name are saved", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const loop = page.getByRole("switch", { name: "Loop playback" });
  await expect(loop).toBeChecked();
  await page.getByText("Loop playback", { exact: true }).click();
  await savedWith(page, "loop_playback", false);
  await page.getByRole("radio", { name: "10 s" }).check();
  await savedWith(page, "skip_seconds", "10");
  await page.locator("#settings-nav-files").click();
  await expect(page.getByRole("radio", { name: "Add a number" })).toBeChecked();
  await page.getByRole("radio", { name: "Replace the old file" }).check();
  await savedWith(page, "name_taken", "replace");
});

test("pinned profiles lead the picker and hidden ones leave it", async ({ page }) => {
  const many = [
    { profile_id: "everyday", name: "Everyday", workflow: "compression", builtin: true },
    { profile_id: "sharing", name: "Sharing", workflow: "compression", builtin: false },
    { profile_id: "archive", name: "Archive", workflow: "compression", builtin: false },
  ];
  await start(page, { profiles: many }, { getProfilesJson: many });
  await openSettings(page, "profiles");
  await page.getByLabel("More actions for Archive", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to top of picker" }).click();
  await savedWith(page, "pinned_profile_ids", ["archive"]);
  await expect(page.getByRole("list", { name: "Your profiles" }).locator(".set-profile-row").filter({ hasText: "Archive" }))
    .toContainText("Pinned");
  await expect(page.getByLabel("More actions for Archive", { exact: true })).toBeFocused();
  await page.getByLabel("More actions for Sharing", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Hide from picker" }).click();
  await savedWith(page, "hidden_profile_ids", ["sharing"]);
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.locator("#prof-pick").click();
  const names = page.locator("#prof-options .profile-option-name");
  await expect(names).toHaveText(["Archive", "Everyday"]);
  await expect(page.locator("#prof-options .profile-option.pinned-last")).toHaveCount(1);
});

test("the timeline style is Graphite by default and Violet when chosen", async ({ page }) => {
  await start(page);
  await expect(page.locator("html")).toHaveAttribute("data-timeline", "graphite");
  await openSettings(page, "appearance");
  // the accent swatches have a Violet too, so look inside the Timeline row
  const timeline = page.locator('[data-setting="timeline-style"]');
  await expect(timeline.getByRole("radio", { name: "Graphite" })).toBeChecked();
  await timeline.getByRole("radio", { name: "Violet" }).check();
  await savedWith(page, "timeline_style", "violet");
  await expect(page.locator("html")).toHaveAttribute("data-timeline", "violet");
});

test("paths, names, and versions from the backend show as text, never as markup", async ({ page }) => {
  const hostile = `<img src=x onerror="window.__settingsInjected=1"> "quoted" & 'more'`;
  const folder = `C:\\Exports\\${hostile}`;
  const ffmpeg = `C:\\Tools\\${hostile}\\ffmpeg.exe`;
  await start(page, {
    version: hostile,
    last_update_check: hostile,
    output_location: "folder",
    output_dir: folder,
    output_subfolder: hostile,
    compression_suffix: `_${hostile}`,
    ffmpeg_available: true,
    ffmpeg_path: ffmpeg,
    available_encoders: [hostile],
  }, {
    getProfilesJson: [{ profile_id: "odd", name: `Odd ${hostile}`, workflow: "compression", builtin: false }],
  });
  const settingsPage = page.locator("#settings-page");

  await openSettings(page, "files");
  await expect(settingsPage.locator('[data-setting="folder"] .set-desc')).toHaveText(folder);
  await expect(page.locator("#set-od")).toHaveAttribute("data-path", folder);
  await expect(page.locator("#set-cs")).toHaveValue(`_${hostile}`);
  await expect(settingsPage.locator('[data-setting="suffix-compression"] .set-desc')).toHaveText(`Morning ride_${hostile}.mp4`);
  await expect(settingsPage.locator("img")).toHaveCount(0);

  await page.locator("#settings-nav-media").click();
  await expect(settingsPage.locator('[data-setting="ffmpeg"] .set-path')).toHaveText(ffmpeg);
  await expect(settingsPage.locator(".set-chip")).toHaveText([hostile]);
  await expect(settingsPage.locator("img")).toHaveCount(0);

  await page.locator("#settings-nav-about").click();
  await expect(settingsPage.locator(".set-about-name .mono")).toHaveText(hostile);
  await expect(settingsPage.locator('[data-setting="updates"] .set-desc')).toHaveText(`Last checked ${hostile}`);
  await expect(settingsPage.locator("img")).toHaveCount(0);

  await page.locator("#settings-nav-profiles").click();
  await expect(settingsPage.locator("#pm-own .set-label")).toHaveText([`Odd ${hostile}`]);
  await expect(settingsPage.locator("img")).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search settings" }).fill(hostile);
  await expect(settingsPage.locator(".set-empty")).toHaveText(`No settings match “${hostile}”.`);
  await expect(settingsPage.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "__settingsInjected"))).toBeUndefined();
});
