import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import ts from "typescript";

const moduleSource = ts.transpileModule(
  readFileSync("frontend/src/features/preview/lut-preview.ts", "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;

test("LUT preview transforms real video pixels and restores the source", async ({ page }) => {
  await page.setContent('<div style="position:relative;width:160px;height:80px"><video muted style="position:absolute;width:160px;height:80px;object-fit:fill;transform-origin:0 0"></video></div>');
  const result = await page.evaluate(async source => {
    const { createLutPreview } = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    const video = document.querySelector("video")!;
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 16;
    sourceCanvas.height = 8;
    const paint = sourceCanvas.getContext("2d")!;
    paint.fillStyle = "rgb(128,64,192)";
    paint.fillRect(0, 0, 16, 4);
    paint.fillStyle = "rgb(32,192,64)";
    paint.fillRect(0, 4, 16, 4);
    const stream = sourceCanvas.captureStream(0);
    video.srcObject = stream;
    await video.play();
    video.pause();
    const errors: string[] = [];
    const preview = createLutPreview(video, (message: string) => errors.push(message));
    const canvas = document.querySelector<HTMLCanvasElement>("[data-lut-preview]")!;
    const table = new Float32Array(24);
    for (let blue = 0; blue < 2; blue++) for (let green = 0; green < 2; green++) for (let red = 0; red < 2; red++) {
      table.set([blue, green, red], ((blue * 2 + green) * 2 + red) * 3);
    }
    function pixel(top: boolean): number[] {
      const gl = canvas.getContext("webgl2")!;
      const value = new Uint8Array(4);
      gl.readPixels(2, top ? canvas.height - 2 : 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
      return Array.from(value).slice(0, 3);
    }
    preview.set(table, 2, 1);
    const full = pixel(true);
    const bottom = pixel(false);
    const visible = getComputedStyle(canvas).display !== "none";
    preview.set(table, 2, 0.5);
    const half = pixel(true);
    await video.play();
    const playingFrame = new Promise<number[]>(resolve => {
      video.requestVideoFrameCallback(() => resolve(pixel(true)));
    });
    paint.fillStyle = "rgb(64,128,192)";
    paint.fillRect(0, 0, 16, 8);
    const captureTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    captureTrack.requestFrame();
    const live = await playingFrame;
    video.pause();
    video.style.transform = "matrix(0,1,-1,0,80,0)";
    video.style.width = "80px";
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const geometry = [canvas.style.transform, canvas.style.width];
    video.dispatchEvent(new Event("loadstart"));
    const hiddenOnLoad = getComputedStyle(canvas).display === "none";
    video.dispatchEvent(new Event("loadeddata"));
    const restoredOnLoad = getComputedStyle(canvas).display !== "none";
    preview.clear();
    const cleared = getComputedStyle(canvas).display === "none" && getComputedStyle(video).display !== "none";
    preview.set(table, 2, 0);
    const zero = getComputedStyle(canvas).display === "none";
    preview.dispose();
    const disposed = !canvas.isConnected;
    for (const track of stream.getTracks()) track.stop();
    return { full, bottom, half, live, visible, geometry, hiddenOnLoad, restoredOnLoad, cleared, zero, disposed, errors };
  }, moduleSource);
  expect(result.errors).toEqual([]);
  for (const [actual, expected] of [[result.full, [192, 64, 128]], [result.bottom, [64, 192, 32]], [result.half, [160, 64, 160]], [result.live, [128, 128, 128]]] as const) {
    actual.forEach((value, index) => expect(Math.abs(value - expected[index]!)).toBeLessThanOrEqual(4));
  }
  expect(result.visible).toBe(true);
  expect(result.geometry).toEqual(["matrix(0, 1, -1, 0, 80, 0)", "80px"]);
  expect(result.hiddenOnLoad).toBe(true);
  expect(result.restoredOnLoad).toBe(true);
  expect(result.cleared).toBe(true);
  expect(result.zero).toBe(true);
  expect(result.disposed).toBe(true);
});

test("LUT preview restores raw video after graphics context loss", async ({ page }) => {
  await page.setContent("<video></video>");
  const result = await page.evaluate(async source => {
    const { createLutPreview } = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    const errors: string[] = [];
    const video = document.querySelector("video")!;
    const input = document.createElement("canvas");
    input.width = input.height = 8;
    input.getContext("2d")!.fillRect(0, 0, 8, 8);
    const stream = input.captureStream(0);
    video.srcObject = stream;
    await video.play();
    video.pause();
    const preview = createLutPreview(video, (message: string) => errors.push(message));
    preview.set(new Float32Array(24), 2, 1);
    const canvas = document.querySelector("canvas")!;
    const lost = new Promise<void>(resolve => canvas.addEventListener("webglcontextlost", () => resolve(), { once: true }));
    const extension = canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    extension.loseContext();
    await lost;
    const hidden = getComputedStyle(canvas).display === "none";
    const sourceVisible = getComputedStyle(video).display !== "none";
    const restored = new Promise<void>(resolve => canvas.addEventListener("webglcontextrestored", () => resolve(), { once: true }));
    // restoration must happen after the context-lost event has finished dispatching
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    extension.restoreContext();
    await restored;
    preview.clear();
    preview.set(new Float32Array(24).fill(1), 2, 1);
    const recovered = getComputedStyle(canvas).display !== "none";
    const gl = canvas.getContext("webgl2")!;
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    preview.dispose();
    for (const track of stream.getTracks()) track.stop();
    return { errors, hidden, sourceVisible, recovered, pixel: Array.from(pixel) };
  }, moduleSource);
  expect(result.errors).toEqual(["LUT preview stopped because graphics resources were lost. Turn the LUT off and on to retry."]);
  expect(result.hidden).toBe(true);
  expect(result.sourceVisible).toBe(true);
  expect(result.recovered).toBe(true);
  expect(result.pixel).toEqual([255, 255, 255, 255]);
});

test("LUT preview matches the real FFmpeg export filter at every strength", async ({ page }) => {
  const python = resolve(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  test.skip(!existsSync(python), "The project Python environment is required for the FFmpeg comparison");
  const table: number[] = [];
  for (let blue = 0; blue < 2; blue++) for (let green = 0; green < 2; green++) for (let red = 0; red < 2; red++) table.push(blue, green, red);
  const strengths = [0, 0.35, 1];
  await page.setContent('<video muted style="width:16px;height:8px"></video>');
  const browser = await page.evaluate(async ({ source, table, strengths }) => {
    const { createLutPreview } = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    const input = document.createElement("canvas");
    input.width = 16;
    input.height = 8;
    const context = input.getContext("2d")!;
    context.fillStyle = "rgb(128,64,192)";
    context.fillRect(0, 0, 16, 8);
    const stream = input.captureStream(0);
    const video = document.querySelector("video")!;
    video.srcObject = stream;
    await video.play();
    video.pause();
    context.drawImage(video, 0, 0);
    const sourceRgb = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    const errors: string[] = [];
    const preview = createLutPreview(video, (message: string) => errors.push(message));
    const canvas = document.querySelector("[data-lut-preview]") as HTMLCanvasElement;
    const pixels = strengths.map(strength => {
      preview.set(new Float32Array(table), 2, strength);
      if (strength === 0) return sourceRgb;
      const gl = canvas.getContext("webgl2")!;
      const output = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, output);
      return Array.from(output).slice(0, 3);
    });
    preview.dispose();
    for (const track of stream.getTracks()) track.stop();
    return { sourceRgb, pixels, errors };
  }, { source: moduleSource, table, strengths });
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
`], { input: JSON.stringify({ table, strengths, sourceRgb: browser.sourceRgb }), encoding: "utf8", timeout: 100_000 })) as { pixels?: number[][]; unavailable?: boolean };
  test.skip(exportPixels.unavailable === true, "FFmpeg is required for the export comparison");
  expect(browser.errors).toEqual([]);
  expect(exportPixels.pixels).toHaveLength(strengths.length);
  browser.pixels.forEach((pixel, index) => pixel.forEach((value, channel) => {
    expect(Math.abs(value - exportPixels.pixels![index]![channel]!)).toBeLessThanOrEqual(1);
  }));
});

test("LUT preview reports invalid tables without covering the video", async ({ page }) => {
  await page.setContent("<video></video>");
  const result = await page.evaluate(async source => {
    const { createLutPreview } = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    const errors: string[] = [];
    const preview = createLutPreview(document.querySelector("video")!, (message: string) => errors.push(message));
    preview.set(new Float32Array(3), 2, 1);
    const hidden = getComputedStyle(document.querySelector("canvas")!).display === "none";
    preview.dispose();
    return { errors, hidden };
  }, moduleSource);
  expect(result.errors).toEqual(["LUT preview data is invalid. Import the LUT again."]);
  expect(result.hidden).toBe(true);
});
