import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, type FakeBackendFixture } from "../fixtures/fake-backend";

const SOURCE = "C:\\media\\Recording.mp4";
const OUTPUT = "C:\\pictures\\Recording-frame.png";

function fixture(): FakeBackendFixture {
  const result = healthyBackendFixture();
  result.startup.files = [SOURCE];
  result.responses.probeFile = {
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: false },
  };
  result.responses.getMediaUrl = { ok: false, error: "Preview codec unavailable" };
  result.responses.pickSaveFile = { path: OUTPUT };
  result.responses.exportFrame = { path: OUTPUT, width: 1920, height: 1080, time: 0, warnings: [] };
  return result;
}

async function open(page: Page, data = fixture()) {
  await installFakeBackend(page, data);
  await page.goto("/");
  if (data.startup.files.length) {
    await expect(page.locator("#player-bar")).toBeVisible();
  }
}

// this video has no playable preview: the HTML player keeps the time its element is given, and
// the native player moves with the default 3 second skip
async function playheadAtThreeSeconds(page: Page) {
  if (process.env.TUCK_E2E_NATIVE_PREVIEW === "engine") {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Shift+ArrowRight");
    return;
  }
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("#vid")!;
    video.currentTime = 3;
    video.dispatchEvent(new Event("timeupdate"));
  });
}

async function calls(page: Page, method: string) {
  return page.evaluate(name => (window.__tuckFakeBackendCalls ?? [])
    .filter(call => call.method === name)
    .map(call => call.args), method);
}
test("Save frame stays disabled until a selected video is ready", async ({ page }) => {
  const data = fixture();
  data.startup.files = [];
  data.responses.pickFiles = { files: [SOURCE] };
  data.holdMethods = ["probeFile"];
  await open(page, data);
  await expect(page.locator("#btn-save-frame")).toBeDisabled();
  await page.keyboard.press("Control+Shift+s");
  expect(await calls(page, "pickSaveFile")).toHaveLength(0);
  await page.locator("#btn-add").click();
  await expect.poll(() => calls(page, "probeFile")).toHaveLength(1);
  await expect(page.locator("#btn-save-frame")).toBeDisabled();
  await page.keyboard.press("Control+Shift+s");
  expect(await calls(page, "pickSaveFile")).toHaveLength(0);
  await page.evaluate(() => window.__tuckReleaseHeld?.("probeFile"));
  await expect(page.locator("#btn-save-frame")).toBeEnabled();
});
test("keyboard save works without a playable preview and keeps focus through measured completion", async ({ page }) => {
  const data = fixture();
  data.holdMethods = ["exportFrame"];
  await open(page, data);
  const button = page.getByRole("button", { name: "Save frame", exact: true });
  await expect(button).toBeEnabled();
  await button.focus();
  await button.press("Enter");
  await expect(button).toHaveAccessibleDescription(/Saving frame/);
  await expect(page.locator("#toast-ct .toast")).toHaveCount(0);
  await expect(button).toBeDisabled();
  await expect(button).toBeFocused();
  await expect(page.getByRole("button", { name: "Show in folder", exact: true })).toBeHidden();
  await button.press("Enter");
  await page.keyboard.press("Control+Shift+s");
  expect(await calls(page, "exportFrame")).toHaveLength(1);
  await page.evaluate(() => window.__tuckReleaseHeld?.("exportFrame"));
  await expect(page.locator("#toast-ct")).toContainText(OUTPUT);
  await expect(button).toHaveAccessibleDescription(/Saved frame from Recording.mp4/);
  await expect(button).toBeFocused();
  await expect(button).toBeEnabled();
  await page.getByRole("button", { name: "Show in folder", exact: true }).click();
  expect(await calls(page, "openOutputFolder")).toEqual([[OUTPUT]]);
  expect(await calls(page, "pickSaveFile")).toEqual([["C:\\media\\Recording-frame-00-00-00-000.png", "png"]]);
});

test("Save frame shortcuts can be changed in Keyboard settings and appear in the guide", async ({ page }) => {
  await open(page);
  const button = page.getByRole("button", { name: "Save frame", exact: true });
  await expect(button).toHaveAttribute("aria-keyshortcuts", "Control+Shift+S");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard", exact: true }).click();
  await page.getByRole("button", { name: "Change Ctrl+Shift+S for Save frame", exact: true }).click();
  await page.keyboard.press("Control+Shift+p");
  await expect(page.locator("#kb-status")).toHaveText("Save frame now uses Ctrl+Shift+P.");
  expect(await calls(page, "saveSettings")).toContainEqual([{ shortcut_overrides: { "playback.save-frame": ["Ctrl+Shift+P"] } }]);
  await expect(button).toHaveAttribute("aria-keyshortcuts", "Control+Shift+P");
  await expect(button).toHaveAttribute("data-tip", "Save frame (Ctrl+Shift+P)");
  await page.keyboard.press("Control+Shift+p");
  expect(await calls(page, "pickSaveFile")).toHaveLength(0);
  await page.getByRole("button", { name: "Shortcut guide", exact: true }).click();
  const guide = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await guide.getByRole("searchbox", { name: "Search keyboard shortcuts" }).fill("save frame");
  await expect(guide.locator(".kbs-row")).toHaveCount(1);
  await expect(guide.locator(".kbs-row")).toContainText("Save frame");
  await expect(guide.locator(".kbs-row")).toContainText("P");
  await page.keyboard.press("Control+Shift+p");
  expect(await calls(page, "pickSaveFile")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await button.focus();
  await page.keyboard.press("Control+Shift+s");
  expect(await calls(page, "pickSaveFile")).toHaveLength(0);
  await page.keyboard.press("Control+Shift+p");
  await expect.poll(() => calls(page, "exportFrame")).toHaveLength(1);
});

test("the default frame shortcut works from a slider and stays out of text entry", async ({ page }) => {
  await open(page);
  await page.locator("#sz-badge").focus();
  await page.keyboard.press("Control+Shift+s");
  expect(await calls(page, "pickSaveFile")).toHaveLength(0);
  await page.locator("#vbar").focus();
  await page.keyboard.press("Control+Shift+s");
  await expect.poll(() => calls(page, "exportFrame")).toHaveLength(1);
  await expect(page.locator("#vbar")).toBeFocused();
  await page.locator("#btn-save-frame").focus();
  await page.keyboard.press("Control+Shift+s");
  await expect.poll(() => calls(page, "exportFrame")).toHaveLength(2);
  await page.locator("#btn-play").focus();
  await page.keyboard.press("Control+Shift+s");
  await expect.poll(() => calls(page, "exportFrame")).toHaveLength(3);
  await expect(page.locator("#toast-ct")).toContainText(OUTPUT);
});

test("a folder failure uses a normal error toast and preserves the saved frame", async ({ page }) => {
  const data = fixture();
  data.responses.openOutputFolder = { ok: false, error: "The folder is unavailable." };
  await open(page, data);
  const button = page.getByRole("button", { name: "Save frame", exact: true });
  await button.click();
  await page.getByRole("button", { name: "Show in folder", exact: true }).click();
  await expect(page.locator("#toast-ct .toast.err")).toContainText("folder is unavailable");
  await expect(button).toHaveAccessibleDescription(/Saved frame.*folder is unavailable/);
  await expect(button).toBeEnabled();
  expect(await calls(page, "exportFrame")).toHaveLength(1);
});
test("cancel is quiet and an export error stays readable", async ({ page }) => {
  const data = fixture();
  data.responseSequences = { pickSaveFile: [{ path: "" }, { path: OUTPUT }] };
  data.responses.exportFrame = { ok: false, error: "The destination is full. Choose another folder." };
  await open(page, data);
  await page.getByRole("button", { name: "Save frame", exact: true }).click();
  await expect(page.locator("#toast-ct .toast")).toHaveCount(0);
  expect(await calls(page, "exportFrame")).toHaveLength(0);
  await page.getByRole("button", { name: "Save frame", exact: true }).click();
  await expect(page.locator("#toast-ct")).toContainText("destination is full");
  await expect(page.getByRole("button", { name: "Save frame", exact: true })).toHaveAccessibleDescription(/destination is full/);
  await expect(page.getByRole("button", { name: "Show in folder", exact: true })).toBeHidden();
});
test("a native picker keeps the original clip and source playhead while selection changes", async ({ page }) => {
  const data = fixture();
  data.startup.files.push("C:\\media\\Second.mp4");
  data.holdMethods = ["pickSaveFile"];
  await open(page, data);
  await playheadAtThreeSeconds(page);
  await page.getByRole("button", { name: "Save frame", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save frame", exact: true })).toHaveAccessibleDescription(/Recording.mp4 at 3.000 s/);
  await page.locator(".clip").filter({ hasText: "Second.mp4" }).click();
  await page.evaluate(() => window.__tuckReleaseHeld?.("pickSaveFile"));
  await expect(page.locator("#toast-ct")).toContainText(OUTPUT);
  await expect(page.getByRole("button", { name: "Save frame", exact: true })).toHaveAccessibleDescription(/Saved frame from Recording.mp4/);
  const exported = await calls(page, "exportFrame");
  expect(exported).toHaveLength(1);
  expect(exported[0]?.[0]).toMatchObject({ source: SOURCE, time: 3, output: OUTPUT });
});
test("a frame keeps crop, rotation and LUT settings when the profile changes during the picker", async ({ page }) => {
  const data = fixture();
  data.holdMethods = ["pickSaveFile"];
  const lut = { enabled: true, path: "C:/managed/film.cube", name: "Film", strength: 0.4 };
  const base = {
    workflow: "compression",
    target_size_bytes: 20971520,
    resolution_mode: "source",
    fps_mode: "source",
    video_encoder: "libx264",
    preset: "medium",
    audio_bitrate: 128000,
  };
  data.responses.getSettings = {
    ...data.responses.getSettings as object,
    profiles: [
      { ...base, profile_id: "plain", name: "Plain" },
      {
        ...base,
        profile_id: "look",
        name: "Look",
        lut,
        transform_intent: { crop_aspect: "1:1", rotation: 90, sizing_mode: "fit" },
      },
    ],
  };
  data.responses.loadLut = {
    path: lut.path,
    name: "Film",
    size: 2,
    table_url: "https://lut.test/frame-table",
    token: "lut",
  };
  await page.route("https://lut.test/frame-table", route => route.fulfill({
    body: Buffer.from(new Float32Array(24).buffer),
    headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await open(page, data);
  await page.locator("#prof-pick").click();
  await page.locator('#prof-options [data-profile-id="look"]').click();
  await expect(page.locator("#lut-panel")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#lut-enabled")).toBeChecked();
  await page.getByRole("button", { name: "Save frame", exact: true }).click();
  await page.locator("#prof-pick").click();
  await page.locator('#prof-options [data-profile-id="plain"]').click();
  await page.evaluate(() => window.__tuckReleaseHeld?.("pickSaveFile"));
  await expect(page.locator("#toast-ct")).toContainText("Saved frame");
  const exported = await calls(page, "exportFrame");
  expect(exported[0]?.[0]).toMatchObject({
    source: SOURCE,
    lut,
    transform: {
      crop_aspect: "1:1",
      rotation: 90,
      flip_horizontal: false,
      flip_vertical: false,
      sizing_mode: "fit",
    },
  });
  const request = exported[0]?.[0] as {
    transform: {
      crop: {
        width: number;
        height: number;
      };
    };
  };
  expect(request.transform.crop).toMatchObject({ width: 1080, height: 1080 });
  expect(Object.keys(exported[0]?.[0] as object).sort()).toEqual(["lut", "output", "source", "time", "transform"]);
});
for (const width of [1440, 960]) {
  test(`frame controls and status fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await open(page);
    await page.getByRole("button", { name: "Save frame", exact: true }).click();
    await expect(page.locator("#toast-ct")).toContainText("Saved frame");
    const fits = await page.evaluate(() => {
      const elements = [
        "btn-save-frame", "btn-fullscreen", "btn-play", "toast-ct",
      ].map(id => document.getElementById(id)!.getBoundingClientRect());
      return elements.every(rect =>
        rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight)
        && document.documentElement.scrollWidth <= innerWidth;
    });
    expect(fits).toBe(true);
    await page.getByRole("button", { name: "Lossless cut", exact: true }).click();
    const separated = await page.evaluate(() => {
      const buttons = [
        "btn-save-frame", "btn-fullscreen", "btn-mute", "btn-kf-next", "btn-cut-set-end",
      ].map(id => document.getElementById(id)!.getBoundingClientRect());
      return buttons.every((rect, index) => buttons.slice(index + 1)
        .every(other => rect.right <= other.left || other.right <= rect.left))
        && buttons.every(rect => rect.left >= 0 && rect.right <= innerWidth);
    });
    expect(separated).toBe(true);
  });
}
