import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, type FakeBackendFixture } from "../fixtures/fake-backend";

const DONE = "C:\\videos\\Ranked match clutch.mp4";
const RUNNING = "C:\\videos\\Bike trail morning.mov";
const READY = "C:\\videos\\Cat vs laser pointer.mp4";
const RESULT = "C:\\videos\\録画 #1, final_small.mp4";
const PICTURE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

async function open(page: Page, width = 1240, adjust: (fixture: FakeBackendFixture) => void = () => {}) {
  await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = [DONE, RUNNING, READY];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1280, height: 720, fps: 30, has_audio: false, file_size: 48_200_000 } };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  fixture.responses.getQueueState = { items: [
    { id: "done", source: "Ranked match clutch.mp4", source_path: DONE, state: "completed", progress: 100, result_path: RESULT, result_size: 9_400_000, target_size: 10 * 1024 * 1024 },
    { id: "running", source: "Bike trail morning.mov", source_path: RUNNING, state: "running", progress: 42 },
  ] };
  adjust(fixture);
  await installFakeBackend(page, fixture);
  await page.goto("/");
  if (width === 960) await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator("#clips .clip")).toHaveCount(3);
}

const row = (page: Page, name: string) => page.locator("#clips .clip").filter({ hasText: name });
const calls = (page: Page, method: string) =>
  page.evaluate((name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args), method);

for (const width of [1240, 960]) {
  test(`a finished row keeps its size readable beside Copy file and Show in folder at ${width}px`, async ({ page }) => {
    await open(page, width);
    const done = row(page, "Ranked match clutch.mp4");
    const copy = done.getByRole("button", { name: "Copy file", exact: true });
    const show = done.getByRole("button", { name: "Show in folder", exact: true });
    await expect(copy).toHaveAttribute("data-tip", "Copy file");
    await expect(show).toHaveAttribute("data-tip", "Show in folder");
    await expect(done.locator(".c-status")).toHaveText("9.0 MB");
    // the target gives way to the buttons but still reaches the tooltip and screen readers
    await expect(done.locator(".c-status")).toHaveAttribute("data-tip", "Fits the 10 MB target");
    await expect(done.locator(".c-fit")).toHaveText("fits 10 MB");
    const layout = await done.evaluate((card) => {
      const box = card.getBoundingClientRect();
      const status = card.querySelector<HTMLElement>(".c-status")!;
      const buttons = Array.from(card.querySelectorAll<HTMLElement>(".c-icon")).map((button) => button.getBoundingClientRect());
      return {
        sizeClipped: status.scrollWidth > status.clientWidth,
        inside: buttons.every((button) => button.left >= box.left && button.right <= box.right),
        targets: buttons.map((button) => [button.width, button.height]),
      };
    });
    expect(layout).toEqual({ sizeClipped: false, inside: true, targets: [[24, 22], [24, 22]] });
    // the other rows have nothing to copy or show
    await expect(row(page, "Bike trail morning.mov").locator(".c-icon")).toHaveCount(0);
    await expect(row(page, "Cat vs laser pointer.mp4").locator(".c-icon")).toHaveCount(0);
  });
}

test("Copy file and Show in folder hand the export's own file to the desktop", async ({ page }) => {
  await open(page, 1240, (fixture) => {
    fixture.holdMethods = ["copyFile"];
  });
  const done = row(page, "Ranked match clutch.mp4");
  const copy = done.getByRole("button", { name: "Copy file", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(copy).toHaveAttribute("aria-disabled", "true");
  await expect(copy).toHaveAttribute("data-tip", "Copying...");
  await expect(copy).toBeFocused();
  // one copy at a time; pressing again while it runs asks for nothing more
  await page.keyboard.press("Enter");
  expect(await calls(page, "copyFile")).toEqual([[RESULT]]);
  await page.evaluate(() => window.__tuckReleaseHeld?.("copyFile", { ok: true }));
  await expect(copy).toHaveAttribute("data-tip", "Copied");
  await expect(copy).not.toHaveAttribute("aria-disabled", "true");
  await expect(copy).toBeFocused();
  await expect(page.locator(".toast", { hasText: "File copied to clipboard." })).toBeVisible();
  // the Exports panel tells the same story
  await page.locator("#qstatus").click();
  await expect(page.getByRole("button", { name: "Copy file for Ranked match clutch.mp4" })).toHaveText("Copied");
  await page.keyboard.press("Escape");
  await done.getByRole("button", { name: "Show in folder", exact: true }).click();
  expect(await calls(page, "openOutputFolder")).toEqual([[RESULT]]);
  // neither button selected the row or started playback
  await expect(page.locator(".toast", { hasText: /couldn/i })).toHaveCount(0);
});

test("double-click on a finished row never opens its result; the Exports panel opens it by queue id", async ({ page }) => {
  await open(page, 1240, (fixture) => {
    fixture.responseSequences = { openExportFile: [{ ok: false, error: "The export could not be found. It may have been moved or deleted." }, { ok: true }] };
  });
  await row(page, "Ranked match clutch.mp4").locator(".c2").dblclick();
  await expect(row(page, "Ranked match clutch.mp4")).toHaveAttribute("aria-selected", "true");
  expect(await calls(page, "openExportFile")).toEqual([]);
  await page.locator("#qstatus").click();
  const openResult = page.getByRole("button", { name: "Open Ranked match clutch.mp4", exact: true });
  await expect(openResult).toBeVisible();
  await expect(page.locator('[data-export-id="running"]').getByRole("button", { name: /^Open / })).toHaveCount(0);
  await openResult.click();
  await expect(page.locator(".toast", { hasText: "Couldn’t open the export. The export could not be found." })).toBeVisible();
  await openResult.click();
  expect(await calls(page, "openExportFile")).toEqual([["done"], ["done"]]);
});

for (const width of [1240, 960]) {
  test(`the Exports panel keeps Open, Copy file and Show inside it at ${width}px`, async ({ page }) => {
    await open(page, width);
    await page.locator("#qstatus").click();
    const actions = page.locator('[data-export-id="done"] .exports-actions');
    await expect(actions.getByRole("button")).toHaveText(["Open", "Copy file", "Show"]);
    // polling redraws the list while an export runs, so measure the row that is there now
    await expect.poll(() => page.evaluate(() => {
      const panel = document.getElementById("exports-panel")!.getBoundingClientRect();
      const box = document.querySelector('[data-export-id="done"] .exports-actions')!.getBoundingClientRect();
      return box.width > 0 && box.left >= panel.left && box.right <= panel.right;
    })).toBe(true);
  });
}

test("dragging a finished export's picture starts a file drag; a press or another row does not", async ({ page }) => {
  await open(page);
  const done = row(page, "Ranked match clutch.mp4");
  const picture = done.locator(".c-thumb");
  await expect(picture).toHaveAttribute("data-drag-out", "1");
  await expect(row(page, "Bike trail morning.mov").locator(".c-thumb")).not.toHaveAttribute("data-drag-out", "1");
  const box = (await picture.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // pressing and letting go without moving only selects
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, start.y + 1);
  await page.mouse.up();
  expect(await calls(page, "startExportDrag")).toEqual([]);

  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 4, { steps: 4 });
  await page.mouse.move(start.x + 80, start.y + 8, { steps: 4 });
  await page.mouse.up();
  expect(await calls(page, "startExportDrag")).toEqual([["done"]]);
  // the Library order is unchanged and no reorder was left behind
  await expect(page.locator("#clips .clip .c2")).toHaveText(["Ranked match clutch.mp4", "Bike trail morning.mov", "Cat vs laser pointer.mp4"]);
  await expect(page.locator("#clips .clip.dragging")).toHaveCount(0);

  const other = (await row(page, "Cat vs laser pointer.mp4").locator(".c-thumb").boundingBox())!;
  await page.mouse.move(other.x + 10, other.y + 10);
  await page.mouse.down();
  await page.mouse.move(other.x + 80, other.y + 10, { steps: 6 });
  await page.mouse.up();
  expect(await calls(page, "startExportDrag")).toEqual([["done"]]);
});

test("a drag that can't start says why", async ({ page }) => {
  await open(page, 1240, (fixture) => {
    fixture.responses.startExportDrag = { ok: false, error: "The export could not be found. It may have been moved or deleted." };
  });
  const picture = row(page, "Ranked match clutch.mp4").locator(".c-thumb");
  await expect(picture).toHaveAttribute("data-drag-out", "1");
  const box = (await picture.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".toast", { hasText: "Couldn’t drag the export. The export could not be found." })).toBeVisible();
});

test("reordering by the handle still works on a finished row and never drags the file out", async ({ page }) => {
  await open(page);
  const done = row(page, "Ranked match clutch.mp4");
  const ready = row(page, "Cat vs laser pointer.mp4");
  await done.hover();
  const handle = (await done.locator(".c-drag").boundingBox())!;
  const target = (await ready.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 4, { steps: 8 });
  await expect(ready).toHaveAttribute("data-drop-position", "after");
  await page.mouse.up();
  await expect(page.locator("#clips .clip .c2")).toHaveText(["Bike trail morning.mov", "Cat vs laser pointer.mp4", "Ranked match clutch.mp4"]);
  expect(await calls(page, "startExportDrag")).toEqual([]);
});
