import assert from "node:assert/strict";
import test from "node:test";

import {
  backendFailureCopy,
  backendFailureDetails,
  backendUnavailableScreen,
  hasDesktopBackend,
  restartTuckAction,
  updateStoppedTuck,
} from "../../src/desktop-status.ts";

test("desktop backend detection requires the Tauri invoke bridge", () => {
  assert.equal(hasDesktopBackend(undefined), false);
  assert.equal(hasDesktopBackend({}), false);
  assert.equal(hasDesktopBackend({ __TAURI_INTERNALS__: {} }), false);
  assert.equal(
    hasDesktopBackend({ __TAURI_INTERNALS__: { invoke: () => undefined } }),
    true,
  );
});

test("a failed start and a later crash read differently and both say what to do", () => {
  const start = backendFailureCopy("start");
  const stopped = backendFailureCopy("stopped");
  const update = backendFailureCopy("update");
  assert.equal(start.title, "Tuck couldn't start");
  assert.equal(stopped.title, "Tuck stopped working");
  assert.equal(update.title, "The update couldn't start");
  assert.notEqual(start.message, stopped.message);
  assert.match(stopped.message, /exports in progress were stopped/);
  // a failed installer is not a crash, so it never says Tuck stopped unexpectedly
  assert.doesNotMatch(update.message, /unexpectedly/);
  assert.match(update.message, /try the update again/);
  for (const copy of [start, stopped, update]) {
    assert.match(copy.message, /Restart Tuck/);
    // people see this text, so it never names internals or developer commands
    assert.doesNotMatch(copy.message, /backend|python|sidecar|protocol|npm|tauri/i);
  }
});

test("copied details keep the error and the crash output for a bug report", () => {
  assert.equal(
    backendFailureDetails({
      code: "BACKEND_EXITED",
      message: "The Python backend closed its protocol output.",
      details: { stderr: "Traceback (most recent call last):\n  boom\n" },
    }),
    "BACKEND_EXITED: The Python backend closed its protocol output.\n\nTraceback (most recent call last):\n  boom",
  );
  assert.equal(
    backendFailureDetails({ code: "BACKEND_TIMEOUT", message: "Too slow.", details: {} }),
    "BACKEND_TIMEOUT: Too slow.",
  );
  assert.match(backendFailureDetails(undefined), /desktop shell/);
});

test("an installer that failed after Tuck stopped its work asks for a restart", () => {
  const stopped = { code: "UPDATE_BACKEND_STOPPED", message: "access denied", details: {} };
  assert.equal(updateStoppedTuck(stopped), true);
  assert.equal(updateStoppedTuck({ ...stopped, code: "UPDATE_FAILED" }), false);

  const screen = backendUnavailableScreen("update", [restartTuckAction(async () => undefined)]);
  // the crash screen leaves an existing backend-unavailable screen alone, so a later
  // request failing on the stopped backend can't replace this one
  assert.equal(screen.id, "backend-unavailable");
  assert.equal(screen.tone, "alert");
  assert.equal(screen.title, "The update couldn't start");
  assert.deepEqual(screen.actions?.map((action) => action.label), ["Restart Tuck"]);
});

test("restart shows progress and offers it again when the shell can't restart", async () => {
  const button = { disabled: false, textContent: "Restart Tuck" } as HTMLButtonElement;
  const note = { textContent: "Earlier note" } as HTMLElement;
  let fail: (reason: unknown) => void = () => undefined;
  const restarting = new Promise<unknown>((_resolve, reject) => {
    fail = reject;
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    restartTuckAction(() => restarting).run(button, note);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Restarting…");
    assert.equal(note.textContent, "");

    fail(new Error("denied"));
    await restarting.catch(() => undefined);
    await Promise.resolve();
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Restart Tuck");
    assert.match(note.textContent ?? "", /Close it and open it again/);
  } finally {
    console.error = originalError;
  }
});
