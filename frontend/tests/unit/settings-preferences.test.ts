import assert from "node:assert/strict";
import test from "node:test";

import { accentColor, applyAppearance, createInterfaceSizer, interfaceSize } from "../../src/features/appearance/appearance.ts";
import { formatClockTime, timeFormat } from "../../src/features/editor/time-format.ts";
import { createSessionFiles, SESSION_FILES_MAX } from "../../src/features/library/session-files.ts";
import { finishedNotification, type QueueItem } from "../../src/features/queue/queue-view.ts";
import { nextPlaybackSpeed, PLAYBACK_SPEEDS } from "../../src/features/player/player.ts";
import { cutPointNear } from "../../src/features/timeline/segments.ts";
import {
  highlightParts,
  searchSettings,
  SETTINGS_INDEX,
  settingsPage,
} from "../../src/features/settings/settings-search.ts";

test("search finds settings by label, keyword, or page, in page order", () => {
  const folder = searchSettings("folder", SETTINGS_INDEX).map((entry) => entry.id);
  assert.deepEqual(folder, ["save-to", "show-folder", "logs", "settings-folder"]);
  // every word has to match
  assert.deepEqual(searchSettings("export folder", SETTINGS_INDEX).map((entry) => entry.id), ["save-to", "show-folder"]);
  assert.deepEqual(searchSettings("GPU", SETTINGS_INDEX).map((entry) => entry.id), ["encoders"]);
  assert.deepEqual(searchSettings("   ", SETTINGS_INDEX), []);
  assert.deepEqual(searchSettings("hdr", SETTINGS_INDEX), []);
});

test("search finds the switch that removes exported videos from the Library", () => {
  assert.deepEqual(searchSettings("library", SETTINGS_INDEX).map((entry) => entry.id), ["reopen", "remove-exported"]);
  assert.deepEqual(searchSettings("remove", SETTINGS_INDEX).map((entry) => entry.id), ["clear-finished", "remove-exported"]);
});

test("search leaves out pages this computer doesn't show", () => {
  const all = searchSettings("send to", SETTINGS_INDEX).map((entry) => entry.page);
  assert.ok(all.includes("explorer"));
  const linux = searchSettings("send to", SETTINGS_INDEX, (page) => page !== "explorer");
  assert.ok(linux.every((entry) => entry.page !== "explorer"));
});

test("search marks matches as plain text parts", () => {
  assert.deepEqual(highlightParts("Settings folder", "folder"), [
    { text: "Settings ", match: false },
    { text: "folder", match: true },
  ]);
  assert.deepEqual(highlightParts("<b>Keep</b>", "keep"), [
    { text: "<b>", match: false },
    { text: "Keep", match: true },
    { text: "</b>", match: false },
  ]);
  assert.deepEqual(highlightParts("Logs", ""), [{ text: "Logs", match: false }]);
});

test("old page names still open the page that replaced them", () => {
  assert.equal(settingsPage("output"), "files");
  assert.equal(settingsPage("system"), "about");
  assert.equal(settingsPage("keyboard"), "keyboard");
  assert.equal(settingsPage("nope"), "general");
  assert.equal(settingsPage(undefined), "general");
});

test("every searchable setting points at a page that exists", () => {
  const ids = new Set<string>();
  for (const entry of SETTINGS_INDEX) {
    assert.equal(settingsPage(entry.page), entry.page);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
});

test("time formats read the same moment three ways", () => {
  assert.equal(formatClockTime(63.4, "seconds"), "1:03.40");
  assert.equal(formatClockTime(63.4, "timecode", 30), "00:01:03:12");
  assert.equal(formatClockTime(63.4, "frames", 30), "1902 f");
  // at 29.97 fps the 30th frame starts just after one second, and both formats agree on it
  assert.equal(formatClockTime(1, "timecode", 29.97), "00:00:00:29");
  assert.equal(formatClockTime(1, "frames", 29.97), "29 f");
  assert.equal(formatClockTime(3600, "timecode", 30000 / 1001), "00:59:56:12");
  assert.equal(formatClockTime(3600, "frames", 30000 / 1001), "107892 f");
  assert.equal(formatClockTime(1 / 30, "frames", 30), "1 f");
  assert.equal(formatClockTime(3725, "timecode", 25), "01:02:05:00");
  // an unknown frame rate falls back to 30
  assert.equal(formatClockTime(2, "frames"), "60 f");
  assert.equal(formatClockTime(-5, "seconds"), "0:00.00");
  assert.equal(timeFormat("timecode"), "timecode");
  assert.equal(timeFormat("hours"), "seconds");
});

test("appearance reads stored values defensively and marks the root", () => {
  assert.equal(accentColor("teal"), "teal");
  assert.equal(accentColor("purple"), "violet");
  assert.equal(interfaceSize("large"), "large");
  assert.equal(interfaceSize(2), "default");
  const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  applyAppearance(root, { accent_color: "rose", animations: false });
  assert.equal(root.dataset.accent, "rose");
  assert.equal(root.dataset.motion, "off");
  applyAppearance(root, { accent_color: "violet", animations: true });
  assert.equal(root.dataset.accent, undefined);
  assert.equal(root.dataset.motion, undefined);
});

test("the interface size only calls the window when it changes", async () => {
  const calls: string[] = [];
  let ok = true;
  const resize = createInterfaceSizer(async (size) => {
    calls.push(size);
    return { ok };
  });
  await resize("default");
  await resize("large");
  await resize("large");
  ok = false;
  await resize("compact");
  // a failed change is tried again next time
  ok = true;
  await resize("compact");
  assert.deepEqual(calls, ["large", "compact", "compact"]);
});

test("a size picked while the window is still resizing is not skipped", async () => {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const resize = createInterfaceSizer((size) => {
    calls.push(size);
    return new Promise((resolve) => pending.push(() => resolve({ ok: true })));
  });
  const first = resize("large");
  while (calls.length < 1) await Promise.resolve();
  // picked while the window is still changing to large
  const second = resize("default");
  pending.shift()!();
  await first;
  while (calls.length < 2) await Promise.resolve();
  pending.shift()!();
  await second;
  assert.deepEqual(calls, ["large", "default"]);
});

function sessionFiles(enabled: { value: boolean }) {
  const saved: (readonly string[])[] = [];
  const timers: (() => void)[] = [];
  const files = createSessionFiles({
    enabled: () => enabled.value,
    save: async (paths) => {
      saved.push(paths);
    },
    schedule: (run) => {
      timers.push(run);
      return timers.length - 1;
    },
    cancel: (handle) => {
      timers[handle as number] = () => {};
    },
  });
  const runTimers = () => timers.splice(0).forEach((run) => run());
  return { files, saved, runTimers, scheduled: () => timers.length };
}

test("the Library is remembered once per change, and only while reopening is on", () => {
  const enabled = { value: true };
  const { files, saved, runTimers } = sessionFiles(enabled);
  files.remember(["a.mp4"]);
  files.track(["a.mp4"]);
  runTimers();
  assert.deepEqual(saved, []);
  files.track(["a.mp4", "b.mp4"]);
  files.track(["a.mp4", "b.mp4", "c.mp4"]);
  runTimers();
  assert.deepEqual(saved, [["a.mp4", "b.mp4", "c.mp4"]]);
  enabled.value = false;
  files.track(["a.mp4"]);
  runTimers();
  assert.equal(saved.length, 1);
});

test("repeated renders of the same Library don't keep pushing the save back", () => {
  const { files, saved, runTimers, scheduled } = sessionFiles({ value: true });
  files.track(["a.mp4"]);
  // the queue re-renders the Library every poll while the save is waiting
  for (let poll = 0; poll < 5; poll += 1) files.track(["a.mp4"]);
  assert.equal(scheduled(), 1);
  runTimers();
  assert.deepEqual(saved, [["a.mp4"]]);
});

test("turning reopening off forgets the list, and turning it on saves the current one", () => {
  const enabled = { value: false };
  const { files, saved } = sessionFiles(enabled);
  files.remember(["old.mp4"]);
  files.sync(["now.mp4"]);
  assert.deepEqual(saved, [[]]);
  files.sync(["now.mp4"]);
  assert.equal(saved.length, 1);
  enabled.value = true;
  files.sync(["now.mp4"]);
  assert.deepEqual(saved.at(-1), ["now.mp4"]);
});

test("only the first 500 videos are remembered", () => {
  const { files, saved, runTimers } = sessionFiles({ value: true });
  files.track(Array.from({ length: SESSION_FILES_MAX + 20 }, (_, index) => `${index}.mp4`));
  runTimers();
  assert.equal(saved[0]!.length, SESSION_FILES_MAX);
});

test("the finished notification counts only the batch that just ran", () => {
  const items: QueueItem[] = [
    { id: "a", state: "completed" },
    { id: "b", state: "completed" },
    { id: "c", state: "failed" },
    { id: "old", state: "completed" },
  ];
  assert.deepEqual(finishedNotification(items, { a: true, b: true }), {
    title: "Exports finished",
    body: "2 videos saved.",
  });
  assert.deepEqual(finishedNotification(items, { a: true, c: true }), {
    title: "Exports finished with problems",
    body: "1 video saved, 1 failed.",
  });
  assert.deepEqual(finishedNotification(items, { c: true }), {
    title: "Exports finished with problems",
    body: "1 video failed.",
  });
  // cancelling everything is not news
  assert.equal(finishedNotification([...items, { id: "d", state: "cancelled" }], { d: true }), null);
});

test("playback speed steps through the list and stops at both ends", () => {
  assert.equal(nextPlaybackSpeed(1, 1), 1.5);
  assert.equal(nextPlaybackSpeed(1, -1), 0.5);
  assert.equal(nextPlaybackSpeed(4, 1), 4);
  assert.equal(nextPlaybackSpeed(0.25, -1), 0.25);
  // a speed set elsewhere snaps to the nearest step first
  assert.equal(nextPlaybackSpeed(1.1, 1), 1.5);
  assert.deepEqual([...PLAYBACK_SPEEDS], [0.25, 0.5, 1, 1.5, 2, 4]);
});

test("cut points are segment edges and the video's own start and end", () => {
  const segments = [{ start: 2, end: 4 }, { start: 6, end: 8 }];
  assert.equal(cutPointNear(segments, 5, 1, 10), 6);
  assert.equal(cutPointNear(segments, 5, -1, 10), 4);
  // already on a cut point, the next press moves on
  assert.equal(cutPointNear(segments, 6, 1, 10), 8);
  assert.equal(cutPointNear(segments, 8, 1, 10), 10);
  assert.equal(cutPointNear(segments, 10, 1, 10), null);
  assert.equal(cutPointNear(segments, 0, -1, 10), null);
  assert.equal(cutPointNear([], 3, -1, 10), 0);
});
