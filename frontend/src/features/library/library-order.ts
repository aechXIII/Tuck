// The Library's order and its Find: which order the rows take, and which names match.

import type { EditorClip } from "../editor/types.ts";

export type LibraryOrder = "yours" | "newest" | "oldest" | "name" | "largest" | "longest";

export const LIBRARY_ORDERS: readonly { value: LibraryOrder; label: string }[] = [
  { value: "yours", label: "Your order" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name" },
  { value: "largest", label: "Largest first" },
  { value: "longest", label: "Longest first" },
];

/** Find and Sort show once the Library is longer than this, or while Find is open. */
export const FIND_SHOWS_AFTER = 8;

export function isLibraryOrder(value: unknown): value is LibraryOrder {
  return LIBRARY_ORDERS.some((order) => order.value === value);
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The paths in this order. A video whose value isn't known yet (still loading, or unreadable) goes
 * after the ones that have it, in the order it had; equal values keep their order too.
 */
export function sortedPaths(
  paths: readonly string[],
  clips: Readonly<Record<string, EditorClip | undefined>>,
  order: LibraryOrder,
): string[] {
  if (order === "yours") return [...paths];
  const value = (path: string): number | string | null => {
    const clip = clips[path];
    if (!clip) return null;
    if (order === "name") return clip.name;
    const data = clip.probeData;
    if (order === "newest" || order === "oldest") return typeof data?.modified === "number" ? data.modified : null;
    if (order === "largest") return Number(clip._fileSize) || (typeof data?.file_size === "number" ? data.file_size : null);
    return typeof data?.duration === "number" && data.duration > 0 ? data.duration : null;
  };
  const descending = order === "newest" || order === "largest" || order === "longest";
  return paths
    .map((path, index) => ({ path, index, value: value(path) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
      }
      const compared = typeof a.value === "string" && typeof b.value === "string"
        ? names.compare(a.value, b.value)
        : Number(a.value) - Number(b.value);
      return (descending ? -compared : compared) || a.index - b.index;
    })
    .map((entry) => entry.path);
}

/** Where the query is in the name, ignoring capitals, or null; an empty query matches nothing. */
export function findMatch(name: string, query: string): [number, number] | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const at = name.toLowerCase().indexOf(needle);
  return at < 0 ? null : [at, at + needle.length];
}
