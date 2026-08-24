const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const layout = require("../../tuck/web/layout.js");
const panelsSource = fs.readFileSync(
  path.join(__dirname, "../../tuck/web/panels.js"),
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
