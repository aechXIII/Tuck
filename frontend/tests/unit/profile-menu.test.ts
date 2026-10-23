import assert from "node:assert/strict";
import test from "node:test";

import {
  matchParts,
  matchRanges,
  profileMatches,
  profileMenuGroups,
  profileMenuPlacement,
  type ProfileMenuOptions,
} from "../../src/features/profiles/profile-menu.ts";

const profiles = [
  { profile_id: "discord", name: "Discord", workflow: "compression" },
  { profile_id: "email", name: "Email" },
  { profile_id: "secret", name: "Secret", workflow: "compression" },
  { profile_id: "4k", name: "4K", workflow: "upscale" },
  { profile_id: "1440", name: "1440p", workflow: "upscale" },
];

const options = (changes: Partial<ProfileMenuOptions> = {}): ProfileMenuOptions => ({
  current: "compression",
  tasks: ["compression", "upscale"],
  pinned: [],
  hidden: [],
  inUse: { compression: "discord", upscale: "" },
  ...changes,
});

const shape = (groups: ReturnType<typeof profileMenuGroups>) =>
  groups.map((group) => [group.task, group.switches, group.profiles.map((profile) => profile.profile_id)]);

test("the current task's profiles come first and the other task's switch task", () => {
  assert.deepEqual(shape(profileMenuGroups(profiles, options())), [
    ["compression", false, ["discord", "email", "secret"]],
    ["upscale", true, ["4k", "1440"]],
  ]);
  assert.deepEqual(shape(profileMenuGroups(profiles, options({ current: "upscale" }))), [
    ["upscale", false, ["4k", "1440"]],
    ["compression", true, ["discord", "email", "secret"]],
  ]);
});

test("each group keeps pinned profiles first and hidden ones out, except the one each task remembers", () => {
  const groups = profileMenuGroups(profiles, options({
    pinned: ["1440", "secret"],
    hidden: ["email", "4k", "discord"],
    inUse: { compression: "discord", upscale: "4k" },
  }));
  assert.deepEqual(shape(groups), [
    ["compression", false, ["secret", "discord"]],
    ["upscale", true, ["1440", "4k"]],
  ]);
});

test("a hidden task's profiles are left out, and an empty other task has no group", () => {
  assert.deepEqual(shape(profileMenuGroups(profiles, options({ tasks: ["compression"] }))), [
    ["compression", false, ["discord", "email", "secret"]],
  ]);
  const compressOnly = profiles.filter((profile) => profile.workflow !== "upscale");
  assert.deepEqual(shape(profileMenuGroups(compressOnly, options())), [
    ["compression", false, ["discord", "email", "secret"]],
  ]);
  // the current task keeps its group even when empty, so the menu can say so
  assert.deepEqual(shape(profileMenuGroups(compressOnly, options({ current: "upscale" }))), [
    ["upscale", false, []],
    ["compression", true, ["discord", "email", "secret"]],
  ]);
});

test("search matches the name or the details, ignoring case and outer spaces", () => {
  assert.equal(profileMatches("1440p Upscale", "2560 × 1440", ""), true);
  assert.equal(profileMatches("Discord", "Target 20 MB", "  disc "), true);
  assert.equal(profileMatches("Upscale", "2560 × 1440 · source frame rate", "1440"), true);
  assert.equal(profileMatches("Discord", "Target 20 MB", "tiktok"), false);
});

test("match ranges cover every match without overlapping", () => {
  assert.deepEqual(matchRanges("1440p Upscale (2560x1440)", "1440"), [[0, 4], [20, 24]]);
  assert.deepEqual(matchRanges("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(matchRanges("Discord", "DIS"), [[0, 3]]);
  assert.deepEqual(matchRanges("Discord", " "), []);
  assert.deepEqual(matchRanges("Discord", "x"), []);
});

test("match parts keep the whole text in order, matches marked", () => {
  assert.deepEqual(matchParts("1440p Upscale", "upscale"), [
    { text: "1440p ", match: false },
    { text: "Upscale", match: true },
  ]);
  assert.deepEqual(matchParts("Email", ""), [{ text: "Email", match: false }]);
  assert.deepEqual(matchParts("", "a"), [{ text: "", match: false }]);
});

test("the menu covers the card from its top and grows up from the field when below is short", () => {
  const card = { left: 1100, top: 100, width: 320 };
  assert.deepEqual(profileMenuPlacement(card, 46, 470, 1440, 900),
    { left: 1100, top: 100, width: 320, maxHeight: 470, side: "below" });
  // short on room below and more above: the field stays where the header was
  assert.deepEqual(profileMenuPlacement({ ...card, top: 600 }, 46, 470, 1440, 900),
    { left: 1100, top: 176, width: 320, maxHeight: 470, side: "above" });
  // with more room below the list scrolls there instead
  assert.deepEqual(profileMenuPlacement({ ...card, top: 300 }, 46, 700, 1440, 900),
    { left: 1100, top: 300, width: 320, maxHeight: 592, side: "below" });
  // the menu never leaves the window
  assert.deepEqual(profileMenuPlacement({ left: 700, top: 50, width: 400 }, 46, 300, 960, 640),
    { left: 552, top: 50, width: 400, maxHeight: 300, side: "below" });
});
