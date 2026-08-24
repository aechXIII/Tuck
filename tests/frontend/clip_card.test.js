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
