import test from "node:test";
import assert from "node:assert/strict";
import { parseCustomWeights, weightPreview } from "../../src/features/export/frame-blending.ts";

test("custom weights preserve invalid input for validation", () => {
  assert.deepEqual(parseCustomWeights("1, 2 3"), [1, 2, 3]);
  assert.deepEqual(parseCustomWeights(""), []);
  assert.ok(Number.isNaN(parseCustomWeights("1, nope")[1]));
});
const previewSettings = {enabled:true,amount:1,curve:"equal",sigma:.25,peak:.5,power:1,custom_weights:[],linear_light:false};
test("weight preview shows the selected curve and custom weights", () => {
  assert.deepEqual(weightPreview(previewSettings), Array(32).fill(1));
  const rising = weightPreview({...previewSettings,curve:"ascending"});
  assert.ok(rising[0]! < rising[31]!);
  assert.deepEqual(weightPreview({...previewSettings,curve:"descending"}), [...rising].reverse());
  const bell = weightPreview({...previewSettings,curve:"gaussian"});
  assert.ok(bell[15]! > bell[0]!);
  const custom = weightPreview({...previewSettings,custom_weights:[0,1]});
  assert.deepEqual(custom.slice(0,16), Array(16).fill(0));
  assert.deepEqual(custom.slice(16), Array(16).fill(1));
  assert.equal(weightPreview({...previewSettings,amount:0}).filter(Boolean).length, 1);
  assert.ok(weightPreview({...previewSettings,sigma:NaN,curve:"gaussian"}).every(Number.isFinite));
});

test("Vegas preview has softer edges for even windows and equal odd windows", () => {
  const even = weightPreview({...previewSettings,curve:"vegas"}, 240, 60);
  assert.ok(even[0]! < even[15]!);
  assert.deepEqual(weightPreview({...previewSettings,curve:"vegas"}, 900, 60), Array(32).fill(1));
});

test("Vegas preview remains visible before source rates are known", () => {
  const bars = weightPreview({...previewSettings, curve:"vegas"});
  assert.ok(bars.every(value => value > 0));
  assert.equal(bars[0], .5);
  assert.equal(Math.max(...bars), 1);
});
