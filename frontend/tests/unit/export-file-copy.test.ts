import assert from "node:assert/strict";
import test from "node:test";
import { createExportFileCopy } from "../../src/features/queue/export-file-copy.ts";
import type { BackendResult, EmptyPayload } from "../../src/backend/types.ts";

test("copy waits for the native result and prevents competing clipboard requests", async () => {
  let finish!: (result: BackendResult<EmptyPayload>) => void;
  const paths: string[] = [];
  let changes = 0;
  const copier = createExportFileCopy(path => {
    paths.push(path);
    return new Promise(resolve => { finish = resolve; });
  }, () => { changes++; });
  const pending = copier.copy("a", "C:\\videos\\clip.mp4");
  assert.equal(copier.state("a", "C:\\videos\\clip.mp4").label, "Copying...");
  assert.equal(copier.state("b", "other.mp4").disabled, true);
  assert.equal(await copier.copy("b", "other.mp4"), "ignored");
  assert.equal(copier.state("a", "C:\\videos\\clip.mp4").error, "");
  finish({ ok: true, value: {} });
  assert.equal(await pending, "copied");
  assert.deepEqual(paths, ["C:\\videos\\clip.mp4"]);
  assert.equal(copier.state("a", "C:\\videos\\clip.mp4").label, "Copied");
  assert.equal(copier.state("a", "new-output.mp4").label, "Copy file");
  assert.equal(changes, 2);
});

test("copy errors persist, can be retried, and never show Copied", async () => {
  let fails = true;
  const copier = createExportFileCopy(async () => fails
    ? { ok: false, error: { code: "MISSING", message: "The exported file no longer exists.", details: {} } }
    : { ok: true, value: {} }, () => {});
  assert.equal(await copier.copy("a", "out.mp4"), "error");
  assert.equal(copier.state("a", "out.mp4").label, "Copy file");
  assert.equal(copier.state("a", "out.mp4").error, "The exported file no longer exists.");
  assert.equal(copier.state("a", "replacement.mp4").error, "");
  fails = false;
  assert.equal(await copier.copy("a", "out.mp4"), "copied");
  assert.equal(copier.state("a", "out.mp4").error, "");
});

test("a later successful copy clears the earlier Copied label", async () => {
  const copier = createExportFileCopy(async () => ({ ok: true, value: {} }), () => {});
  await copier.copy("a", "a.mp4");
  await copier.copy("b", "b.mp4");
  assert.equal(copier.state("a", "a.mp4").label, "Copy file");
  assert.equal(copier.state("b", "b.mp4").label, "Copied");
});

test("unexpected native exceptions leave copying retryable", async () => {
  const copier = createExportFileCopy(async () => { throw new Error("Clipboard is busy."); }, () => {});
  assert.equal(await copier.copy("a", "out.mp4"), "error");
  assert.equal(copier.state("a", "out.mp4").disabled, false);
  assert.equal(copier.state("a", "out.mp4").error, "Clipboard is busy.");
  assert.equal(await copier.copy("a", ""), "ignored");
});

test("several files are one copy, sharing the one clipboard with single files", async () => {
  const single: string[] = [];
  const batches: string[][] = [];
  let finish!: (result: BackendResult<EmptyPayload>) => void;
  const copier = createExportFileCopy(async path => { single.push(path); return { ok: true, value: {} }; }, () => {},
    paths => { batches.push([...paths]); return new Promise(resolve => { finish = resolve; }); });
  const files = ["C:\\out\\a.mp4", "C:\\out\\b.mp4"];
  const pending = copier.copyMany("batch", files);
  assert.equal(copier.state("batch", files.join("\n")).status, "copying");
  // a single file waits while the batch holds the clipboard
  assert.equal(await copier.copy("a", files[0]!), "ignored");
  finish({ ok: true, value: {} });
  assert.equal(await pending, "copied");
  assert.deepEqual(batches, [files]);
  assert.equal(copier.state("batch", files.join("\n")).status, "copied");
  // a batch of one is the single-file copy
  assert.equal(await copier.copyMany("one", ["C:\\out\\c.mp4"]), "copied");
  assert.deepEqual(single, ["C:\\out\\c.mp4"]);
  assert.equal(copier.state("batch", files.join("\n")).status, "idle");
});

test("a failed repeat copy clears its previous success label", async () => {
  let fails = false;
  const copier = createExportFileCopy(async () => fails
    ? { ok: false, error: { code: "BUSY", message: "Clipboard is busy.", details: {} } }
    : { ok: true, value: {} }, () => {});
  await copier.copy("a", "out.mp4");
  fails = true;
  await copier.copy("a", "out.mp4");
  assert.equal(copier.state("a", "out.mp4").label, "Copy file");
});
