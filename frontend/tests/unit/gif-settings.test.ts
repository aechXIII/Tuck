import assert from "node:assert/strict";
import test from "node:test";

import type { GifPreviewPayload } from "../../src/backend/gif-types.ts";
import {
  GIF_DEFAULTS,
  customValue,
  gifResultText,
  gifSettingsPayload,
  savedChoices,
  sizeParts,
} from "../../src/features/export/gif-settings.ts";

const MB = 1024 * 1024;

function preview(extra: Partial<GifPreviewPayload> = {}): GifPreviewPayload {
  return {
    url: "http://127.0.0.1:1/t/preview.gif", size_bytes: 2.5 * MB, width: 480, height: 270, fps: 15,
    frames: 36, seconds: 2.4, lowered: false, fits: true, estimated: false,
    start_width: 480, start_fps: 15, name: "Replay_tucked.gif", ...extra,
  };
}

test("a typed value outside what a GIF allows is pulled back and says why", () => {
  assert.deepEqual(customValue("fps", "60"), { value: 50, note: "A GIF plays at most 50 fps." });
  assert.deepEqual(customValue("width", "561"), { value: 562, note: "" });
  assert.deepEqual(customValue("speed", "0,1"), { value: 0.25, note: "At least 0.25×." });
  assert.deepEqual(customValue("colors", "300"), { value: 256, note: "A GIF has at most 256 colors." });
  assert.equal(customValue("limit", ""), null);
  assert.equal(customValue("limit", "big"), null);
});

test("the dialog opens with the settings last saved with, and the defaults for anything wrong", () => {
  assert.deepEqual(savedChoices(undefined), GIF_DEFAULTS);
  const saved = gifSettingsPayload({ ...GIF_DEFAULTS, width: 640, limit: 10, plays: 1, dither: "pattern" });
  assert.equal(saved.size_limit, 10 * MB);
  const back = savedChoices(saved);
  assert.equal(back.width, 640);
  assert.equal(back.limit, 10);
  assert.equal(back.plays, 1);
  assert.equal(back.dither, "pattern");
  const broken = savedChoices({ width: 4, fps: "fast", dither: "dots", plays: 500 });
  assert.equal(broken.width, GIF_DEFAULTS.width);
  assert.equal(broken.fps, GIF_DEFAULTS.fps);
  assert.equal(broken.dither, "soft");
  assert.equal(broken.plays, 0);
});

test("the size reads as the Export card's estimate does", () => {
  assert.deepEqual(sizeParts(2.5 * MB), ["2.5", "MB"]);
  assert.deepEqual(sizeParts(12.4 * MB), ["12", "MB"]);
  assert.deepEqual(sizeParts(480 * 1024), ["480", "KB"]);
});

test("the lines under the size give the timeline, the picture, and what a size limit changed", () => {
  assert.deepEqual(gifResultText(preview(), GIF_DEFAULTS), {
    from: "Timeline · 2.4 s",
    detail: "480 × 270 · 15 fps · 36 frames",
    warn: false,
  });
  // at 2× the timeline still says its own length and the GIF says how long it plays
  const fast = gifResultText(preview({ seconds: 1.2, frames: 18 }), { ...GIF_DEFAULTS, speed: 2 });
  assert.equal(fast.from, "Timeline · 2.4 s");
  assert.equal(fast.detail, "480 × 270 · 15 fps · 18 frames · plays 1.2 s");
  const lowered = gifResultText(
    preview({ lowered: true, fps: 10, width: 432, start_fps: 15, start_width: 480 }),
    { ...GIF_DEFAULTS, limit: 5 },
  );
  assert.deepEqual(lowered, { from: "Timeline · 2.4 s", detail: "Lowered to 10 fps and 432 wide to fit 5 MB", warn: false });
  const over = gifResultText(preview({ lowered: true, fits: false }), { ...GIF_DEFAULTS, limit: 0.5 });
  assert.deepEqual(over, { from: "Timeline · 2.4 s", detail: "Can’t fit 0.5 MB. Try fewer colors or a shorter timeline.", warn: true });
  assert.equal(gifResultText(preview({ seconds: 65 }), GIF_DEFAULTS).from, "Timeline · 1:05");
});
