import assert from "node:assert/strict";
import test from "node:test";

import { createSecondInstanceLaunchQueue } from "../../src/platform/second-instance.ts";

test("second-instance files queue until startup drains them, then deliver immediately", () => {
  const delivered: string[][] = [];
  const queue = createSecondInstanceLaunchQueue((files) => delivered.push([...files]));

  queue.enqueue(["first.mp4", 42, "second.mp4"]);
  queue.enqueue("not a path list");
  assert.deepEqual(queue.drain(), ["first.mp4", "second.mp4"]);
  assert.deepEqual(delivered, []);

  queue.markReadyAndFlush();
  queue.enqueue(["later.mp4"]);
  assert.deepEqual(delivered, [["later.mp4"]]);
});

test("second-instance paths queued after startup drain flush during the ready handoff", () => {
  const delivered: string[][] = [];
  const queue = createSecondInstanceLaunchQueue((files) => delivered.push([...files]));

  queue.enqueue(["startup.mp4"]);
  assert.deepEqual(queue.drain(), ["startup.mp4"]);

  // This models a Tauri event delivered after startup drain and before the
  // editor finishes attaching its backend client.
  queue.enqueue(["interleaved.mp4"]);
  queue.markReadyAndFlush();

  assert.deepEqual(delivered, [["interleaved.mp4"]]);
  queue.enqueue(["later.mp4"]);
  assert.deepEqual(delivered, [["interleaved.mp4"], ["later.mp4"]]);
});
