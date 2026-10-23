import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

async function openPlayer(page: Page, width: number, height: number) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = ["C:\\videos\\Morning ride.mp4"];
  fixture.responses.probeFile = { data: { duration: 12, width, height, fps: 30, has_audio: true, file_size: 15_000_000 } };
  fixture.holdMethods = ["createPlan"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator("#player-bar")).toBeVisible();
}

async function expectPlayerLayout(page: Page, aspect: number) {
  await expect.poll(() => page.evaluate((ratio) => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const main = box("main"), center = box("center"), stage = box("stage");
    const frame = box("media-viewport"), bar = box("player-bar"), play = box("btn-play");
    const library = document.body.classList.contains("library-panel-open") && window.innerWidth >= 1180;
    const inspector = document.body.classList.contains("inspector-panel-open") && window.innerWidth >= 1180;
    return Math.max(
      Math.abs(center.top - main.top), Math.abs(center.bottom - main.bottom),
      Math.abs(center.left - (library ? box("left").right + 8 : 8)),
      Math.abs(center.right - (inspector ? box("right").left - 8 : window.innerWidth - 8)),
      library ? Math.abs(box("left").width - 232) : 0,
      inspector ? Math.abs(box("right").width - 344) : 0,
      Math.abs(bar.bottom - center.bottom),
      // the screen keeps the same inset from the card on every side, controls included
      Math.abs(stage.top - center.top - 8), Math.abs(stage.left - center.left - 8),
      Math.abs(center.right - stage.right - 8), Math.abs(play.top - stage.bottom - 8),
      Math.abs(frame.left + frame.width / 2 - stage.left - stage.width / 2),
      Math.abs(frame.top + frame.height / 2 - stage.top - stage.height / 2),
      Math.abs(frame.width - frame.height * ratio),
      frame.width - stage.width, frame.height - stage.height,
      document.documentElement.scrollWidth - window.innerWidth,
      document.documentElement.scrollHeight - window.innerHeight,
    );
  }, aspect)).toBeLessThanOrEqual(1);
}

for (const [name, width, height] of [["landscape", 1920, 1080], ["portrait", 1080, 1920], ["square", 1080, 1080]] as const) {
  test(`${name} video stays centred in a stable workspace while resizing`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    await openPlayer(page, width, height);
    await expectPlayerLayout(page, width / height);
    const timelineHeight = await page.locator("#timeline-resizer").getAttribute("aria-valuenow");
    for (const viewport of [
      { width: 1340, height: 1200 }, { width: 1440, height: 900 },
      { width: 1240, height: 800 }, { width: 1180, height: 640 },
      { width: 1179, height: 640 }, { width: 960, height: 640 },
      { width: 1920, height: 640 }, { width: 1920, height: 1200 },
    ]) {
      await page.setViewportSize(viewport);
      await expectPlayerLayout(page, width / height);
      await expect(page.locator("#timeline-resizer")).toHaveAttribute("aria-valuenow", timelineHeight!);
    }
  });
}

test("resizing the timeline and toggling panels leaves the video controls inside the player", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await openPlayer(page, 1920, 1080);
  const separator = page.getByRole("separator", { name: "Resize timeline" });
  const automaticHeight = await separator.getAttribute("aria-valuenow");
  await separator.focus();
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "660");
  await expectPlayerLayout(page, 16 / 9);
  for (const panel of ["library", "inspector", "library", "inspector"]) {
    await page.locator(`#panel-toggle-${panel}`).click();
    await expectPlayerLayout(page, 16 / 9);
  }
  await page.setViewportSize({ width: 960, height: 640 });
  await expectPlayerLayout(page, 16 / 9);
  await expect(separator).toHaveAttribute("aria-valuenow", "310");
  await page.setViewportSize({ width: 1920, height: 1200 });
  await expect(separator).toHaveAttribute("aria-valuenow", "660");
  await separator.dblclick();
  await expect(separator).toHaveAttribute("aria-valuenow", automaticHeight!);
  await expectPlayerLayout(page, 16 / 9);
});

test("rotating a video and entering fullscreen preserve the workspace layout", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await openPlayer(page, 1920, 1080);
  const separator = page.getByRole("separator", { name: "Resize timeline" });
  const timelineHeight = await separator.getAttribute("aria-valuenow");
  await page.locator("#insp-tab-edit").click();
  await page.getByRole("button", { name: "90° right", exact: true }).click();
  await expectPlayerLayout(page, 9 / 16);
  await expect(separator).toHaveAttribute("aria-valuenow", timelineHeight!);

  const fullscreen = page.getByRole("button", { name: "Fullscreen", exact: true });
  await fullscreen.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#center")).toHaveJSProperty("clientWidth", 1240);
  await expect.poll(() => page.evaluate(() => {
    const center = document.getElementById("center")!.getBoundingClientRect();
    const stage = document.getElementById("stage")!.getBoundingClientRect();
    const frame = document.getElementById("media-viewport")!.getBoundingClientRect();
    return document.fullscreenElement?.id === "center"
      && center.height === window.innerHeight
      && Math.abs(frame.width / frame.height - 9 / 16) < 0.001
      && Math.abs(frame.left + frame.width / 2 - stage.left - stage.width / 2) < 1
      && Math.abs(frame.top + frame.height / 2 - stage.top - stage.height / 2) < 1;
  })).toBe(true);
  await fullscreen.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expectPlayerLayout(page, 9 / 16);
  await expect(separator).toHaveAttribute("aria-valuenow", timelineHeight!);
});

test("on Linux fullscreen fills a full screen window instead of asking WebKit for element fullscreen", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Reflect.set(window, "__windowFullscreenCalls", calls);
    // WebKitGTK aborts the whole app on element fullscreen, so the page must never ask for it
    Element.prototype.requestFullscreen = () => {
      calls.push("element");
      return Promise.resolve();
    };
    Reflect.set(window, "__TAURI_INTERNALS__", {
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === "platform_capabilities") return {
          platform: "linux", architecture: "x86_64", customTitleBar: false, elementFullscreen: false,
          sendToIntegration: false, publicCli: false, automaticUpdater: true,
          hardwareAcceleration: true, packaged: false,
        };
        if (command === "set_window_fullscreen") {
          calls.push(args.fullscreen);
          return false;
        }
        return 1;
      },
    });
  });
  await openPlayer(page, 1920, 1080);
  const separator = page.getByRole("separator", { name: "Resize timeline" });
  const timelineHeight = await separator.getAttribute("aria-valuenow");
  const calls = () => page.evaluate(() => Reflect.get(window, "__windowFullscreenCalls") as unknown[]);

  const fullscreen = page.getByRole("button", { name: "Fullscreen", exact: true });
  await fullscreen.click();
  await expect(page.locator("html")).toHaveClass(/\bstage-fullscreen\b/);
  await expect.poll(calls).toEqual([true]);
  await expect.poll(() => page.evaluate(() => {
    const center = document.getElementById("center")!.getBoundingClientRect();
    const stage = document.getElementById("stage")!.getBoundingClientRect();
    const frame = document.getElementById("media-viewport")!.getBoundingClientRect();
    const covering = document.elementFromPoint(window.innerWidth - 4, window.innerHeight / 2);
    return document.fullscreenElement === null
      && center.left === 0 && center.top === 0
      && center.width === window.innerWidth && center.height === window.innerHeight
      && document.getElementById("center")!.contains(covering)
      && Math.abs(frame.width / frame.height - 16 / 9) < 0.001
      && Math.abs(frame.left + frame.width / 2 - stage.left - stage.width / 2) < 1;
  })).toBe(true);
  await expect(fullscreen).toBeFocused();

  // Escape belongs to leaving full screen, as with the webview's own fullscreen
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveClass(/\bstage-fullscreen\b/);
  await expect.poll(calls).toEqual([true, false]);
  await expectPlayerLayout(page, 16 / 9);
  await expect(separator).toHaveAttribute("aria-valuenow", timelineHeight!);

  await fullscreen.click();
  await expect(page.locator("html")).toHaveClass(/\bstage-fullscreen\b/);
  await fullscreen.click();
  await expect(page.locator("html")).not.toHaveClass(/\bstage-fullscreen\b/);
  await expect.poll(calls).toEqual([true, false, true, false]);
  await expectPlayerLayout(page, 16 / 9);
});
