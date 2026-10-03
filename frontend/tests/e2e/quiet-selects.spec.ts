import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

test("Quiet dropdowns show compact labels and a neutral selection", async ({ page }) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trigger = page.locator("#set-ds-trigger");
  await trigger.click();
  const popup = page.locator("#set-ds-popup");
  const options = popup.getByRole("option");
  await expect(options).toHaveText(["Bilinear", "Bicubic", "Lanczos", "Point", "Neighbor"]);
  await expect(popup.getByRole("combobox")).toHaveCount(0);
  const geometry = await options.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  for (const height of geometry) expect(height).toBeCloseTo(33, 2);
  const selected = await popup.locator('[aria-selected="true"]').evaluate(row => {
    const style = getComputedStyle(row);
    return { background: style.backgroundColor, text: style.color,
      neutral: getComputedStyle(document.documentElement).getPropertyValue("--raised-2").trim(),
      foreground: getComputedStyle(document.querySelector("#set-ds-trigger")!).color };
  });
  expect(selected.background).toBe("rgb(52, 53, 58)");
  expect(selected.neutral).toBe("#34353a");
  expect(selected.text).toBe(selected.foreground);
  await popup.getByRole("option", { name: "Bicubic", exact: true }).click();
  await expect(page.locator("#set-ds")).toHaveValue("Bicubic");
  await expect(trigger).toBeFocused();
});
