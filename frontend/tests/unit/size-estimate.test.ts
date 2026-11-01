import assert from "node:assert/strict";
import test from "node:test";

import type { BackendResult, PlanRequest } from "../../src/backend/types.ts";
import type { SizeEstimatePayload } from "../../src/backend/size-estimate-types.ts";
import {
  createSizeEstimates,
  estimateKey,
  estimateLabel,
  estimateNumber,
  estimateTip,
} from "../../src/features/export/size-estimate.ts";

const MB = 1024 * 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function request(level: number, source = "a.mp4"): PlanRequest {
  return { source, rate_control_method: "crf", crf: level, _request_id: level } as unknown as PlanRequest;
}

function harness(answer: (request: PlanRequest) => BackendResult<SizeEstimatePayload>) {
  const asked: number[] = [];
  let cancels = 0;
  let paints = 0;
  const estimates = createSizeEstimates({
    estimate: async (req) => {
      asked.push(Number((req as unknown as { crf: number }).crf));
      await tick();
      return answer(req);
    },
    cancel: () => { cancels += 1; },
    paint: () => { paints += 1; },
    settleMs: 1,
  });
  return { estimates, asked, cancels: () => cancels, paints: () => paints };
}

const ok = (mb: number): BackendResult<SizeEstimatePayload> => ({
  ok: true,
  value: { size_bytes: mb * MB, video_bytes: mb * MB, audio_bytes: 0, sampled_seconds: 3, encoder: "libx264" },
});
const fail = (code: string, message = "FFmpeg stopped"): BackendResult<SizeEstimatePayload> => ({
  ok: false,
  error: { code, message, details: {} },
});

test("the key ignores the request id, so the same settings share one result", () => {
  assert.equal(estimateKey(request(23)), estimateKey({ ...request(23), _request_id: 99 } as PlanRequest));
  assert.notEqual(estimateKey(request(23)), estimateKey(request(23, "b.mp4")));
});

test("labels follow the stage and round like the card", () => {
  assert.equal(estimateNumber(120.4), "120");
  assert.equal(estimateNumber(4.26), "4.3");
  assert.equal(estimateLabel({ state: "done", sizeMb: 96.2, reason: "" }), "About 96 MB");
  assert.equal(estimateLabel({ state: "running", sizeMb: 0, reason: "" }), "Estimating");
  assert.equal(estimateLabel({ state: "waiting", sizeMb: 0, reason: "" }), "After export");
  assert.equal(estimateLabel({ state: "failed", sizeMb: 0, reason: "x" }), "No estimate");
  assert.equal(estimateTip({ state: "failed", sizeMb: 0, reason: "FFmpeg stopped" }), "No estimate: FFmpeg stopped");
  assert.equal(estimateTip({ state: "done", sizeMb: 96.2, reason: "" }), "Use 96 MB as the size");
});

test("it waits for the settings to settle, then shows the result", async () => {
  const h = harness(() => ok(96));
  h.estimates.update(request(23), false);
  assert.equal(h.estimates.view().state, "running");
  assert.deepEqual(h.asked, []);
  await tick();
  await tick();
  assert.deepEqual(h.asked, [23]);
  assert.equal(h.estimates.view().state, "done");
  assert.equal(Math.round(h.estimates.view().sizeMb), 96);
});

test("a change starts over and an earlier answer is dropped", async () => {
  const h = harness((req) => ok(Number((req as unknown as { crf: number }).crf)));
  h.estimates.update(request(23), false);
  await new Promise((resolve) => setTimeout(resolve, 2));
  h.estimates.update(request(28), false);
  assert.equal(h.estimates.view().state, "running");
  await tick();
  await tick();
  await tick();
  assert.equal(h.estimates.view().state, "done");
  assert.equal(Math.round(h.estimates.view().sizeMb), 28);
});

test("results are kept per video and settings", async () => {
  const h = harness(() => ok(50));
  h.estimates.update(request(23), false);
  await tick();
  await tick();
  h.estimates.update(request(28), false);
  h.estimates.update(request(23), false);
  assert.equal(h.estimates.view().state, "done");
  await tick();
  await tick();
  assert.deepEqual(h.asked, [23]);
});

test("it waits while an export runs and starts once the exports finish", async () => {
  const h = harness(() => ok(40));
  h.estimates.update(request(23), true);
  assert.equal(h.estimates.view().state, "waiting");
  await tick();
  assert.deepEqual(h.asked, []);
  h.estimates.update(request(23), false);
  assert.equal(h.estimates.view().state, "running");
  await tick();
  await tick();
  assert.equal(h.estimates.view().state, "done");
});

test("the backend's export_running answer also waits, and a failure keeps its reason", async () => {
  const busy = harness(() => fail("export_running", "Tuck estimates the size once the exports finish."));
  busy.estimates.update(request(23), false);
  await tick();
  await tick();
  assert.equal(busy.estimates.view().state, "waiting");
  const broken = harness(() => fail("failed"));
  broken.estimates.update(request(23), false);
  await tick();
  await tick();
  assert.deepEqual(broken.estimates.view(), { state: "failed", sizeMb: 0, reason: "FFmpeg stopped" });
  // the same settings don't encode again
  broken.estimates.update(request(24), false);
  broken.estimates.update(request(23), false);
  assert.equal(broken.estimates.view().state, "failed");
});

test("nothing to estimate stops the running one and goes back to Auto", async () => {
  const h = harness(() => ok(10));
  h.estimates.update(request(23), false);
  await new Promise((resolve) => setTimeout(resolve, 2));
  h.estimates.update(null, false);
  assert.equal(h.estimates.view().state, "idle");
  assert.equal(h.cancels(), 1);
  await tick();
  await tick();
  assert.equal(h.estimates.view().state, "idle");
});
