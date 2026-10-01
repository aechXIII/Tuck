import assert from "node:assert/strict";
import test from "node:test";

import { createClipLoader } from "../../src/features/library/clip-loader.ts";

function harness(limit: number) {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  const loader = createClipLoader(
    (path) =>
      new Promise<void>((resolve) => {
        started.push(path);
        finishers.set(path, resolve);
      }),
    limit,
  );
  async function finish(path: string): Promise<void> {
    finishers.get(path)?.();
    // let the finished load hand its slot to the next path
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { loader, started, finish };
}

test("loads paths in order, never more than the limit at once", async () => {
  const { loader, started, finish } = harness(2);
  loader.add(["a", "b", "c", "d"]);
  assert.deepEqual(started, ["a", "b"]);

  await finish("a");
  assert.deepEqual(started, ["a", "b", "c"]);
  await finish("b");
  await finish("c");
  assert.deepEqual(started, ["a", "b", "c", "d"]);
});

test("a path already waiting or loading is not loaded twice", async () => {
  const { loader, started, finish } = harness(1);
  loader.add(["a", "b"]);
  loader.add(["a", "b", "c"]);
  await finish("a");
  await finish("b");
  await finish("c");
  assert.deepEqual(started, ["a", "b", "c"]);
});

test("a prioritized path loads next, ahead of the paths waiting before it", async () => {
  const { loader, started, finish } = harness(1);
  loader.add(["a", "b", "c"]);
  loader.prioritize("c");
  loader.prioritize("a");
  await finish("a");
  assert.deepEqual(started, ["a", "c"]);
  await finish("c");
  assert.deepEqual(started, ["a", "c", "b"]);

  loader.prioritize("d");
  await finish("b");
  assert.deepEqual(started, ["a", "c", "b", "d"]);
});
