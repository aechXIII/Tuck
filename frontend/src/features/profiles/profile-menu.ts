import { pickerProfiles, type ProfileListEntry } from "./profile-list.ts";

export type ProfileTask = "compression" | "upscale";

export interface ProfileMenuGroup<T> {
  readonly task: ProfileTask;
  // picking from a group of another task switches to that task first
  readonly switches: boolean;
  readonly profiles: readonly T[];
}

export interface ProfileMenuOptions {
  readonly current: ProfileTask;
  // tasks the user can reach; a hidden task's profiles are not offered
  readonly tasks: readonly ProfileTask[];
  readonly pinned: readonly string[];
  readonly hidden: readonly string[];
  // the profile each task remembers, kept in its list even when hidden from the picker
  readonly inUse: Readonly<Record<ProfileTask, string>>;
}

export const PROFILE_TASK_LABELS: Readonly<Record<ProfileTask, string>> = {
  compression: "Compress",
  upscale: "Upscale",
};

export function profileTask(profile: ProfileListEntry): ProfileTask {
  return profile.workflow === "upscale" ? "upscale" : "compression";
}

/**
 * The profile menu's groups: the current task first, then the other task when it is shown.
 * The current task's group is always there, even when empty, so the menu can say so.
 */
export function profileMenuGroups<T extends ProfileListEntry>(
  profiles: readonly T[],
  options: ProfileMenuOptions,
): ProfileMenuGroup<T>[] {
  const order: ProfileTask[] = options.current === "upscale" ? ["upscale", "compression"] : ["compression", "upscale"];
  const groups: ProfileMenuGroup<T>[] = [];
  for (const task of order) {
    const switches = task !== options.current;
    if (switches && !options.tasks.includes(task)) continue;
    const listed = pickerProfiles(
      profiles.filter((profile) => profileTask(profile) === task),
      options.pinned,
      options.hidden,
      options.inUse[task],
    );
    if (switches && !listed.length) continue;
    groups.push({ task, switches, profiles: listed });
  }
  return groups;
}

/** Where the query appears in the text, ignoring case, as [start, end) pairs that never overlap. */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  // lower-casing can change a string's length; the ranges index the original text, so skip those
  if (haystack.length !== text.length) return [];
  const ranges: [number, number][] = [];
  let from = 0;
  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    ranges.push([start, start + needle.length]);
    from = start + needle.length;
  }
  return ranges;
}

export function profileMatches(name: string, detail: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || name.toLocaleLowerCase().includes(needle) || detail.toLocaleLowerCase().includes(needle);
}

/** Splits text into plain and matched parts, in order, for rendering the matches as marks. */
export function matchParts(text: string, query: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, query)) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

export interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
  // below: the field covers the card's header and the list hangs down from it
  readonly side: "below" | "above";
}

/**
 * Places the menu over the card so its search field sits where the header was. The list hangs
 * down from there, or grows up from the field when the room below is too short and above is larger.
 */
export function profileMenuPlacement(
  card: { readonly left: number; readonly top: number; readonly width: number },
  fieldHeight: number,
  desiredHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): MenuPlacement {
  const margin = 8;
  const width = Math.min(card.width, Math.max(0, viewportWidth - margin * 2));
  const left = Math.max(margin, Math.min(card.left, viewportWidth - margin - width));
  const below = Math.max(0, viewportHeight - margin - card.top);
  const above = Math.max(0, card.top + fieldHeight - margin);
  if (desiredHeight <= below || below >= above) {
    return { left, top: card.top, width, maxHeight: Math.min(desiredHeight, below), side: "below" };
  }
  const height = Math.min(desiredHeight, above);
  return { left, top: card.top + fieldHeight - height, width, maxHeight: height, side: "above" };
}
