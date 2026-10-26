import assert from "node:assert/strict";
import test from "node:test";

import { createTauriBackendClient } from "../../src/backend/tauri.ts";
import { isJoinStatus, type JoinStatus } from "../../src/backend/join-types.ts";
import * as clipCards from "../../src/features/library/clip-card.ts";
import type { ClipCardElement, ClipCardEvent, ClipPick } from "../../src/features/library/clip-card.ts";
import { joinedMessage, joinStageNote, joinStageText } from "../../src/features/library/join.ts";

const running: JoinStatus = {
  work_id: "join-1", status: "running", stage: "checking", progress: null, output_path: "", lossless: null,
  reason: "", encoder: "", fallback: "", code: "", message: "",
};

test("join requests use their own allowlisted commands and check every answer", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (_command, args) => {
    calls.push(args);
    const command = (args.command as { command: string }).command;
    return command === "cancel_join" ? { cancelled: true } : running;
  });
  const paths = ["C:\\videos\\b.mp4", "C:\\videos\\a.mp4"];
  assert.deepEqual(await client.joinVideos(paths, "join-1"), { ok: true, value: running });
  assert.deepEqual(await client.getJoin("join-1"), { ok: true, value: running });
  assert.deepEqual(await client.cancelJoin("join-1"), { ok: true, value: { cancelled: true } });
  assert.deepEqual(calls, [
    { command: { command: "join_videos", payload: { paths, work_id: "join-1" } } },
    { command: { command: "get_join", payload: { work_id: "join-1" } } },
    { command: { command: "cancel_join", payload: { work_id: "join-1" } } },
  ]);
  for (const bad of [
    { ...running, progress: 1.5 },
    { ...running, status: "finished" },
    { ...running, stage: "uploading" },
    { ...running, lossless: "yes" },
    { ...running, status: "done", output_path: "" },
    { ...running, message: 4 },
  ]) {
    assert.equal(isJoinStatus(bad), false);
    assert.equal((await createTauriBackendClient(async () => bad).getJoin("join-1")).ok, false);
  }
});

test("a read ahead is asked for only when it is one", async () => {
  const calls: unknown[] = [];
  const pending = { work_id: "w", status: "pending", progress: null, coverage_end: { ticks: "0", time_base_num: 1, time_base_den: 1 }, keyframes: [], issue: null, analysis: null };
  const client = createTauriBackendClient(async (_command, args) => { calls.push(args); return pending; });
  await client.analyzeCut("a.mp4", "w1", true);
  await client.analyzeCut("a.mp4", "w2");
  assert.deepEqual(calls, [
    { command: { command: "analyze_cut", payload: { path: "a.mp4", work_id: "w1", background: true } } },
    { command: { command: "analyze_cut", payload: { path: "a.mp4", work_id: "w2" } } },
  ]);
});

test("a join names its stage and shows a share only where it was measured", () => {
  assert.equal(joinStageText(3, null), "Checking 3 videos…");
  assert.equal(joinStageText(3, { ...running, stage: "copying", progress: 0.456, lossless: true }), "Joining · 45%");
  assert.equal(joinStageText(3, { ...running, stage: "encoding", progress: null, lossless: false }), "Re-encoding…");
  assert.equal(joinStageText(3, { ...running, stage: "saving", progress: null }), "Saving…");
  assert.equal(joinStageNote(running), "");
  assert.equal(joinStageNote({ ...running, lossless: true }), "Copying without re-encoding, so nothing changes in quality.");
  const encoded = { ...running, lossless: false, reason: "the picture sizes differ (1920x1080 and 1280x720)" };
  assert.equal(joinStageNote(encoded), "Re-encoding because the picture sizes differ (1920x1080 and 1280x720).");
  const fallback = "The NVIDIA encoder couldn't be used, so the processor made this video.";
  assert.equal(joinStageNote({ ...encoded, fallback }), `Re-encoding because the picture sizes differ (1920x1080 and 1280x720). ${fallback}`);
});

test("a finished join says what it made", () => {
  const done = { ...running, status: "done" as const, stage: "" as const, progress: 1, output_path: "/videos/Round 1_joined.mp4" };
  assert.equal(joinedMessage(2, { ...done, lossless: true }), "Joined 2 videos into “Round 1_joined.mp4”. Nothing was re-encoded.");
  assert.equal(
    joinedMessage(3, { ...done, lossless: false, reason: "some videos have sound and some don't" }),
    "Joined 3 videos into “Round 1_joined.mp4”. Re-encoded because some videos have sound and some don't.",
  );
});

class Element implements ClipCardElement {
  className = "";
  textContent: string | null = "";
  dataset: { [key: string]: string | undefined } = {};
  parentElement: Element | null = null;
  listeners: Record<string, Array<(event: ClipCardEvent) => void>> = {};
  setAttribute(): void {}
  addEventListener(type: string, listener: (event: ClipCardEvent) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  appendChild(child: ClipCardElement): ClipCardElement {
    (child as Element).parentElement = this;
    return child;
  }
}

test("Ctrl and Shift add rows to the selection, by pointer and by key", () => {
  const picks: Array<[string, ClipPick | undefined]> = [];
  const extended: Array<[string, number]> = [];
  const card = clipCards.createClipCard({ createElement: () => new Element() }, { path: "b.mp4", name: "b.mp4" }, {
    select: (path, pick) => picks.push([path, pick]),
    extendSelection: (path, delta) => extended.push([path, delta]),
    togglePlay() {}, remove() {}, openResult() {}, retry() {}, beginReorder() {},
  }) as Element;
  const click = card.listeners.click![0]!;
  const keydown = card.listeners.keydown![0]!;
  click({ target: card });
  click({ target: card, ctrlKey: true });
  click({ target: card, metaKey: true });
  click({ target: card, shiftKey: true });
  keydown({ key: " ", ctrlKey: true, target: card, preventDefault() {} });
  assert.deepEqual(picks, [["b.mp4", undefined], ["b.mp4", "toggle"], ["b.mp4", "toggle"], ["b.mp4", "range"], ["b.mp4", "toggle"]]);
  let stopped = false;
  keydown({ key: "ArrowDown", shiftKey: true, target: card, preventDefault() {}, stopPropagation() { stopped = true; } });
  keydown({ key: "ArrowUp", shiftKey: true, target: card, preventDefault() {}, stopPropagation() {} });
  // a plain arrow key is left to the shortcut that moves to the next video
  keydown({ key: "ArrowDown", target: card, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(extended, [["b.mp4", 1], ["b.mp4", -1]]);
  assert.equal(stopped, true);
});
