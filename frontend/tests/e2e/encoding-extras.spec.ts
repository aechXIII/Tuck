import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { chooseSelect } from "../fixtures/select";

const MB = 1024 * 1024;

async function open(page: Page, options: { tenBit?: boolean } = {}) {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  const base = { workflow: "compression", resolution_mode: "source", fps_mode: "source", audio_bitrate: 128000, two_pass: false };
  fixture.startup.files = ["C:\\videos\\Ranked match clutch.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 65, width: 2560, height: 1440, fps: 60, has_audio: true, file_size: 480_000_000 } };
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    available_encoders: ["libx264", "libx265"],
    auto_encoders: { auto_compression: "libx264", auto_fast: "libx264", auto: "libx264" },
    default_profile_id: "discord",
    profiles: [
      { ...base, profile_id: "discord", name: "Discord", target_size_bytes: 10 * MB, video_encoder: "libx264", preset: "medium", two_pass: true },
      { ...base, profile_id: "archive", name: "Archive", target_size_bytes: 50 * MB, video_encoder: "libx265", preset: "medium", rate_control_method: "crf", crf: 20 },
      {
        ...base, profile_id: "capped", name: "Capped", target_size_bytes: 50 * MB, video_encoder: "libx265", preset: "medium",
        rate_control_method: "crf", crf: 22, max_bitrate_mbps: 6, ten_bit: true, keyframe_seconds: 5,
      },
    ],
  };
  fixture.responses.getProfilesJson = (fixture.responses.getSettings as { profiles: unknown }).profiles;
  fixture.responses.estimateSize = { size_bytes: 40 * MB, video_bytes: 36 * MB, audio_bytes: 4 * MB, sampled_seconds: 3, encoder: "libx265" };
  if (options.tenBit === false) fixture.responses.checkTenBit = { ok: true, ten_bit: false };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#prof-name")).toHaveText("Discord");
}

async function useProfile(page: Page, name: string) {
  await page.locator("#prof-pick").click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await expect(page.locator("#prof-name")).toHaveText(name);
}

async function openAdvanced(page: Page) {
  await page.locator("#right summary", { hasText: "Encoder" }).click();
  await page.locator("#adv-toggle").click();
  await expect(page.locator("#max-bitrate")).toBeVisible();
}

const lastPlan = (page: Page) =>
  page.evaluate(() => [...(window.__tuckFakeBackendCalls ?? [])].reverse().find((call) => call.method === "createPlan")?.args[0] as Record<string, unknown> | undefined);
const callsTo = (page: Page, method: string) =>
  page.evaluate((name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args), method);

test("a cap, 10-bit and keyframe spacing reach the plan and save to the profile", async ({ page }) => {
  await open(page);
  await useProfile(page, "Archive");
  await openAdvanced(page);

  await page.locator("#max-bitrate").fill("8");
  await page.locator("#max-bitrate").press("Tab");
  // the cap shows on the card without opening Advanced
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps · max 8 Mbps");

  await page.locator('label[for="ten-bit"]').click();
  await expect(page.locator("#ten-bit")).toBeChecked();
  await expect(page.locator("#export-encoder-summary")).toHaveText("H.265 · Balanced · 10-bit");
  // asked once, the first time it's turned on
  await expect.poll(() => callsTo(page, "checkTenBit")).toEqual([["libx265"]]);

  await chooseSelect(page, page.locator("#keyframe-sel-trigger"), "2");
  await expect.poll(async () => (await lastPlan(page))?.keyframe_seconds).toBe(2);
  expect(await lastPlan(page)).toMatchObject({ max_bitrate: 8_000_000, ten_bit: true, rate_control_method: "crf" });
  await expect(page.locator("#prof-sub")).toHaveAttribute("title", "Changed encoder");

  await page.getByRole("button", { name: "Save to profile", exact: true }).click();
  await expect.poll(async () => (await callsTo(page, "updateProfile"))[0])
    .toEqual(["archive", expect.objectContaining({ max_bitrate_mbps: 8, ten_bit: true, keyframe_seconds: 2 })]);
});

test("rows that can't be used stay in place and say why", async ({ page }) => {
  await open(page);
  await openAdvanced(page);
  // Discord aims for a size with H.264
  await expect(page.locator("#max-bitrate")).toBeDisabled();
  await expect(page.locator("#max-bitrate")).toHaveAttribute("placeholder", "Set by Size");
  await expect(page.locator("#ten-bit")).toBeDisabled();
  await expect(page.locator("#ten-bit-note")).toHaveText("10-bit needs H.265.");
  await expect.poll(async () => (await lastPlan(page))?.max_bitrate).toBe(0);
  expect(await lastPlan(page)).toMatchObject({ ten_bit: false, keyframe_seconds: 0 });

  // switching the goal doesn't change the rows' own size
  const span = async () => {
    const top = (await page.locator("#max-bitrate-row").boundingBox())!.y;
    return (await page.locator("#keyframe-sel-trigger").boundingBox())!.y - top;
  };
  const before = await span();
  await page.locator('[data-goal-col="quality"]').click();
  await expect(page.locator("#max-bitrate")).toBeEnabled();
  await expect(page.locator("#max-bitrate")).toHaveAttribute("placeholder", "No limit");
  expect(await span()).toBe(before);
});

test("an encoder that can't make 10-bit turns the switch back off and says why", async ({ page }) => {
  await open(page, { tenBit: false });
  await useProfile(page, "Archive");
  await openAdvanced(page);
  await page.locator('label[for="ten-bit"]').click();
  await expect(page.locator("#ten-bit-note")).toHaveText("10-bit needs a GPU encoder here.");
  await expect(page.locator("#ten-bit")).not.toBeChecked();
  await expect(page.locator("#ten-bit")).toBeDisabled();
  await expect.poll(async () => (await lastPlan(page))?.ten_bit).toBe(false);
});

test("a profile's settings load into the panel and the profile editor", async ({ page }) => {
  await open(page);
  await useProfile(page, "Capped");
  await openAdvanced(page);
  await expect(page.locator("#max-bitrate")).toHaveValue("6");
  await expect(page.locator("#ten-bit")).toBeChecked();
  await expect(page.locator("#keyframe-sel-trigger")).toHaveText("5 seconds");
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps · max 6 Mbps");
  await expect(page.locator("#prof-sub")).not.toHaveAttribute("title", /Changed/);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-profiles").click();
  await page.getByRole("button", { name: "Edit Capped", exact: true }).click();
  await page.locator("#pe-advanced-button").click();
  await expect(page.locator("#pe-max-bitrate")).toHaveValue("6");
  await expect(page.locator("#pe-ten-bit")).toBeChecked();
  await chooseSelect(page, page.locator("#pe-keyframe-trigger"), "10");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(async () => (await callsTo(page, "updateProfile"))[0])
    .toEqual(["capped", expect.objectContaining({ max_bitrate_mbps: 6, ten_bit: true, keyframe_seconds: 10 })]);
});

test("the profile editor's fields show their whole placeholder and line up with its menus", async ({ page }) => {
  await open(page);
  await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans", sans-serif; }' });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-profiles").click();
  await page.getByRole("button", { name: "Edit Discord", exact: true }).click();
  await page.locator("#pe-advanced-button").click();
  // room left for the placeholder inside the field, measured in the placeholder's own font
  const room = () => page.locator("#pe-max-bitrate").evaluate((field: HTMLInputElement) => {
    const style = getComputedStyle(field);
    const probe = document.createElement("span");
    probe.style.cssText = "position: absolute; white-space: pre";
    probe.style.font = getComputedStyle(field, "::placeholder").font;
    probe.textContent = field.placeholder;
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    return field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - needed;
  });
  const left = async (selector: string) => (await page.locator(selector).boundingBox())!.x;

  await expect(page.locator("#pe-max-bitrate")).toHaveAttribute("placeholder", "Set by Size");
  expect(await room()).toBeGreaterThanOrEqual(0);
  expect(await left('[data-setting="pe-max-bitrate"] .set-input')).toBe(await left("#pe-keyframe-trigger"));

  await page.locator("#pe-u").click();
  await chooseSelect(page, page.locator("#pe-rc-trigger"), "CBR");
  await expect(page.locator("#pe-max-bitrate")).toHaveAttribute("placeholder", "Set by Bitrate");
  expect(await room()).toBeGreaterThanOrEqual(0);
  for (const setting of ["pe-bitrate", "pe-max-bitrate", "pe-audio"]) {
    expect(await left(`[data-setting="${setting}"] .set-input`)).toBe(await left("#pe-keyframe-trigger"));
  }
});
