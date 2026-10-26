import assert from "node:assert/strict";
import test from "node:test";

import {
  activeExportCount,
  closeRequestFrom,
  exitScreenCopy,
  installCloseGuard,
  stopExportsQuestion,
  withTimeout,
  type CloseGuardBridge,
  type CloseGuardHost,
  type StopExportsQuestion,
} from "../../src/platform/app-exit.ts";

test("only running and waiting exports count as work that closing would stop", () => {
  assert.equal(
    activeExportCount({
      items: [
        { state: "running" },
        { state: "pending" },
        { state: "pending" },
        { state: "completed" },
        { state: "failed" },
        { state: "cancelled" },
        null,
      ],
    }),
    3,
  );
  assert.equal(activeExportCount({ items: [] }), 0);
  assert.equal(activeExportCount(null), 0);
  assert.equal(activeExportCount({ items: "running" }), 0);
});

test("a close request needs a positive whole request number", () => {
  assert.equal(closeRequestFrom({ request: 4 }), 4);
  for (const payload of [null, {}, { request: 0 }, { request: 1.5 }, { request: "4" }]) {
    assert.equal(closeRequestFrom(payload), null);
  }
});

test("the stop-exports question names the count and the way out", () => {
  assert.deepEqual(stopExportsQuestion(1, "close"), {
    title: "Stop 1 export and close Tuck?",
    message: "Running and waiting exports stop now and come back paused the next time you open Tuck. Finished exports are kept.",
    confirmLabel: "Close anyway",
    cancelLabel: "Keep working",
  });
  const update = stopExportsQuestion(3, "update");
  assert.equal(update.title, "Stop 3 exports and install the update?");
  assert.equal(update.confirmLabel, "Install anyway");
  assert.match(update.message, /opens again once the update is installed, with them paused/);
  // when the queue could not be read, the question stays honest about it
  assert.match(stopExportsQuestion(null, "close").message, /couldn't check/);
  const restart = stopExportsQuestion(2, "restart");
  assert.equal(restart.title, "Stop 2 exports and restart Tuck?");
  assert.equal(restart.confirmLabel, "Restart anyway");
  assert.match(restart.message, /opens again right away, with them paused/);
  assert.equal(stopExportsQuestion(null, "restart").title, "Restart Tuck?");
});

test("the closing screen says exports are stopping when there may be some", () => {
  assert.equal(exitScreenCopy(2, "close").title, "Stopping exports…");
  assert.equal(exitScreenCopy(null, "close").title, "Stopping exports…");
  assert.equal(exitScreenCopy(0, "close").title, "Closing Tuck…");
  assert.equal(exitScreenCopy(0, "update").title, "Installing the update…");
  assert.equal(exitScreenCopy(0, "restart").title, "Restarting Tuck…");
  assert.match(exitScreenCopy(1, "restart").detail, /restarts once the exports have stopped/);
});

function fakeShell(activeExports: number | null) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const shown: Array<number | null> = [];
  const asked: StopExportsQuestion[] = [];
  let confirmLater: (() => void) | undefined;
  let deliver: ((event: { payload: unknown }) => void) | undefined;
  const bridge: CloseGuardBridge = {
    invoke: async (command, args) => {
      calls.push(args === undefined ? { command } : { command, args });
      return undefined;
    },
    listen: async (event, handler) => {
      assert.equal(event, "close-requested");
      deliver = handler;
      return () => undefined;
    },
  };
  const host: CloseGuardHost = {
    activeExports: async () => activeExports,
    confirm: (question, onConfirm) => {
      asked.push(question);
      confirmLater = onConfirm;
    },
    showClosing: (count) => shown.push(count),
  };
  return {
    bridge,
    host,
    calls,
    shown,
    asked,
    request: async (payload: unknown) => {
      deliver?.({ payload });
      await new Promise((resolve) => setImmediate(resolve));
    },
    confirm: () => confirmLater?.(),
  };
}

test("closing with nothing running closes straight away", async () => {
  const shell = fakeShell(0);
  await installCloseGuard(shell.host, shell.bridge);
  await shell.request({ request: 1 });
  assert.deepEqual(shell.calls, [
    { command: "acknowledge_close_request", args: { request: 1 } },
    { command: "confirm_close" },
  ]);
  assert.deepEqual(shell.asked, []);
  assert.deepEqual(shell.shown, [0]);
});

test("closing with running exports asks first and closes only on confirmation", async () => {
  const shell = fakeShell(2);
  await installCloseGuard(shell.host, shell.bridge);
  await shell.request({ request: 7 });
  assert.deepEqual(shell.calls, [{ command: "acknowledge_close_request", args: { request: 7 } }]);
  assert.equal(shell.asked[0]?.title, "Stop 2 exports and close Tuck?");
  assert.deepEqual(shell.shown, []);

  shell.confirm();
  assert.deepEqual(shell.calls.at(-1), { command: "confirm_close" });
  assert.deepEqual(shell.shown, [2]);
});

test("an unreadable queue asks instead of closing silently", async () => {
  const shell = fakeShell(null);
  await installCloseGuard(shell.host, shell.bridge);
  await shell.request({ request: 2 });
  assert.equal(shell.asked[0]?.title, "Close Tuck?");
  assert.equal(shell.calls.some((call) => call.command === "confirm_close"), false);
});

test("a malformed close request is ignored", async () => {
  const shell = fakeShell(0);
  await installCloseGuard(shell.host, shell.bridge);
  await shell.request({ request: "soon" });
  assert.deepEqual(shell.calls, []);
});

test("a slow answer falls back instead of holding up the close", async () => {
  const never = new Promise<number>(() => undefined);
  assert.equal(await withTimeout(never, 5, null), null);
  assert.equal(await withTimeout(Promise.resolve(3), 1_000, null), 3);
  assert.equal(await withTimeout(Promise.reject(new Error("down")), 1_000, null), null);
});
