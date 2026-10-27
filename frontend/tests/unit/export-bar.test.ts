import assert from "node:assert/strict";
import test from "node:test";

import { exportBarView, passFills } from "../../src/features/queue/export-bar.ts";
import { emptyQueueView, reduceQueueSnapshot, type QueueItem } from "../../src/features/queue/queue-view.ts";

const MB = 1024 * 1024;
const sizes: Record<string, number> = { "C:\\v\\a.mp4": 34.6 * MB, "C:\\v\\b.mp4": 40 * MB, "C:\\v\\c.mp4": 20 * MB };
const sourceSize = (path: string): number => sizes[path] ?? 0;

function viewOf(items: QueueItem[]) {
  return exportBarView(items, reduceQueueSnapshot(emptyQueueView(), { items }), sourceSize);
}

const running = (extra: Partial<QueueItem> = {}): QueueItem => ({
  id: "a", source: "a.mp4", source_path: "C:\\v\\a.mp4", state: "running", progress: 62, two_pass: true,
  status_text: "Pass 2 of 2", progress_info: { stage: "pass_2", fps: 146.2, eta_seconds: 11 }, ...extra,
});
const done = (id: string, path: string, size: number, extra: Partial<QueueItem> = {}): QueueItem => ({
  id, source: path.split("\\").pop() ?? path, source_path: path, state: "completed", progress: 100,
  output: `${id}_tucked.mp4`, result_path: `C:\\out\\${id}_tucked.mp4`, result_size: size, ...extra,
});

test("nothing in the queue hides the export area", () => {
  assert.deepEqual(viewOf([]), { kind: "hidden" });
});

test("a running two-pass export shows its whole percent, fps, time left and what waits", () => {
  const view = viewOf([running(), { id: "b", state: "pending", source_path: "C:\\v\\b.mp4" }, { id: "c", state: "pending" }]);
  assert.equal(view.kind, "running");
  if (view.kind !== "running") return;
  assert.equal(view.title, "a.mp4");
  assert.equal(view.percent, 62);
  assert.equal(view.passes, 2);
  assert.equal(view.fps, 146.2);
  assert.equal(view.eta, 11);
  assert.equal(view.waiting, 2);
  assert.equal(view.failed, 0);
  assert.equal(view.attempt, "");
});

test("a failure in a running batch is counted before the batch ends", () => {
  const view = viewOf([
    { id: "x", source: "x.mp4", state: "failed", error: "Disk is full" },
    running(),
    { id: "b", state: "pending" },
  ]);
  assert.equal(view.kind === "running" && view.failed, 1);
  assert.equal(view.kind === "running" && view.waiting, 1);
});

test("a failure counts every finished export, even one that names no file", () => {
  const view = viewOf([
    { id: "a", source: "a.mp4", state: "completed", result_size: MB },
    { id: "b", source: "b.mp4", state: "failed", error: "FFmpeg stopped" },
  ]);
  assert.equal(view.kind === "failed" && view.finished, 1);
});

test("a step without a measured amount is named, never given a percent", () => {
  for (const item of [
    running({ progress: 0, status_text: "Preparing", progress_info: { stage: "preparing" } }),
    running({ progress: 0, status_text: "Blending frames (37%)", progress_info: { stage: "preparing", fps: 236 } }),
    running({ progress: 40, status_text: "Checking output", progress_info: { stage: "verifying", indeterminate: true } }),
  ]) {
    const view = viewOf([item]);
    assert.equal(view.kind, "running");
    if (view.kind !== "running") continue;
    assert.equal(view.percent, null, item.status_text);
    assert.equal(view.stage, item.status_text);
  }
  // fps is shown whenever FFmpeg measured it, blending included
  const blending = viewOf([running({ progress: 0, status_text: "Blending frames (37%)", progress_info: { stage: "preparing", fps: 236 } })]);
  assert.equal(blending.kind === "running" && blending.fps, 236);
});

test("no fps or time left until FFmpeg reports them", () => {
  const view = viewOf([running({ progress_info: { stage: "pass_1" } })]);
  assert.equal(view.kind === "running" && view.fps, null);
  assert.equal(view.kind === "running" && view.eta, null);
});

test("a waiting export with nothing running yet reads Waiting", () => {
  const view = viewOf([{ id: "b", state: "pending", source: "b.mp4" }, { id: "c", state: "pending" }]);
  assert.equal(view.kind, "running");
  if (view.kind !== "running") return;
  assert.equal(view.title, "b.mp4");
  assert.equal(view.stage, "Waiting");
  assert.equal(view.percent, null);
  assert.equal(view.waiting, 1);
});

test("one finished export is the file, with its size and the source's", () => {
  const view = viewOf([done("a", "C:\\v\\a.mp4", 9.8 * MB, { target_size: 10 * MB })]);
  assert.equal(view.kind, "one");
  if (view.kind !== "one") return;
  assert.equal(view.title, "a_tucked.mp4");
  assert.equal(view.resultPath, "C:\\out\\a_tucked.mp4");
  assert.equal(view.resultSize, 9.8 * MB);
  assert.equal(view.sourceSize, 34.6 * MB);
  // a file within its target says nothing about the target
  assert.equal(view.missedTarget, 0);
  const over = viewOf([done("a", "C:\\v\\a.mp4", 11 * MB, { target_size: 10 * MB })]);
  assert.equal(over.kind === "one" && over.missedTarget, 10 * MB);
});

test("several finished exports count, add up what they saved and stack the newest three", () => {
  const view = viewOf([
    done("a", "C:\\v\\a.mp4", 9.8 * MB, { target_size: 10 * MB }),
    done("b", "C:\\v\\b.mp4", 9.7 * MB, { target_size: 10 * MB }),
    done("c", "C:\\v\\c.mp4", 9.9 * MB, { target_size: 10 * MB }),
    done("d", "C:\\v\\d.mp4", 12 * MB, { target_size: 10 * MB }),
  ]);
  assert.equal(view.kind, "many");
  if (view.kind !== "many") return;
  assert.equal(view.count, 4);
  assert.deepEqual(view.itemIds, ["a", "b", "c", "d"]);
  assert.deepEqual(view.resultPaths, ["a", "b", "c", "d"].map((id) => `C:\\out\\${id}_tucked.mp4`));
  assert.deepEqual(view.sourcePaths, ["C:\\v\\b.mp4", "C:\\v\\c.mp4", "C:\\v\\d.mp4"]);
  assert.equal(view.resultPath, "C:\\out\\d_tucked.mp4");
  // the unknown source size of d adds nothing; the others shrank
  assert.equal(Math.round(view.saved / MB * 10) / 10, Math.round((34.6 - 9.8 + 40 - 9.7 + 20 - 9.9) * 10) / 10);
  assert.equal(view.missedTarget, 1);
});

test("a failure takes over the finished area, with its reason and the counts", () => {
  const view = viewOf([
    done("a", "C:\\v\\a.mp4", 9.8 * MB),
    { id: "b", source: "b.mp4", source_path: "C:\\v\\b.mp4", state: "failed", error: "Couldn’t save: E: is read-only" },
    done("c", "C:\\v\\c.mp4", 9.9 * MB),
  ]);
  assert.deepEqual(view, {
    kind: "failed", itemId: "b", sourcePath: "C:\\v\\b.mp4", title: "b.mp4",
    error: "Couldn’t save: E: is read-only", failed: 1, finished: 2,
  });
});

test("paused exports wait for Resume, and canceled ones alone are counted", () => {
  assert.deepEqual(viewOf([{ id: "a", state: "paused" }, { id: "b", state: "paused" }, done("c", "C:\\v\\c.mp4", MB)]),
    { kind: "paused", count: 2 });
  assert.deepEqual(viewOf([{ id: "a", state: "cancelled" }]), { kind: "canceled", count: 1 });
});

test("a size retry names its try while the track keeps counting", () => {
  const items = [running({ progress_info: { stage: "pass_1", retry_number: 2 } })];
  const view = exportBarView(items, reduceQueueSnapshot(emptyQueueView(), { items }), sourceSize);
  assert.equal(view.kind === "running" && view.attempt, "Second try · adjusting bitrate");
  assert.equal(view.kind === "running" && view.percent, 62);
});

test("the track's halves fill in turn, one pass after the other", () => {
  assert.deepEqual(passFills(0, 2), [0, 0]);
  assert.deepEqual(passFills(25, 2), [50, 0]);
  assert.deepEqual(passFills(50, 2), [100, 0]);
  assert.deepEqual(passFills(92, 2), [100, 84]);
  assert.deepEqual(passFills(140, 2), [100, 100]);
  assert.deepEqual(passFills(37, 1), [37]);
});
