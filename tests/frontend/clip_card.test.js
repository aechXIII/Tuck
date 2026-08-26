"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clipCards = require("../../tuck/web/clip-card.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.parentElement = null;
  }

  set innerHTML(_value) {
    throw new Error("clip cards must not use innerHTML");
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }
}

const document = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

function descendants(root) {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function action(root, name) {
  return descendants(root).find((element) => element.dataset.clipAction === name);
}

test("clip cards keep backend data inert and delegate exact action values", () => {
  const calls = [];
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
    select: (path) => calls.push(["select", path]),
    togglePlay: (path) => calls.push(["play", path]),
    remove: (path) => calls.push(["remove", path]),
    openResult: (path) => calls.push(["open", path]),
    cancel: (id) => calls.push(["cancel", id]),
    retry: (id) => calls.push(["retry", id]),
    beginReorder: (_event, path) => calls.push(["reorder", path]),
  };

  const card = clipCards.createClipCard(document, model, callbacks);

  const text = descendants(card).map((element) => element.textContent).join(" ");
  assert.match(text, /globalThis\.pwned=true/);
  assert.equal(card.attributes["aria-keyshortcuts"], "Enter Space Delete ArrowUp ArrowDown");
  const badge = descendants(card).find((element) => element.className.includes("cst-completed"));
  assert.equal(badge.attributes.role, "img");
  assert.equal(badge.attributes["aria-label"], "Completed");
  assert.ok(descendants(card).some((element) => element.className === "c-error"));
  const open = action(card, "open-result");
  assert.ok(open);
  assert.equal(open.attributes.onclick, undefined);
  card.listeners.click[0]({ target: open, stopPropagation() {} });
  assert.deepEqual(calls.pop(), ["open", model.resultPath]);
  const remove = action(card, "remove");
  card.listeners.click[0]({ target: remove, stopPropagation() {} });
  assert.deepEqual(calls.pop(), ["remove", model.path]);
  let prevented = false;
  card.listeners.keydown[0]({
    key: "Delete",
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(calls.pop(), ["remove", model.path]);
  assert.equal(globalThis.pwned, undefined);
});

test("library groups active work ahead of queued and ready clips without reordering within a group", () => {
  const clips = [
    { path: "ready-a.mp4", queueState: "" },
    { path: "queued-a.mp4", queueState: "pending" },
    { path: "encoding-a.mp4", queueState: "running" },
    { path: "ready-b.mp4", queueState: "completed" },
    { path: "encoding-b.mp4", queueState: "processing" },
    { path: "queued-b.mp4", queueState: "pending" },
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
  assert.equal(clipCards.groupHeading({ key: "encoding", label: "Encoding", items: [{}, {}] }), "Encoding");
  assert.equal(clipCards.groupHeading({ key: "queued", label: "Queued", items: [{}] }), "Queued · 1");
  assert.equal(clipCards.groupHeading({ key: "ready", label: "Ready", items: [{}, {}] }), "Ready · 2");
});

test("queued cards use their compact badge as the per-item cancel action", () => {
  const calls = [];
  const card = clipCards.createClipCard(
    document,
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
      cancel(id) { calls.push(id); },
      retry() {},
      beginReorder() {},
    },
  );

  const badge = descendants(card).find((element) => element.className === "c-queue-badge");
  assert.equal(badge.textContent, "QUEUED");
  assert.equal(
    descendants(card).find((element) => element.className === "c-status-row"),
    undefined,
  );
  assert.equal(action(card, "cancel"), badge);
  assert.equal(badge.attributes["aria-label"], "Cancel queued export");
  card.listeners.click[0]({ target: badge, stopPropagation() {} });
  assert.deepEqual(calls, ["q1"]);
});

test("library omits empty status sections and reports a hand-checked summary", () => {
  const clips = [
    { path: "one.mp4", queueState: "", fileSize: 1_500_000_000 },
    { path: "two.mp4", queueState: "failed", fileSize: 540_000_000 },
    { path: "three.mp4", queueState: "cancelled", fileSize: 0 },
  ];

  const groups = clipCards.groupClipModels(clips);
  assert.deepEqual(groups.map((group) => [group.key, group.items.length]), [
    ["ready", 3],
  ]);
  assert.deepEqual(clipCards.librarySummary(clips), {
    countLabel: "3 videos",
    sizeLabel: "1.9 GB",
  });
});
