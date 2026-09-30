import assert from "node:assert/strict";
import test from "node:test";

import * as clipCards from "../../src/features/library/clip-card.ts";
import type {
  ClipCardElement,
  ClipCardEvent,
} from "../../src/features/library/clip-card.ts";

class FakeElement implements ClipCardElement {
  tagName: string;
  className = "";
  textContent: string | null = "";
  type?: string;
  children: FakeElement[] = [];
  dataset: { [key: string]: string | undefined } = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: ClipCardEvent) => void>> = {};
  parentElement: FakeElement | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set innerHTML(_value: string) {
    throw new Error("clip cards must not use innerHTML");
  }

  appendChild(child: ClipCardElement): ClipCardElement {
    if (!(child instanceof FakeElement)) {
      throw new Error("expected FakeElement");
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  addEventListener(type: string, listener: (event: ClipCardEvent) => void): void {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }
}

const documentRef = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
};

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function action(root: FakeElement, name: string): FakeElement | undefined {
  return descendants(root).find((element) => element.dataset.clipAction === name);
}

test("clip cards keep backend data inert and delegate exact action values", () => {
  const calls: Array<[string, string | undefined]> = [];
  const model = {
    path: `C:\\video'\" onclick=\"globalThis.pwned=true.mp4`,
    name: '<img src=x onerror="globalThis.pwned=true">',
    selected: true,
    queueItemId: `queue-'\" dangerous`,
    queueState: "completed",
    resultPath: `C:\\result-'\" dangerous.mp4`,
    statusLabel: '<b onmouseover="globalThis.pwned=true">Done</b>',
    meta: { text: '<svg onload="globalThis.pwned=true">' },
    detail: '<img src=x onerror="globalThis.pwned=true">',
    thumbnail: 'x" onerror="globalThis.pwned=true',
    resultSize: "9.7 MB",
  };
  const callbacks = {
    select: (path: string) => calls.push(["select", path]),
    togglePlay: (path: string) => calls.push(["play", path]),
    remove: (path: string) => calls.push(["remove", path]),
    openResult: (path: string | undefined) => calls.push(["open", path]),
    retry: (id: string | undefined) => calls.push(["retry", id]),
    beginReorder: (_event: ClipCardEvent, path: string) =>
      calls.push(["reorder", path]),
  };

  const created = clipCards.createClipCard(documentRef, model, callbacks);
  if (!(created instanceof FakeElement)) throw new Error("expected FakeElement");
  const card = created;

  const text = descendants(card)
    .map((element) => element.textContent)
    .join(" ");
  assert.match(text, /globalThis\.pwned=true/);
  assert.equal(
    card.attributes["aria-keyshortcuts"],
    "Enter Space Delete ArrowUp ArrowDown",
  );
  // the picture's address is an attribute, never markup
  const image = descendants(card).find((element) => element.tagName === "img");
  assert.ok(image);
  assert.equal(image.attributes.src, model.thumbnail);
  assert.equal(image.attributes.alt, "");
  const line = descendants(card).find((element) => element.className === "c-line done");
  assert.ok(line);
  assert.equal(line.children[0]?.textContent, "9.7 MB");
  assert.equal(card.attributes["aria-description"], model.detail);
  const open = action(card, "open-result");
  assert.ok(open);
  assert.equal(open.textContent, "Show");
  assert.equal(open.attributes.onclick, undefined);
  const click = card.listeners.click?.[0];
  assert.ok(click);
  click({ target: open, stopPropagation() {} });
  assert.deepEqual(calls.pop(), ["open", model.resultPath]);
  const remove = action(card, "remove");
  assert.ok(remove);
  click({ target: remove, stopPropagation() {} });
  assert.deepEqual(calls.pop(), ["remove", model.path]);
  let prevented = false;
  const keydown = card.listeners.keydown?.[0];
  assert.ok(keydown);
  keydown({
    key: "Delete",
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(calls.pop(), ["remove", model.path]);
  assert.equal((globalThis as { pwned?: unknown }).pwned, undefined);
});

test("library lists problems first and keeps every other video in the order it was given", () => {
  const clips = [
    { path: "ready-a.mp4", name: "ready-a.mp4", queueState: "" },
    { path: "queued-a.mp4", name: "queued-a.mp4", queueState: "pending" },
    { path: "failed.mp4", name: "failed.mp4", queueState: "failed" },
    { path: "encoding-a.mp4", name: "encoding-a.mp4", queueState: "running" },
    { path: "done.mp4", name: "done.mp4", queueState: "completed" },
  ];

  assert.deepEqual(
    clipCards.groupClipModels(clips).map((group) => ({
      key: group.key,
      label: group.label,
      paths: group.items.map((clip) => clip.path),
    })),
    [
      { key: "attention", label: "Needs attention", paths: ["failed.mp4"] },
      { key: "videos", label: "Videos", paths: ["ready-a.mp4", "queued-a.mp4", "encoding-a.mp4", "done.mp4"] },
    ],
  );
  assert.deepEqual(clipCards.groupedClipPaths(clips), [
    "failed.mp4",
    "ready-a.mp4",
    "queued-a.mp4",
    "encoding-a.mp4",
    "done.mp4",
  ]);
  assert.equal(
    clipCards.groupHeading({ key: "videos", label: "Videos", items: [{ path: "a", name: "a" }, { path: "b", name: "b" }] }),
    "Videos · 2",
  );
});

test("failed exports and unreadable files need attention and say so briefly", () => {
  const clips = [
    { path: "ready.mp4", name: "ready.mp4", queueState: "cancelled" },
    { path: "failed.mp4", name: "failed.mp4", queueState: "failed", queueItemId: "q1" },
    { path: "broken.mp4", name: "broken.mp4", queueState: "", probeError: true },
  ];
  assert.deepEqual(
    clipCards.groupClipModels(clips).map((group) => [group.key, group.items.map((clip) => clip.path)]),
    [["attention", ["failed.mp4", "broken.mp4"]], ["videos", ["ready.mp4"]]],
  );
  assert.equal(
    clipCards.groupHeading({ key: "attention", label: "Needs attention", items: clips.slice(1) }),
    "Needs attention · 2",
  );

  const noop = () => {};
  const created = clipCards.createClipCard(
    documentRef,
    { path: "broken.mp4", name: "broken.mp4", probeError: true, statusLabel: "Can't read file", detail: "moov atom not found" },
    { select: noop, togglePlay: noop, remove: noop, openResult: noop, retry: noop, beginReorder: noop },
  );
  if (!(created instanceof FakeElement)) throw new Error("expected FakeElement");
  assert.ok(descendants(created).find((element) => element.className === "c-thumb unreadable"));
  const status = descendants(created).find((element) => element.className === "c-status attention");
  assert.ok(status);
  assert.equal(status.textContent, "Can't read file");
  assert.equal(status.dataset.tip, "moov atom not found");
  assert.equal(created.attributes["aria-description"], "moov atom not found");
  const retry = action(created, "retry-probe");
  assert.ok(retry);
  assert.equal(retry.textContent, "Retry");
  assert.equal(retry.attributes["aria-label"], "Retry reading broken.mp4");
});

const quiet = { select() {}, togglePlay() {}, remove() {}, openResult() {}, retry() {}, beginReorder() {} };

test("a queued or exporting row says where it is and leaves its controls to the Exports panel", () => {
  const queued = clipCards.createClipCard(documentRef, {
    path: "queued.mp4",
    name: "queued.mp4",
    queueItemId: "q1",
    queueState: "pending",
    statusLabel: "Pending",
    duration: "1:35",
  }, quiet);
  if (!(queued instanceof FakeElement)) throw new Error("expected FakeElement");
  const queuedLine = descendants(queued).find((element) => element.className === "c-line queued");
  assert.equal(queuedLine?.children[0]?.textContent, "Queued");
  assert.equal(descendants(queued).find((element) => element.className === "c-dur")?.textContent, "1:35");
  assert.equal(action(queued, "cancel"), undefined);
  assert.equal(action(queued, "remove"), undefined);

  const running = clipCards.createClipCard(documentRef, {
    path: "running.mp4",
    name: "running.mp4",
    queueItemId: "q2",
    queueState: "running",
    statusLabel: "Pass 1 of 2 · 42% · 1.3x · ETA 1:23",
    progress: 42.4,
  }, quiet);
  if (!(running instanceof FakeElement)) throw new Error("expected FakeElement");
  const bar = descendants(running).find((element) => element.attributes.role === "progressbar");
  assert.ok(bar);
  assert.equal(bar.attributes["aria-valuenow"], "42");
  assert.equal(bar.parentElement?.className, "c-thumb");
  assert.equal(descendants(running).find((element) => element.className === "c-line run")?.children[0]?.textContent, "Pass 1 of 2 · 42%");
});

test("a ready row says what the task makes of the video, and warns when it runs over the target", () => {
  const ready = clipCards.createClipCard(documentRef, {
    path: "beach.mp4",
    name: "beach.mp4",
    result: { from: "1.2 GB", to: "10.0 MB" },
  }, quiet);
  if (!(ready instanceof FakeElement)) throw new Error("expected FakeElement");
  const line = descendants(ready).find((element) => element.className === "c-line");
  assert.deepEqual(line?.children.map((element) => [element.className, element.textContent]), [
    ["c-from", "1.2 GB"],
    ["c-arrow", "→"],
    ["c-to", "10.0 MB"],
  ]);

  const over = clipCards.createClipCard(documentRef, {
    path: "long.mp4",
    name: "long.mp4",
    result: { from: "4.0 GB", to: "14.2 MB", over: true },
  }, quiet);
  if (!(over instanceof FakeElement)) throw new Error("expected FakeElement");
  const overLine = descendants(over).find((element) => element.className === "c-line");
  assert.equal(overLine?.children.at(-1)?.className, "c-to over");
  assert.equal(overLine?.attributes.title, "The estimate is over the target size");
});

test("library omits empty status sections and reports a hand-checked summary", () => {
  const clips = [
    { path: "one.mp4", name: "one.mp4", queueState: "", fileSize: 1_500_000_000 },
    { path: "two.mp4", name: "two.mp4", queueState: "failed", fileSize: 540_000_000 },
    { path: "three.mp4", name: "three.mp4", queueState: "cancelled", fileSize: 0 },
  ];

  const groups = clipCards.groupClipModels(clips);
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.length]),
    [["attention", 1], ["videos", 2]],
  );
  assert.deepEqual(clipCards.librarySummary(clips), {
    countLabel: "3 videos",
    sizeLabel: "1.9 GB",
  });
});
