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
    meta: { text: '<svg onload="globalThis.pwned=true">', error: true },
    badge: { className: "cst-completed", label: "Completed", icon: "✓" },
  };
  const callbacks = {
    select: (path: string) => calls.push(["select", path]),
    togglePlay: (path: string) => calls.push(["play", path]),
    remove: (path: string) => calls.push(["remove", path]),
    openResult: (path: string | undefined) => calls.push(["open", path]),
    cancel: (id: string | undefined) => calls.push(["cancel", id]),
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
  const badge = descendants(card).find((element) =>
    element.className.includes("cst-completed"),
  );
  assert.ok(badge);
  assert.equal(badge.attributes.role, "img");
  assert.equal(badge.attributes["aria-label"], "Completed");
  assert.ok(descendants(card).some((element) => element.className === "c-error"));
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

test("library groups active work ahead of queued and ready clips without reordering within a group", () => {
  const clips = [
    { path: "ready-a.mp4", name: "ready-a.mp4", queueState: "" },
    { path: "queued-a.mp4", name: "queued-a.mp4", queueState: "pending" },
    { path: "encoding-a.mp4", name: "encoding-a.mp4", queueState: "running" },
    { path: "ready-b.mp4", name: "ready-b.mp4", queueState: "completed" },
    { path: "encoding-b.mp4", name: "encoding-b.mp4", queueState: "processing" },
    { path: "queued-b.mp4", name: "queued-b.mp4", queueState: "pending" },
  ];

  assert.deepEqual(
    clipCards.groupClipModels(clips).map((group) => ({
      key: group.key,
      label: group.label,
      paths: group.items.map((clip) => clip.path),
    })),
    [
      {
        key: "encoding",
        label: "Encoding",
        paths: ["encoding-a.mp4", "encoding-b.mp4"],
      },
      {
        key: "queued",
        label: "Queued",
        paths: ["queued-a.mp4", "queued-b.mp4"],
      },
      {
        key: "ready",
        label: "Ready",
        paths: ["ready-a.mp4", "ready-b.mp4"],
      },
    ],
  );
  assert.deepEqual(clipCards.groupedClipPaths(clips), [
    "encoding-a.mp4",
    "encoding-b.mp4",
    "queued-a.mp4",
    "queued-b.mp4",
    "ready-a.mp4",
    "ready-b.mp4",
  ]);
  assert.equal(
    clipCards.groupHeading({
      key: "encoding",
      label: "Encoding",
      items: [{ path: "a", name: "a" }, { path: "b", name: "b" }],
    }),
    "Encoding",
  );
  assert.equal(
    clipCards.groupHeading({
      key: "queued",
      label: "Queued",
      items: [{ path: "a", name: "a" }],
    }),
    "Queued · 1",
  );
  assert.equal(
    clipCards.groupHeading({
      key: "ready",
      label: "Ready",
      items: [{ path: "a", name: "a" }, { path: "b", name: "b" }],
    }),
    "Ready · 2",
  );
});

test("queued cards use their compact badge as the per-item cancel action", () => {
  const calls: string[] = [];
  const created = clipCards.createClipCard(
    documentRef,
    {
      path: "queued.mp4",
      name: "queued.mp4",
      selected: false,
      queueItemId: "q1",
      queueState: "pending",
      statusLabel: "Pending",
      meta: { text: "3840×2160 · 1.4 GB", error: false },
    },
    {
      select() {},
      togglePlay() {},
      remove() {},
      openResult() {},
      cancel(id) {
        if (id !== undefined) calls.push(id);
      },
      retry() {},
      beginReorder() {},
    },
  );
  if (!(created instanceof FakeElement)) throw new Error("expected FakeElement");
  const card = created;

  const badge = descendants(card).find(
    (element) => element.className === "c-queue-badge",
  );
  assert.ok(badge);
  assert.equal(badge.textContent, "QUEUED");
  assert.equal(
    descendants(card).find((element) => element.className === "c-status-row"),
    undefined,
  );
  assert.equal(action(card, "cancel"), badge);
  assert.equal(badge.attributes["aria-label"], "Cancel queued export");
  const click = card.listeners.click?.[0];
  assert.ok(click);
  click({ target: badge, stopPropagation() {} });
  assert.deepEqual(calls, ["q1"]);
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
    [["ready", 3]],
  );
  assert.deepEqual(clipCards.librarySummary(clips), {
    countLabel: "3 videos",
    sizeLabel: "1.9 GB",
  });
});
