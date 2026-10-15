import assert from "node:assert/strict";
import test from "node:test";
import { createTauriBackendClient } from "../../src/backend/tauri.ts";

test("timeline sprite transport preserves grid, geometry and refinement", async () => {
  const calls: unknown[] = [];
  const value = { url: "http://127.0.0.1:9988/token/sprite.png", token: "token", start: 4, step: .25, count: 3, tile_width: 150, tile_height: 84, columns: 3 };
  const client = createTauriBackendClient(async (_command, args) => { calls.push(args); return value; });
  assert.deepEqual(await client.getTimelineFrames("video.mp4", 4, .25, 16, "center", true), { ok: true, value });
  assert.deepEqual(calls, [{ command: { command: "get_timeline_frames", payload: { path: "video.mp4", start: 4, step: .25, count: 16, mode: "center", exact: true } } }]);
  for (const invalid of [
    { ...value, start: NaN }, { ...value, step: 0 }, { ...value, count: 33 },
    { ...value, count: 1.5 }, { ...value, columns: 4 }, { ...value, tile_width: 0 },
    { ...value, tile_height: 83 }, { ...value, token: "" }, { ...value, url: "https://example.com/image.png" },
  ]) {
    assert.equal((await createTauriBackendClient(async () => invalid).getTimelineFrames("video.mp4", 4, .25, 16, "whole", false)).ok, false);
  }
  const failure = await createTauriBackendClient(async () => ({ ok: false, error: "Unreadable video" })).getTimelineFrames("video.mp4", 4, .25, 16, "whole", false);
  assert.equal(failure.ok, false);
});

test("bundled documents open through native allowlisted command and report failures", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command, args) => { calls.push({ command, args }); return null; });
  assert.deepEqual(await client.openLocalDocument("license"), { ok: true, value: {} });
  assert.deepEqual(calls, [{ command: "open_local_document", args: { document: "license" } }]);
  assert.equal((await createTauriBackendClient(async () => { throw new Error("Missing document"); }).openLocalDocument("third_party_notices")).ok, false);
});

test("invalid timeline ranges never reach the desktop transport", async () => {
  let calls = 0;
  const client = createTauriBackendClient(async () => { calls += 1; return {}; });
  for (const [start, step, count] of [[NaN, 1, 16], [-1, 1, 16], [0, Infinity, 16], [0, 0, 16], [0, 1, 1.5], [0, 1, 33]] as const) {
    assert.equal((await client.getTimelineFrames("clip.mp4", start, step, count, "center", false)).ok, false);
  }
  assert.equal(calls, 0);
});
