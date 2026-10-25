import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, withVideo } from "../fixtures/fake-backend";

async function expectTriggerToggle(page: Page, id: string) {
  const trigger = page.locator(`#${id}-trigger`);
  const popup = page.locator(`#${id}-popup`);
  const value = await page.locator(`#${id}`).inputValue();
  await trigger.click();
  await expect(popup).toBeVisible();
  const bounds = (await trigger.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  for (let index = 0; index < 2; index++) {
    await page.mouse.click(x, y);
    await expect(popup).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    await expect(page.locator(`#${id}`)).toHaveValue(value);
    await page.mouse.click(x, y);
    await expect(popup).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
}

for (const width of [1240, 960]) {
  test(`clicking the same dropdown trigger toggles its menu at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    const fixture = withVideo(healthyBackendFixture());
    fixture.responses.getSettings = {
      ...fixture.responses.getSettings as object,
      default_profile_id: "profile-0",
      profiles: Array.from({ length: 8 }, (_, index) => ({
        profile_id: `profile-${index}`, name: `Profile ${index}`, workflow: "compression",
        resolution_mode: "source", fps_mode: "source",
      })),
    };
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await expectTriggerToggle(page, "export-res-select");
    await expectTriggerToggle(page, "export-fps-select");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expectTriggerToggle(page, "set-start-task");
    await expectTriggerToggle(page, "set-inspector-start");
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await expectTriggerToggle(page, "set-ds");
  });
}

test("Quiet dropdowns show compact labels and a neutral selection", async ({ page }) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Profiles", exact: true }).click();
  const trigger = page.locator("#set-ds-trigger");
  await trigger.click();
  const popup = page.locator("#set-ds-popup");
  const options = popup.getByRole("option");
  await expect(options).toHaveText(["Smooth", "Sharp pixels"]);
  await expect(popup.getByRole("combobox")).toHaveCount(0);
  const geometry = await options.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  for (const height of geometry) expect(height).toBeCloseTo(33, 2);
  // a click opens with nothing lit; the checkmark alone marks the chosen option, in the normal text colour
  const selected = await popup.locator('[aria-selected="true"]').evaluate(row => {
    const style = getComputedStyle(row);
    return { background: style.backgroundColor, text: style.color, check: getComputedStyle(row.querySelector("svg")!).visibility,
      foreground: getComputedStyle(document.querySelector("#set-ds-trigger")!).color };
  });
  expect(selected.background).toBe("rgba(0, 0, 0, 0)");
  expect(selected.check).toBe("visible");
  expect(selected.text).toBe(selected.foreground);
  await popup.getByRole("option", { name: "Sharp pixels", exact: true }).click();
  await expect(page.locator("#set-ds")).toHaveValue("neighbor");
  await expect(trigger).toBeFocused();
});

for (const count of [7, 8]) {
  test(`Quiet profile menus always open on their search field (${count} choices)`, async ({ page }) => {
    await page.setViewportSize({ width: count === 7 ? 960 : 1240, height: count === 7 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = withVideo(healthyBackendFixture());
    fixture.responses.getSettings = {
      ...fixture.responses.getSettings as object,
      default_profile_id: "profile-0",
      profiles: Array.from({ length: count }, (_, index) => ({
        profile_id: `profile-${index}`, name: `Profile ${index}`, workflow: "compression",
        video_encoder: "libx264", preset: "medium", resolution_mode: "source", fps_mode: "source",
      })),
    };
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (count === 7) await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const profiles = page.locator("#prof-menu");
    await page.locator("#prof-pick").click();
    await expect(profiles).toBeVisible();
    await expect(page.locator("#prof-options")).toHaveAccessibleName("Profiles");
    const search = page.getByRole("combobox", { name: "Search profiles", exact: true });
    await expect(search).toBeFocused();
    if (count === 8) {
      await search.fill("Profile 1");
    } else {
      // a click opens with nothing lit; the first arrow press lands on the chosen profile
      await page.keyboard.press("ArrowDown");
      const first = profiles.getByRole("option", { name: "Profile 0", exact: true });
      await expect(search).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
    await expect(page.locator("#prof-sel")).toHaveValue("profile-1");
    await expect(page.locator("#prof-pick")).toBeFocused();
  });
}

test("Quiet profile search still finds the settings shown in tooltips", async ({ page }) => {
  const fixture = withVideo(healthyBackendFixture());
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    profiles: Array.from({ length: 8 }, (_, index) => ({
      profile_id: `profile-${index}`, name: `Profile ${index}`, workflow: "compression",
      target_size_bytes: (10 + index * 10) * 1024 * 1024, resolution_mode: "source", fps_mode: "source",
    })),
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#prof-pick").click();
  await page.locator("#prof-search").fill("20 MB");
  await expect(page.locator("#prof-options").getByRole("option")).toHaveAccessibleName("Profile 1");
  await page.locator("#prof-search").press("Enter");
  await expect(page.locator("#prof-sel")).toHaveValue("profile-1");
});

test("short Quiet profile lists filter as you type", async ({ page }) => {
  const fixture = withVideo(healthyBackendFixture());
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    default_profile_id: "discord",
    profiles: ["Discord", "Daily", "Email"].map(name => ({
      profile_id: name.toLowerCase(), name, workflow: "compression", resolution_mode: "source", fps_mode: "source",
    })),
  };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#prof-pick").click();
  const options = page.locator("#prof-options");
  const search = page.locator("#prof-search");
  const lit = async (name: string) => expect(search).toHaveAttribute("aria-activedescendant",
    (await options.getByRole("option", { name, exact: true }).getAttribute("id"))!);
  const names = options.locator(".profile-option-name");
  await page.keyboard.press("d");
  await page.keyboard.press("a");
  await expect(names).toHaveText(["Daily"]);
  await lit("Daily");
  // clearing the search brings every profile back, lit on the chosen one
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(names).toHaveText(["Discord", "Daily", "Email"]);
  await lit("Discord");
  await page.keyboard.press("Escape");
  await page.locator("#prof-pick").click();
  await page.keyboard.press("e");
  await page.keyboard.press("m");
  await lit("Email");
  await page.keyboard.press("Enter");
  await expect(page.locator("#prof-sel")).toHaveValue("email");
  await expect(page.locator("#prof-pick")).toBeFocused();
});
