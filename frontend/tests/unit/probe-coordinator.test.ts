import assert from "node:assert/strict";
import test from "node:test";

import { setBackendClient } from "../../src/backend/client.ts";
import type { BackendClient, BackendResult, DataPayload } from "../../src/backend/types.ts";
import { createFakeBackendClient } from "../../src/backend/fake.ts";
import {
  createProbeCoordinator,
  currentProbeGeneration,
} from "../../src/features/library/probe-coordinator.ts";
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

test("a successful probe stores duration metadata and leaves the clip retryable after failure", async () => {
  const clips = new Map<string, EditorClip>();
  const path = "C:\\media\\Morning.mp4";
  clips.set(path, createEditorClip(path));
  const started: string[] = [];
  const finished: Array<{ path: string; ok: boolean }> = [];
  setBackendClient(
    createFakeBackendClient({
      probeFile: {
        ok: true,
        value: { data: { duration: 12.5, width: 1920, height: 1080, file_size: 4096 } },
      },
    }).client,
  );
  const coordinator = createProbeCoordinator({
    clip: (value) => clips.get(value),
    onProbeStarted: (value) => started.push(value),
    onProbeFinished: (value, _clip, ok) => finished.push({ path: value, ok }),
  });

  await coordinator.probe(path);
  const ready = clips.get(path);
  assert.equal(ready?.probed, true);
  assert.equal(ready?.probing, false);
  assert.equal(ready?.probeData?.duration, 12.5);
  assert.equal(ready?._fileSize, 4096);
  assert.deepEqual(started, [path]);
  assert.deepEqual(finished, [{ path, ok: true }]);

  setBackendClient(
    createFakeBackendClient({
      probeFile: {
        ok: false,
        error: { code: "PROBE_FAILED", message: "Malformed media", details: {} },
      },
    }).client,
  );
  await coordinator.retry(path);
  assert.equal(clips.get(path)?.probed, false);
  assert.equal(clips.get(path)?.error, "Malformed media");
  assert.equal(finished.at(-1)?.ok, false);
});

test("a stale probe result does not replace a newer generation or a removed clip", async () => {
  const first = deferred<BackendResult<DataPayload>>();
  const second = deferred<BackendResult<DataPayload>>();
  const third = deferred<BackendResult<DataPayload>>();
  const path = "C:\\media\\stale.mp4";
  const clips = new Map<string, EditorClip>([[path, createEditorClip(path)]]);
  const finished: boolean[] = [];
  const pending = [first.promise, second.promise, third.promise];
  const client: BackendClient = {
    ...createFakeBackendClient({}).client,
    probeFile: async () => pending.shift() ?? first.promise,
  };
  setBackendClient(client);
  const coordinator = createProbeCoordinator({
    clip: (value) => clips.get(value),
    onProbeStarted() {},
    onProbeFinished(_path, _clip, ok) {
      finished.push(ok);
    },
  });

  const firstProbe = coordinator.probe(path);
  const firstGeneration = currentProbeGeneration(path);
  const secondProbe = coordinator.retry(path);
  second.resolve({
    ok: true,
    value: { data: { duration: 8, width: 1280, height: 720 } },
  });
  await secondProbe;
  first.resolve({
    ok: true,
    value: { data: { duration: 99, width: 10, height: 10 } },
  });
  await firstProbe;

  assert.equal(firstGeneration + 1, currentProbeGeneration(path));
  assert.equal(clips.get(path)?.probeData?.duration, 8);
  assert.deepEqual(finished, [true]);

  const removed = coordinator.probe(path);
  clips.delete(path);
  third.resolve({
    ok: true,
    value: { data: { duration: 1 } },
  });
  await removed;
  assert.equal(clips.has(path), false);
});
