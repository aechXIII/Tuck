import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";
import type { JsonObject } from "../../src/backend/types";

async function start(page: Page, settings: Record<string, unknown> = {}) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\media\\Recording.mp4"];
  fixture.responses.getSettings = { ...fixture.responses.getSettings as object, ...settings };
  fixture.responses.probeFile = {
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: false },
  };
  await installFakeBackend(page, fixture);
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
  });
  await page.goto("/");
  await expect(page.locator("#player-bar")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
}

test("layout density and text size change independently and keep Settings readable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const density = page.getByRole("radiogroup", { name: "Layout density", exact: true });
  const text = page.getByRole("radiogroup", { name: "Text size", exact: true });
  await expect(density).toBeVisible();
  await expect(text).toBeVisible();
  const measure = () => page.evaluate(() => {
    const label = document.querySelector<HTMLElement>('[data-setting="interface-size"] .set-label')!;
    return {
      font: parseFloat(getComputedStyle(label).fontSize),
      settingsWidth: document.querySelector(".settings-dialog")!.getBoundingClientRect().width,
      toolbar: document.querySelector("#tb")!.getBoundingClientRect().height,
    };
  });
  const original = await measure();
  await density.getByRole("radio", { name: "Compact", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  const compact = await measure();
  expect(compact.font).toBe(original.font);
  expect(compact.settingsWidth).toBe(original.settingsWidth);
  expect(compact.toolbar).toBeLessThan(original.toolbar);
  await text.getByRole("radio", { name: "Large", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  expect((await measure()).font).toBeCloseTo(original.font * 1.1, 1);
  await density.getByRole("radio", { name: "Default", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-density", "default");
  expect((await measure()).font).toBeCloseTo(original.font * 1.1, 1);
  await text.getByRole("radio", { name: "Large", exact: true }).press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "extra_large");
  await expect(text.getByRole("radio", { name: "Extra large", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(text.getByRole("radio", { name: "Extra large", exact: true })).toBeChecked();
});

test("the segment sample follows both timeline styles and the current segment labels", async ({ page }) => {
  await start(page);
  const timeline = page.getByRole("radiogroup", { name: "Timeline", exact: true });
  for (const [label, value] of [["Graphite", "graphite"], ["Violet", "violet"]] as const) {
    await timeline.getByRole("radio", { name: label, exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-timeline", value);
    const colors = await page.evaluate(() => {
      const sample = document.querySelector(".set-preview-clip")!;
      const actual = document.querySelector(".tl-segment.active .tl-segment-surface")!;
      return {
        sample: getComputedStyle(sample).backgroundColor,
        actual: getComputedStyle(actual).backgroundColor,
        outline: getComputedStyle(sample).boxShadow,
        label: sample.textContent,
      };
    });
    expect(colors.sample).toBe(colors.actual);
    expect(colors.outline).toBe("none");
    expect(colors.label).toBe("S112s");
  }
});

test("text size reaches the shortcut diagram without clipping its keys", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await start(page);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  const opener = page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
  await opener.click();
  const keys = page.locator(".kbs-key");
  const original = await keys.first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.getByRole("button", { name: "Close keyboard shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Text size", exact: true })
    .getByRole("radio", { name: "Extra large", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "extra_large");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await opener.click();
  const enlarged = await keys.first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  expect(enlarged).toBeCloseTo(original * 1.25, 1);
  const clipped = await keys.evaluateAll(elements => elements.filter(element =>
    element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
    .map(element => element.textContent));
  expect(clipped).toEqual([]);
  await page.getByRole("button", { name: "Close keyboard shortcuts", exact: true }).click();
  await expect(opener).toBeFocused();
});

for (const width of [1440, 960]) {
  test(`all density and text combinations fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await start(page);
    for (const density of ["Compact", "Default", "Large"]) {
      await page.getByRole("radiogroup", { name: "Layout density", exact: true })
        .getByRole("radio", { name: density, exact: true }).check();
      await expect(page.locator("html")).toHaveAttribute("data-density", density.toLowerCase());
      for (const [label, value, scale] of [["Default", "default", 1], ["Large", "large", 1.1], ["Extra large", "extra_large", 1.25]] as const) {
        await page.getByRole("radiogroup", { name: "Text size", exact: true })
          .getByRole("radio", { name: label, exact: true }).check();
        await expect(page.locator("html")).toHaveAttribute("data-text-size", value);
        const geometry = await page.evaluate(() => {
          const dialog = document.querySelector<HTMLElement>(".settings-dialog")!;
          const labels = [...dialog.querySelectorAll<HTMLElement>(".set-label, .set-desc, .set-choice-label")];
          return {
            font: parseFloat(getComputedStyle(dialog.querySelector(".set-label")!).fontSize),
            overflow: document.documentElement.scrollWidth > innerWidth || dialog.scrollWidth > dialog.clientWidth,
            clipped: labels.filter(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
              .map(element => element.textContent),
            focusable: [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
              .every(input => input.getBoundingClientRect().width > 0),
          };
        });
        expect(geometry.font).toBeCloseTo(13 * scale, 1);
        expect(geometry.overflow).toBe(false);
        expect(geometry.clipped).toEqual([]);
        expect(geometry.focusable).toBe(true);
      }
    }
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    const controlsFit = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLElement>("#stage-controls .pbtn")]
        .filter(button => button.getClientRects().length);
      return document.documentElement.scrollWidth <= innerWidth && buttons.every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      });
    });
    expect(controlsFit).toBe(true);
  });
}
