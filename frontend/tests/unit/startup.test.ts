import assert from "node:assert/strict";
import test from "node:test";

import { backendUnavailableMessage, hasDesktopBackend } from "../../src/desktop-status.ts";

test("desktop backend detection requires an API object", () => {
  assert.equal(hasDesktopBackend(undefined), false);
  assert.equal(hasDesktopBackend({}), false);
  assert.equal(hasDesktopBackend({ pywebview: {} }), false);
  assert.equal(hasDesktopBackend({ pywebview: { api: null } }), false);
  assert.equal(hasDesktopBackend({ pywebview: { api: {} } }), true);
  assert.equal(
    hasDesktopBackend({ __TAURI_INTERNALS__: { invoke: () => undefined } }),
    true,
  );
});

test("backend failure copy contains exactly one sentence break before recovery", () => {
  assert.equal(
    backendUnavailableMessage("The Python backend closed its protocol output."),
    "Tuck could not connect to its desktop backend: The Python backend closed its protocol output. Close and reopen Tuck.",
  );
});
