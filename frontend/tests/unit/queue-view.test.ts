import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyQueueView,
  exportRows,
  formatEta,
  formatQueueStatus,
  queueCompletionOutput,
  reduceQueueSnapshot,
  batchSummary,
  isQueueActive,
  queueItemState,
  queueItemsFromSnapshot,
  type QueueItem,
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

test("formatQueueStatus says when Auto fell back to another encoder", () => {
  const fallback = "Used software encoding because the NVIDIA encoder couldn't start";
  assert.equal(
    formatQueueStatus({ state: "completed", status_text: "Completed", encoder_fallback: fallback }),
    `Completed · ${fallback}`,
  );
  assert.equal(
    formatQueueStatus({ state: "completed", status_text: "Completed", encoder_fallback: "" }),
    "Completed",
  );
});

test("empty snapshot yields a hidden bar and disabled controls", () => {
  const next = reduceQueueSnapshot(emptyQueueView(), { items: [] });
  assert.equal(next.barVisible, false);
  assert.equal(next.active, false);
  assert.equal(next.cancelDisabled, true);
  assert.equal(next.clearDisabled, true);
  assert.equal(next.finishedToast, null);
});

test("a running item shows its name, how far it is and what is left", () => {
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
      { id: "b", source: "next.mp4", state: "pending" },
      { id: "c", source: "old.mp4", state: "completed" },
      { id: "d", source: "bad.mp4", state: "failed" },
    ],
  }, (seconds) => `${seconds}s`);
  assert.equal(next.barVisible, true);
  assert.equal(next.active, true);
  assert.equal(next.progress, 42);
  assert.equal(next.fname, "clip.mp4");
  assert.equal(next.detail, "42% · 18s left");
  assert.equal(next.waiting, 1);
  assert.equal(next.failed, 1);
  // a second pass or other named step says so; plain encoding does not
  const pass = reduceQueueSnapshot(emptyQueueView(), {
    items: [{ id: "a", source: "clip.mp4", state: "running", progress: 0, status_text: "Pass 2" }],
  });
  assert.equal(pass.detail, "Pass 2");
  const starting = reduceQueueSnapshot(emptyQueueView(), {items: [{ id: "a", source: "clip.mp4", state: "running" }]});
  assert.equal(starting.detail, "Starting");
});

test("a finished queue says it is done and keeps its failures", () => {
  const view = reduceQueueSnapshot(emptyQueueView(), {
    items: [{ id: "c", state: "completed" }, { id: "d", state: "failed" }],
  });
  assert.equal(view.fname, "1 exported");
  assert.equal(view.finished, true);
  assert.equal(view.detail, "");
  assert.equal(view.failed, 1);
  assert.equal(view.waiting, 0);
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
  assert.deepEqual(done.finishedToast, { message: "Exported “c”.", kind: "ok", failedIds: [] });
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
    message: "Couldn’t export “c”.",
    kind: "err",
    failedIds: ["a"],
  });
  assert.equal(done.clearDisabled, true);
});

test("queueCompletionOutput ignores completions from before the batch started", () => {
  const items: QueueItem[] = [
    { id: "old", state: "completed", result_path: "old.mp4", finished_at: "1" },
    { id: "new", state: "completed", result_path: "new.mp4", finished_at: "2" },
  ];
  assert.equal(queueCompletionOutput(items, true, false, { new: true }), "new.mp4");
  assert.equal(queueCompletionOutput(items, false, false, { new: true }), "");
});
test("cut finalization has no percentage, speed or ETA", () => {
  for (const status of ["Joining", "Checking output"]) {
    const item: QueueItem = {id: "cut", operation: "cut", state: "running", progress: 99, status_text: status,
      progress_info: {indeterminate: true, speed: 2, eta_seconds: 1}};
    assert.equal(formatQueueStatus(item), status);
    const view = reduceQueueSnapshot(emptyQueueView(), {items: [item]});
    assert.equal(view.indeterminate, true);
    assert.equal(view.detail, status);
  }
  assert.equal(formatQueueStatus({state: "running", progress: 50, status_text: "Copying", progress_info: {indeterminate: false}}), "Copying · 50%");
});

test("finished cuts that could not be fully checked stay marked", () => {
  assert.equal(formatQueueStatus({state: "completed", status_text: "Completed", unverified: ["Starts not confirmed."]}), "Completed · Not checked");
  assert.equal(formatQueueStatus({state: "completed", status_text: "Completed", unverified: []}), "Completed");
  assert.equal(formatQueueStatus({state: "running", status_text: "Copying", unverified: ["x"], progress_info: {indeterminate: true}}), "Copying");
});

test("export rows group this session's exports and say what each can do", () => {
  const sizes: Record<string, number> = { "C:/a.mp4": 20_000_000, "C:/b.mp4": 8_000_000 };
  const rows = exportRows([
    { id: "run", source: "a.mp4", source_path: "C:/a.mp4", state: "running", progress: 42.4, progress_info: { eta_seconds: 83 } },
    { id: "wait", source: "b.mp4", source_path: "C:/b.mp4", state: "pending" },
    { id: "bad", source: "c.mp4", state: "failed", error: "Out of disk space" },
    { id: "stop", source: "d.mp4", state: "cancelled" },
    { id: "done", source: "a.mp4", source_path: "C:/a.mp4", state: "completed", result_path: "C:/a_small.mp4", result_size: 5_000_000 },
    { id: "gone", source: "e.mp4", source_path: "C:/e.mp4", state: "completed" },
  ], (path) => sizes[path] ?? 0, (seconds) => `${seconds}s`);
  assert.deepEqual(rows.running.map((row) => [row.id, row.detail, row.progress, row.action]), [["run", "42% · 83s left", 42, "cancel"]]);
  assert.deepEqual(rows.waiting.map((row) => [row.id, row.detail, row.action]), [["wait", "Waiting", "cancel"]]);
  assert.deepEqual(rows.finished.map((row) => [row.id, row.kind, row.detail, row.action]), [
    ["bad", "failed", "Failed: Out of disk space", "retry"],
    ["stop", "cancelled", "Cancelled", "retry"],
    ["done", "completed", "", "show"],
    ["gone", "completed", "Done", null],
  ]);
  assert.deepEqual(rows.finished[2]?.sizes, { from: 20_000_000, to: 5_000_000 });
  assert.equal(rows.saved, 15_000_000);
});

test("queue states are the backend's own, and only pending or running work is active", () => {
  assert.equal(queueItemState("pending"), "pending");
  assert.equal(queueItemState("cancelled"), "cancelled");
  // the old names the cut export once used are not queue states
  assert.equal(queueItemState("queued"), "");
  assert.equal(queueItemState("encoding"), "");
  assert.equal(queueItemState("processing"), "");
  assert.equal(isQueueActive("pending"), true);
  assert.equal(isQueueActive("running"), true);
  assert.equal(isQueueActive("completed"), false);
  assert.equal(isQueueActive(""), false);
  assert.deepEqual(
    queueItemsFromSnapshot([{ id: "a", state: "running" }, { id: "b", state: "mystery" }, null, "x"]),
    [{ id: "a", state: "running" }, { id: "b" }],
  );
});

test("a finished batch is summed up once, from that batch only", () => {
  const items: QueueItem[] = [
    { id: "a", source: "a.mp4", state: "completed" },
    { id: "b", source: "b.mp4", state: "failed", error: "Encoder crashed" },
    { id: "c", source: "c.mp4", state: "failed" },
    { id: "d", source: "d.mp4", state: "completed" },
    { id: "e", source: "e.mp4", state: "cancelled" },
    { id: "old", source: "old.mp4", state: "failed" },
  ];
  assert.deepEqual(batchSummary(items, { a: true, b: true, c: true, d: true }), {
    message: "2 of 4 exports failed.",
    kind: "err",
    failedIds: ["b", "c"],
  });
  assert.deepEqual(batchSummary(items, { a: true, d: true }), {
    message: "2 videos exported.",
    kind: "ok",
    failedIds: [],
  });
  // a cancelled batch says so instead of claiming it completed
  assert.deepEqual(batchSummary(items, { e: true }), { message: "Export cancelled.", kind: "info", failedIds: [] });
  assert.deepEqual(batchSummary(items, { a: true, e: true }), {
    message: "1 exported, 1 cancelled.",
    kind: "info",
    failedIds: [],
  });
});

test("cancelling every export finishes the batch without claiming success", () => {
  const active = reduceQueueSnapshot(emptyQueueView(), {
    items: [
      { id: "a", source: "a.mp4", state: "running", progress: 10 },
      { id: "b", source: "b.mp4", state: "pending" },
      { id: "old", source: "old.mp4", state: "failed" },
    ],
  });
  const done = reduceQueueSnapshot(active, {
    items: [
      { id: "a", source: "a.mp4", state: "cancelled" },
      { id: "b", source: "b.mp4", state: "cancelled" },
      { id: "old", source: "old.mp4", state: "failed" },
    ],
  });
  assert.deepEqual(done.finishedToast, { message: "Exports cancelled.", kind: "info", failedIds: [] });
});
