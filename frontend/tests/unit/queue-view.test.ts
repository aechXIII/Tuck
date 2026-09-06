import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyQueueView,
  formatEta,
  formatQueueStatus,
  queueCompletionOutput,
  reduceQueueSnapshot,
  type QueueViewState,
} from "../../src/features/queue/queue-view.ts";

test("formatEta pads minutes and seconds and adds hours when needed", () => {
  assert.equal(formatEta(null), "--");
  assert.equal(formatEta(-1), "--");
  assert.equal(formatEta(9), "00:09");
  assert.equal(formatEta(125), "02:05");
  assert.equal(formatEta(3661), "01:01:01");
});

test("formatQueueStatus summarizes a running item with progress, speed, and eta", () => {
  assert.equal(
    formatQueueStatus({
      state: "running",
      status_text: "Encoding",
      progress: 42,
      progress_info: { speed: 1.5, eta_seconds: 18 },
    }),
    "Encoding · 42% · 1.5x · ETA 00:18",
  );
  assert.equal(formatQueueStatus({ state: "failed" }), "Failed");
});

test("empty snapshot yields a hidden bar and disabled controls", () => {
  const next = reduceQueueSnapshot(emptyQueueView(), { items: [] });
  assert.equal(next.barVisible, false);
  assert.equal(next.active, false);
  assert.equal(next.cancelDisabled, true);
  assert.equal(next.clearDisabled, true);
  assert.equal(next.finishedToast, null);
});

test("a running item drives count, progress, eta, and filename", () => {
  const next = reduceQueueSnapshot(emptyQueueView(), {
    items: [
      {
        id: "a",
        source: "clip.mp4",
        state: "running",
        progress: 42,
        progress_info: { eta_seconds: 18, speed: 1.5 },
        segment_count: 1,
        duration: 12,
      },
    ],
  }, (seconds) => `${seconds}s`);
  assert.equal(next.barVisible, true);
  assert.equal(next.active, true);
  assert.equal(next.count, "1/1");
  assert.equal(next.progress, 42);
  assert.equal(next.eta, "ETA 00:18");
  assert.equal(next.fname, "clip.mp4 · 1 segment · 12s · Encoding · 42%");
});

test("displayed progress never regresses while the same item runs", () => {
  const running = (progress: number): QueueViewState =>
    reduceQueueSnapshot(previous, { items: [{ id: "a", source: "c", state: "running", progress }] });
  let previous = emptyQueueView();
  previous = running(60);
  assert.equal(previous.progress, 60);
  const dip = reduceQueueSnapshot(previous, {
    items: [{ id: "a", source: "c", state: "running", progress: 55 }],
  });
  assert.equal(dip.progress, 60);
  const climb = reduceQueueSnapshot(dip, {
    items: [{ id: "a", source: "c", state: "running", progress: 70 }],
  });
  assert.equal(climb.progress, 70);
});

test("a new running item resets the progress floor", () => {
  let previous = reduceQueueSnapshot(emptyQueueView(), {
    items: [{ id: "a", source: "c", state: "running", progress: 90 }],
  });
  previous = reduceQueueSnapshot(previous, {
    items: [{ id: "b", source: "d", state: "running", progress: 5 }],
  });
  assert.equal(previous.progress, 5);
});

test("finishing a batch reports a success toast and clears active ids", () => {
  const active = reduceQueueSnapshot(emptyQueueView(), {
    items: [{ id: "a", source: "c", state: "running", progress: 99 }],
  });
  const done = reduceQueueSnapshot(active, {
    items: [{ id: "a", source: "c", state: "completed", result_path: "C:\\out\\c.mp4" }],
  });
  assert.deepEqual(done.finishedToast, { message: "Processing completed.", kind: "ok" });
  assert.equal(done.outputToOpen, "C:\\out\\c.mp4");
  assert.deepEqual(done.activeItemIds, {});
});

test("a failed job finishes the batch with an error toast", () => {
  const active = reduceQueueSnapshot(emptyQueueView(), {
    items: [{ id: "a", source: "c", state: "running", progress: 10 }],
  });
  const done = reduceQueueSnapshot(active, {
    items: [{ id: "a", source: "c", state: "failed", error: "boom" }],
  });
  assert.deepEqual(done.finishedToast, {
    message: "Processing finished with 1 failure.",
    kind: "err",
  });
  assert.equal(done.clearDisabled, true);
});

test("queueCompletionOutput ignores completions from before the batch started", () => {
  const items = [
    { id: "old", state: "completed", result_path: "old.mp4", finished_at: "1" },
    { id: "new", state: "completed", result_path: "new.mp4", finished_at: "2" },
  ];
  assert.equal(queueCompletionOutput(items, true, false, { new: true }), "new.mp4");
  assert.equal(queueCompletionOutput(items, false, false, { new: true }), "");
});
