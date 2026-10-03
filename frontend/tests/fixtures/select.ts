import type { Locator, Page } from "@playwright/test";

export async function chooseSelect(page: Page, trigger: Locator, value: string | { label: string }): Promise<void> {
  await trigger.click();
  const popup = page.locator(".select-popup:popover-open");
  if (typeof value === "string") {
    await popup.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  } else {
    await popup.getByText(value.label, { exact: true }).click();
  }
}
