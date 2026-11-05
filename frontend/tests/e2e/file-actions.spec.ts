import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const ONE = "C:\\videos\\Round one.mp4";
const TWO = "C:\\videos\\Round two.mp4";
const THREE = "D:\\usb\\Round three.mp4";

async function open(page: Page, responses: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = [ONE, TWO, THREE];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 400_000_000 } };
  Object.assign(fixture.responses, responses);
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(3);
  // the queue answers with whatever the test puts in window.__queueItems
  await page.evaluate(() => {
    Reflect.set(window, "__queueItems", []);
    const client = Reflect.get(window, "tuckBackendClient") as { getQueueState: () => Promise<unknown> };
    client.getQueueState = async () => ({ ok: true, value: { items: Reflect.get(window, "__queueItems") } });
  });
}

const row = (page: Page, name: string) => page.locator("#clips .clip").filter({ hasText: name });
const calls = (page: Page, method: string) =>
  page.evaluate((name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args), method);

async function menu(page: Page, name: string) {
  await row(page, name).click({ button: "right" });
  await expect(page.locator("#library-menu")).toBeVisible();
}

test("Rename names the file in a dialog, and a taken name renames nothing", async ({ page }) => {
  await open(page, {
    renameVideo: { ok: false, code: "NAME_TAKEN", error: "There's already a file called Round two.mp4 in that folder." },
  });
  await row(page, "Round one").click();
  // an edit made before the rename stays, with its undo step
  await expect(page.locator(".tl-segment")).toHaveCount(1);
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.5, ruler.y + ruler.height / 2);
  await page.locator("#btn-seq-split").click();
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", /Undo split/);

  await menu(page, "Round one");
  await expect(page.getByRole("menuitem", { name: "Rename…" })).toHaveAttribute("aria-keyshortcuts", "F2");
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const field = page.locator("#rn-name");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Round one.mp4");
  // the name is chosen up to its extension
  expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 9]);
  await field.fill("Round two.mp4");
  await field.press("Enter");
  await expect(page.locator("#rn-error")).toHaveText("There's already a file called Round two.mp4 in that folder.");
  await expect(field).toHaveAttribute("aria-invalid", "");
  await expect(row(page, "Round one")).toHaveCount(1);

  await page.evaluate(() => {
    const client = Reflect.get(window, "tuckBackendClient") as { renameVideo: (path: string, name: string) => Promise<unknown> };
    client.renameVideo = async (path: string, name: string) => ({ ok: true, value: { path: path.replace(/[^\\]+$/, name) } });
  });
  await field.fill("Clutch round.mp4");
  await expect(page.locator("#rn-error")).toBeHidden();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.locator("#rn-name")).toBeHidden();
  await expect(row(page, "Clutch round.mp4")).toHaveCount(1);
  await expect(row(page, "Round one")).toHaveCount(0);
  // still on the stage, in the same place, with its edits and undo
  await expect(page.locator("#clips .clip").first()).toContainText("Clutch round.mp4");
  await expect(row(page, "Clutch round")).toHaveClass(/\bsel\b/);
  // the menu item that opened the dialog is gone, so focus goes to the renamed row
  await expect(row(page, "Clutch round")).toBeFocused();
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", /Undo split/);
  await expect(page.locator(".tl-segment")).toHaveCount(2);
});

test("F2 renames and Shift+Delete moves the focused video to the Recycle Bin", async ({ page }) => {
  await open(page, { moveVideosToTrash: [{ path: TWO, outcome: "moved" }] });
  await row(page, "Round two").click();
  await row(page, "Round two").focus();
  await page.keyboard.press("F2");
  await expect(page.locator("#rn-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rn-name")).toBeHidden();

  await row(page, "Round two").focus();
  await page.keyboard.press("Shift+Delete");
  // one video moves at once; the Recycle Bin keeps it
  await expect.poll(() => calls(page, "moveVideosToTrash")).toEqual([[[TWO]]]);
  await expect(row(page, "Round two")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Moved Round two.mp4 to the Recycle Bin.");
  // no Undo: the row would point at a file that isn't there
  await expect(page.locator(".toast").getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page.locator(".clip")).toHaveCount(2);
  // the row went with its file, so focus goes to the video now on the stage
  await expect(page.locator("#clips .clip.sel")).toBeFocused();
});

test("several videos ask first, and ones on a drive without a Recycle Bin stay and are named", async ({ page }) => {
  await open(page, {
    moveVideosToTrash: [{ path: TWO, outcome: "moved" }, { path: THREE, outcome: "no_trash" }],
  });
  await row(page, "Round two").click();
  await row(page, "Round three").click({ modifiers: ["Shift"] });
  await menu(page, "Round three");
  await page.getByRole("menuitem", { name: "Move to Recycle Bin" }).click();
  await expect(page.locator("#confirm-title")).toHaveText("Move 2 videos to the Recycle Bin?");
  await expect(page.locator("#confirm-copy")).toHaveText(/MB\.$/);
  await page.locator("#confirm-accept").click();
  await expect.poll(() => calls(page, "moveVideosToTrash")).toEqual([[[TWO, THREE]]]);
  await expect(page.locator("#trash-title")).toHaveText("1 of 2 moved to the Recycle Bin");
  await expect(page.locator("#trash-copy")).toHaveText("Round three.mp4 is on a drive with no Recycle Bin, so it stayed where it is.");
  await page.locator("#trash-ok").click();
  await expect(row(page, "Round two")).toHaveCount(0);
  await expect(row(page, "Round three")).toHaveCount(1);
});

test("a video that is exporting can't be renamed or moved", async ({ page }) => {
  await open(page);
  await page.evaluate((path) => {
    Reflect.set(window, "__queueItems", [{ id: "run", source: "Round one.mp4", source_path: path, state: "running", progress: 40 }]);
  }, ONE);
  await expect(row(page, "Round one")).toContainText(/Exporting|40%/);
  await menu(page, "Round one");
  for (const name of ["Rename…", "Move to Recycle Bin"]) {
    const item = page.getByRole("menuitem", { name });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item).toHaveAttribute("title", "Wait for its export to finish");
  }
  await expect(page.getByRole("menuitem", { name: "Remove from Library" })).not.toHaveAttribute("aria-disabled", "true");
});

test("Exports moves finished exports' originals once, and the exports stay", async ({ page }) => {
  await open(page, { moveVideosToTrash: [{ path: ONE, outcome: "moved" }, { path: TWO, outcome: "moved" }] });
  const done = (id: string, path: string) => ({ id, source: path.split("\\").pop(), source_path: path, state: "completed", progress: 100, result_path: path.replace(".mp4", "_tucked.mp4"), result_size: 9_000_000 });
  await page.evaluate((items) => Reflect.set(window, "__queueItems", items), [done("a", ONE), done("b", TWO), { id: "c", source: "Round three.mp4", source_path: THREE, state: "failed", progress: 0, error: "No space" }]);
  await page.locator("#qstatus").click();
  const move = page.locator("#btn-move-originals");
  await expect(move).toHaveText("Move originals to Recycle Bin");
  await expect(move).toBeEnabled();
  await move.click();
  await expect(page.locator("#confirm-title")).toHaveText("Move 2 originals to the Recycle Bin?");
  await expect(page.locator("#confirm-copy")).toHaveText(/MB\. The exports stay\.$/);
  await page.locator("#confirm-accept").click();
  // only finished exports' originals, never the failed one's
  await expect.poll(() => calls(page, "moveVideosToTrash")).toEqual([[[ONE, TWO]]]);
  await expect(page.locator(".clip")).toHaveCount(1);
  await expect(row(page, "Round three")).toHaveCount(1);
  await expect(page.locator(".exports-row")).toHaveCount(3);
  await expect(move).toBeDisabled();
});
