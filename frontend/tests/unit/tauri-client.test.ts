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


test("LUT import uses a native picker and a validated sidecar response", async () => {
  const calls: unknown[] = [];
  const payload = {path:"managed.cube", name:"Warm.cube", size:2, table_url:"http://127.0.0.1:4321/token/table", token:"token"};
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({command,args});
    return command === "pick_lut_file" ? "Warm.cube" : payload;
  });
  assert.deepEqual(await client.pickLutFile(), {ok:true,value:{path:"Warm.cube"}});
  assert.deepEqual(await client.loadLut("Warm.cube"), {ok:true,value:payload});
  assert.deepEqual(calls[1], {command:"backend_request",args:{command:{command:"load_lut",payload:{path:"Warm.cube"}}}});
  for (const invalid of [{...payload,size:1000}, {...payload,table_url:"https://outside.test/table"}, {...payload,size:2.5}]) {
    const bad = createTauriBackendClient(async () => invalid);
    assert.equal((await bad.loadLut("test.cube")).ok, false);
  }
  const failure = createTauriBackendClient(async () => ({ok:false,error:"Unsupported LUT format. Export a .cube file."}));
  const result = await failure.loadLut("bad.lut");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /cube/);
});


test("saved LUTs are typed and planning error fields survive the native boundary", async () => {
  const library = {luts:[{path:"managed.cube",name:"Warm"}]};
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command,args) => { calls.push({command,args}); return library; });
  assert.deepEqual(await client.listLuts(), {ok:true,value:library});
  assert.deepEqual(calls[0], {command:"backend_request",args:{command:{command:"list_luts"}}});
  const malformed = createTauriBackendClient(async () => ({luts:[{path:123,name:"bad"}]}));
  assert.equal((await malformed.listLuts()).ok,false);
  const rejected = createTauriBackendClient(async () => { throw {code:"VALIDATION_ERROR",message:"Choose a lower output frame rate.",details:{field:"frame_blending"}}; });
  const result = await rejected.createPlan({source:"s"});
  assert.equal(result.ok,false);
  if (!result.ok) assert.equal(result.error.details.field,"frame_blending");
});

test("clear LUT history validates success and preserves backend failures", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command,args) => { calls.push({command,args}); return {cleared:true}; });
  assert.deepEqual(await client.clearLutHistory(), {ok:true,value:{cleared:true}});
  assert.deepEqual(calls, [{command:"backend_request",args:{command:{command:"clear_lut_history"}}}]);
  for (const payload of [{}, {cleared:false}, {cleared:"true"}]) {
    assert.equal((await createTauriBackendClient(async () => payload).clearLutHistory()).ok, false);
  }
  const failed = await createTauriBackendClient(async () => ({ok:false,error:"Could not save LUT history."})).clearLutHistory();
  assert.equal(failed.ok,false);
  if (!failed.ok) assert.match(failed.error.message, /save LUT history/);
});

test("generic Send To shortcuts are managed one kind at a time", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return { kind: "upscale", path: "C:\\SendTo\\Tuck Upscale.lnk" };
  });

  assert.equal((await client.installGenericSendto("upscale")).ok, true);
  assert.equal((await client.repairGenericSendto("cut")).ok, true);
  assert.equal((await client.removeGenericSendto("open")).ok, true);

  assert.deepEqual(calls, [
    {
      command: "backend_request",
      args: { command: { command: "install_generic_sendto", payload: { kind: "upscale" } } },
    },
    {
      command: "backend_request",
      args: { command: { command: "repair_generic_sendto", payload: { kind: "cut" } } },
    },
    {
      command: "backend_request",
      args: { command: { command: "remove_generic_sendto", payload: { kind: "open" } } },
    },
  ]);
});

test("generic Send To failures keep the backend message", async () => {
  const client = createTauriBackendClient(async () => {
    throw {
      code: "UNSUPPORTED_OPERATION",
      message: "Send To integration is not supported on Linux.",
      details: {},
    };
  });

  const result = await client.installGenericSendto("open");

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "UNSUPPORTED_OPERATION");
});

test("Send To listing is typed and carries the generic kind", async () => {
  const shortcuts = [
    { name: "Tuck", type: "generic", kind: "open", status: "ok", path: "C:\\SendTo\\Tuck.lnk" },
    {
      name: "Tuck Lossless Cut",
      type: "generic",
      kind: "cut",
      status: "broken",
      path: "C:\\SendTo\\Tuck Lossless Cut.lnk",
    },
    {
      name: "small",
      profile_id: "small",
      type: "profile",
      status: "ok",
      path: "C:\\SendTo\\Tuck - small.lnk",
    },
  ];
  const client = createTauriBackendClient(async () => ({ shortcuts }));

  assert.deepEqual(await client.listSendtoShortcuts(), { ok: true, value: { shortcuts } });

  for (const entry of [
    { name: "Tuck", type: "generic", kind: "trim", status: "ok", path: "x" },
    { name: "Tuck", type: "generic", status: "ok" },
  ]) {
    const malformed = createTauriBackendClient(async () => ({ shortcuts: [entry] }));
    assert.equal((await malformed.listSendtoShortcuts()).ok, false);
  }
});
