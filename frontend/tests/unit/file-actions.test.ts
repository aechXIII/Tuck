import assert from "node:assert/strict";
import test from "node:test";

import { fileBusyReason, nameStemEnd, renameBusyReason, trashName, trashSummary } from "../../src/features/library/file-actions.ts";
import type { EditorClip } from "../../src/features/editor/types.ts";

test("the Trash has its platform's name", () => {
  assert.equal(trashName("windows"), "Recycle Bin");
  assert.equal(trashName("linux"), "Trash");
  assert.equal(trashName(null), "Trash");
});

test("everything moved is a short confirmation", () => {
  const one = trashSummary([{ path: "/v/Clutch.mp4", outcome: "moved" }], "Trash");
  assert.deepEqual([one.title, one.message, one.stayed], ["Moved Clutch.mp4 to the Trash.", "", []]);
  const several = trashSummary(
    [{ path: "/v/a.mp4", outcome: "moved" }, { path: "C:\\v\\b.mp4", outcome: "missing" }],
    "Recycle Bin",
    "originals",
  );
  // a file already gone leaves the Library like a moved one
  assert.deepEqual([several.title, several.gone], ["Moved 2 originals to the Recycle Bin.", ["/v/a.mp4", "C:\\v\\b.mp4"]]);
});

test("files that stayed are named, with why", () => {
  const summary = trashSummary(
    [
      { path: "/v/a.mp4", outcome: "moved" },
      { path: "/usb/b.mp4", outcome: "no_trash" },
      { path: "/usb/c.mp4", outcome: "no_trash" },
      { path: "/v/d.mp4", outcome: "failed" },
    ],
    "Trash",
  );
  assert.equal(summary.title, "1 of 4 moved to the Trash");
  assert.equal(
    summary.message,
    "2 are on a drive with no Trash, so they stayed where they are: b.mp4 and c.mp4. d.mp4 couldn't be moved. Another program may have it open.",
  );
  assert.deepEqual(summary.stayed, ["/usb/b.mp4", "/usb/c.mp4", "/v/d.mp4"]);
  const none = trashSummary([{ path: "/usb/b.mp4", outcome: "no_trash" }], "Trash");
  assert.equal(none.title, "Couldn't move it to the Trash");
  assert.equal(none.message, "b.mp4 is on a drive with no Trash, so it stayed where it is.");
});

test("Rename selects the name up to its extension and waits for exports and loading", () => {
  assert.equal(nameStemEnd("Replay 2026-10-29.mp4"), 17);
  assert.equal(nameStemEnd("Replay"), 6);
  assert.equal(nameStemEnd(".hidden"), 7);
  const clip = { probed: true, error: "", _queueState: "running" } as unknown as EditorClip;
  assert.equal(fileBusyReason(clip), "Wait for its export to finish");
  assert.equal(fileBusyReason({ ...clip, _queueState: "completed" }), "");
  assert.equal(renameBusyReason({ ...clip, _queueState: "", probed: false }), "Wait for the video to load");
  assert.equal(renameBusyReason({ ...clip, _queueState: "" }), "");
});
