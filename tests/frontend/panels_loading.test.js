const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const layout = require("../../frontend/public/legacy/layout.js");
const panelsSource = fs.readFileSync(
  path.join(__dirname, "../../frontend/public/legacy/panels.js"),
  "utf8",
);

function fakeElement() {
  return {
    classList: {
      add() {},
      toggle() {},
    },
    inert: false,
    removeAttribute() {},
    setAttribute() {},
  };
}

test("workspace resize is safe before the later timeline script loads", () => {
  const listeners = {};
  const elements = new Map();
  const body = fakeElement();
  const context = {
    TuckLayout: layout,
    byId(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    document: {
      activeElement: null,
      addEventListener() {},
      body,
    },
    window: {
      TuckLayout: layout,
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
      innerWidth: 960,
    },
  };

  vm.runInNewContext(panelsSource, context, { filename: "panels.js" });

  assert.doesNotThrow(() => listeners.resize());
  assert.equal(context.workspaceViewportMode, "overlay");
});

test("selecting an Inspector tab remembers the user-facing panel name", async () => {
  const elements = new Map();
  const saved = [];
  const context = {
    TuckLayout: layout,
    api: {
      async saveSettings(settings) {
        saved.push(settings);
        return { ok: true, value: {} };
      },
    },
    appSettings: {},
    byId(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    document: {
      activeElement: null,
      addEventListener() {},
      body: fakeElement(),
    },
    async legacyBackendResult(call) {
      const result = await call;
      return result.ok
        ? Object.assign({ ok: true }, result.value)
        : { ok: false, error: result.error.message };
    },
    renderAudioMixerList() {},
    toast() {},
    window: {
      TuckLayout: layout,
      addEventListener() {},
      innerWidth: 1240,
    },
  };

  vm.runInNewContext(panelsSource, context, { filename: "panels.js" });
  context.setInspectorTab("export");
  await context.inspectorSettingsSave;

  assert.equal(context.appSettings.last_inspector_panel, "export");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].last_inspector_panel, "export");
});
