import { expect, test } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

test("the Inspector mixer and the timeline share source audio mute, and output audio is a switch", async ({ page }) => {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: ["C:\\media\\Mixer.mp4"] };
  fixture.responses.probeFile = {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true },
  };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos" }).click();
  await page.locator("#insp-tab-edit").click();

  const mixer = page.locator("#audio-track-mixer");
  const mixerMute = mixer.getByRole("button", { name: "Mute Source audio", exact: true });
  await expect(mixerMute).toHaveAttribute("aria-pressed", "false");
  await mixerMute.click();
  await expect(mixer.getByRole("button", { name: "Unmute Source audio", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Unmute source audio", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Unmute source audio", exact: true }).click();
  await expect(mixer.getByRole("button", { name: "Mute Source audio", exact: true })).toHaveAttribute("aria-pressed", "false");

  const output = page.getByRole("switch", { name: "Include audio in export", exact: true });
  await expect(output).toHaveAttribute("aria-checked", "true");
  await output.click();
  await expect(output).toHaveAttribute("aria-checked", "false");
  await output.click();
  await expect(output).toHaveAttribute("aria-checked", "true");
});
