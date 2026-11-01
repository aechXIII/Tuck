import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import { chooseSelect } from "../fixtures/select";

const MB = 1024 * 1024;

interface OpenOptions {
  encoders?: string[];
  autoEncoders?: Record<string, string>;
  estimate?: unknown;
}

async function open(page: Page, width = 1240, options: OpenOptions = {}) {
  await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
  const fixture = healthyBackendFixture();
  const base = { workflow: "compression", resolution_mode: "source", fps_mode: "source", preset: "medium", audio_bitrate: 128000 };
  fixture.startup.files = ["C:\\videos\\Ranked match clutch.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 65, width: 2560, height: 1440, fps: 60, has_audio: true, file_size: 480_000_000 } };
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    available_encoders: options.encoders ?? ["libx264", "libx265"],
    auto_encoders: options.autoEncoders ?? { auto_compression: "libx264", auto_fast: "libx264", auto: "libx264" },
    default_profile_id: "discord",
    profiles: [
      { ...base, profile_id: "discord", name: "Discord", target_size_bytes: 10 * MB, video_encoder: "libx264", two_pass: true },
      { ...base, profile_id: "archive", name: "Archive", target_size_bytes: 50 * MB, video_encoder: "libx265", rate_control_method: "crf", crf: 20, two_pass: false },
    ],
  };
  fixture.responses.getProfilesJson = (fixture.responses.getSettings as { profiles: unknown }).profiles;
  fixture.responses.estimateSize = options.estimate ?? {
    size_bytes: 96 * MB, video_bytes: 86 * MB, audio_bytes: 10 * MB, sampled_seconds: 3, encoder: "libx264",
  };
  fixture.holdMethods = ["createPlan"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  // every plan is answered with its own request id; a size fills 65 seconds, less 128k audio
  await page.evaluate(() => {
    let answered = 0;
    window.setInterval(() => {
      const plans = (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan");
      for (; answered < plans.length; answered += 1) {
        const request = plans[answered]!.args[0] as Record<string, number | string>;
        const quality = request.rate_control_method === "crf" || request.rate_control_method === "cq";
        const mb = Number(request.target_size_bytes) / (1024 * 1024);
        window.__tuckReleaseHeld?.("createPlan", {
          ok: true,
          _request_id: request._request_id,
          data: {
            workflow: "compression", rate_control_method: request.rate_control_method,
            segment_count: 1, selected_duration: 65, target_width: 2560, target_height: 1440,
            target_size_mb: mb, audio_bitrate_kbps: 128, video_bitrate_kbps: quality ? 0 : Math.round((mb * 8 * 1048.576) / 65 - 128),
            estimated_size_mb: quality ? 0 : mb * 0.95,
          },
        });
      }
    }, 20);
  });
  if (width === 960) await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.locator("#prof-name")).toHaveText("Discord");
}

const goal = (page: Page) => page.getByRole("radiogroup", { name: "Export goal" });
const lastPlan = (page: Page) =>
  page.evaluate(() => [...(window.__tuckFakeBackendCalls ?? [])].reverse().find((call) => call.method === "createPlan")?.args[0] as Record<string, unknown> | undefined);

async function typeInto(page: Page, id: string, text: string) {
  await page.locator(id).fill(text);
  await page.locator(id).press("Enter");
}

test("Quality holds a CRF level, and Size comes back as it was", async ({ page }) => {
  await open(page);
  const size = goal(page).getByRole("radio", { name: "Size" });
  const quality = goal(page).getByRole("radio", { name: "Quality" });
  await expect(size).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps · 1.2 Mbps");
  await expect(page.locator('[data-goal-col="quality"]')).toContainText("Auto");
  const sizeBox = await page.locator("#sz-grp").boundingBox();

  await page.locator('[data-goal-col="quality"]').click();
  await expect(quality).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#q-method")).toHaveText("CRF");
  await expect(page.locator("#q-badge")).toHaveValue("23");
  await expect(page.locator('[data-goal-col="size"] .goal-auto')).toHaveText(/Estimating|About96MB/);
  await expect(page.locator("#sz-presets button")).toHaveText(["33", "28", "23", "18"]);
  await expect(page.locator("#q-slider")).toBeVisible();
  await expect(page.locator("#sz-slider")).toBeHidden();
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps");
  // the card keeps its size in both goals
  expect((await page.locator("#sz-grp").boundingBox())!.height).toBe(sizeBox!.height);
  await expect.poll(async () => (await lastPlan(page))?.rate_control_method).toBe("crf");
  expect(await lastPlan(page)).toMatchObject({ crf: 23, two_pass: false });

  await page.locator("#sz-presets button", { hasText: "18" }).click();
  await expect(page.locator("#q-badge")).toHaveValue("18");
  await expect(page.locator("#q-slider")).toHaveAttribute("aria-valuetext", "CRF 18");
  await expect.poll(async () => (await lastPlan(page))?.crf).toBe(18);

  await page.locator('[data-goal-col="size"]').click();
  await expect(page.locator("#sz-badge")).toHaveValue("10");
  await expect.poll(async () => (await lastPlan(page))?.rate_control_method).toBe("cbr");
  expect(await lastPlan(page)).toMatchObject({ two_pass: true, target_size_bytes: 10 * MB });
});

test("the Quality slider runs right for a better picture", async ({ page }) => {
  await open(page);
  await page.locator('[data-goal-col="quality"]').click();
  const slider = page.locator("#q-slider");
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(page.locator("#q-badge")).toHaveValue("22");
  await slider.press("ArrowLeft");
  await slider.press("ArrowLeft");
  await expect(page.locator("#q-badge")).toHaveValue("24");
});

test("a unit typed with the number picks its goal", async ({ page }) => {
  await open(page);
  await typeInto(page, "#sz-badge", "crf 20");
  await expect(goal(page).getByRole("radio", { name: "Quality" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#q-badge")).toHaveValue("20");

  await typeInto(page, "#q-badge", "25mb");
  await expect(goal(page).getByRole("radio", { name: "Size" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#sz-badge")).toHaveValue("25");
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps · 3.1 Mbps");

  // a bitrate sets the size whose plan gives it
  await typeInto(page, "#sz-badge", "8 mbps");
  await expect(page.locator("#sz-badge")).toHaveValue("63");
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps · 8 Mbps");

  // a number alone stays in its own goal, and nonsense puts the value back
  await typeInto(page, "#sz-badge", "40");
  await expect(page.locator("#sz-badge")).toHaveValue("40");
  await typeInto(page, "#sz-badge", "lots");
  await expect(page.locator("#sz-badge")).toHaveValue("40");
});

test("the goals are one radio group for the keyboard", async ({ page }) => {
  await open(page);
  const size = goal(page).getByRole("radio", { name: "Size" });
  const quality = goal(page).getByRole("radio", { name: "Quality" });
  await expect(quality).toHaveAttribute("tabindex", "-1");
  await size.focus();
  await page.keyboard.press("ArrowRight");
  await expect(quality).toBeFocused();
  await expect(quality).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Tab");
  await expect(page.locator("#q-badge")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowLeft");
  await expect(size).toBeFocused();
  await expect(size).toHaveAttribute("aria-checked", "true");
});

test("each encoder keeps its own level", async ({ page }) => {
  await open(page);
  await page.locator('[data-goal-col="quality"]').click();
  await typeInto(page, "#q-badge", "20");
  await page.locator(".adjust-panel > summary").filter({ has: page.locator("#export-encoder-summary") }).click();
  await chooseSelect(page, page.locator("#enc-sel-trigger"), "libx265");
  await expect(page.locator("#q-badge")).toHaveValue("28");
  await expect(page.locator("#sz-presets button")).toHaveText(["32", "28", "24", "20"]);
  await chooseSelect(page, page.locator("#enc-sel-trigger"), "libx264");
  await expect(page.locator("#q-badge")).toHaveValue("20");
  // Quality is met in one pass; Size keeps the two-pass switch as it was
  await expect(page.locator("#two-pass")).toBeDisabled();
  await page.locator('[data-goal-col="size"]').click();
  await expect(page.locator("#two-pass")).toBeEnabled();
  await expect(page.locator("#two-pass")).toBeChecked();
});

test("a Quality profile applies its level, and a changed level saves to it", async ({ page }) => {
  await open(page);
  await page.locator("#prof-pick").click();
  await expect(page.getByRole("option", { name: /Archive/ })).toContainText("CRF 20");
  await page.getByRole("option", { name: /Archive/ }).click();
  await expect(goal(page).getByRole("radio", { name: "Quality" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#q-badge")).toHaveValue("20");

  await page.locator("#sz-presets button", { hasText: "24" }).click();
  await expect(page.locator("#prof-sub")).toHaveAttribute("title", "CRF 24, was CRF 20");
  await page.getByRole("button", { name: "Save to profile", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.find((call) => call.method === "updateProfile")?.args))
    .toEqual(["archive", expect.objectContaining({ rate_control_method: "crf", crf: 24, two_pass: false, video_encoder: "libx265" })]);
});

test("the goals fit the Inspector at 960 wide", async ({ page }) => {
  await open(page, 960);
  await page.locator("#right").evaluate((right) => Promise.all(right.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  await typeInto(page, "#sz-badge", "1000");
  const card = await page.locator("#profile-card").boundingBox();
  for (const selector of ["#sz-badge", "#sz-unit", "#sz-presets button >> nth=3", '[data-goal-col="quality"]']) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(card!.x + card!.width);
  }
});

async function editProfile(page: Page, name: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-nav-profiles").click();
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  await expect(page.locator("#pe-name")).toBeVisible();
}

const savedProfile = (page: Page) =>
  page.evaluate(() => window.__tuckFakeBackendCalls?.find((call) => call.method === "updateProfile")?.args[1] as Record<string, unknown> | undefined);

test("the profile editor keeps a Quality profile's goal and level through an edit", async ({ page }) => {
  await open(page);
  await editProfile(page, "Archive");
  const goalChoice = page.getByRole("group", { name: "Goal", exact: true });
  await expect(goalChoice.getByRole("button", { name: "Quality" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pe-level")).toHaveValue("20");
  await expect(page.locator("#pe-level-row .set-input-unit")).toHaveText("CRF");
  await expect(page.locator("#pe-size")).toBeHidden();
  await expect(page.getByRole("group", { name: "Quality presets" }).getByRole("button")).toHaveText(["32", "28", "24", "20"]);

  await page.locator("#pe-name").fill("Archive copy");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => savedProfile(page)).toMatchObject({ name: "Archive copy", rate_control_method: "crf", crf: 20, two_pass: false });
});

test("the profile editor switches a Size profile to Quality and back", async ({ page }) => {
  await open(page);
  await editProfile(page, "Discord");
  const goalChoice = page.getByRole("group", { name: "Goal", exact: true });
  await expect(goalChoice.getByRole("button", { name: "Size" })).toHaveAttribute("aria-pressed", "true");
  const sizeRow = (await page.locator("#pe-size-sec").boundingBox())!;

  await goalChoice.getByRole("button", { name: "Quality" }).click();
  await expect(page.locator("#pe-level")).toHaveValue("23");
  await expect(page.locator("#pe-two-pass")).toBeDisabled();
  // the section keeps its height, so nothing below it moves
  expect((await page.locator("#pe-size-sec").boundingBox())!.height).toBe(sizeRow.height);
  await page.getByRole("group", { name: "Quality presets" }).getByRole("button", { name: "CRF 18" }).click();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => savedProfile(page)).toMatchObject({ rate_control_method: "crf", crf: 18, two_pass: false });
});

const sizeColumn = (page: Page) => page.locator('[data-goal-col="size"]');
const estimateCalls = (page: Page) =>
  page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "estimateSize").map((call) => call.args[0] as Record<string, unknown>));

test("with Quality set the Size column estimates the size, and a click makes it the size", async ({ page }) => {
  await open(page);
  await goal(page).getByRole("radio", { name: "Quality" }).click();
  await expect(sizeColumn(page).locator(".goal-auto")).toHaveText("Estimating");
  await expect(sizeColumn(page).locator(".goal-auto")).toHaveText("About96MB");
  await expect(page.locator("#sz-est-status")).toHaveText("About 96 MB");
  const asked = await estimateCalls(page);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ rate_control_method: "crf", crf: 23, two_pass: false });
  await expect(goal(page).getByRole("radio", { name: "Size" })).toHaveAttribute("title", "Use 96 MB as the size");
  // the same settings come back from the kept result, without encoding again
  await page.locator("#sz-presets button", { hasText: "18" }).click();
  await expect(sizeColumn(page).locator(".goal-auto")).toHaveText("About96MB");
  await expect.poll(async () => (await estimateCalls(page)).length).toBe(2);
  await page.locator("#sz-presets button", { hasText: "23" }).click();
  await expect(sizeColumn(page).locator(".goal-auto")).toHaveText("About96MB");
  expect(await estimateCalls(page)).toHaveLength(2);
  await sizeColumn(page).click();
  await expect(page.locator("#sz-grp")).toHaveAttribute("data-goal", "size");
  await expect(page.locator("#sz-badge")).toHaveValue("96");
});

test("a failed estimate says so, with the reason in the tooltip", async ({ page }) => {
  await open(page, 1240, { estimate: { ok: false, code: "failed", error: "FFmpeg stopped at 0.4 s." } });
  await goal(page).getByRole("radio", { name: "Quality" }).click();
  await expect(sizeColumn(page).locator(".goal-auto")).toHaveText("No estimate");
  await expect(goal(page).getByRole("radio", { name: "Size" })).toHaveAttribute("title", "No estimate: FFmpeg stopped at 0.4 s.");
  // going back to Size stops asking and shows the size again
  await goal(page).getByRole("radio", { name: "Size" }).click();
  await expect(page.locator("#sz-badge")).toHaveValue("10");
});

test("the encoder chips flip the codec and where it runs", async ({ page }) => {
  await open(page, 1240, {
    encoders: ["libx264", "libx265", "h264_nvenc", "hevc_nvenc"],
    autoEncoders: { auto_compression: "libx264", auto_fast: "h264_nvenc", auto: "h264_nvenc" },
  });
  const chips = page.getByRole("group", { name: "Encoder" });
  const codec = page.locator("#enc-codec");
  const place = page.locator("#enc-place");
  await expect(chips).toBeVisible();
  await expect(codec).toHaveText("H.264");
  await expect(place).toHaveText("CPU");
  await expect(place).toHaveAttribute("title", "Use the GPU");
  await place.click();
  await expect(page.locator("#enc-sel")).toHaveValue("h264_nvenc");
  await expect(place).toHaveText("GPU");
  await codec.click();
  await expect(page.locator("#enc-sel")).toHaveValue("hevc_nvenc");
  await expect(codec).toHaveText("H.265");
  // the level follows the encoder: NVIDIA is CQ, and H.265 starts higher
  await goal(page).getByRole("radio", { name: "Quality" }).click();
  await expect(page.locator("#q-method")).toHaveText("CQ");
  await expect(page.locator("#q-badge")).toHaveValue("28");
  await place.click();
  await expect(page.locator("#enc-sel")).toHaveValue("libx265");
  await expect(page.locator("#q-method")).toHaveText("CRF");
  await expect(page.locator("#export-summary-detail")).toHaveText("2560×1440 · 60 fps");
});

test("a chip with nothing to switch to is greyed out and says why", async ({ page }) => {
  await open(page);
  await expect(page.locator("#enc-place")).toBeDisabled();
  await expect(page.locator("#enc-place")).toHaveAttribute("title", "No H.264 encoder for the GPU was found");
  await expect(page.locator("#enc-codec")).toBeEnabled();
});
