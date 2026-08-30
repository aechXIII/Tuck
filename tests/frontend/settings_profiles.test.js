"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const settingsProfiles = require("../../frontend/public/legacy/settings-profiles.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.parentElement = null;
  }

  set innerHTML(_value) {
    throw new Error("profile rendering must not use innerHTML");
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }
}

const document = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

function descendants(root) {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function action(root, name) {
  return descendants(root).find((element) => element.dataset.profileAction === name);
}

test("profile rows keep malicious names and identifiers as inert DOM data", () => {
  const list = new FakeElement("div");
  const calls = [];
  const profile = {
    profile_id: 'profile-\" onclick=\"globalThis.pwned=true',
    name: '\" onmouseover=\"globalThis.pwned=true',
    workflow: "compression",
  };

  settingsProfiles.renderProfileList(document, list, [profile], {
    defaultProfileId: profile.profile_id,
    summarize: () => "Compress · Source resolution",
  });
  settingsProfiles.bindProfileActions(list, (...args) => calls.push(args));

  const text = descendants(list).map((element) => element.textContent).join(" ");
  assert.match(text, /globalThis\.pwned=true/);
  const remove = action(list, "delete");
  assert.ok(remove);
  assert.ok(descendants(list).some((element) => element.className === "profile-actions-menu"));
  assert.ok(
    descendants(list).some((element) => element.className === "profile-actions-popover"),
  );
  assert.equal(remove.attributes.onclick, undefined);
  list.listeners.click[0]({ target: remove });
  assert.deepEqual(calls, [["delete", profile.profile_id, profile.name]]);
  assert.equal(globalThis.pwned, undefined);
});

test("profile shortcut choices dispatch exact profile data without inline handlers", () => {
  const list = new FakeElement("div");
  const calls = [];
  const profile = {
    profile_id: "profile-' dangerous",
    name: '<img src=x onerror="globalThis.pwned=true">',
  };

  settingsProfiles.renderShortcutChoices(document, list, [profile], {
    summarize: () => "Upscale · 1920 × 1080",
  });
  settingsProfiles.bindProfileActions(list, (...args) => calls.push(args));

  const install = action(list, "install-profile-shortcut");
  assert.ok(install);
  assert.equal(install.attributes.onclick, undefined);
  list.listeners.click[0]({ target: install });
  assert.deepEqual(calls, [["install-profile-shortcut", profile.profile_id, profile.name]]);
  assert.equal(globalThis.pwned, undefined);
});
