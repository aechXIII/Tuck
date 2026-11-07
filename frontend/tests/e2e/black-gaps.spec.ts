import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

async function open(page: Page, width = 1240) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Video.mp4"];
  fixture.responses.probeFile = { ok: true, data: { duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: 15000000 } };
  fixture.responses.getMediaUrl = { ok: true, url: "", token: "" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".tl-segment")).toBeVisible();
  await page.locator("#btn-snap-toggle").click();
}

// the fixtures load no media, so each seek is finished by hand
async function seek(page: Page, share: number) {
  const ruler = (await page.locator("#sequence-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * share, ruler.y + ruler.height / 2);
  await page.evaluate(() => document.getElementById("vid")?.dispatchEvent(new Event("seeked")));
}

// three segments with the middle one deleted: a gap the export skips, since nothing was moved
async function gapNeverMoved(page: Page) {
  for (const share of [0.3, 0.6]) {
    await seek(page, share);
    await page.locator("#btn-seq-split").click();
  }
  await page.locator(".tl-segment").nth(1).click();
  await page.locator('[data-action-click="timeline-remove-segment"]').click();
  await expect(page.locator(".tl-segment")).toHaveCount(2);
}

async function nudgeLast(page: Page) {
  const last = (await page.locator(".tl-segment").nth(1).boundingBox())!;
  const track = (await page.locator("#tl-track").boundingBox())!;
  await page.mouse.move(last.x + 40, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 40 - track.width * 0.03, last.y + last.height / 2, { steps: 6 });
  return { up: () => page.mouse.up() };
}

const gaps = (page: Page) => page.locator("#tl-gaps .tl-gap");

test("a gap says it exports as black only once a move places the timeline, and Close gap closes it", async ({ page }) => {
  await open(page);
  await gapNeverMoved(page);
  // skipped in the export, so it says nothing
  await expect(gaps(page)).toHaveCount(0);

  const drag = await nudgeLast(page);
  // it says so the moment the move makes the switch, while the drag is still going
  await expect(gaps(page)).toHaveCount(1);
  await drag.up();
  const gap = gaps(page).first();
  await expect(gap.locator(".tl-gap-text")).toHaveText(/^\d+(\.\d+)?s of black$/);
  const close = gap.getByRole("button", { name: /^Close the \d+(\.\d+)?s gap$/ });
  await expect(close).toBeVisible();

  // centered in the gap, in the lane's own color
  const [box, mark] = await Promise.all([gap.boundingBox(), gap.locator(".tl-gap-text").boundingBox()]);
  expect(Math.abs(box!.x + box!.width / 2 - (mark!.x + mark!.width / 2))).toBeLessThan(1.5);
  expect(await gap.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

  // a click on the gap itself still seeks, and the preview offers Close gap too
  // the mark lets the pointer through to the lane, so this lands on the lane as it does today
  await page.mouse.click(box!.x + 8, box!.y + 8);
  await page.evaluate(() => document.getElementById("vid")?.dispatchEvent(new Event("seeked")));
  await expect(page.locator("#timeline-gap-caption")).toBeVisible();
  await expect(page.locator("#timeline-gap-close")).toBeVisible();

  const segmentsBefore = await page.locator(".tl-segment").count();
  await close.click();
  await expect(gaps(page)).toHaveCount(0);
  await expect(page.locator(".tl-segment")).toHaveCount(segmentsBefore);
  await expect(page.locator("#btn-undo")).toHaveAttribute("aria-label", /close gap/i);

  await page.locator("#btn-undo").click();
  await expect(gaps(page)).toHaveCount(1);
  await seek(page, 0.45);
  await expect(page.locator("#timeline-gap-close")).toBeVisible();
  await page.locator("#timeline-gap-close").click();
  await expect(gaps(page)).toHaveCount(0);
});

test("at the smallest window both lines fit, and a narrow gap keeps only what fits", async ({ page }) => {
  await open(page, 960);
  await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans", sans-serif; }' });
  await gapNeverMoved(page);
  await (await nudgeLast(page)).up();
  const gap = gaps(page).first();
  await expect(gap.locator(".tl-gap-text")).toBeVisible();
  await expect(gap.locator(".tl-gap-close")).toBeVisible();
  const fit = await gap.evaluate((element) => [...element.children].every((child) => {
    const inner = child.getBoundingClientRect(), outer = element.getBoundingClientRect();
    return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
  }));
  expect(fit).toBe(true);

  // a gap too narrow for its lines leaves them out; the gap's menu still closes it
  await gap.evaluate((element) => { element.style.width = "60px"; });
  await expect(gap.locator(".tl-gap-close")).toBeHidden();
  await expect(gap.locator(".tl-gap-text")).toBeHidden();
});
