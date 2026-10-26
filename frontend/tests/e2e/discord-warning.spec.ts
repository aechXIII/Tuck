import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, withVideo } from "../fixtures/fake-backend";

const MB = 1024 * 1024;
const DISCORD_WARNING =
  "Discord doesn't play H.265 in the chat on every device, so some friends would have to download it. H.264 plays everywhere.";

async function open(page: Page) {
  const fixture = healthyBackendFixture();
  withVideo(fixture);
  fixture.responses.getSettings = {
    ...fixture.responses.getSettings as object,
    available_encoders: ["libx264", "libx265"],
    default_profile_id: "discord-free",
    profiles: [{
      profile_id: "discord-free",
      name: "Discord Free - 20MB",
      workflow: "compression",
      target_size_bytes: 20 * MB,
      resolution_mode: "source",
      fps_mode: "source",
      video_encoder: "libx265",
      preset: "medium",
      audio_bitrate: 128000,
      keep_audio: true,
      builtin: true,
    }],
  };
  // plans answer by hand, so the one shown carries what the backend chose
  fixture.holdMethods = ["createPlan"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#prof-name")).toHaveText("Discord Free - 20MB");
}

async function answerPlans(page: Page, data: Record<string, unknown>): Promise<void> {
  const pending = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan").map((call) => call.args[0]));
  await page.evaluate(({ requests, data }) => {
    for (const request of requests) {
      window.__tuckReleaseHeld?.("createPlan", { ok: true, _request_id: (request as Record<string, unknown>)._request_id, data });
    }
  }, { requests: pending, data });
}

test("the Discord note shows under the profile card when the plan says H.265 won't play", async ({ page }) => {
  await open(page);
  await answerPlans(page, { warnings: [DISCORD_WARNING] });
  await expect(page.locator("#export-plan-warnings")).toHaveText(DISCORD_WARNING);
  await expect(page.locator("#export-plan-warnings")).toBeVisible();
});
