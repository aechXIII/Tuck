"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const dom = require("../../tuck/web/dom.js");

test("HTML escaping protects both text and quoted attributes", () => {
  assert.equal(
    dom.escapeHtml(`<&>"'`),
    "&lt;&amp;&gt;&quot;&#39;",
  );
});

test("HTML escaping handles nullish and numeric values predictably", () => {
  assert.equal(dom.escapeHtml(null), "");
  assert.equal(dom.escapeHtml(undefined), "");
  assert.equal(dom.escapeHtml(42), "42");
});
