import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const FIRST = "C:\\videos\\Round 1.mp4";
const SECOND = "C:\\videos\\Round 2.mp4";
const THIRD = "C:\\videos\\Round 3.mp4";
const JOINED = "C:\\videos\\Round 1_joined.mp4";

function status(fields: Record<string, unknown>) {
  return {
    work_id: "join", status: "running", stage: "checking", progress: null, output_path: "", lossless: null,
    reason: "", encoder: "", fallback: "", code: "", message: "", ...fields,
  };
}

async function open(page: Page, joins: unknown[] = [], options: { hold?: boolean; refuse?: string } = {}) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = [FIRST, SECOND, THIRD];
  fixture.responses.probeFile = { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 60, has_audio: true, file_size: 20_000_000 } };
  fixture.responses.joinVideos = options.refuse ? { ok: false, error: options.refuse, code: "JOIN_BUSY" } : status({});
  fixture.responses.cancelJoin = { cancelled: true };
  fixture.responseSequences = { getJoin: joins };
  if (options.hold) fixture.holdMethods = ["getJoin"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip[data-clip-path]")).toHaveCount(3);
}

const row = (page: Page, path: string) => page.locator(`.clip[data-clip-path="${path.replace(/\\/g, "\\\\")}"]`);
const polls = (page: Page) => page.evaluate(() => window.__tuckFakeBackendCalls?.filter((call) => call.method === "getJoin").length ?? 0);
const joinCalls = (page: Page) => page.evaluate(() => window.__tuckFakeBackendCalls?.filter((call) => call.method === "joinVideos").map((call) => call.args) ?? []);

test("Join appears only with two or more videos chosen, by pointer or keyboard", async ({ page }) => {
  await open(page);
  const join = page.getByRole("button", { name: /^Join/ });
  await expect(join).toBeHidden();
  await row(page, THIRD).click({ modifiers: ["Control"] });
  await expect(page.locator("#lib-join-text")).toHaveText("2 selected");
  await expect(join).toBeVisible();
  await expect(row(page, THIRD)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, SECOND)).toHaveAttribute("aria-selected", "false");
  // a plain click chooses one video again
  await row(page, SECOND).click();
  await expect(join).toBeHidden();
  await expect(row(page, THIRD)).toHaveAttribute("aria-selected", "false");
  // Shift with an arrow key reaches one row further; the stage keeps its video
  await row(page, SECOND).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(row(page, THIRD)).toBeFocused();
  await expect(page.locator("#lib-join-text")).toHaveText("2 selected");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(page.locator("#lib-join-text")).toHaveText("2 selected");
  await expect(row(page, FIRST)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, THIRD)).toHaveAttribute("aria-selected", "false");
  // Ctrl+Space adds the focused row
  await row(page, THIRD).focus();
  await page.keyboard.press("Control+Space");
  await expect(page.locator("#lib-join-text")).toHaveText("3 selected");
});

test("joining adds the new video to the Library in Library order and opens it", async ({ page }) => {
  await open(page, [
    status({ stage: "encoding", progress: 0.4, lossless: false, reason: "the frame rates differ (60 fps and 30 fps)", encoder: "libx264" }),
    status({ status: "done", stage: "", progress: 1, lossless: false, reason: "the frame rates differ (60 fps and 30 fps)", encoder: "libx264", output_path: JOINED }),
  ]);
  await row(page, THIRD).click();
  await row(page, FIRST).click({ modifiers: ["Shift"] });
  await expect(page.locator("#lib-join-text")).toHaveText("3 selected");
  await page.getByRole("button", { name: "Join 3 videos into one" }).click();
  await expect(row(page, JOINED)).toBeVisible();
  await expect(row(page, JOINED)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#lib-join")).toBeHidden();
  const calls = await joinCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toEqual([FIRST, SECOND, THIRD]);
  await expect(page.locator("#toast-ct")).toContainText("Joined 3 videos into “Round 1_joined.mp4”. Re-encoded because the frame rates differ (60 fps and 30 fps).");
});

test("a join shows its measured stage and can be canceled", async ({ page }) => {
  await open(page, [
    status({ stage: "copying", progress: 0.25, lossless: true }),
    status({ status: "cancelled", stage: "copying", lossless: true, message: "Join canceled." }),
  ], { hold: true });
  await row(page, SECOND).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Join 2 videos into one" }).click();
  // nothing is measured while the videos are checked, so the stage is named instead
  await expect(page.locator("#lib-join-text")).toHaveText("Checking 2 videos…");
  await expect(page.locator("#lib-join-bar")).toBeHidden();
  await expect.poll(() => polls(page)).toBe(1);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getJoin"));
  await expect(page.locator("#lib-join-text")).toHaveText("Joining · 25%");
  await expect(page.locator("#lib-join-bar")).toHaveJSProperty("value", 25);
  await expect(page.locator("#lib-join-note")).toHaveText("Copying without re-encoding, so nothing changes in quality.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Canceling…" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.some((call) => call.method === "cancelJoin"))).toBe(true);
  await expect.poll(() => polls(page)).toBe(2);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getJoin"));
  await expect(page.locator("#lib-join-text")).toHaveText("2 selected");
  await expect(page.locator("#lib-join-status")).toHaveText("Join canceled. Nothing was saved.");
  await expect(page.locator(".clip[data-clip-path]")).toHaveCount(3);
});

test("a failed join says why and stays until dismissed", async ({ page }) => {
  await open(page, [
    status({ status: "failed", stage: "", code: "join_failed", message: "The disk is full, so the joined video wasn't saved. Free up some space and try again." }),
  ]);
  await row(page, SECOND).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Join 2 videos into one" }).click();
  await expect(page.locator("#lib-join-text")).toHaveText("Couldn’t join the videos");
  await expect(page.locator("#lib-join-note")).toHaveText("The disk is full, so the joined video wasn't saved. Free up some space and try again.");
  await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeFocused();
  await row(page, THIRD).click();
  await expect(page.locator("#lib-join-text")).toHaveText("Couldn’t join the videos");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator("#lib-join")).toBeHidden();
  await expect(page.locator(".clip[data-clip-path]")).toHaveCount(3);
});

test("a refused join request is shown the same way", async ({ page }) => {
  await open(page, [], { refuse: "Another join is still running. Wait for it or cancel it." });
  await row(page, SECOND).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Join 2 videos into one" }).click();
  await expect(page.locator("#lib-join-note")).toHaveText("Another join is still running. Wait for it or cancel it.");
});
