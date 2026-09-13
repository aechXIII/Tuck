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
  const select = page.locator(".settings-dialog select").first();
  const background = await select.evaluate(el => getComputedStyle(el).backgroundImage);
  expect(background).toContain("select-chevron");
  expect(background).not.toContain("data:");
  const url = background.slice(5, -2);
  expect((await page.request.get(url)).ok()).toBe(true);
  expect(blocked).toEqual([]);
});
