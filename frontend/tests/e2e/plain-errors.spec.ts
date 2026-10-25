import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const MATCH = "C:\\videos\\Ranked match.mp4";
const BIKE = "C:\\videos\\Bike trail.mov";
const BROKEN = "C:\\videos\\Broken.mp4";

const READ_ONLY =
  "E: is read-only, so the export couldn't be saved. Pick another folder in Settings > Files & names, then Retry.";
const UNREADABLE = "Tuck can't read this file. It may be damaged or in a format FFmpeg doesn't support.";
const TOO_SMALL = "20\u00a0MB is too small for 1:00:00 of video. Try at least 30\u00a0MB, or trim it.";

function probe(duration: number) {
  return { ok: true, data: { duration, width: 1280, height: 720, fps: 30, has_audio: true, file_size: 48_000_000 } };
}

async function open(page: Page, options: { files: string[]; queue?: unknown[]; probes?: unknown[]; width?: number; holdPlans?: boolean }) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = options.files;
  fixture.responses.probeFile = probe(3600);
  if (options.probes) fixture.responseSequences = { probeFile: options.probes };
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 3600 } };
  if (options.queue) fixture.responses.getQueueState = { items: options.queue };
  if (options.holdPlans) fixture.holdMethods = ["createPlan"];
  await page.setViewportSize({ width: options.width ?? 1440, height: options.width === 960 ? 640 : 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  // line counts depend on the font: Arial and Liberation Sans have the same widths and are on every
  // test machine, where the Linux runners would otherwise fall back to the wider DejaVu Sans
  await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans", sans-serif; }' });
  await expect(page.locator(".clip")).toHaveCount(options.files.length);
}

// answers every plan asked for so far with the same reply, echoing each request's id
let answered = 0;
async function answerPlans(page: Page, reply: Record<string, unknown>): Promise<void> {
  const pending = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan").map((call) => call.args[0]));
  await page.evaluate(({ requests, reply }) => {
    for (const request of requests) {
      window.__tuckReleaseHeld?.("createPlan", { ...reply, _request_id: (request as Record<string, unknown>)._request_id });
    }
  }, { requests: pending.slice(answered), reply });
  answered = pending.length;
}

test.beforeEach(() => {
  answered = 0;
});

// the panel and the Library redraw on every queue poll, so a count is read again until it settles
const lineCount = (locator: ReturnType<Page["locator"]>) => () =>
  locator.evaluate((element) => Math.round(element.clientHeight / parseFloat(getComputedStyle(element).lineHeight)));

test("a failed export's reason wraps in the Exports panel and is reachable from the keyboard", async ({ page }) => {
  const long = `${UNREADABLE} ${UNREADABLE} ${UNREADABLE} The last words of a long reason.`;
  await open(page, {
    files: [MATCH],
    width: 960,
    queue: [
      { id: "bike", source: "Bike trail.mov", source_path: BIKE, state: "failed", error: READ_ONLY },
      { id: "long", source: "Ranked match.mp4", source_path: MATCH, state: "failed", error: long },
    ],
  });
  await page.locator("#qstatus").click();
  const panel = page.getByRole("dialog", { name: "Exports" });
  const bike = panel.locator(".exports-row", { hasText: "Bike trail.mov" });
  const reason = bike.locator(".exports-detail");

  // the whole reason, with its next step, shows on two or three lines instead of being cut
  await expect(reason).toHaveText(`Failed: ${READ_ONLY}`);
  await expect.poll(lineCount(reason)).toBe(2);
  await expect.poll(() => reason.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await expect(bike.getByRole("button", { name: "Retry Bike trail.mov" })).toHaveAccessibleDescription(`Failed: ${READ_ONLY}`);
  await expect(bike.getByRole("button", { name: "Copy details for Bike trail.mov" })).toHaveAccessibleDescription(`Failed: ${READ_ONLY}`);

  // a longer reason stops at three lines and shows whole once a button on its row has focus
  const longRow = panel.locator(".exports-row", { hasText: "Ranked match.mp4" });
  const longReason = longRow.locator(".exports-detail");
  await expect.poll(lineCount(longReason)).toBe(3);
  await longRow.getByRole("button", { name: "Retry Ranked match.mp4" }).focus();
  await expect.poll(lineCount(longReason)).toBeGreaterThan(3);
  await page.keyboard.press("Tab");
  await expect(longRow.getByRole("button", { name: "Copy details for Ranked match.mp4" })).toBeFocused();
  await expect.poll(lineCount(longReason)).toBeGreaterThan(3);
});

test("an unreadable file says why on its Library card", async ({ page }) => {
  await open(page, { files: [MATCH, BROKEN], probes: [probe(12), { ok: false, error: UNREADABLE }] });
  const card = page.locator(".lib-group-attention .clip");
  await expect(card.locator(".c-status")).toHaveText("Can't read file");
  const reason = card.locator(".c-reason");
  await expect(reason).toHaveText(UNREADABLE);
  await expect(reason).toBeVisible();
  await expect(card).toHaveAttribute("aria-description", UNREADABLE);

  // the narrow Library keeps two lines and shows the rest while the card has focus
  await expect.poll(lineCount(reason)).toBe(2);
  await card.focus();
  await expect.poll(lineCount(reason)).toBeGreaterThan(2);
});

test("a target size that can't work is said under Target size and turns the export button off", async ({ page }) => {
  await open(page, { files: [MATCH], holdPlans: true });
  const button = page.locator("#btn-one");
  await answerPlans(page, { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 3600 } });
  await expect(button).toBeEnabled();

  await page.locator("#sz-badge").fill("20");
  await page.locator("#sz-badge").dispatchEvent("change");
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan").length)).toBeGreaterThan(answered);
  await answerPlans(page, { ok: false, error: TOO_SMALL, details: { field: "target_size" } });

  const message = page.locator("#sz-grp #sz-error");
  await expect(message).toHaveText(TOO_SMALL);
  await expect(message).toBeVisible();
  await expect(page.locator("#export-plan-error")).toBeHidden();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(TOO_SMALL);
  // the message sits between the slider and the summary line, at the size it is about
  const order = await page.evaluate(() => {
    const top = (id: string) => document.getElementById(id)!.getBoundingClientRect().top;
    return [top("sz-slider"), top("sz-error"), top("export-summary-detail")];
  });
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);

  // a size that fits takes the message away and turns the button back on
  await page.locator("#sz-badge").fill("50");
  await page.locator("#sz-badge").dispatchEvent("change");
  await expect.poll(() => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === "createPlan").length)).toBeGreaterThan(answered);
  await answerPlans(page, { ok: true, data: { video_bitrate_kbps: 90, segment_count: 1, selected_duration: 3600 } });
  await expect(message).toBeHidden();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-describedby");
});
