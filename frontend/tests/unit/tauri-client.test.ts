import assert from "node:assert/strict";
import test from "node:test";

import {
  createTauriBackendClient,
  hasTauriInvoke,
} from "../../src/backend/tauri.ts";

test("Tauri transport maps probe requests through the finite backend command", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return { data: { duration: 1, path: "C:\\clip.mp4" } };
  });

  assert.deepEqual(await client.probeFile("C:\\clip.mp4"), {
    ok: true,
    value: { data: { duration: 1, path: "C:\\clip.mp4" } },
  });
  assert.deepEqual(calls, [
    {
      command: "backend_request",
      args: {
        command: {
          command: "probe_file",
          payload: { path: "C:\\clip.mp4" },
        },
      },
    },
  ]);
});

test("Tauri transport keeps unavailable native operations explicit", async () => {
  const client = createTauriBackendClient(async () => ({ status: "ok" }));

  assert.deepEqual(await client.pickFiles(), {
    ok: false,
    error: {
      code: "BACKEND_METHOD_UNAVAILABLE",
      message: "Desktop backend method pickFiles is not available in the Tauri shell yet",
      details: { method: "pickFiles" },
    },
  });
});

test("Tauri transport publishes a fatal backend exit to the shell", async () => {
  const client = createTauriBackendClient(async () => {
    throw {
      code: "BACKEND_EXITED",
      message: "The Python backend closed its protocol output.",
      details: { stderr: "sidecar stopped" },
    };
  });
  const failures: string[] = [];
  const unsubscribe = client.onFatal((error) => failures.push(error.code));

  const result = await client.getQueueState();

  assert.equal(result.ok, false);
  assert.deepEqual(failures, ["BACKEND_EXITED"]);
  unsubscribe();
});

test("Tauri runtime detection requires the injected invoke function", () => {
  assert.equal(hasTauriInvoke(undefined), false);
  assert.equal(hasTauriInvoke({}), false);
  assert.equal(hasTauriInvoke({ __TAURI_INTERNALS__: {} }), false);
  assert.equal(
    hasTauriInvoke({ __TAURI_INTERNALS__: { invoke: () => undefined } }),
    true,
  );
});
