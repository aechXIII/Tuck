import { expect, type Page } from "@playwright/test";

import type { FixtureLut } from "./fixture-engine.ts";

/** whether TUCK_E2E_NATIVE_PREVIEW runs the specs through the native player's fixture engine */
export const nativePreview = process.env.TUCK_E2E_NATIVE_PREVIEW === "engine";

/** every LUT the page sent to the native player, in order */
export function sentLuts(page: Page): Promise<FixtureLut[]> {
  return page.evaluate(() => (Reflect.get(window, "__fixtureEngine") as { luts?: FixtureLut[] } | undefined)?.luts ?? []);
}

/**
 * The LUT preview is on: the HTML player draws it over the video, the native player was given a
 * table, and the strength it last got when one is expected.
 */
export async function expectLutShown(page: Page, strength?: number): Promise<void> {
  if (!nativePreview) {
    await expect(page.locator("[data-lut-preview]")).toBeVisible();
    return;
  }
  await expect.poll(async () => {
    const luts = await sentLuts(page);
    const last = luts.at(-1);
    if (!last || last.size === 0 || !luts.some((lut) => lut.bytes > 0)) return false;
    return strength === undefined || Math.abs(last.strength - strength) < 0.001;
  }).toBe(true);
}

/** The LUT preview is off: no overlay, or the native player was told to remove it. */
export async function expectLutHidden(page: Page): Promise<void> {
  if (!nativePreview) {
    await expect(page.locator("[data-lut-preview]")).toBeHidden();
    return;
  }
  await expect.poll(async () => (await sentLuts(page)).at(-1)?.size).toBe(0);
}
