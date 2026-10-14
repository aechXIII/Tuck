import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import type { JsonObject } from "../../src/backend/types";

test("Snap Layouts target follows density changes and deduplicates unchanged geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeBackend(page, healthyBackendFixture());
  await page.addInitScript(() => {
    const backend = window.tuckBackendClient!;
    let saved: JsonObject = {};
    const get = backend.getSettings.bind(backend);
    const save = backend.saveSettings.bind(backend);
    backend.getSettings = async () => {
      const result = await get();
      return result.ok ? { ...result, value: { ...result.value, ...saved } } : result;
    };
    backend.saveSettings = async settings => {
      const result = await save(settings);
      if (result.ok) saved = { ...saved, ...settings };
      return result;
    };
    const areas: unknown[] = [];
    Reflect.set(window, "captionAreas", areas);
    Reflect.set(window, "__TAURI_INTERNALS__", {
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === "platform_capabilities") {
          return {
            platform: "windows", architecture: "x86_64", customTitleBar: true,
            sendToIntegration: true, publicCli: true, automaticUpdater: true,
            hardwareAcceleration: true, packaged: false,
          };
        }
        if (command === "set_caption_maximize_area") {
          areas.push(args.area);
          return { maximized: false };
        }
        return 1;
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "captionAreas"))).toEqual([
    { right: 46, width: 46, height: 40 },
  ]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const density = page.getByRole("radiogroup", { name: "Layout density", exact: true });
  await density.getByRole("radio", { name: "Compact", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "captionAreas"))).toEqual([
    { right: 46, width: 46, height: 40 },
    { right: 46, width: 46, height: 36 },
  ]);
  await density.getByRole("radio", { name: "Large", exact: true }).check();
  const expected = [
    { right: 46, width: 46, height: 40 },
    { right: 46, width: 46, height: 36 },
    { right: 46, width: 46, height: 44 },
  ];
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "captionAreas"))).toEqual(expected);
  await page.evaluate(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await page.evaluate(() => Reflect.get(window, "captionAreas"))).toEqual(expected);
  expect(await page.evaluate(() => window.innerWidth)).toBe(1440);
});
