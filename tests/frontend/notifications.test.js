"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const notifications = require("../../frontend/public/legacy/notifications.js");

test("notification semantics announce errors urgently and other updates politely", () => {
  assert.deepEqual(notifications.presentation("err"), {
    kind: "err",
    role: "alert",
    live: "assertive",
    duration: 6000,
  });
  assert.deepEqual(notifications.presentation("ok"), {
    kind: "ok",
    role: "status",
    live: "polite",
    duration: 3500,
  });
  assert.deepEqual(notifications.presentation(""), {
    kind: "info",
    role: "status",
    live: "polite",
    duration: 3500,
  });
});

test("notification messages render untrusted markup as text", () => {
  const created = [];
  const document = {
    createElement(tagName) {
      const element = {
        tagName,
        className: "",
        children: [],
        textContent: "",
      };
      created.push(element);
      return element;
    },
  };
  const payload = '<img src=x onerror="globalThis.pwned=true">';

  const message = notifications.createMessageElement(document, payload);

  assert.equal(created.length, 1);
  assert.equal(message.tagName, "span");
  assert.equal(message.className, "tmsg");
  assert.equal(message.textContent, payload);
  assert.deepEqual(message.children, []);
});
