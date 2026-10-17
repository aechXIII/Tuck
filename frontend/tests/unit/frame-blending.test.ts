import test from "node:test";
import assert from "node:assert/strict";
import { parseCustomWeights, updateWeightPreview, weightPreview } from "../../src/features/export/frame-blending.ts";

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

function fakeChart() {
  let created = 0;
  const makeBar = () => {
    const attributes = new Map<string, string>();
    const bar = { writes: 0, getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute(name: string, value: string) { attributes.set(name, value); bar.writes++; } };
    return bar;
  };
  type Bar = ReturnType<typeof makeBar>;
  const chart = {
    children: [] as Bar[],
    get childElementCount() { return chart.children.length; },
    replaceChildren(...bars: Bar[]) { chart.children = bars; },
    ownerDocument: { createElementNS(namespace: string, name: string) {
      assert.equal(namespace, "http://www.w3.org/2000/svg");
      assert.equal(name, "rect");
      created++;
      return makeBar();
    } },
  };
  return { chart, created: () => created };
}

test("weight chart keeps its bars and only rewrites what changed", () => {
  const { chart, created } = fakeChart();
  const equal = weightPreview(previewSettings);
  updateWeightPreview(chart, equal);
  assert.equal(created(), 32);
  const bars = [...chart.children];
  assert.equal(bars[0]!.getAttribute("height"), "42");
  assert.equal(bars[31]!.getAttribute("x"), "250");
  const writes = bars.map(bar => bar.writes);
  for (let refresh = 0; refresh < 100; refresh++) updateWeightPreview(chart, equal);
  assert.equal(created(), 32);
  assert.deepEqual(chart.children, bars);
  assert.deepEqual(bars.map(bar => bar.writes), writes);
  const rising = weightPreview({...previewSettings, curve:"ascending"});
  updateWeightPreview(chart, rising);
  assert.deepEqual(chart.children, bars);
  assert.equal(bars[0]!.getAttribute("height"), String(rising[0]! * 42));
  assert.equal(bars[0]!.getAttribute("y"), String(46 - rising[0]! * 42));
});

test("weight chart rebuilds only when the bar count changes", () => {
  const { chart, created } = fakeChart();
  updateWeightPreview(chart, [1, .5]);
  assert.equal(created(), 2);
  updateWeightPreview(chart, [1, .5, .25]);
  assert.equal(created(), 5);
  assert.equal(chart.childElementCount, 3);
  assert.equal(chart.children[2]!.getAttribute("height"), String(.25 * 42));
});
