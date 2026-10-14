import assert from "node:assert/strict";
import test from "node:test";

import { createSourceAudioPreview, type SourcePreviewPlayer } from "../../src/features/audio/source-audio-preview.ts";

function player() {
  const state = { time: 0, rate: 1, gain: 0, playing: false, disposed: false };
  const api: SourcePreviewPlayer = {
    sync(time, rate, gain, playing) { Object.assign(state, { time, rate, gain, playing }); },
    dispose() { state.disposed = true; state.playing = false; },
  };
  return { state, api };
}

const settle = () => new Promise<void>((done) => setImmediate(done));

test("source preview requests exact track indices and independently applies positive gain, mute and source time", async () => {
  const players = [player(), player()];
  const asked: number[] = [];
  const preview = createSourceAudioPreview({
    request: async (_path, track) => { asked.push(track); return { ok: true, value: { url: String(track), token: `token-${track}` } }; },
    release: async () => {},
    player: (url) => players[Number(url)]!.api,
    status() {},
  });
  preview.select("two.mkv", 2);
  preview.sync(3.25, 1.5, 0.5, true, [{ muted: true, gainDb: 0 }, { muted: false, gainDb: 6 }]);
  await settle();
  assert.deepEqual(asked, [0, 1]);
  assert.equal(players[0]!.state.gain, 0);
  assert.equal(players[1]!.state.gain, 0.5 * Math.pow(10, 6 / 20));
  assert.equal(players[1]!.state.time, 3.25);
  assert.equal(players[1]!.state.rate, 1.5);
  assert.equal(players[1]!.state.playing, true);
  preview.sync(4, 1, 1, false, [{ muted: false, gainDb: 0 }, { muted: false, gainDb: 0 }]);
  assert.equal(players[1]!.state.playing, false);
  await preview.clear();
  assert.equal(players[1]!.state.disposed, true);
});

test("stale source preview responses release tokens and cannot start removed audio", async () => {
  let resolve!: (value: { ok: true; value: { url: string; token: string } }) => void;
  const late = new Promise<{ ok: true; value: { url: string; token: string } }>((done) => { resolve = done; });
  const released: string[] = [];
  let created = false;
  const preview = createSourceAudioPreview({
    request: async () => late, release: async (token) => { released.push(token); },
    player: () => { created = true; return player().api; }, status() {},
  });
  preview.select("late.mkv", 1);
  await preview.clear();
  resolve({ ok: true, value: { url: "late", token: "late-token" } });
  await settle();
  assert.deepEqual(released, ["late-token"]);
  assert.equal(created, false);
});

test("failed source audio never falls back to the browser default track", async () => {
  const messages: Array<string | null> = [];
  const first = player();
  const preview = createSourceAudioPreview({
    request: async (_path, track) => track === 0
      ? { ok: true, value: { url: "first", token: "first" } }
      : { ok: false, error: { code: "MEDIA", message: "Missing second track", details: {} } },
    release: async () => {}, player: () => first.api,
    status: (message) => { messages.push(message); },
  });
  preview.select("two.mkv", 2);
  preview.sync(0, 1, 1, true, [{ muted: false, gainDb: 0 }, { muted: false, gainDb: 0 }]);
  await settle();
  assert.equal(first.state.playing, false);
  assert.match(messages.at(-1) ?? "", /Missing second track/);
});
