import assert from "node:assert/strict";
import test from "node:test";

import { createFakeBackendClient } from "../../src/backend/fake.ts";
import { createPywebviewClient } from "../../src/backend/pywebview.ts";

test("successful bridge envelopes are normalized without losing payload fields", async () => {
  const client = createPywebviewClient({
    probeFile: async (path: string) => ({
      ok: true,
      data: { duration: 12.5, path },
      request_id: 7,
    }),
  });

  assert.deepEqual(await client.probeFile("video.mp4"), {
    ok: true,
    value: {
      data: { duration: 12.5, path: "video.mp4" },
      request_id: 7,
    },
  });
});

test("backend validation errors keep their code, message, and details", async () => {
  const client = createPywebviewClient({
    probeFile: async () => ({
      ok: false,
      code: "VALIDATION_ERROR",
      error: "The selected file does not exist",
      details: { field: "path" },
    }),
  });

  assert.deepEqual(await client.probeFile("missing.mp4"), {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "The selected file does not exist",
      details: { field: "path" },
    },
  });
});

test("a rejected raw bridge call becomes a typed backend error", async () => {
  const client = createPywebviewClient({
    probeFile: async () => {
      throw new Error("boom");
    },
  });

  assert.deepEqual(await client.probeFile("video.mp4"), {
    ok: false,
    error: { code: "BRIDGE_CALL_FAILED", message: "boom", details: {} },
  });
});

test("an unavailable bridge method returns a typed error", async () => {
  const client = createPywebviewClient({});

  assert.deepEqual(await client.pickFiles(), {
    ok: false,
    error: {
      code: "BRIDGE_METHOD_UNAVAILABLE",
      message: "Desktop backend method pickFiles is unavailable",
      details: { method: "pickFiles" },
    },
  });
});

test("a method that becomes available later is resolved at call time", async () => {
  const raw = {};
  const client = createPywebviewClient(raw);

  assert.equal((await client.pickFiles()).ok, false);
  Object.defineProperty(raw, "pickFiles", {
    value: async () => ({ ok: true, files: ["late.mp4"] }),
  });
  assert.deepEqual(await client.pickFiles(), {
    ok: true,
    value: { files: ["late.mp4"] },
  });
});

test("legacy JSON strings are rejected even when they contain valid JSON", async () => {
  const client = createPywebviewClient({
    getSettings: async () => '{"check_updates":false}',
  });

  assert.deepEqual(await client.getSettings(), {
    ok: false,
    error: {
      code: "MALFORMED_BRIDGE_RESULT",
      message: "Desktop backend method getSettings returned an invalid result",
      details: { method: "getSettings" },
    },
  });
});

test("known payload fields are checked at runtime", async () => {
  const client = createPywebviewClient({
    getQueueState: async () => ({ items: "not-an-array" }),
  });

  assert.deepEqual(await client.getQueueState(), {
    ok: false,
    error: {
      code: "MALFORMED_BRIDGE_RESULT",
      message: "Desktop backend method getQueueState returned an invalid result",
      details: { method: "getQueueState" },
    },
  });
});

test("raw call arguments retain their order and values", async () => {
  const calls: unknown[][] = [];
  const client = createPywebviewClient({
    installProfileSendto: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true };
    },
  });

  assert.deepEqual(await client.installProfileSendto("mobile", "start"), {
    ok: true,
    value: {},
  });
  assert.deepEqual(calls, [["mobile", "start"]]);
});

test("a bridge call timeout becomes a deterministic typed error", async () => {
  const client = createPywebviewClient(
    { pickFiles: () => new Promise(() => {}) },
    { timeoutMs: 5 },
  );

  assert.deepEqual(await client.pickFiles(), {
    ok: false,
    error: {
      code: "BRIDGE_CALL_TIMEOUT",
      message: "Desktop backend method pickFiles timed out",
      details: { method: "pickFiles", timeout_ms: 5 },
    },
  });
});

test("the fake backend is explicit, deterministic, and records calls", async () => {
  const fake = createFakeBackendClient({
    pickFiles: { ok: true, value: { files: ["one.mp4"] } },
  });

  assert.deepEqual(await fake.client.pickFiles(), {
    ok: true,
    value: { files: ["one.mp4"] },
  });
  assert.deepEqual(fake.calls, [{ method: "pickFiles", args: [] }]);
});
