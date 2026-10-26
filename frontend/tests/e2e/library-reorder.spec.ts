import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`Library insertion line follows the drop position at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = healthyBackendFixture();
    fixture.responses.pickFiles = { files: ["C:/First.mp4", "C:/Second.mp4", "C:/Third.mp4"] };
    fixture.responses.probeFile = { data: { width: 1920, height: 1080, duration: 30, fps: 30, has_audio: false } };
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.locator("#btn-add").click();
    const cards = page.locator("#clips .clip");
    await expect(cards).toHaveCount(3);
    const third = cards.filter({ hasText: "Third.mp4" });
    const second = cards.filter({ hasText: "Second.mp4" });
    await third.hover();
    const handle = await third.locator(".c-drag").boundingBox();
    const target = await second.boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + 5, { steps: 6 });
    await page.screenshot({ path: testInfo.outputPath("insertion-before.png") });
    await expect(second).toHaveAttribute("data-drop-position", "before");
    await page.mouse.up();
    await expect(cards.locator(".c2")).toHaveText(["First.mp4", "Third.mp4", "Second.mp4"]);
    await expect(page.locator("[data-drop-position]")).toHaveCount(0);
    const first = cards.filter({ hasText: "First.mp4" });
    await first.hover();
    const firstHandle = await first.locator(".c-drag").boundingBox();
    const lastBounds = await second.boundingBox();
    await page.mouse.move(firstHandle!.x + 4, firstHandle!.y + 10);
    await page.mouse.down();
    await page.mouse.move(lastBounds!.x + 40, lastBounds!.y + lastBounds!.height - 5, { steps: 6 });
    await expect(second).toHaveAttribute("data-drop-position", "after");
    await expect(second).toHaveCSS("box-shadow", "none");
    await page.screenshot({ path: testInfo.outputPath("insertion-after.png") });
    await page.mouse.up();
    await expect(cards.locator(".c2")).toHaveText(["Third.mp4", "Second.mp4", "First.mp4"]);
    await third.hover();
    const cancelHandle = await third.locator(".c-drag").boundingBox();
    const cancelTarget = await first.boundingBox();
    await page.mouse.move(cancelHandle!.x + 4, cancelHandle!.y + 10);
    await page.mouse.down();
    await page.mouse.move(cancelTarget!.x + 40, cancelTarget!.y + 5, { steps: 6 });
    await expect(first).toHaveAttribute("data-drop-position", "before");
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel")));
    await page.mouse.up();
    await expect(cards.locator(".c2")).toHaveText(["Third.mp4", "Second.mp4", "First.mp4"]);
    await expect(page.locator("[data-drop-position]")).toHaveCount(0);
  });
}

test("a reorder the queue rejects puts the Library back in the order exports will run", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  const files = ["C:/First.mp4", "C:/Second.mp4", "C:/Third.mp4"];
  const fixture = healthyBackendFixture();
  fixture.startup.files = files;
  fixture.responses.probeFile = { data: { width: 1920, height: 1080, duration: 30, fps: 30, has_audio: false } };
  fixture.responses.getQueueState = {
    items: files.map((path, index) => ({ id: `q${index}`, source: path.slice(3), source_path: path, state: "pending" })),
    pending_ids: ["q0", "q1", "q2"],
  };
  // the first export started before the move arrived
  fixture.responses.moveItem = { ok: false, error: "That export has already started." };
  await installFakeBackend(page, fixture);
  await page.goto("/");
  const cards = page.locator("#clips .clip");
  await expect(cards).toHaveCount(3);
  // the Library knows the videos are waiting once the queue has been read
  await expect(page.locator("#qbar")).toBeVisible();

  const third = cards.filter({ hasText: "Third.mp4" });
  const first = cards.filter({ hasText: "First.mp4" });
  await third.hover();
  const handle = await third.locator(".c-drag").boundingBox();
  const target = await first.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 5, { steps: 6 });
  await page.mouse.up();

  await expect(cards.locator(".c2")).toHaveText(["First.mp4", "Second.mp4", "Third.mp4"]);
  await expect(page.locator(".toast")).toContainText("the Library now shows the order they will run in");
});
