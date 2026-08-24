"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clipDetails = require("../../tuck/web/clip-details.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.parentElement = null;
  }

  set innerHTML(_value) {
    throw new Error("clip details must not use innerHTML");
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
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

test("probe errors render as text and retry with the exact source path", () => {
  const host = new FakeElement("div");
  const calls = [];
  const path = `C:\\clip-'\" onclick=\"globalThis.pwned=true.mp4`;
  const error = '<img src=x onerror="globalThis.pwned=true">';

  clipDetails.render(document, host, { state: "error", path, error }, (value) => {
    calls.push(value);
  });

  const text = descendants(host).map((element) => element.textContent).join(" ");
  assert.match(text, /globalThis\.pwned=true/);
  const retry = descendants(host).find((element) => element.textContent === "Retry");
  assert.ok(retry);
  assert.equal(retry.attributes.onclick, undefined);
  retry.listeners.click[0]();
  assert.deepEqual(calls, [path]);
  assert.equal(globalThis.pwned, undefined);
});
