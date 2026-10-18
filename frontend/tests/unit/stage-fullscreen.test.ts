import assert from "node:assert/strict";
import test from "node:test";

import { createStageFullscreen, type WindowFullscreen } from "../../src/features/player/stage-fullscreen.ts";

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve));
}

function setup(options: { element: boolean; windowWasFullscreen?: boolean; failEnter?: boolean }) {
  const classes = new Set<string>();
  // capture listeners on the document run before the page's own key handling
  const capture = new Set<(event: KeyboardEvent) => void>();
  const doc = {
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void, useCapture?: boolean) => {
      if (type === "keydown" && useCapture === true) capture.add(listener);
    },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void, useCapture?: boolean) => {
      if (type === "keydown" && useCapture === true) capture.delete(listener);
    },
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
    },
    fullscreenElement: null as unknown,
    exits: 0,
    exitFullscreen() {
      this.exits++;
      this.fullscreenElement = null;
      return Promise.resolve();
    },
  };
  const center = {
    requests: 0,
    requestFullscreen() {
      this.requests++;
      doc.fullscreenElement = this;
      return Promise.resolve();
    },
  };
  const windowCalls: boolean[] = [];
  let desktop: ((fullscreen: boolean) => void) | null = null;
  const shell: WindowFullscreen = {
    set: (fullscreen) => {
      windowCalls.push(fullscreen);
      if (fullscreen && options.failEnter) return Promise.reject(new Error("refused"));
      return Promise.resolve(options.windowWasFullscreen ?? false);
    },
    watch: (listener) => {
      desktop = listener;
    },
  };
  const stage = createStageFullscreen({
    doc: doc as unknown as Document,
    center: () => center as unknown as HTMLElement,
    elementFullscreen: () => Promise.resolve(options.element),
    window: shell,
  });
  const escape = () => {
    let stopped = false;
    let prevented = false;
    const event = {
      key: "Escape",
      preventDefault: () => (prevented = true),
      stopPropagation: () => (stopped = true),
      stopImmediatePropagation: () => (stopped = true),
    } as unknown as KeyboardEvent;
    for (const listener of [...capture]) listener(event);
    return { reachedPage: !stopped, prevented };
  };
  return { stage, classes, doc, center, windowCalls, escape, desktop: (on: boolean) => desktop?.(on) };
}

test("where the webview has element fullscreen, the player's card goes full screen and back", async () => {
  const { stage, classes, doc, center, windowCalls } = setup({ element: true });
  await settle();
  stage.toggle();
  assert.equal(center.requests, 1);
  stage.toggle();
  assert.equal(doc.exits, 1);
  assert.deepEqual(windowCalls, []);
  assert.equal(classes.has("stage-fullscreen"), false);
});

test("without element fullscreen the window goes full screen and the card covers the editor", async () => {
  const { stage, classes, center, windowCalls } = setup({ element: false });
  await settle();
  stage.toggle();
  await settle();
  assert.equal(center.requests, 0, "WebKitGTK aborts the app on element fullscreen");
  assert.equal(classes.has("stage-fullscreen"), true);
  assert.deepEqual(windowCalls, [true]);
  stage.toggle();
  await settle();
  assert.equal(classes.has("stage-fullscreen"), false);
  assert.deepEqual(windowCalls, [true, false]);
});

test("the first press waits for the capabilities instead of guessing", async () => {
  const { stage, center, windowCalls } = setup({ element: false });
  stage.toggle();
  await settle();
  assert.equal(center.requests, 0);
  assert.deepEqual(windowCalls, [true]);
});

test("Escape leaves the full screen window before the page sees the key", async () => {
  const { stage, classes, windowCalls, escape } = setup({ element: false });
  await settle();
  stage.toggle();
  await settle();
  const pressed = escape();
  await settle();
  assert.deepEqual(pressed, { reachedPage: false, prevented: true });
  assert.equal(classes.has("stage-fullscreen"), false);
  assert.deepEqual(windowCalls, [true, false]);
  // once out, Escape is the page's again
  assert.equal(escape().reachedPage, true);
});

test("a window the desktop made full screen stays full screen when the player leaves", async () => {
  const { stage, classes, windowCalls } = setup({ element: false, windowWasFullscreen: true });
  await settle();
  stage.toggle();
  await settle();
  stage.toggle();
  await settle();
  assert.equal(classes.has("stage-fullscreen"), false);
  assert.deepEqual(windowCalls, [true]);
});

test("the card stops covering the editor when the desktop takes the window out of full screen", async () => {
  const { stage, classes, windowCalls, desktop } = setup({ element: false });
  await settle();
  stage.toggle();
  await settle();
  desktop(true);
  desktop(false);
  assert.equal(classes.has("stage-fullscreen"), false);
  assert.deepEqual(windowCalls, [true]);
});

test("a refused full screen window leaves the editor as it was", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const { stage, classes } = setup({ element: false, failEnter: true });
    await settle();
    stage.toggle();
    await settle();
    assert.equal(classes.has("stage-fullscreen"), false);
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
  }
});
