import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, type FakeBackendFixture } from "../fixtures/fake-backend";

const MB = 1024 * 1024;
const FILES = ["C:\\videos\\Ranked match.mp4", "C:\\videos\\Replay one.mp4", "C:\\videos\\Replay two.mp4"];
const PICTURE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const fileName = (path: string): string => path.split("\\").pop() ?? path;
const resultOf = (index: number): string => `C:\\out\\${fileName(FILES[index]!).replace(".mp4", "_tucked.mp4")}`;
const done = (index: number, size = 9.8 * MB) => ({
  id: `done-${index}`, source: fileName(FILES[index]!), source_path: FILES[index], state: "completed", progress: 100,
  output: fileName(resultOf(index)), result_path: resultOf(index), result_size: size,
});
const waiting = (id: string, index: number, state: string) => ({ id, source: fileName(FILES[index]!), source_path: FILES[index], state });

async function open(page: Page, items: unknown[], adjust: (fixture: FakeBackendFixture) => void = () => {}) {
  await page.setViewportSize({ width: 1240, height: 800 });
  const fixture = healthyBackendFixture();
  fixture.startup.files = FILES;
  fixture.responses.probeFile = { ok: true, data: { duration: 66, width: 1920, height: 1080, fps: 60, has_audio: false, file_size: 34.6 * MB } };
  fixture.responses.getThumbnail = { ok: true, thumbnail: PICTURE };
  fixture.responses.getQueueState = { items };
  adjust(fixture);
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#clips .clip")).toHaveCount(3);
  await expect(page.locator("#qbar")).toBeVisible();
}

const calls = (page: Page, method: string) =>
  page.evaluate((name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args), method);
const actionNames = (page: Page) =>
  page.locator("#qactions button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent));

test("one finished export is its file, with its size against the source's and copy, folder and clear beside it", async ({ page }) => {
  await open(page, [done(0)]);
  await expect(page.locator("#qfname")).toHaveText("Ranked match_tucked.mp4");
  await expect(page.locator("#qeta")).toHaveText("9.8 MB · was 34.6 MB");
  await expect(page.locator("#qlead .qthumb img")).toHaveAttribute("src", PICTURE);
  await expect(page.locator("#qstatus")).toHaveAttribute("aria-label", "Exported Ranked match_tucked.mp4, 9.8 MB · was 34.6 MB. Show Exports");
  expect(await actionNames(page)).toEqual(["Copy file", "Show in folder", "Clear finished exports"]);

  const actions = page.locator("#qactions");
  await actions.getByRole("button", { name: "Copy file" }).click();
  await expect(actions.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(page.locator(".toast", { hasText: "File copied to clipboard." })).toBeVisible();
  expect(await calls(page, "copyFile")).toEqual([[resultOf(0)]]);

  await actions.getByRole("button", { name: "Show in folder" }).click();
  await expect.poll(() => calls(page, "openOutputFolder")).toEqual([[resultOf(0)]]);
  await actions.getByRole("button", { name: "Clear finished exports" }).click();
  await expect.poll(() => calls(page, "clearFinished")).toHaveLength(1);
  // none of them opened Exports on the way
  await expect(page.locator("#exports-panel")).toBeHidden();
});

test("polls leave the bar's picture and buttons in place, and focus follows a button that changes", async ({ page }) => {
  await open(page, [done(0)]);
  const copy = page.locator("#qactions").getByRole("button", { name: "Copy file" });
  await copy.focus();
  // a press that spans a poll needs the same nodes under it when it lets go
  await page.evaluate(() => {
    (window as unknown as { __kept: Element[] }).__kept = [document.querySelector("#qlead .qthumb")!, document.querySelector("#qactions button")!];
  });
  const polls = (await calls(page, "getQueueState")).length;
  await expect.poll(async () => (await calls(page, "getQueueState")).length).toBeGreaterThan(polls + 1);
  expect(await page.evaluate(() => {
    const [picture, button] = (window as unknown as { __kept: Element[] }).__kept;
    return picture === document.querySelector("#qlead .qthumb") && button === document.querySelector("#qactions button");
  })).toBe(true);
  await expect(copy).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("#qactions").getByRole("button", { name: "Copied" })).toBeFocused();
});

test("several finished exports copy together, and a copy that fails stays said in the bar", async ({ page }) => {
  await open(page, [done(0, 9.6 * MB), done(1, 9.7 * MB), done(2, 9.9 * MB)], (fixture) => {
    fixture.responseSequences = { copyFiles: [{ ok: false, error: "The clipboard is busy. Try copying the file again." }, { ok: true }] };
  });
  await expect(page.locator("#qfname")).toHaveText("3 videos exported");
  await expect(page.locator("#qeta")).toHaveText("74.6 MB smaller in total");
  await expect(page.locator("#qlead .qstack .qthumb")).toHaveCount(3);
  expect(await actionNames(page)).toEqual(["Copy 3 files", "Show in folder", "Clear finished exports"]);

  const actions = page.locator("#qactions");
  await actions.getByRole("button", { name: "Copy 3 files" }).click();
  await expect(page.locator("#qeta")).toHaveText("The clipboard is busy. Try copying the file again.");
  await expect(page.locator("#qeta")).toHaveClass("warn");
  await page.locator(".toast", { hasText: "The clipboard is busy." }).getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator("#qeta")).toHaveText("The clipboard is busy. Try copying the file again.");

  await actions.getByRole("button", { name: "Copy 3 files" }).click();
  await expect(actions.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(page.locator("#qeta")).toHaveText("74.6 MB smaller in total");
  await expect(page.locator(".toast", { hasText: "3 files copied to clipboard." })).toBeVisible();
  // one clipboard entry with every file, in the order they finished
  const paths = [resultOf(0), resultOf(1), resultOf(2)];
  expect(await calls(page, "copyFiles")).toEqual([[paths], [paths]]);
  expect(await calls(page, "copyFile")).toEqual([]);
  // the folder is the newest export's
  await actions.getByRole("button", { name: "Show in folder" }).click();
  await expect.poll(() => calls(page, "openOutputFolder")).toEqual([[resultOf(2)]]);
});

test("dragging the stack of pictures drags every file, and a press opens Exports instead", async ({ page }) => {
  await open(page, [done(0), done(1), done(2)]);
  const stack = page.locator("#qlead .qstack");
  await expect(stack).toHaveAttribute("data-drag-out", "done-0,done-1,done-2");
  const box = (await stack.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // pressing and letting go without moving is a click on the status
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, start.y + 1);
  await page.mouse.up();
  expect(await calls(page, "startExportsDrag")).toEqual([]);
  await expect(page.locator("#exports-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#exports-panel")).toBeHidden();

  // a drag that comes back to let go over the picture drags and leaves Exports closed
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y - 30, { steps: 5 });
  await page.mouse.move(start.x + 1, start.y, { steps: 5 });
  await page.mouse.up();
  expect(await calls(page, "startExportsDrag")).toEqual([[["done-0", "done-1", "done-2"]]]);
  await expect(page.locator("#exports-panel")).toBeHidden();
});

test("one finished file drags by its own picture", async ({ page }) => {
  await open(page, [done(0)]);
  const picture = page.locator("#qlead .qthumb");
  await expect(picture).toHaveAttribute("data-drag-out", "done-0");
  const box = (await picture.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y - 20, { steps: 5 });
  await page.mouse.up();
  expect(await calls(page, "startExportDrag")).toEqual([["done-0"]]);
  expect(await calls(page, "startExportsDrag")).toEqual([]);
});

test("paused exports offer Resume, and canceled ones Retry and clear", async ({ page }) => {
  await open(page, [waiting("p1", 0, "paused"), waiting("p2", 1, "paused")]);
  await expect(page.locator("#qfname")).toHaveText("2 exports paused");
  await expect(page.locator("#qeta")).toHaveText("Resume starts them again");
  expect(await actionNames(page)).toEqual(["Resume"]);
  await page.locator("#qactions").getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => calls(page, "resumeExports")).toHaveLength(1);

  await open(page, [waiting("c1", 0, "cancelled")]);
  await expect(page.locator("#qfname")).toHaveText("1 export canceled");
  await expect(page.locator("#qeta")).toHaveText("Retry starts it again");
  expect(await actionNames(page)).toEqual(["Retry", "Clear finished exports"]);
  await page.locator("#qactions").getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => calls(page, "retryAllItems")).toHaveLength(1);
});
