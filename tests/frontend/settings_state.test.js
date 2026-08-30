"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const settingsState = require("../../frontend/public/legacy/settings-state.js");

test("settings dirty state clears when controls return to their opening values", () => {
  const opening = settingsState.snapshot({ profile: "balanced", autoClear: false });

  assert.equal(
    settingsState.isDirty(opening, { profile: "balanced", autoClear: false }),
    false,
  );
  assert.equal(
    settingsState.isDirty(opening, { profile: "balanced", autoClear: true }),
    true,
  );
  assert.equal(
    settingsState.isDirty(opening, { profile: "balanced", autoClear: false }),
    false,
  );
});
