import assert from "node:assert/strict";
import test from "node:test";

import type { BackendResult, FolderVideos } from "../../src/backend/types.ts";
import type { ConfirmIntent } from "../../src/features/editor/toast.ts";
import { ASK_ABOVE, addFolderVideos, folderAsk, importPaths, type ImportDeps } from "../../src/features/library/folder-import.ts";

function videos(count: number, folder = "C:\\Replays"): string[] {
  return Array.from({ length: count }, (_, index) => `${folder}\\Replay ${index + 1}.mp4`);
}

function recorder(listing: BackendResult<FolderVideos> = { ok: true, value: { folders: [], videos: [], truncated: false } }) {
  const added: string[][] = [];
  const audio: string[][] = [];
  const toasts: { message: string; kind?: string }[] = [];
  const asked: { message: string; intent: ConfirmIntent; accept: () => void }[] = [];
  const listed: string[][] = [];
  const deps: ImportDeps = {
    listFolders: async (paths) => {
      listed.push([...paths]);
      return listing;
    },
    addVideos: (paths) => added.push([...paths]),
    addAudio: (paths) => audio.push([...paths]),
    confirm: (message, accept, intent) => asked.push({ message, intent, accept }),
    toast: (message, kind) => toasts.push(kind === undefined ? { message } : { message, kind }),
  };
  return { deps, added, audio, toasts, asked, listed };
}

test("a dropped folder's videos go into the Library with the dropped files", async () => {
  const found = videos(3);
  const run = recorder({ ok: true, value: { folders: ["C:\\Replays"], videos: found, truncated: false } });
  await importPaths(["C:\\clip.mp4", "C:\\Replays", "C:\\song.mp3"], run.deps);
  assert.deepEqual(run.listed, [["C:\\Replays"]]);
  assert.deepEqual(run.added, [["C:\\clip.mp4"], found]);
  assert.deepEqual(run.audio, [["C:\\song.mp3"]]);
  assert.deepEqual(run.toasts, []);
});

test("a drop of only media files never asks the shell about folders", async () => {
  const run = recorder();
  await importPaths(["C:\\clip.mp4"], run.deps);
  assert.deepEqual(run.listed, []);
  assert.deepEqual(run.added, [["C:\\clip.mp4"]]);
});

test("files that are neither media nor folders are still named as skipped", async () => {
  const run = recorder({ ok: true, value: { folders: ["C:\\Replays"], videos: videos(1), truncated: false } });
  await importPaths(["C:\\Replays", "C:\\notes.txt"], run.deps);
  assert.deepEqual(run.toasts, [{ message: "Skipped notes.txt, which isn’t a video or audio file." }]);
});

test("a folder with no videos says so", async () => {
  const run = recorder({ ok: true, value: { folders: ["/home/me/Documents/"], videos: [], truncated: false } });
  await importPaths(["/home/me/Documents/"], run.deps);
  assert.deepEqual(run.added, []);
  assert.deepEqual(run.toasts, [{ message: "No videos in Documents.", kind: "info" }]);
});

test("up to the limit videos are added at once, and above it Tuck asks first", () => {
  const few = recorder();
  addFolderVideos({ folders: ["C:\\Replays"], videos: videos(ASK_ABOVE), truncated: false }, few.deps);
  assert.equal(few.asked.length, 0);
  assert.equal(few.added[0]?.length, ASK_ABOVE);

  const many = recorder();
  const found = videos(ASK_ABOVE + 1);
  addFolderVideos({ folders: ["C:\\Replays"], videos: found, truncated: false }, many.deps);
  assert.equal(many.added.length, 0);
  assert.equal(many.asked.length, 1);
  many.asked[0]?.accept();
  assert.deepEqual(many.added, [found]);
});

test("the question names the count and where the videos come from", () => {
  assert.deepEqual(folderAsk({ folders: ["C:\\Videos\\Replays\\"], videos: videos(120), truncated: false }), {
    message: "From Replays.",
    intent: { title: "Add 120 videos?", confirmLabel: "Add videos", cancelLabel: "Cancel", danger: false },
  });
  const cut = folderAsk({ folders: ["/a", "/b"], videos: videos(1000), truncated: true });
  assert.equal(cut.intent.title, "Add 1,000 videos?");
  assert.equal(cut.message, "From 2 folders. There are more, so Tuck stops at the first 1,000.");
});

test("a folder the shell can't read is reported and nothing else is said", async () => {
  const run = recorder({ ok: false, error: { code: "INTERNAL_ERROR", message: "Could not read the folder. Try again.", details: {} } });
  await importPaths(["C:\\Replays"], run.deps);
  assert.deepEqual(run.added, []);
  assert.deepEqual(run.toasts, [{ message: "Couldn’t read the folder. Try again.", kind: "err" }]);
});
