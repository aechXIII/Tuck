import assert from "node:assert/strict";
import test from "node:test";

import { UPDATE_BACKEND_STOPPED } from "../../src/backend/errors.ts";
import {
  createTauriBackendClient,
  hasTauriInvoke,
} from "../../src/backend/tauri.ts";

test("placed source ranges reach native planning and keep validation errors", async () => {
  const request = { source: "clip.mp4", segments: [{ start: 10, end: 60, timeline_start: 0 }] };
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (_command, args) => {
    calls.push(args);
    return { data: { effective_duration: 50 } };
  });
  assert.deepEqual(await client.createPlan(request), { ok: true, value: { data: { effective_duration: 50 } } });
  assert.deepEqual(calls, [{ command: { command: "create_plan", payload: { request } } }]);
  const error = { code: "BACKEND_REJECTED", message: "Video segments overlap on the timeline.", details: { field: "segments" } };
  const rejected = createTauriBackendClient(async () => { throw error; });
  assert.deepEqual(await rejected.createPlan(request), { ok: false, error });
});

test("file copy invokes the native file command and preserves native errors", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
  });
  const path = "C:\\videos\\録画 #1.mp4";
  assert.deepEqual(await client.copyFile(path), { ok: true, value: {} });
  assert.deepEqual(calls, [{ command: "copy_file_to_clipboard", args: { path } }]);
  const error = { code: "CLIPBOARD_UNAVAILABLE", message: "Clipboard is busy.", details: {} };
  const failed = createTauriBackendClient(async () => { throw error; });
  assert.deepEqual(await failed.copyFile(path), { ok: false, error });
  assert.equal((await createTauriBackendClient(async () => { throw new Error("Offline"); }).copyFile(path)).ok, false);
});

test("frame export sends its snapshot and validates the complete result", async () => {
  const calls: unknown[] = [];
  const value = { path: "out.png", width: 1920, height: 1080, time: 3.25, warnings: [] };
  const client = createTauriBackendClient(async (_command, args) => {
    calls.push(args);
    return value;
  });
  const request = { source: "input.mp4", output: "out.png", time: 3.25 };
  assert.deepEqual(await client.exportFrame(request), { ok: true, value });
  assert.deepEqual(calls, [{ command: { command: "export_frame", payload: { request } } }]);
  for (const invalid of [
    { ...value, width: 0 },
    { ...value, time: NaN },
    { ...value, warnings: [1] },
    { ...value, path: 4 },
    { ...value, height: 1.5 },
  ]) {
    assert.equal((await createTauriBackendClient(async () => invalid).exportFrame(request)).ok, false);
  }
  const rejected = await createTauriBackendClient(async () => ({
    ok: false,
    error: "Could not decode",
  })).exportFrame(request);
  assert.equal(rejected.ok, false);
});
test("PNG save pickers carry their format while existing JSON calls remain unchanged", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return null;
  });
  assert.deepEqual(await client.pickSaveFile("frame.png", "png"), { ok: true, value: { path: "" } });
  await client.pickSaveFile("settings.json");
  assert.deepEqual(calls, [
    { command: "pick_save_file", args: { defaultName: "frame.png", format: "png" } },
    { command: "pick_save_file", args: { defaultName: "settings.json" } },
  ]);
});

test("media URL requests preserve explicit source track zero and later tracks", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = createTauriBackendClient(async (_command, args) => {
    calls.push(args);
    return { url: "http://127.0.0.1/audio", token: "audio" };
  });
  for (const track of [undefined, 0, 1]) assert.equal((await client.getMediaUrl("clip.mkv", track)).ok, true);
  assert.deepEqual(calls.map((args) => args.command), [
    { command: "get_media_url", payload: { path: "clip.mkv" } },
    { command: "get_media_url", payload: { path: "clip.mkv", track: 0 } },
    { command: "get_media_url", payload: { path: "clip.mkv", track: 1 } },
  ]);
  const failed = createTauriBackendClient(async () => { throw { code: "BACKEND_REJECTED", message: "Could not preview audio track 2", details: {} }; });
  const result = await failed.getMediaUrl("clip.mkv", 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.message, "Could not preview audio track 2");
});

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

test("a finished export is removed from the list by its id", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return { ok: true };
  });
  assert.equal((await client.removeItem("item-9")).ok, true);
  assert.deepEqual(calls, [
    { command: "backend_request", args: { command: { command: "remove_item", payload: { item_id: "item-9" } } } },
  ]);
  const refused = await createTauriBackendClient(async () => ({
    ok: false,
    error: "This export can't be removed while it runs. Cancel it first.",
  })).removeItem("item-1");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error.message, /Cancel it first/);
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

test("settings backups go through the finite backend command with only a path", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return { skipped: ["output_dir"] };
  });

  assert.deepEqual(await client.exportSettingsToFile("C:\backup.json"), { ok: true, value: { skipped: ["output_dir"] } });
  assert.deepEqual(await client.importSettingsFromFile("C:\backup.json"), { ok: true, value: { skipped: ["output_dir"] } });
  assert.deepEqual(await client.resetSettings(), { ok: true, value: { skipped: ["output_dir"] } });
  assert.deepEqual(calls.map((call) => call.args.command), [
    { command: "export_settings_to_file", payload: { path: "C:\backup.json" } },
    { command: "import_settings_from_file", payload: { path: "C:\backup.json" } },
    { command: "reset_settings" },
  ]);
});

test("a settings import keeps the backend's message and rejects a malformed reply", async () => {
  const failing = createTauriBackendClient(async () => {
    throw { code: "BACKEND_REJECTED", message: "This file isn't a Tuck settings backup.", details: {} };
  });
  const failed = await failing.importSettingsFromFile("C:\notes.json");
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.error.message, "This file isn't a Tuck settings backup.");

  const malformed = createTauriBackendClient(async () => ({ skipped: "output_dir" }));
  assert.equal((await malformed.importSettingsFromFile("C:\backup.json")).ok, false);
});

test("interface size and notifications are native commands", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const client = createTauriBackendClient(async (command, args) => {
    calls.push({ command, args });
    return command === "notify_when_unfocused" ? true : null;
  });

  assert.deepEqual(await client.setInterfaceSize("large"), { ok: true, value: {} });
  assert.deepEqual(await client.notifyWhenUnfocused("Exports finished", "2 videos saved."), { ok: true, value: { shown: true } });
  assert.deepEqual(await client.setTaskbarProgress("normal", 42, false), { ok: true, value: {} });
  assert.deepEqual(await client.setTaskbarProgress("error", null, true), { ok: true, value: {} });
  assert.deepEqual(calls, [
    { command: "set_interface_size", args: { size: "large" } },
    { command: "notify_when_unfocused", args: { title: "Exports finished", body: "2 videos saved." } },
    { command: "set_taskbar_progress", args: { state: "normal", progress: 42, flash: false } },
    { command: "set_taskbar_progress", args: { state: "error", progress: null, flash: true } },
  ]);

  const failing = createTauriBackendClient(async () => {
    throw { code: "INVALID_REQUEST", message: "The notification text is empty.", details: {} };
  });
  const result = await failing.notifyWhenUnfocused("", "");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, "INVALID_REQUEST");
});

test("update checks and download progress are validated at the native boundary", async () => {
  const replies: Record<string, unknown> = {
    check_for_updates: { available: true, version: "0.6.0", notes: "Faster startup" },
    get_download_progress: { downloading: false, progress: 100, done: true },
  };
  const client = createTauriBackendClient(async (command) => replies[command]);
  assert.deepEqual(await client.checkForUpdates(), {
    ok: true,
    value: { available: true, version: "0.6.0", notes: "Faster startup" },
  });
  assert.deepEqual(await client.getDownloadProgress(), {
    ok: true,
    value: { downloading: false, progress: 100, done: true },
  });

  replies.check_for_updates = { available: "yes" };
  replies.get_download_progress = { progress: 50 };
  const check = await client.checkForUpdates();
  const progress = await client.getDownloadProgress();
  assert.equal(check.ok ? "ok" : check.error.code, "MALFORMED_BRIDGE_RESULT");
  assert.equal(progress.ok ? "ok" : progress.error.code, "MALFORMED_BRIDGE_RESULT");
});

test("an install that failed after the backend stopped keeps its code for the page", async () => {
  const client = createTauriBackendClient(async () => {
    throw {
      code: "UPDATE_BACKEND_STOPPED",
      message: "the installer did not start after Tuck stopped its work: access denied",
      details: {},
    };
  });
  const fatal: string[] = [];
  client.onFatal((error) => fatal.push(error.code));
  const result = await client.installUpdate();
  assert.equal(result.ok ? "ok" : result.error.code, UPDATE_BACKEND_STOPPED);
  // the page shows its own restart screen, not the crash screen
  assert.deepEqual(fatal, []);
});

test("a refused retry keeps the code and message the backend gave it", async () => {
  for (const code of ["SOURCE_CHANGED", "SOURCE_UNAVAILABLE"]) {
    const client = createTauriBackendClient(async () => {
      throw { code, message: "Add it again.", details: { method: "retry_item" } };
    });
    const result = await client.retryItem("item-1");
    assert.deepEqual(result, {
      ok: false,
      error: { code, message: "Add it again.", details: { method: "retry_item" } },
    });
  }
});

test("profile Send To shortcuts never send an executable path", async () => {
  const payloads: unknown[] = [];
  const client = createTauriBackendClient(async (_command, args) => {
    payloads.push((args.command as { payload?: unknown }).payload);
    return {};
  });
  await client.installProfileSendto("profile-1", "review");
  await client.repairProfileSendto("profile-1");
  assert.deepEqual(payloads, [
    { profile_id: "profile-1", action: "review" },
    { profile_id: "profile-1" },
  ]);
});

test("plan warnings are optional and must be plain sentences when present", async () => {
  const plan = (data: Record<string, unknown>) => createTauriBackendClient(async () => ({ data }));
  assert.equal((await plan({ estimated_size_mb: 9 }).createPlan({ source: "s" })).ok, true);
  const warned = await plan({ warnings: ["Extra audio tracks are left out."] }).createPlan({ source: "s" });
  assert.deepEqual(warned, { ok: true, value: { data: { warnings: ["Extra audio tracks are left out."] } } });
  assert.equal((await plan({ warnings: "HDR" }).createPlan({ source: "s" })).ok, false);
  assert.equal((await plan({ warnings: [1] }).createPlan({ source: "s" })).ok, false);
});

test("waveform requests name the audio track only after the first", async () => {
  const payloads: unknown[] = [];
  const client = createTauriBackendClient(async (_command, args) => {
    payloads.push((args.command as { payload: unknown }).payload);
    return { url: "http://127.0.0.1/w", token: "t" };
  });

  assert.deepEqual(await client.getWaveform("C:\clip.mkv"), {
    ok: true,
    value: { url: "http://127.0.0.1/w", token: "t" },
  });
  await client.getWaveform("C:\clip.mkv", 0);
  await client.getWaveform("C:\clip.mkv", 2);
  assert.deepEqual(payloads, [
    { path: "C:\clip.mkv" },
    { path: "C:\clip.mkv" },
    { path: "C:\clip.mkv", track: 2 },
  ]);
});

test("a waveform the backend can't make keeps its error", async () => {
  const client = createTauriBackendClient(async () => ({ ok: false, error: "This video has no audio track 3" }));
  const result = await client.getWaveform("C:\clip.mkv", 2);
  assert.equal(result.ok, false);
});
