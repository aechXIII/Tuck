import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPATIBILITY_EXPORTS,
  loadLegacyFeatureScripts,
} from "../../src/compatibility.ts";

test("remaining legacy feature scripts are loaded once in their dependency order", async () => {
  const loaded: string[] = [];
  await loadLegacyFeatureScripts(async (source) => {
    loaded.push(source);
  });

  assert.deepEqual(loaded, [
    "./legacy/encoding-ui.js",
    "./legacy/queue.js",
    "./legacy/settings-profiles.js",
    "./legacy/settings.js",
    "./legacy/ui-bindings.js",
  ]);
});

test("each temporary global compatibility export names its owner and removal commit", () => {
  assert.ok(COMPATIBILITY_EXPORTS.length > 0);
  assert.ok(
    COMPATIBILITY_EXPORTS.every(
      (entry) => entry.owner.length > 0 && entry.removeAfter === "legacy frontend removal",
    ),
  );
});
