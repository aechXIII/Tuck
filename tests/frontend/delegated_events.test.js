"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const delegatedEvents = require("../../frontend/src/ui/delegated-events.ts");

class FakeElement {
  constructor(parentElement = null) {
    this.parentElement = parentElement;
    this.dataset = {};
    this.listeners = {};
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
}

test("delegated actions dispatch an explicit event-specific handler", () => {
  const root = new FakeElement();
  const button = new FakeElement(root);
  const icon = new FakeElement(button);
  const calls = [];
  button.dataset.actionClick = "save-general";

  delegatedEvents.bind(root, {
    click: {
      "save-general": (target, event) => calls.push([target, event.type]),
    },
  });

  let prevented = false;
  root.listeners.click({
    type: "click",
    target: icon,
    preventDefault() {
      prevented = true;
    },
  });

  assert.deepEqual(calls, [[button, "click"]]);
  assert.equal(prevented, true);
});

test("unknown and cross-event action names are inert", () => {
  const root = new FakeElement();
  const input = new FakeElement(root);
  const calls = [];
  input.dataset.actionInput = "preview-output";
  input.dataset.actionClick = "not-registered";

  delegatedEvents.bind(root, {
    click: {},
    input: { "preview-output": () => calls.push("input") },
  });

  root.listeners.click({ target: input, preventDefault() {} });
  root.listeners.input({ target: input });

  assert.deepEqual(calls, ["input"]);
});

test("actions outside the bound root are ignored", () => {
  const root = new FakeElement();
  const outside = new FakeElement();
  const calls = [];
  outside.dataset.actionChange = "mark-dirty";

  delegatedEvents.bind(root, {
    change: { "mark-dirty": () => calls.push("change") },
  });
  root.listeners.change({ target: outside });

  assert.deepEqual(calls, []);
});

test("a bound root action does not intercept native descendant clicks", () => {
  const root = new FakeElement();
  const nativeControl = new FakeElement(root);
  const calls = [];
  root.dataset.settingsClick = "close-overlay";

  delegatedEvents.bind(
    root,
    {
      click: {
        "close-overlay": () => calls.push("overlay"),
      },
    },
    "settings",
  );

  let prevented = false;
  root.listeners.click({
    target: nativeControl,
    preventDefault() {
      prevented = true;
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(prevented, false);
});

test("registries accept late module registration and reject duplicate owners", () => {
  const root = new FakeElement();
  const button = new FakeElement(root);
  const calls = [];
  button.dataset.actionClick = "queue-clear";
  const registry = delegatedEvents.createRegistry(root);

  registry.register("click", {
    "queue-clear": () => calls.push("clear"),
  });
  root.listeners.click({ target: button, preventDefault() {} });

  assert.deepEqual(calls, ["clear"]);
  assert.throws(
    () => registry.register("click", { "queue-clear": () => {} }),
    /already registered/,
  );
});
