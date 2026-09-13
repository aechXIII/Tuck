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
  const client = createTauriBackendClient(async (command) => {
    if (command === "pick_video_files") return [];
    return { status: "ok" };
  });

  // pickFiles is now a native Tauri command and should succeed via invoke
  assert.deepEqual(await client.pickFiles(), {
    ok: true,
    value: { files: [] },
  });
  // the IPC file-forwarding methods are not part of the Tauri shell
  assert.deepEqual(await client.getIpcFiles(), {
    ok: false,
    error: {
      code: "BACKEND_METHOD_UNAVAILABLE",
      message: "Desktop backend method getIpcFiles is not available in the Tauri shell yet",
      details: { method: "getIpcFiles" },
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

test("Tauri transport routes probeAudioFile through backend_request", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return { data: { duration: 5 } };
  });

  assert.deepEqual(await client.probeAudioFile("audio.mp3"), {
    ok: true,
    value: { data: { duration: 5 } },
  });
  assert.deepEqual(calls, [
    {
      command: "backend_request",
      args: {
        command: {
          command: "probe_audio_file",
          payload: { path: "audio.mp3" },
        },
      },
    },
  ]);
});

test("show export passes the full path to the native opener and preserves errors", async () => {
  const path = "C:\\Exports\\holiday, final.mp4";
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const failure = { code: "INVALID_PATH", message: "The export could not be found.", details: {} };
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    if (calls.length > 1) throw failure;
  });
  assert.equal((await client.openOutputFolder(path)).ok, true);
  assert.deepEqual(calls, [{ command: "open_output_folder", args: { path } }]);
  assert.deepEqual(await client.openOutputFolder(path), { ok: false, error: failure });
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
