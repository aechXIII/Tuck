"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { queueCompletionOutput } = require("../../tuck/web/queue.js");

const items = [
  {
    id: "first",
    state: "completed",
    result_path: "C:\\exports\\first.mp4",
    finished_at: "2026-08-15T09:00:00+00:00",
  },
  {
    id: "failed",
    state: "failed",
    result_path: "",
    finished_at: "2026-08-15T09:02:00+00:00",
  },
  {
    id: "last",
    state: "completed",
    result_path: "C:\\exports\\last.mp4",
    finished_at: "2026-08-15T09:01:00+00:00",
  },
];

test("queue completion opens the latest successful output once active work drains", () => {
  assert.equal(
    queueCompletionOutput(items, true, 0, {
      first: true,
      failed: true,
      last: true,
    }),
    "C:\\exports\\last.mp4",
  );
  assert.equal(queueCompletionOutput(items, false, 0), "");
  assert.equal(queueCompletionOutput(items, true, 1), "");
});

test("queue completion ignores successful output left from an earlier queue", () => {
  assert.equal(
    queueCompletionOutput(
      [
        {
          id: "old",
          state: "completed",
          result_path: "C:\\exports\\old.mp4",
          finished_at: "2026-08-15T08:00:00+00:00",
        },
        {
          id: "current",
          state: "failed",
          result_path: "",
          finished_at: "2026-08-15T09:00:00+00:00",
        },
      ],
      true,
      0,
      { current: true },
    ),
    "",
  );
});

test("queue completion ignores queues without a successful output", () => {
  assert.equal(
    queueCompletionOutput(
      [
        {
          state: "failed",
          result_path: "",
          finished_at: "2026-08-15T09:00:00+00:00",
        },
      ],
      true,
      0,
    ),
    "",
  );
});
