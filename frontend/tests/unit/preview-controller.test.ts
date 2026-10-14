import assert from "node:assert/strict";
import test from "node:test";

import { setBackendClient } from "../../src/backend/client.ts";
import type { BackendClient, BackendResult, UrlPayload } from "../../src/backend/types.ts";
import { createFakeBackendClient } from "../../src/backend/fake.ts";
import { createPreviewController } from "../../src/features/preview/preview-controller.ts";
import { createEditorClip, type EditorClip } from "../../src/features/editor/types.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settleAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("preview URLs bind to the selected source and ignore stale responses", async () => {
  const first = deferred<BackendResult<UrlPayload>>();
  const second = deferred<BackendResult<UrlPayload>>();
  const clips = new Map<string, EditorClip>([
    ["A.mp4", createEditorClip("A.mp4")],
    ["B.mp4", createEditorClip("B.mp4")],
  ]);
  let selected: string | null = "A.mp4";
  const urls: string[] = [];
  const thumbs: string[] = [];
  let mediaCalls = 0;
  const released: string[] = [];
  const client: BackendClient = {
    ...createFakeBackendClient({}).client,
    getMediaUrl: async (path: string) => {
      mediaCalls += 1;
      assert.ok(path === "A.mp4" || path === "B.mp4");
      return mediaCalls === 1 ? first.promise : second.promise;
    },
    releaseMediaToken: async (token: string) => {
      released.push(token);
      return { ok: true, value: {} };
    },
  };
  setBackendClient(client);

  const preview = createPreviewController({
    clip: (path) => clips.get(path),
    selectedPath: () => selected,
    media: {
      showLoading() {},
      showUrl: (url) => urls.push(url),
      showThumbnail: (source) => thumbs.push(source),
      showUnavailable() {},
      clear() {},
      seek() {},
    },
  });

  preview.select("A.mp4");
  selected = "B.mp4";
  preview.select("B.mp4");
  first.resolve({ ok: true, value: { url: "media://A", token: "token-a" } });
  second.resolve({ ok: true, value: { url: "media://B", token: "token-b" } });
  await settleAsyncWork();

  assert.deepEqual(urls, ["media://B"]);
  assert.equal(clips.get("B.mp4")?.mediaToken, "token-b");
  assert.equal(clips.get("A.mp4")?.mediaToken, null);
  assert.deepEqual(thumbs, []);
  assert.deepEqual(released, ["token-a"]);
});

test("a media response arriving after disposal gives its token back", async () => {
  const media = deferred<BackendResult<UrlPayload>>();
  const clip = createEditorClip("late.mp4");
  const released: string[] = [];
  const urls: string[] = [];
  setBackendClient({
    ...createFakeBackendClient({}).client,
    getMediaUrl: async () => media.promise,
    releaseMediaToken: async (token) => {
      released.push(token);
      return { ok: true, value: {} };
    },
  });
  const preview = createPreviewController({
    clip: () => clip,
    selectedPath: () => clip.path,
    media: {
      showLoading() {}, showThumbnail() {}, showUnavailable() {}, clear() {}, seek() {},
      showUrl: (url) => urls.push(url),
    },
  });
  preview.select(clip.path);
  await preview.dispose();
  media.resolve({ ok: true, value: { url: "media://late", token: "late-token" } });
  await settleAsyncWork();
  assert.deepEqual(urls, []);
  assert.deepEqual(released, ["late-token"]);
  assert.equal(clip.mediaToken, null);
});

test("retrying the same video releases the old token without releasing the replacement", async () => {
  const clip = createEditorClip("retry.mp4");
  const released: string[] = [];
  let count = 0;
  setBackendClient({
    ...createFakeBackendClient({}).client,
    getMediaUrl: async () => ({ ok: true, value: { url: `media://${++count}`, token: `token-${count}` } }),
    releaseMediaToken: async (token) => {
      released.push(token);
      return { ok: true, value: {} };
    },
  });
  const preview = createPreviewController({
    clip: () => clip,
    selectedPath: () => clip.path,
    media: {
      showLoading() {}, showUrl() {}, showThumbnail() {}, showUnavailable() {}, clear() {}, seek() {},
    },
  });
  preview.select(clip.path);
  await settleAsyncWork();
  preview.select(clip.path);
  await settleAsyncWork();
  assert.deepEqual(released, ["token-1"]);
  assert.equal(clip.mediaToken, "token-2");
  await preview.dispose();
  assert.deepEqual(released, ["token-1", "token-2"]);
});

test("a media result with no playable URL releases its unused token", async () => {
  const clip = createEditorClip("picture.mp4");
  const backend = createFakeBackendClient({
    getMediaUrl: { ok: true, value: { url: "", token: "unused-token" } },
    getThumbnail: { ok: true, value: { thumbnail: "picture://still" } },
  });
  setBackendClient(backend.client);
  const preview = createPreviewController({
    clip: () => clip,
    selectedPath: () => clip.path,
    media: {
      showLoading() {}, showUrl() {}, showThumbnail() {}, showUnavailable() {}, clear() {}, seek() {},
    },
  });
  preview.select(clip.path);
  await settleAsyncWork();
  assert.deepEqual(backend.calls.filter((call) => call.method === "releaseMediaToken").map((call) => call.args), [["unused-token"]]);
  assert.equal(clip.mediaToken, null);
});

test("disposing a preview releases its media token exactly once", async () => {
  const clip = createEditorClip("C:\\long names\\clip-日本語.mp4");
  let displayed = false;
  const backend = createFakeBackendClient({
    getMediaUrl: { ok: true, value: { url: "media://c", token: "token-c" } },
  });
  const client = backend.client;
  setBackendClient(client);
  assert.deepEqual(await client.getMediaUrl(clip.path), {
    ok: true,
    value: { url: "media://c", token: "token-c" },
  });
  let selected: string | null = clip.path;
  const preview = createPreviewController({
    clip: (path) => (path === clip.path ? clip : undefined),
    selectedPath: () => selected,
    media: {
      showLoading() {},
      showUrl() {
        displayed = true;
      },
      showThumbnail() {},
      showUnavailable() {},
      clear() {
        selected = null;
      },
      seek() {},
    },
  });

  preview.select(clip.path);
  await settleAsyncWork();
  assert.equal(displayed, true);
  await preview.dispose();
  await preview.dispose();

  assert.deepEqual(
    backend.calls
      .filter((call) => call.method === "releaseMediaToken")
      .map((call) => call.args),
    [["token-c"]],
  );
  assert.equal(clip.mediaToken, null);
});

test("selecting a video shows its own picture at once, before its preview arrives", async () => {
  const media = deferred<BackendResult<UrlPayload>>();
  const first = createEditorClip("A.mp4");
  const second = createEditorClip("B.mp4");
  second._thumbnail = "picture://B";
  const clips = new Map<string, EditorClip>([
    [first.path, first],
    [second.path, second],
  ]);
  let selected: string | null = first.path;
  const events: string[] = [];
  setBackendClient({
    ...createFakeBackendClient({}).client,
    getMediaUrl: async () => media.promise,
  });
  const preview = createPreviewController({
    clip: (path) => clips.get(path),
    selectedPath: () => selected,
    media: {
      showLoading: (picture) => events.push(`loading ${picture ?? "none"}`),
      showUrl: (url) => events.push(`url ${url}`),
      showThumbnail: (source) => events.push(`picture ${source}`),
      showUnavailable: (hasPicture) => events.push(`unavailable ${hasPicture}`),
      clear: () => events.push("clear"),
      seek() {},
    },
  });

  selected = second.path;
  preview.select(second.path);
  // the stage changes in the same moment, while the media link is still on its way
  assert.deepEqual(events, ["loading picture://B"]);

  media.resolve({ ok: true, value: { url: "media://B", token: "token-b" } });
  await settleAsyncWork();
  assert.deepEqual(events, ["loading picture://B", "url media://B"]);
});

test("a video with neither a preview nor a picture says its preview is unavailable", async () => {
  const clip = createEditorClip("broken.mp4");
  const events: string[] = [];
  setBackendClient({
    ...createFakeBackendClient({}).client,
    getMediaUrl: async () => ({ ok: false, error: { code: "MEDIA", message: "No preview", details: {} } }),
    getThumbnail: async () => ({ ok: false, error: { code: "MEDIA", message: "No picture", details: {} } }),
  });
  const preview = createPreviewController({
    clip: (path) => (path === clip.path ? clip : undefined),
    selectedPath: () => clip.path,
    media: {
      showLoading: (picture) => events.push(`loading ${picture ?? "none"}`),
      showUrl: (url) => events.push(`url ${url}`),
      showThumbnail: (source) => events.push(`picture ${source}`),
      showUnavailable: (hasPicture) => events.push(`unavailable ${hasPicture}`),
      clear: () => events.push("clear"),
      seek() {},
    },
  });

  preview.select(clip.path);
  await settleAsyncWork();
  await settleAsyncWork();
  assert.deepEqual(events, ["loading none", "unavailable false"]);
});
