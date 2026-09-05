import assert from "node:assert/strict";
import test from "node:test";

import * as clipDetails from "../../src/features/library/clip-details.ts";
import type { ClipDetailsElement } from "../../src/features/library/clip-details.ts";

class FakeElement implements ClipDetailsElement {
  tagName: string;
  className = "";
  textContent: string | null = "";
  type?: string;
  children: FakeElement[] = [];
  listeners: Record<string, Array<() => void>> = {};
  attributes: Record<string, string> = {};
  parentElement: FakeElement | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set innerHTML(_value: string) {
    throw new Error("clip details must not use innerHTML");
  }

  appendChild(child: ClipDetailsElement): ClipDetailsElement {
    if (!(child instanceof FakeElement)) {
      throw new Error("expected FakeElement");
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: ClipDetailsElement[]): void {
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
}

const documentRef = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
};

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

test("probe errors render as text and retry with the exact source path", () => {
  const host = new FakeElement("div");
  const calls: string[] = [];
  const path = `C:\\clip-'\" onclick=\"globalThis.pwned=true.mp4`;
  const error = '<img src=x onerror="globalThis.pwned=true">';

  clipDetails.render(documentRef, host, { state: "error", path, error }, (value) => {
    calls.push(value);
  });

  const text = descendants(host)
    .map((element) => element.textContent)
    .join(" ");
  assert.match(text, /globalThis\.pwned=true/);
  const retry = descendants(host).find((element) => element.textContent === "Retry");
  assert.ok(retry);
  assert.equal(retry.attributes.onclick, undefined);
  const click = retry.listeners.click?.[0];
  assert.ok(click);
  click();
  assert.deepEqual(calls, [path]);
  assert.equal((globalThis as { pwned?: unknown }).pwned, undefined);
});

test("source file rows match the compact Inspector order without repeating the filename", () => {
  assert.deepEqual(
    clipDetails.sourceFileRows({
      duration: "0:19.20",
      resolution: "2560×1440",
      frameRate: "59.94 fps",
      format: "H.264 / AAC",
      size: "177.4 MB",
    }),
    [
      ["Duration", "0:19.20"],
      ["Resolution", "2560×1440"],
      ["Frame rate", "59.94 fps"],
      ["Format", "H.264 / AAC"],
      ["Size", "177.4 MB"],
    ],
  );
});
