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
      showUrl: (url) => urls.push(url),
      showThumbnail: (source) => thumbs.push(source),
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
      showUrl() {
        displayed = true;
      },
      showThumbnail() {},
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
