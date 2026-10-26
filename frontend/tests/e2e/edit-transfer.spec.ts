import { expect, test, type Page } from "@playwright/test";

import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const LONG = "C:\\videos\\Harbour walk.mp4";
const SHORT = "C:\\videos\\Sunset bridge.mp4";
const THIRD = "C:\\videos\\Night market.mp4";

// each video has its own length, so a paste can land on a shorter one
async function open(page: Page, files = [LONG, SHORT]): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = files;
  await installFakeBackend(page, fixture);
  await page.addInitScript(() => {
    const client = Reflect.get(window, "tuckBackendClient") as { probeFile: (path: string) => Promise<unknown> };
    client.probeFile = async (path: string) => ({
      ok: true,
      value: {
        data: {
          duration: path.includes("Sunset") ? 6 : 12,
          width: path.includes("Night") ? 1280 : 1920,
          height: path.includes("Night") ? 720 : 1080,
          fps: 30,
          has_audio: true,
          file_size: 15_000_000,
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(files.length);
}

function row(page: Page, name: string) {
  return page.locator(".clip").filter({ hasText: name });
}

async function select(page: Page, name: string): Promise<void> {
  await row(page, name).click();
  await expect(page.locator(".clip.sel")).toContainText(name);
  await expect(page.locator(".tl-segment").first()).toBeVisible();
}

// splits Harbour walk at 9 s and crops it to its left half
async function editLong(page: Page): Promise<void> {
  await select(page, "Harbour walk.mp4");
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.75, ruler.y + ruler.height / 2);
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await page.locator("#insp-tab-edit").click();
  await page.getByRole("group", { name: "Crop aspect ratio" }).getByRole("button", { name: "Free" }).click();
  await page.locator("#crop-width").fill("960");
  await page.locator("#crop-width").press("Enter");
  await expect(page.locator("#crop-width")).toHaveValue("960");
}

test("a Library row's menu copies one video's edits onto another, as one undo step", async ({ page }) => {
  await open(page);
  await editLong(page);

  await row(page, "Harbour walk.mp4").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Edits for Harbour walk.mp4" });
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Copy edits" })).toBeFocused();
  // nothing is copied yet, so pasting waits
  await expect(menu.getByRole("menuitem", { name: "Paste edits", exact: true })).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: "Copy edits" }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator(".toast")).toContainText("Copied edits from Harbour walk.mp4.");

  await row(page, "Sunset bridge.mp4").click({ button: "right" });
  const target = page.getByRole("menu", { name: "Edits for Sunset bridge.mp4" });
  const paste = target.getByRole("menuitem", { name: "Paste edits", exact: true });
  await expect(paste).toContainText("From Harbour walk.mp4");
  await expect(paste).toHaveAttribute("aria-keyshortcuts", "Control+Shift+V");
  await expect(paste).not.toHaveAttribute("aria-disabled", "true");
  await paste.click();
  // the 6 second video keeps the first segment and the part of the second that reaches into it
  await expect(page.locator(".toast")).toContainText(
    "Sunset bridge.mp4 is shorter, so segments past its end were cut there.",
  );
  // pasting onto a video in the background leaves the one on screen alone
  await expect(page.locator(".clip.sel")).toContainText("Harbour walk.mp4");

  await select(page, "Sunset bridge.mp4");
  await expect(page.locator(".tl-segment")).toHaveCount(1);
  await expect(page.locator("#crop-width")).toHaveValue("960");
  await expect(page.locator("#crop-height")).toHaveValue("1080");
  const undo = page.locator("#btn-undo");
  await expect(undo).toHaveAttribute("aria-label", "Undo paste edits");
  await undo.click();
  await expect(page.locator("#crop-numbers")).toBeHidden();
  await expect(page.locator("#crop-selection")).toBeHidden();
});

test("the row menu works from the keyboard and Ctrl+Shift+C and Ctrl+Shift+V copy and paste", async ({ page }) => {
  await open(page, [LONG, SHORT, THIRD]);
  await editLong(page);

  const long = row(page, "Harbour walk.mp4");
  await long.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Edits for Harbour walk.mp4" });
  await expect(menu.getByRole("menuitem", { name: "Copy edits" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Paste edits", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(long).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+C");
  await expect(page.locator(".toast")).toContainText("Copied edits from Harbour walk.mp4.");
  await select(page, "Night market.mp4");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+V");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  // the crop keeps its share of a smaller picture
  await expect(page.locator("#crop-width")).toHaveValue("640");
  await expect(page.locator("#crop-height")).toHaveValue("720");
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo paste edits");

  // Paste edits to all videos gives each video its own step
  await row(page, "Sunset bridge.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste edits to all videos" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Pasted edits to 3 videos." })).toBeVisible({ timeout: 15_000 });
  await select(page, "Sunset bridge.mp4");
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", "Undo paste edits");
});

test("with several videos selected, Paste edits goes to each of them", async ({ page }) => {
  await open(page, [LONG, SHORT, THIRD]);
  await editLong(page);
  // the shortcut stays off while the crop field has focus
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+C");
  await expect(page.locator(".toast")).toContainText("Copied edits from Harbour walk.mp4.");

  await select(page, "Sunset bridge.mp4");
  await row(page, "Night market.mp4").click({ modifiers: ["Control"] });
  await row(page, "Night market.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste edits to 2 videos" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Pasted edits to 2 videos." })).toBeVisible();

  // the shortcut follows the same selection; the same message would only refresh the old toast
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((toast) => toast.remove()));
  await select(page, "Harbour walk.mp4");
  await row(page, "Night market.mp4").click({ modifiers: ["Control"] });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+Shift+V");
  await expect(page.locator(".toast").filter({ hasText: "Pasted edits to 2 videos." })).toBeVisible();
});
