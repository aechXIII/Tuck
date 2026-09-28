import assert from "node:assert/strict";
import test from "node:test";

import {
  createSecondInstanceLaunchQueue,
  launchFromPayload,
  mergeLaunches,
  type StartupLaunch,
} from "../../src/platform/second-instance.ts";

test("second-instance files queue until startup drains them, then deliver immediately", () => {
  const delivered: StartupLaunch[] = [];
  const queue = createSecondInstanceLaunchQueue((launch) => delivered.push(launch));

  queue.enqueue({ files: ["first.mp4", 42, "second.mp4"], task: null });
  queue.enqueue("not a launch");
  queue.enqueue(["bare.mp4"]);
  queue.enqueue({ files: [], task: null });
  assert.deepEqual(queue.drain(), { files: ["first.mp4", "second.mp4"], task: null });
  assert.deepEqual(delivered, []);

  queue.markReadyAndFlush();
  queue.enqueue({ files: ["later.mp4"], task: "upscale" });
  assert.deepEqual(delivered, [{ files: ["later.mp4"], task: "upscale" }]);
});

test("second-instance paths queued after startup drain flush during the ready handoff", () => {
  const delivered: StartupLaunch[] = [];
  const queue = createSecondInstanceLaunchQueue((launch) => delivered.push(launch));

  queue.enqueue({ files: ["startup.mp4"], task: null });
  assert.deepEqual(queue.drain(), { files: ["startup.mp4"], task: null });

  // This models a Tauri event delivered after startup drain and before the
  // editor finishes attaching its backend client.
  queue.enqueue({ files: ["interleaved.mp4"], task: "cut" });
  queue.markReadyAndFlush();

  assert.deepEqual(delivered, [{ files: ["interleaved.mp4"], task: "cut" }]);
  queue.enqueue({ files: ["later.mp4"], task: null });
  assert.deepEqual(delivered, [
    { files: ["interleaved.mp4"], task: "cut" },
    { files: ["later.mp4"], task: null },
  ]);
});

test("a launch with only a task still reaches the editor", () => {
  const delivered: StartupLaunch[] = [];
  const queue = createSecondInstanceLaunchQueue((launch) => delivered.push(launch));

  queue.enqueue({ files: [], task: "cut" });
  assert.deepEqual(queue.drain(), { files: [], task: "cut" });

  queue.markReadyAndFlush();
  queue.enqueue({ files: [], task: "compression" });
  assert.deepEqual(delivered, [{ files: [], task: "compression" }]);
});

test("startup payloads keep valid files and known tasks only", () => {
  assert.deepEqual(launchFromPayload({ files: ["a.mp4", null], task: "upscale" }), {
    files: ["a.mp4"],
    task: "upscale",
  });
  assert.deepEqual(launchFromPayload({ files: "a.mp4", task: "trim" }), { files: [], task: null });
  assert.deepEqual(launchFromPayload(null), { files: [], task: null });
  assert.deepEqual(launchFromPayload(["a.mp4"]), { files: [], task: null });
});

test("merged launches keep file order and the latest task", () => {
  assert.deepEqual(
    mergeLaunches([
      { files: ["a.mp4"], task: "cut" },
      { files: ["b.mp4"], task: null },
      { files: [], task: "upscale" },
    ]),
    { files: ["a.mp4", "b.mp4"], task: "upscale" },
  );
  assert.deepEqual(mergeLaunches([]), { files: [], task: null });
});
