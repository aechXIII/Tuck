import assert from "node:assert/strict";
import test from "node:test";

import { hasDesktopBackend } from "../../src/main.ts";

test("desktop backend detection requires an API object", () => {
  assert.equal(hasDesktopBackend(undefined), false);
  assert.equal(hasDesktopBackend({}), false);
  assert.equal(hasDesktopBackend({ pywebview: {} }), false);
  assert.equal(hasDesktopBackend({ pywebview: { api: null } }), false);
  assert.equal(hasDesktopBackend({ pywebview: { api: {} } }), true);
});
