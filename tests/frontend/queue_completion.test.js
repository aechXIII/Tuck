"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const dom = require("../../frontend/public/legacy/dom.js");
const { queueCompletionOutput } = require("../../frontend/public/legacy/queue.js");

function queueHarness(items, previousState) {
  const elements = {};
  [
    "qbar",
    "q-active",
    "qidle",
    "qcnt",
    "qprog",
    "qeta",
    "qfname",
    "btn-stop-after",
    "btn-cancel",
    "btn-clear",
  ].forEach((id) => {
    elements[id] = {
      classList: { toggle() {} },
      disabled: false,
      textContent: "",
      value: 0,
    };
  });
  const toasts = [];
  const context = {
    api: {
      async getQueueState() {
        return { ok: true, value: { items } };
      },
    },
    appSettings: {
      clear_completed_automatically: false,
      open_output_folder_after_queue: false,
    },
    byId(id) {
      return elements[id];
    },
    clipReorder: null,
    clips: {
      "video.mp4": {
        name: "video.mp4",
        _queueState: previousState,
      },
    },
    errorSummary(value) {
      return value;
    },
    esc: dom.escapeHtml,
    fmtt() {
      return "0:10";
    },
    lastQueueHadActive: true,
    async legacyBackendResult(call) {
      const result = await call;
      return result.ok
        ? Object.assign({ ok: true }, result.value)
        : { ok: false, error: result.error.message };
    },
    renderClips() {},
    setTimeout,
    toast(message, type) {
      toasts.push({ message, type });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../frontend/public/legacy/queue.js"), "utf8"),
    context,
  );
  return { context, elements, toasts };
}

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

test("queue completion produces one notification after active work drains", async () => {
  const { context, toasts } = queueHarness(
    [
      {
        id: "current",
        source_path: "video.mp4",
        source: "video.mp4",
        state: "completed",
        progress: 100,
        finished_at: "2026-08-15T09:00:00+00:00",
      },
    ],
    "running",
  );

  await context.pollQueue();

  assert.deepEqual(toasts, [{ message: "Processing completed.", type: "ok" }]);
});

test("queue failure notifications preserve literal file and error text", () => {
  const { context, toasts } = queueHarness([], "running");
  context.clips["video.mp4"].name = "A&B <clip>";

  context.mapQueueItems([
    {
      id: "failed",
      source_path: "video.mp4",
      state: "failed",
      error: "bad & <error>",
    },
  ]);

  assert.deepEqual(toasts, [
    {
      message: 'Failed to process "A&B <clip>": bad & <error>',
      type: "err",
    },
  ]);
});

test("idle queue disables active actions but keeps clear available for completed work", async () => {
  const { context, elements } = queueHarness(
    [
      {
        id: "current",
        source_path: "video.mp4",
        source: "video.mp4",
        state: "completed",
        progress: 100,
      },
    ],
    "completed",
  );

  await context.pollQueue();

  assert.equal(elements["btn-stop-after"].disabled, true);
  assert.equal(elements["btn-cancel"].disabled, true);
  assert.equal(elements["btn-clear"].disabled, false);
});

test("active queue enables stop and cancel but not clear without completed work", async () => {
  const { context, elements } = queueHarness(
    [
      {
        id: "current",
        source_path: "video.mp4",
        source: "video.mp4",
        state: "pending",
        progress: 0,
      },
    ],
    null,
  );
  context.lastQueueHadActive = false;

  await context.pollQueue();

  assert.equal(elements["btn-stop-after"].disabled, false);
  assert.equal(elements["btn-cancel"].disabled, false);
  assert.equal(elements["btn-clear"].disabled, true);
});
