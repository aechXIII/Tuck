import assert from "node:assert/strict";
import test from "node:test";

import {
  bindProfileActions,
  pickerProfiles,
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

test("profile rows open the editor and offer Set as default only for other profiles", () => {
  const list = new FakeElement("div");
  const profiles = [
    { profile_id: "default", name: "Everyday", workflow: "compression" },
    { profile_id: "clips", name: "Clips", workflow: "compression" },
  ];
  renderProfileList(fakeDocument, list as unknown as HTMLElement, profiles, {
    defaultProfileId: "default",
    summarize: () => "Compress · 20 MB",
    pinned: new Set(["clips"]),
    hidden: new Set(["default"]),
  });
  const rows = list.children;
  assert.equal(rows.length, 2);
  const actions = (row: FakeElement) => descendants(row).map((element) => element.dataset.profileAction).filter(Boolean);
  assert.deepEqual(actions(rows[0]!), ["edit", "edit", "duplicate", "pin", "show", "export", "delete"]);
  assert.deepEqual(actions(rows[1]!), ["edit", "edit", "duplicate", "default", "unpin", "hide", "export", "delete"]);
  const tags = (row: FakeElement) => descendants(row).map((element) => element.textContent);
  assert.ok(tags(rows[0]!).includes("Default") && tags(rows[0]!).includes("Hidden"));
  assert.ok(!tags(rows[1]!).includes("Default") && tags(rows[1]!).includes("Pinned"));
});

test("the picker lists pinned profiles first and leaves hidden ones out", () => {
  const all = ["a", "b", "c", "d"].map((profile_id) => ({ profile_id }));
  const ids = (list: readonly { profile_id: string }[]) => list.map((profile) => profile.profile_id);
  assert.deepEqual(ids(pickerProfiles(all, [], [], "")), ["a", "b", "c", "d"]);
  // pinned in the order they were pinned, the rest in their own order
  assert.deepEqual(ids(pickerProfiles(all, ["d", "b"], [], "")), ["d", "b", "a", "c"]);
  assert.deepEqual(ids(pickerProfiles(all, [], ["b", "c"], "")), ["a", "d"]);
  // the profile in use stays, so the picker never loses the current choice
  assert.deepEqual(ids(pickerProfiles(all, [], ["b", "c"], "c")), ["a", "c", "d"]);
  // hiding everything hides nothing
  assert.deepEqual(ids(pickerProfiles(all, [], ["a", "b", "c", "d"], "")), ["a", "b", "c", "d"]);
});

test("an empty profile list says so in its own words", () => {
  const list = new FakeElement("div");
  renderProfileList(fakeDocument, list as unknown as HTMLElement, [], {
    summarize: () => "",
    empty: "None yet.",
  });
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.textContent, "None yet.");
});
