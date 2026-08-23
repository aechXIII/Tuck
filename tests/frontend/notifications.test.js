"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const notifications = require("../../tuck/web/notifications.js");

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
