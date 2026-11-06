import type { EditorClip } from "../editor/types.ts";
import { createContextMenu } from "./context-menu.ts";
import { splitAt, type SegmentRange } from "./segments.ts";

// two markers closer than this mark the same moment
const SAME_MOMENT = 0.01;
// a press that moves less than this is a click on the flag, not a drag
const DRAG_PX = 3;

function clamp(time: number, duration: number): number {
  return Math.max(0, Math.min(duration, time));
}

function sorted(times: readonly number[]): number[] {
  return [...times].sort((a, b) => a - b);
}

/** The markers with one more at the time, or null when one is already there. */
export function addMarker(markers: readonly number[], time: number, duration: number): number[] | null {
  if (!Number.isFinite(time) || !(duration > 0)) return null;
  const at = clamp(time, duration);
  if (markers.some((marker) => Math.abs(marker - at) < SAME_MOMENT)) return null;
  return sorted([...markers, at]);
}

export function moveMarker(markers: readonly number[], index: number, time: number, duration: number): number[] {
  if (!Number.isFinite(time) || index < 0 || index >= markers.length) return [...markers];
  return sorted([...markers.filter((_, other) => other !== index), clamp(time, duration)]);
}

export function removeMarker(markers: readonly number[], index: number): number[] {
  return markers.filter((_, other) => other !== index);
}

/** The markers a video of this length can show; a shorter probe drops the ones past its end. */
export function markersWithin(markers: readonly number[] | undefined, duration: number): number[] {
  if (!markers || !(duration > 0)) return [];
  return markers.filter((marker) => Number.isFinite(marker) && marker >= 0 && marker <= duration);
}

/**
 * The segments cut at every marker inside one, the same way Split cuts at the playhead. Markers
 * in a gap or too close to a segment's edge are left alone. Null when no marker cuts anything.
 */
export function splitAtMarkers(
  segments: SegmentRange[],
  markers: readonly number[],
  duration: number,
): SegmentRange[] | null {
  let current = segments;
  let cut = false;
  for (const marker of markers) {
    const result = splitAt(current, marker, duration);
    if (!result) continue;
    current = result.segments;
    cut = true;
  }
  return cut ? current : null;
}

export interface MarkerHost {
  document: Document;
  window: Window & typeof globalThis;
  clip: () => EditorClip | null;
  // the video's length, 0 while it isn't ready
  duration: () => number;
  playhead: () => number;
  seek: (time: number) => void;
  formatTime: (time: number) => string;
  // the time Snap moves a dragged marker to, or the time itself
  snap: (time: number) => number;
  history?: {
    begin?: (path: string | null, label?: string) => void;
    commit?: () => void;
    revert?: () => void;
    action?: <T>(path: string | null, fn: () => T, label?: string) => T;
  } | null;
  canSplit: () => boolean;
  splitAtMarkers: () => void;
  // focus goes here when the last marker goes away
  timeline: () => HTMLElement | null;
}

export interface MarkerApi {
  paint: () => void;
  add: () => void;
  canAdd: () => boolean;
  // the timeline's menu adds one where it was right-clicked
  addAt: (time: number) => void;
  canAddAt: (time: number) => boolean;
  times: () => number[];
  closeMenu: () => void;
}

interface MarkerDrag {
  pointerId: number;
  flag: HTMLElement;
  index: number;
  from: number;
  startX: number;
  moved: boolean;
}

type MenuAction = "split" | "remove" | "clear";

export function installMarkers(host: MarkerHost): MarkerApi {
  const doc = host.document;
  const layer = doc.getElementById("seq-marker-layer");
  let painted = "";
  let drag: MarkerDrag | null = null;
  const menu = createContextMenu(doc, host.window, "marker-menu");
  let pointerOpen = 0;

  function times(): number[] {
    return markersWithin(host.clip()?.markers, host.duration());
  }

  function record(label: string, run: () => void): void {
    const path = host.clip()?.path ?? null;
    if (host.history?.action) host.history.action(path, run, label);
    else run();
  }

  function setMarkers(next: number[]): void {
    const clip = host.clip();
    if (clip) clip.markers = next;
  }

  function flags(): HTMLElement[] {
    return layer ? Array.from(layer.querySelectorAll<HTMLElement>(".seq-marker-flag")) : [];
  }

  function paint(): void {
    if (!layer) return;
    const duration = host.duration();
    const list = times();
    const key = duration > 0 ? duration + "|" + list.join(",") + "|" + list.map(host.formatTime).join(",") : "";
    layer.classList.toggle("hid", !(duration > 0));
    if (key === painted) return;
    painted = key;
    const focused = flags().findIndex((flag) => flag === doc.activeElement);
    layer.replaceChildren();
    for (const [index, time] of list.entries()) {
      const marker = doc.createElement("div");
      marker.className = "seq-marker";
      marker.style.left = Math.round((time / duration) * 100 * 1e6) / 1e6 + "%";
      const flag = doc.createElement("button");
      flag.type = "button";
      flag.className = "seq-marker-flag";
      flag.dataset.markerIndex = String(index);
      const name = "Marker at " + host.formatTime(time);
      flag.dataset.tip = name;
      flag.setAttribute("aria-label", name);
      flag.setAttribute("aria-keyshortcuts", "Delete");
      const shape = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      shape.setAttribute("viewBox", "0 0 11 13");
      shape.setAttribute("aria-hidden", "true");
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M1 0h9v8l-4.5 4.5L1 8z");
      shape.append(path);
      flag.append(shape);
      marker.append(flag);
      layer.append(marker);
    }
    if (focused >= 0) flags()[Math.min(focused, list.length - 1)]?.focus({ preventScroll: true });
  }

  function canAdd(): boolean {
    return !!host.clip() && host.duration() > 0;
  }

  function canAddAt(time: number): boolean {
    return canAdd() && !!addMarker(times(), time, host.duration());
  }

  function addAt(time: number): void {
    const next = addMarker(times(), time, host.duration());
    if (!next) return;
    record("add marker", () => setMarkers(next));
    paint();
  }

  // a shortcut passes its event, so the playhead is read here rather than taken as an argument
  function add(): void {
    addAt(host.playhead());
  }

  // after a marker goes, focus moves to the one that took its place, or back to the timeline
  function remove(index: number, refocus: boolean): void {
    const list = times();
    if (index < 0 || index >= list.length) return;
    record("remove marker", () => setMarkers(removeMarker(list, index)));
    paint();
    if (!refocus) return;
    const left = flags();
    const next = left[Math.min(index, left.length - 1)];
    if (next) next.focus({ preventScroll: true });
    else host.timeline()?.focus({ preventScroll: true });
  }

  function clear(): void {
    if (!times().length) return;
    record("clear markers", () => setMarkers([]));
    paint();
  }

  function indexOf(target: EventTarget | null): number {
    const flag = target instanceof Element ? target.closest<HTMLElement>(".seq-marker-flag") : null;
    return flag ? Number(flag.dataset.markerIndex) : -1;
  }

  function trackWidth(): number {
    return layer?.getBoundingClientRect().width ?? 0;
  }

  function endDrag(cancelled: boolean): void {
    const current = drag;
    if (!current) return;
    drag = null;
    doc.removeEventListener("keydown", onDragKey, true);
    current.flag.classList.remove("dragging");
    doc.body.classList.remove("marker-dragging");
    if (!current.moved) {
      if (!cancelled) host.seek(times()[current.index] ?? current.from);
      return;
    }
    if (cancelled) host.history?.revert?.();
    else host.history?.commit?.();
    paint();
  }

  function onDragKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    endDrag(true);
  }

  layer?.addEventListener("pointerdown", (event) => {
    const index = indexOf(event.target);
    if (index < 0) return;
    if (event.button === 2) {
      pointerOpen = Date.now();
      return;
    }
    if (event.button !== 0) return;
    const flag = event.target instanceof Element ? event.target.closest<HTMLElement>(".seq-marker-flag") : null;
    if (!flag) return;
    event.preventDefault();
    flag.focus({ preventScroll: true });
    try {
      flag.setPointerCapture(event.pointerId);
    } catch {
      // a pointer that is already gone just ends without a drag
    }
    drag = { pointerId: event.pointerId, flag, index, from: times()[index] ?? 0, startX: event.clientX, moved: false };
    doc.addEventListener("keydown", onDragKey, true);
  });

  layer?.addEventListener("pointermove", (event) => {
    const current = drag;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.startX;
    if (!current.moved) {
      if (Math.abs(dx) < DRAG_PX) return;
      current.moved = true;
      // the drag moves the flag by itself, so whatever comes after it paints them all again
      painted = "";
      current.flag.classList.add("dragging");
      doc.body.classList.add("marker-dragging");
      host.history?.begin?.(host.clip()?.path ?? null, "move marker");
    }
    const width = trackWidth();
    const duration = host.duration();
    if (!(width > 0) || !(duration > 0)) return;
    // the marker keeps its place under the pointer from where it was grabbed
    const time = host.snap(clamp(current.from + (dx / width) * duration, duration));
    const list = times();
    const next = moveMarker(list, current.index, time, duration);
    setMarkers(next);
    current.index = next.indexOf(clamp(time, duration));
    const marker = current.flag.parentElement;
    if (marker) {
      const left = Math.round((clamp(time, duration) / duration) * 100 * 1e6) / 1e6 + "%";
      if (marker.style.left !== left) marker.style.left = left;
    }
  });

  const finish = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) endDrag(event.type === "pointercancel");
  };
  layer?.addEventListener("pointerup", finish);
  layer?.addEventListener("pointercancel", finish);

  layer?.addEventListener("keydown", (event) => {
    const index = indexOf(event.target);
    if (index < 0) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      remove(index, true);
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      open(index);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  layer?.addEventListener("click", (event) => {
    // a pointer click seeks when the press ends; Enter on a focused flag lands here
    if (event.detail !== 0) return;
    const index = indexOf(event.target);
    const time = times()[index];
    if (time != null) host.seek(time);
  });

  layer?.addEventListener("contextmenu", (event) => {
    const index = indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const fromPointer = Date.now() - pointerOpen < 1000;
    pointerOpen = 0;
    open(index, fromPointer ? { x: event.clientX, y: event.clientY } : undefined);
  });

  function closeMenu(returnFocus = false): void {
    menu.close(returnFocus);
  }

  function run(action: MenuAction, index: number): void {
    if (action === "split") host.splitAtMarkers();
    else if (action === "remove") remove(index, true);
    else clear();
  }

  function open(index: number, at?: { x: number; y: number }): void {
    const flag = flags()[index];
    if (!flag) return;
    menu.open({
      label: flag.getAttribute("aria-label") ?? "Marker",
      anchor: flag,
      at,
      items: [
        { action: "split", label: "Split at all markers", disabled: !host.canSplit() },
        { action: "remove", label: "Remove marker", keys: "Delete" },
        { action: "clear", label: "Clear markers" },
      ],
      run: (action) => run(action as MenuAction, index),
      closed: () => flag.classList.remove("menu-target"),
    });
    // after opening, since opening closes the menu before it, which puts out the old target
    flag.classList.add("menu-target");
  }

  return { paint, add, canAdd, addAt, canAddAt, times, closeMenu: () => closeMenu(false) };
}
