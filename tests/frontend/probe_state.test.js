"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const probeState = require("../../frontend/public/legacy/probe-state.js");

test("probe failure preserves the bridge error and leaves a retryable state", () => {
  const clip = {
    probed: false,
    probing: true,
    probeData: null,
    error: "",
  };

  const result = probeState.complete(clip, {
    ok: false,
    error: "FFprobe could not read this file",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "FFprobe could not read this file",
  });
  assert.equal(clip.probing, false);
  assert.equal(clip.probed, false);
  assert.equal(clip.probeData, null);
  assert.equal(clip.error, "FFprobe could not read this file");
  assert.equal(probeState.status(clip), "error");
});

test("retry clears the failure before starting another probe", () => {
  const clip = {
    probed: false,
    probing: false,
    probeData: null,
    error: "Probe failed",
  };

  assert.equal(probeState.begin(clip), true);
  assert.equal(clip.probing, true);
  assert.equal(clip.error, "");
  assert.equal(probeState.status(clip), "loading");
});

test("a successful retry replaces the failed state with probe data", () => {
  const clip = {
    probed: false,
    probing: true,
    probeData: null,
    error: "",
  };
  const data = { duration: 12.5, width: 1920, height: 1080 };

  assert.deepEqual(probeState.complete(clip, { ok: true, data }), {
    ok: true,
    data,
  });
  assert.equal(clip.probing, false);
  assert.equal(clip.probed, true);
  assert.equal(clip.probeData, data);
  assert.equal(clip.error, "");
  assert.equal(probeState.status(clip), "ready");
});

test("failed or loading clips are not ready for editing and export", () => {
  const failed = { probed: false, probing: false, probeData: null, error: "Failed" };
  const loading = { probed: false, probing: true, probeData: null, error: "" };
  const ready = {
    probed: true,
    probing: false,
    probeData: { duration: 12.5 },
    error: "",
  };

  assert.equal(probeState.isReady(failed), false);
  assert.equal(probeState.isReady(loading), false);
  assert.equal(probeState.isReady(ready), true);
  assert.equal(probeState.allReady({ failed, ready }), false);
  assert.equal(probeState.allReady({ ready }), true);
});
