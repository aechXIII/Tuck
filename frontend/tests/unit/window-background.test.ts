import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// npm test runs from the repository root
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

test("the window opens in the editor's own color, so nothing white shows before the page draws", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    app: { windows: Array<{ label: string; backgroundColor?: string }> };
  };
  const floor = /--floor:\s*(#[0-9a-f]{6})\b/i.exec(read("frontend/src/styles/styles.css"))?.[1];
  assert.ok(floor, "styles.css sets --floor");
  const main = config.app.windows.find((window) => window.label === "main");
  assert.equal(main?.backgroundColor?.toLowerCase(), floor.toLowerCase());
});
