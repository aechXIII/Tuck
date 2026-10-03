import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

test("control icons load under the packaged content security policy", async ({ page }) => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  await page.route("**/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": config.app.security.csp } });
  });
  const blocked: string[] = [];
  page.on("console", message => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) blocked.push(message.text());
  });
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const select = page.locator("#set-ds-trigger");
  await expect(select.locator("svg path")).toHaveAttribute("d", "m3 4.5 3 3 3-3");
  const icon = await select.locator("svg").boundingBox();
  expect(icon!.width).toBe(12);
  expect(icon!.height).toBe(12);
  await select.click();
  await expect(page.locator(".select-popup:popover-open")).toBeVisible();
  expect(blocked).toEqual([]);
});
