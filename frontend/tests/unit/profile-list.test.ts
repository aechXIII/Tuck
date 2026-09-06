import assert from "node:assert/strict";
import test from "node:test";

import {
  bindProfileActions,
  renderProfileList,
  renderShortcutChoices,
} from "../../src/features/profiles/profile-list.ts";

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  parentElement: FakeElement | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set innerHTML(_value: string) {
    throw new Error("profile rendering must not use innerHTML");
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function action(root: FakeElement, name: string): FakeElement | undefined {
  return descendants(root).find((element) => element.dataset.profileAction === name);
}

test("profile rows keep malicious names and identifiers as inert DOM data", () => {
  const list = new FakeElement("div");
  const calls: unknown[][] = [];
  const profile = {
    profile_id: 'profile-" onclick="globalThis.pwned=true',
    name: '" onmouseover="globalThis.pwned=true',
    workflow: "compression",
  };

  renderProfileList(fakeDocument, list as unknown as HTMLElement, [profile], {
    defaultProfileId: profile.profile_id,
    summarize: () => "Compress · Source resolution",
  });
  bindProfileActions(list as unknown as HTMLElement, (...args) => calls.push(args));

  const text = descendants(list)
    .map((element) => element.textContent)
    .join(" ");
  assert.match(text, /globalThis\.pwned=true/);
  const remove = action(list, "delete");
  assert.ok(remove);
  assert.ok(descendants(list).some((element) => element.className === "profile-actions-menu"));
  assert.ok(descendants(list).some((element) => element.className === "profile-actions-popover"));
  assert.equal(remove!.attributes.onclick, undefined);
  list.listeners.click![0]!({ target: remove });
  assert.deepEqual(calls, [["delete", profile.profile_id, profile.name]]);
  assert.equal(Reflect.get(globalThis, "pwned"), undefined);
});

test("profile shortcut choices dispatch exact profile data without inline handlers", () => {
  const list = new FakeElement("div");
  const calls: unknown[][] = [];
  const profile = {
    profile_id: "profile-' dangerous",
    name: '<img src=x onerror="globalThis.pwned=true">',
  };

  renderShortcutChoices(fakeDocument, list as unknown as HTMLElement, [profile], {
    summarize: () => "Upscale · 1920 × 1080",
  });
  bindProfileActions(list as unknown as HTMLElement, (...args) => calls.push(args));

  const install = action(list, "install-profile-shortcut");
  assert.ok(install);
  assert.equal(install!.attributes.onclick, undefined);
  list.listeners.click![0]!({ target: install });
  assert.deepEqual(calls, [["install-profile-shortcut", profile.profile_id, profile.name]]);
  assert.equal(Reflect.get(globalThis, "pwned"), undefined);
});
