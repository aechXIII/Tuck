import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const A = "C:\\videos\\Alpha.mp4";
const B = "C:\\videos\\Bravo.mp4";

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  const fixture = healthyBackendFixture();
  fixture.startup.files = [A, B];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true } };
  await installFakeBackend(page, fixture);
  await page.addInitScript(([alpha, bravo]) => {
    const items = [
      { id: "a", source: "Alpha.mp4", source_path: alpha, state: "running", progress: 40 },
      { id: "b", source: "Bravo.mp4", source_path: bravo, state: "pending" },
    ];
    const client = window.tuckBackendClient;
    if (client) client.getQueueState = async () => ({ ok: true, value: { items } }) as never;
  }, [A, B]);
  await page.goto("/");
  await expect(page.locator("#qbar")).toBeVisible();
}

for (const [width, height] of [[1440, 900], [960, 640]] as const) {
  test(`Exports opened from the keyboard takes focus and gives it back at ${width}px`, async ({ page }) => {
    await open(page, width, height);
    const status = page.locator("#qstatus");
    const panel = page.getByRole("dialog", { name: "Exports" });

    // the export button sits between the status and the panel, so focus moves into the panel
    await status.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await expect(panel.locator("#exports-title")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Stop after this");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(status).toBeFocused();

    // a click leaves focus where the pointer put it
    await status.click();
    await expect(panel).toBeVisible();
    await expect(status).toBeFocused();
    await status.click();
    await expect(panel).toBeHidden();
  });
}

test("waiting exports say Waiting in the Library, like the Exports panel", async ({ page }) => {
  await open(page, 1440, 900);
  await expect(page.locator(".clip", { hasText: "Bravo.mp4" }).locator(".c-status")).toHaveText("Waiting");
  await page.locator("#qstatus").click();
  await expect(page.locator("#exports-list")).toContainText("Waiting");
});
