import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

type Rgb = [number, number, number];

declare global {
  interface Window {
    __lutSource?: { paint(top: string, bottom: string): void };
    __lutDraws?: number;
    __frameCallbacks?: Map<number, VideoFrameRequestCallback>;
  }
}

// output red/green/blue come from input blue/green/red, so a direction mix-up shows in the pixels
function swapTable(): number[] {
  const table: number[] = [];
  for (let blue = 0; blue < 2; blue++) for (let green = 0; green < 2; green++) for (let red = 0; red < 2; red++) table.push(blue, green, red);
  return table;
}

// the editor previews an exact 16x8 picture: decoders would blur the colors this test compares
async function openWithLut(
  page: Page,
  table: readonly number[],
  options: { tableSize?: number; top?: string; bottom?: string } = {},
): Promise<void> {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = { ok: true, files: ["C:/swatch.mp4"] };
  fixture.responses.probeFile = { ok: true, data: { width: 16, height: 8, duration: 3, fps: 30, has_audio: false } };
  fixture.responses.getMediaUrl = { ok: false, error: "No media server in this test" };
  fixture.responses.getThumbnail = { ok: true, thumbnail: "" };
  fixture.responses.pickLutFile = { path: "swap.cube" };
  fixture.responses.loadLut = { path: "swap.cube", name: "Swap", size: options.tableSize ?? 2, table_url: "https://lut.test/table", token: "lut" };
  await page.route("https://lut.test/table", (route) => route.fulfill({
    body: Buffer.from(new Float32Array(table).buffer),
    headers: { "Access-Control-Allow-Origin": "*" },
  }));
  await page.setViewportSize({ width: 1240, height: 800 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "Add videos", exact: true }).click();
  await expect(page.locator(".clip")).toHaveCount(1);
  await page.locator("#vid").evaluate(async (video: HTMLVideoElement, colors) => {
    const source = document.createElement("canvas");
    source.width = 16;
    source.height = 8;
    const context = source.getContext("2d")!;
    const stream = source.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    window.__lutSource = {
      paint(top, bottom) {
        context.fillStyle = top;
        context.fillRect(0, 0, 16, 4);
        context.fillStyle = bottom;
        context.fillRect(0, 4, 16, 4);
        track.requestFrame();
      },
    };
    window.__lutSource.paint(colors.top, colors.bottom);
    video.srcObject = stream;
    await video.play();
    video.pause();
  }, { top: options.top ?? "rgb(128,64,192)", bottom: options.bottom ?? "rgb(32,192,64)" });
  await page.locator("#lut-panel > summary").click();
  await page.locator("#lut-import").click();
}

function previewPixel(page: Page, row: "top" | "bottom"): Promise<Rgb> {
  return page.locator("[data-lut-preview]").evaluate(async (element, row) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const canvas = element as HTMLCanvasElement;
    const gl = canvas.getContext("webgl2")!;
    const value = new Uint8Array(4);
    gl.readPixels(2, row === "top" ? canvas.height - 2 : 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
    return [value[0]!, value[1]!, value[2]!] as Rgb;
  }, row);
}

function near(actual: Rgb, expected: Rgb, tolerance = 4): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
}

test("the LUT preview keeps the picture upright, mixes by strength and follows rotation", async ({ page }) => {
  await openWithLut(page, swapTable());
  const canvas = page.locator("[data-lut-preview]");
  await expect(canvas).toBeVisible();
  await expect(page.locator("#lut-error")).toBeHidden();

  await expect.poll(() => previewPixel(page, "top").then((pixel) => near(pixel, [192, 64, 128]))).toBe(true);
  expect(near(await previewPixel(page, "bottom"), [64, 192, 32])).toBe(true);

  const strength = page.locator("#lut-strength");
  await strength.fill("50");
  await expect(page.locator("#lut-strength-value")).toHaveText("50%");
  await expect.poll(() => previewPixel(page, "top").then((pixel) => near(pixel, [160, 64, 160]))).toBe(true);

  // a playing video keeps feeding new frames through the LUT
  await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(async () => {
    await page.evaluate(() => window.__lutSource!.paint("rgb(64,128,192)", "rgb(64,128,192)"));
    return near(await previewPixel(page, "top"), [128, 128, 128]);
  }).toBe(true);
  await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.pause());

  await strength.fill("0");
  await expect(canvas).toBeHidden();
  await expect(page.locator("#vid")).toBeVisible();
  await strength.fill("100");
  await expect(canvas).toBeVisible();

  await page.locator("#insp-tab-edit").click();
  await page.getByRole("button", { name: "Rotate 90° clockwise" }).click();
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-lut-preview]")!;
    const shown = getComputedStyle(video);
    return shown.transform !== "none" && canvas.style.transform === shown.transform && canvas.style.width === shown.width;
  })).toBe(true);
});

test("losing graphics resources shows the video again and the LUT recovers when turned off and on", async ({ page }) => {
  await openWithLut(page, swapTable());
  const canvas = page.locator("[data-lut-preview]");
  await expect(canvas).toBeVisible();

  await canvas.evaluate(async (element) => {
    const extension = (element as HTMLCanvasElement).getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    const lost = new Promise<void>((resolve) => element.addEventListener("webglcontextlost", () => resolve(), { once: true }));
    extension.loseContext();
    await lost;
    // restoring has to wait until the loss event has finished dispatching
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const restored = new Promise<void>((resolve) => element.addEventListener("webglcontextrestored", () => resolve(), { once: true }));
    extension.restoreContext();
    await restored;
  });
  await expect(page.locator("#lut-error")).toHaveText("LUT preview stopped because graphics resources were lost. Turn the LUT off and on to retry.");
  await expect(canvas).toBeHidden();
  await expect(page.locator("#vid")).toBeVisible();

  const apply = page.getByRole("switch", { name: "Apply LUT", exact: true });
  await apply.uncheck();
  await apply.check();
  await expect(canvas).toBeVisible();
  await expect(page.locator("#lut-error")).toBeHidden();
  await expect.poll(() => previewPixel(page, "top").then((pixel) => near(pixel, [192, 64, 128]))).toBe(true);
});

test("invalid LUT data is reported without covering the video", async ({ page }) => {
  await openWithLut(page, [0, 0, 0]);

  await expect(page.locator("#lut-error")).toHaveText("The LUT preview data is invalid.");
  await expect(page.locator("[data-lut-preview]")).toBeHidden();
  await expect(page.locator("#vid")).toBeVisible();
});

test("a paused LUT preview paints late frame notifications and keeps listening after a source change", async ({ page }) => {
  await page.addInitScript(() => {
    // deliver compositor notifications by hand, independently of media events
    const pending = new Map<number, VideoFrameRequestCallback>();
    let sequence = 0;
    window.__frameCallbacks = pending;
    HTMLVideoElement.prototype.requestVideoFrameCallback = (callback) => {
      pending.set(++sequence, callback);
      return sequence;
    };
    HTMLVideoElement.prototype.cancelVideoFrameCallback = (id) => {
      pending.delete(id);
    };
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function drawArrays(...args) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.hasAttribute("data-lut-preview")) {
        window.__lutDraws = (window.__lutDraws ?? 0) + 1;
      }
      draw.apply(this, args);
    };
  });
  await openWithLut(page, new Array<number>(24).fill(1));
  await expect(page.locator("[data-lut-preview]")).toBeVisible();

  const result = await page.locator("#vid").evaluate(async (video: HTMLVideoElement) => {
    const pending = window.__frameCallbacks!;
    video.dispatchEvent(new Event("pause"));
    const listeningWhilePaused = pending.size;
    const before = window.__lutDraws ?? 0;
    const callback = pending.values().next().value;
    pending.clear();
    callback?.(performance.now(), { mediaTime: 0, presentedFrames: 1, expectedDisplayTime: 0, presentationTime: 0, width: 16, height: 8, processingDuration: 0 });
    const repainted = (window.__lutDraws ?? 0) > before;
    video.dispatchEvent(new Event("loadstart"));
    return { listeningWhilePaused, repainted, listeningAfterSourceChange: pending.size };
  });
  expect(result).toEqual({ listeningWhilePaused: 1, repainted: true, listeningAfterSourceChange: 1 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await previewPixel(page, "top")).toEqual([255, 255, 255]);
  await expect(page.locator("[data-lut-preview]")).toBeVisible();
});

test("the LUT preview matches the real FFmpeg export filter at every strength", async ({ page }) => {
  const python = resolve(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  test.skip(!existsSync(python), "The project Python environment is required for the FFmpeg comparison");
  const table = swapTable();
  const strengths = [0, 35, 100];
  await openWithLut(page, table, { top: "rgb(128,64,192)", bottom: "rgb(128,64,192)" });
  await expect(page.locator("[data-lut-preview]")).toBeVisible();
  const sourceRgb = await page.locator("#vid").evaluate((video: HTMLVideoElement) => {
    const sample = document.createElement("canvas");
    sample.width = 16;
    sample.height = 8;
    const context = sample.getContext("2d")!;
    context.drawImage(video, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  });
  const preview: number[][] = [];
  for (const strength of strengths) {
    await page.locator("#lut-strength").fill(String(strength));
    if (strength === 0) {
      await expect(page.locator("[data-lut-preview]")).toBeHidden();
      preview.push(sourceRgb);
      continue;
    }
    await expect(page.locator("[data-lut-preview]")).toBeVisible();
    preview.push(await previewPixel(page, "bottom"));
  }
  const exportPixels = JSON.parse(execFileSync(python, ["-c", `
import json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from tuck.encoding.filters import build_plan_video_filters
from tuck.lut import snapshot_lut, store_table
from tuck.media_tools import find_ffmpeg
from tuck.models import EncodePlan, VideoInfo
from tuck.models.lut import LutSettings
from tuck.settings import configure_storage_root, get_settings_manager
payload = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as temporary:
    configure_storage_root(Path(temporary))
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print(json.dumps({"unavailable": True}))
        sys.exit(0)
    path, _, _ = store_table(np.array(payload["table"], dtype=np.float32).reshape(-1, 3), get_settings_manager().data_dir / "luts")
    info = VideoInfo(path="raw", duration=1, width=16, height=8, fps=30, video_codec="rawvideo")
    pixels = []
    for strength in payload["strengths"]:
        settings = LutSettings(enabled=True, path=str(path), strength=strength)
        plan = EncodePlan(source="raw", output="out", source_info=info, lut=settings, lut_filter_path=snapshot_lut(settings, info))
        filters = build_plan_video_filters(plan)
        args = [ffmpeg, "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "16x8", "-i", "pipe:0"]
        if filters:
            args += ["-vf", ",".join(filters)]
        args += ["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
        result = subprocess.run(args, input=bytes(payload["sourceRgb"]) * 128, capture_output=True, check=True, timeout=30)
        pixels.append(list(result.stdout[:3]))
    print(json.dumps({"pixels": pixels}))
`], { input: JSON.stringify({ table, strengths: strengths.map((value) => value / 100), sourceRgb }), encoding: "utf8", timeout: 100_000 })) as { pixels?: number[][]; unavailable?: boolean };
  test.skip(exportPixels.unavailable === true, "FFmpeg is required for the export comparison");
  await expect(page.locator("#lut-error")).toBeHidden();
  expect(exportPixels.pixels).toHaveLength(strengths.length);
  preview.forEach((pixel, index) => pixel.forEach((value, channel) => {
    expect(Math.abs(value - exportPixels.pixels![index]![channel]!)).toBeLessThanOrEqual(1);
  }));
});
