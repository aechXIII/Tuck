// The timeline's right-click menu on segments, gaps, the ruler and added audio. While it is open a
// line marks where it acts, with its time; each item shows what it will do while it is lit: a cut
// line, the footage or sound that goes, and the line the rest moves to. Items that can't apply
// there aren't in the menu.

import type { AudioTimelineState } from "../editor/types.ts";
import { createContextMenu, type ContextMenuEntry } from "./context-menu.ts";
import { takeOut } from "./ripple.ts";
import { MIN_DURATION, hasPlacement, removeStretch, stretchBounds, timelineGaps, type SegmentRange } from "./segments.ts";

export interface EditMenuHost {
  document: Document;
  window: Window & typeof globalThis;
  // the video's length, 0 while it isn't ready
  duration: () => number;
  segments: () => SegmentRange[];
  markers: () => number[];
  audio: () => AudioTimelineState | null;
  playhead: () => number;
  timeAt: (clientX: number) => number;
  // the time Snap moves a split to, or the time itself
  snap: (time: number) => number;
  formatTime: (time: number) => string;
  selectSegment: (index: number) => void;
  split: (time: number) => void;
  // each takes out from..to and closes up behind it, as Cut out does
  trimStart: (from: number, to: number) => void;
  trimEnd: (from: number, to: number) => void;
  cutOut: (from: number, to: number) => void;
  canAddMarker: (time: number) => boolean;
  addMarker: (time: number) => void;
  // a video without sound has nothing for Mute segment to mute
  hasSound: () => boolean;
  // Lossless cut copies the sound as it is and never exports a gap as black
  cutTask: () => boolean;
  toggleSegmentMute: (index: number) => void;
  remove: (index: number) => void;
  ripple: (index: number) => void;
  closeGap: (start: number, end: number) => void;
  closeAllGaps: () => void;
  selectAudioClip: (trackId: string, clipId: string) => void;
  splitAudio: (time: number) => void;
  removeAudio: () => void;
}

export interface EditMenu {
  openForSegment: (index: number) => void;
  close: () => void;
}

export function installEditMenu(host: EditMenuHost): EditMenu {
  const doc = host.document;
  const menu = createContextMenu(doc, host.window, "timeline-edit-menu");
  const stack = doc.getElementById("sequence-stack");
  const layer = doc.getElementById("seq-edit-preview");

  // --- previews, drawn in the preview layer in timeline time --------------------------------
  function pct(time: number): string {
    return (time / (host.duration() || 1)) * 100 + "%";
  }

  function rowBox(lane: Element): { top: number; height: number } | null {
    if (!layer) return null;
    const box = lane.getBoundingClientRect();
    if (!(box.height > 0)) return null;
    return { top: box.top - layer.getBoundingClientRect().top, height: box.height };
  }

  function segmentLanes(): Element[] {
    return Array.from(doc.querySelectorAll("#source-group .seq-lane"));
  }

  function soundLanes(): Element[] {
    return Array.from(doc.querySelectorAll("#source-group .seq-lane.audio-lane"));
  }

  function addedLane(trackId: string): Element | null {
    return Array.from(doc.querySelectorAll<HTMLElement>("#imported-audio-tracks .seq-lane[data-track-id]"))
      .find((lane) => lane.dataset.trackId === trackId) ?? null;
  }

  function allLanes(): Element[] {
    return [...segmentLanes(), ...Array.from(doc.querySelectorAll("#imported-audio-tracks .seq-lane"))];
  }

  function draw(className: string, lane: Element, start: number, end: number): HTMLElement | null {
    const row = rowBox(lane);
    if (!layer || !row) return null;
    const part = doc.createElement("div");
    part.className = className;
    part.style.left = pct(start);
    part.style.width = pct(end - start);
    part.style.top = row.top + "px";
    part.style.height = row.height + "px";
    layer.append(part);
    return part;
  }

  function line(className: string, time: number, lanes: Element[]): void {
    const rows = lanes.map(rowBox).filter((row): row is { top: number; height: number } => !!row);
    if (!layer || !rows.length) return;
    const top = Math.min(...rows.map((row) => row.top));
    const bottom = Math.max(...rows.map((row) => row.top + row.height));
    const part = doc.createElement("div");
    part.className = className;
    part.style.left = pct(time);
    part.style.top = top + "px";
    part.style.height = bottom - top + "px";
    layer.append(part);
  }

  function chip(time: number, text: string, slide = false): HTMLElement | null {
    const ruler = doc.getElementById("sequence-ruler");
    const row = ruler ? rowBox(ruler) : null;
    if (!layer || !row) return null;
    const part = doc.createElement("div");
    part.className = "edit-preview-time" + (slide ? " slide" : "");
    part.textContent = text;
    part.style.left = pct(time);
    part.style.top = row.top + 1 + "px";
    layer.append(part);
    return part;
  }

  // where the menu acts, shown the whole time it is open: a thin line and its time
  let here = 0;
  let hereLanes: Element[] = [];
  function showHere(): void {
    line("edit-preview-here", here, hereLanes);
    const time = chip(here, host.formatTime(here));
    if (time) time.dataset.here = "";
  }

  // something drawn on the line itself takes the place of its time
  function coverHereTime(time: number): void {
    if (Math.abs(time - here) < 0.001) layer?.querySelectorAll("[data-here]").forEach((part) => part.remove());
  }

  function cutEdges(from: number, to: number): void {
    line("edit-preview-cut", from, segmentLanes());
    line("edit-preview-cut", to, segmentLanes());
  }

  // the footage between from and to goes faint, the way muted sound looks, with its cuts dashed
  function gone(from: number, to: number): void {
    for (const segment of host.segments()) {
      const start = Math.max(from, segment.start);
      const end = Math.min(to, segment.end);
      if (end - start > 0.001) for (const lane of segmentLanes()) draw("edit-preview-gone", lane, start, end);
    }
    cutEdges(from, to);
  }

  // the line everything after slides to, and how far
  function lands(at: number, amount: number): void {
    line("edit-preview-land", at, allLanes());
    coverHereTime(at);
    chip(at, "−" + amount.toFixed(2) + "s", true);
  }

  function parts() {
    return { segments: host.segments(), markers: host.markers(), audio: host.audio() };
  }

  // what taking the stretch out does: what goes (or the gap that closes), the gaps of a never
  // placed timeline that close with it, and the line the rest slides to
  function outcome(from: number, to: number, removesFootage: boolean): void {
    const result = takeOut(parts(), from, to, removesFootage, host.duration());
    if (!result) return;
    if (removesFootage) gone(result.from, result.to);
    else cutEdges(result.from, result.to);
    for (const gap of result.closedGaps) cutEdges(gap.start, gap.end);
    lands(result.from, result.to - result.from);
  }

  function closeAllOutcome(): void {
    const gaps = timelineGaps(host.segments(), host.duration());
    const first = gaps[0];
    if (!first) return;
    for (const gap of gaps) cutEdges(gap.start, gap.end);
    lands(first.start, gaps.reduce((sum, gap) => sum + gap.end - gap.start, 0));
  }

  // a deleted segment that leaves black in the export says so, as the gap itself will
  function blackLabel(start: number, end: number): void {
    const video = doc.getElementById("timeline");
    const part = video ? draw("edit-preview-black", video, start, end) : null;
    if (part) part.textContent = (end - start).toFixed(2) + "s of black";
  }

  function ghostMarker(time: number): void {
    if (!layer) return;
    const marker = doc.createElement("div");
    marker.className = "seq-marker edit-preview-marker";
    marker.style.left = pct(time);
    const flag = doc.createElement("span");
    flag.className = "seq-marker-flag";
    const shape = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    shape.setAttribute("viewBox", "0 0 11 13");
    shape.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M1 0h9v8l-4.5 4.5L1 8z");
    shape.append(path);
    flag.append(shape);
    marker.append(flag);
    layer.append(marker);
    // the flag sits where the line's time would
    coverHereTime(time);
  }

  function clearPreview(): void {
    layer?.replaceChildren();
  }

  // --- what each target offers ---------------------------------------------------------------
  interface Item {
    entry: ContextMenuEntry;
    preview?: () => void;
    run?: () => void;
    // false for items that act on the whole segment or gap, so the line goes while they are lit
    atLine?: boolean;
  }

  // groups that turn out empty leave no separator behind
  function grouped(groups: Item[][]): Item[] {
    const filled = groups.filter((group) => group.length);
    return filled.flatMap((group, i) => (i ? [{ entry: "separator" as const }, ...group] : group));
  }

  function splitItem(at: number, lanes: Element[], run: () => void): Item {
    return {
      entry: { action: "split", label: "Split here" },
      atLine: false,
      preview: () => {
        line("edit-preview-cut", at, lanes);
        chip(at, host.formatTime(at));
      },
      run,
    };
  }

  function markerItem(at: number): Item[] {
    if (!host.canAddMarker(at)) return [];
    return [{ entry: { action: "marker", label: "Add marker here" }, preview: () => ghostMarker(at), run: () => host.addMarker(at) }];
  }

  function segmentItems(index: number, at: number): Item[] {
    const segments = host.segments();
    const segment = segments[index];
    if (!segment) return [];
    const full = host.duration();
    const canCut = at >= segment.start + MIN_DURATION && at <= segment.end - MIN_DURATION;
    const playhead = host.playhead();
    const [from, to] = stretchBounds(segments, Math.min(playhead, at), Math.max(playhead, at), full);
    const inside = playhead > segment.start && playhead < segment.end;
    const apart = Math.abs(playhead - at) >= MIN_DURATION;
    const several = segments.length > 1;
    const cuts: Item[] = [];
    if (canCut) {
      cuts.push(
        splitItem(at, segmentLanes(), () => host.split(at)),
        {
          entry: { action: "trim-start", label: "Trim start to here" },
          preview: () => outcome(segment.start, at, true),
          run: () => host.trimStart(segment.start, at),
        },
        {
          entry: { action: "trim-end", label: "Trim end to here" },
          preview: () => outcome(at, segment.end, true),
          run: () => host.trimEnd(at, segment.end),
        },
      );
    }
    if (inside && apart && removeStretch(segments, from, to, full).length > 0) {
      cuts.push({
        entry: { action: "cut-out", label: "Cut out from the playhead" },
        preview: () => {
          outcome(from, to, true);
          line("edit-preview-from", playhead, allLanes());
        },
        run: () => host.cutOut(from, to),
      });
    }
    const marks: Item[] = [...markerItem(at)];
    if (host.hasSound() && !host.cutTask()) {
      marks.push({
        // the key acts on the selected segment, which this one is now
        entry: { action: "mute", label: segment.muted ? "Unmute segment" : "Mute segment", keys: "Shift+M" },
        atLine: false,
        preview: () => {
          if (!segment.muted) for (const lane of soundLanes()) draw("edit-preview-quiet", lane, segment.start, segment.end);
        },
        run: () => host.toggleSegmentMute(index),
      });
    }
    const deletes: Item[] = several
      ? [
          {
            entry: { action: "remove", label: "Delete", keys: "Delete" },
            atLine: false,
            preview: () => {
              gone(segment.start, segment.end);
              if (!host.cutTask() && hasPlacement(segments) && index < segments.length - 1) blackLabel(segment.start, segment.end);
            },
            run: () => host.remove(index),
          },
          {
            entry: { action: "ripple", label: "Ripple delete", keys: "Shift+Delete" },
            atLine: false,
            preview: () => outcome(segment.start, segment.end, true),
            run: () => host.ripple(index),
          },
        ]
      : [];
    return grouped([cuts, marks, deletes]);
  }

  function gapItems(gap: { start: number; end: number }): Item[] {
    const gaps = timelineGaps(host.segments(), host.duration());
    const items: Item[] = [
      {
        entry: { action: "close-gap", label: "Close gap" },
        atLine: false,
        preview: () => outcome(gap.start, gap.end, false),
        run: () => host.closeGap(gap.start, gap.end),
      },
    ];
    if (gaps.length > 1) {
      items.push({ entry: { action: "close-all", label: "Close all gaps" }, atLine: false, preview: closeAllOutcome, run: () => host.closeAllGaps() });
    }
    return items;
  }

  function rulerItems(at: number): Item[] {
    const segment = host.segments().find((part) => at >= part.start + MIN_DURATION && at <= part.end - MIN_DURATION);
    return grouped([markerItem(at), segment ? [splitItem(at, segmentLanes(), () => host.split(at))] : []]);
  }

  function audioItems(trackId: string, clipId: string, at: number): Item[] {
    const clip = host.audio()?.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId);
    const lane = addedLane(trackId);
    if (!clip || !lane) return [];
    const end = Math.min(host.duration(), clip.timelineStart + clip.timelineDuration);
    const canSplit = at >= clip.timelineStart + MIN_DURATION && at <= end - MIN_DURATION;
    return grouped([
      canSplit ? [splitItem(at, [lane], () => host.splitAudio(at))] : [],
      [{ entry: { action: "remove", label: "Delete", keys: "Delete" }, atLine: false, preview: () => draw("edit-preview-gone", lane, clip.timelineStart, end), run: () => host.removeAudio() }],
    ]);
  }

  // above the ruler and beside the line, so the line, its time and the lit item's preview stay in
  // sight below the menu
  function overLine(time: number): { x: number; bottom: number } | undefined {
    const ruler = doc.getElementById("sequence-ruler");
    const box = layer?.getBoundingClientRect();
    if (!ruler || !box || !(box.width > 0)) return undefined;
    return { x: box.left + (time / (host.duration() || 1)) * box.width + 10, bottom: ruler.getBoundingClientRect().top - 6 };
  }

  function show(label: string, items: Item[], anchor: HTMLElement, at: number, lanes: Element[], pointer?: { x: number; y: number }): void {
    if (!items.length) return;
    here = at;
    hereLanes = lanes;
    const byAction = new Map(items.flatMap((item) => (item.entry === "separator" ? [] : [[item.entry.action, item] as const])));
    menu.open({
      label,
      anchor,
      at: pointer,
      over: overLine(at),
      items: items.map((item) => item.entry),
      lit: (action) => {
        clearPreview();
        const item = action ? byAction.get(action) : undefined;
        if (item?.atLine !== false) showHere();
        item?.preview?.();
      },
      run: (action) => byAction.get(action)?.run?.(),
      closed: clearPreview,
    });
  }

  // --- where the menu opens -------------------------------------------------------------------
  stack?.addEventListener("contextmenu", (event) => {
    if (!(host.duration() > 0) || !(event.target instanceof Element)) return;
    const pointer = { x: event.clientX, y: event.clientY };
    const time = host.timeAt(event.clientX);
    const added = event.target.closest<HTMLElement>(".seq-audio-clip.imported[data-clip-id]");
    if (added) {
      const trackId = added.dataset.trackId ?? "";
      const clipId = added.dataset.clipId ?? "";
      host.selectAudioClip(trackId, clipId);
      const anchor = doc.querySelector<HTMLElement>(`.seq-audio-clip.imported[data-clip-id="${CSS.escape(clipId)}"]`) ?? added;
      const lane = addedLane(trackId);
      const at = host.snap(time);
      show("Audio clip", audioItems(trackId, clipId, at), anchor, at, lane ? [lane] : [], pointer);
      event.preventDefault();
      return;
    }
    const ruler = event.target.closest<HTMLElement>("#sequence-ruler");
    if (ruler) {
      const at = host.snap(time);
      show("Timeline", rulerItems(at), ruler, at, segmentLanes(), pointer);
      event.preventDefault();
      return;
    }
    const lane = event.target.closest("#source-group .seq-lane");
    if (!lane) return;
    const segments = host.segments();
    const index = segments.findIndex((segment) => time >= segment.start && time < segment.end);
    if (index >= 0) {
      host.selectSegment(index);
      const anchor = doc.querySelector<HTMLElement>(`.tl-segment[data-segment-index="${index}"]`) ?? (lane as HTMLElement);
      const at = host.snap(time);
      show("Segment " + (index + 1), segmentItems(index, at), anchor, at, segmentLanes(), pointer);
      return;
    }
    const gap = timelineGaps(segments, host.duration()).find((item) => time >= item.start && time < item.end);
    if (gap) show("Gap", gapItems(gap), lane as HTMLElement, time, segmentLanes(), pointer);
  });

  // Shift+F10 or the menu key on a focused segment or added clip
  stack?.addEventListener("keydown", (event) => {
    if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) || !(event.target instanceof HTMLElement)) return;
    const segment = event.target.closest<HTMLElement>(".tl-segment");
    const added = event.target.closest<HTMLElement>(".seq-audio-clip.imported[data-clip-id]");
    if (segment) openForSegment(Number(segment.dataset.segmentIndex));
    else if (added) {
      const trackId = added.dataset.trackId ?? "";
      const clipId = added.dataset.clipId ?? "";
      const clip = host.audio()?.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId);
      const lane = addedLane(trackId);
      if (!clip || !lane) return;
      const playhead = host.playhead();
      const inside = playhead > clip.timelineStart && playhead < clip.timelineStart + clip.timelineDuration;
      const at = inside ? playhead : clip.timelineStart + clip.timelineDuration / 2;
      show("Audio clip", audioItems(trackId, clipId, at), added, at, [lane]);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });

  // from the keyboard the menu acts at the playhead when it is in the segment, else its middle
  function openForSegment(index: number): void {
    const segment = host.segments()[index];
    if (!segment || !(host.duration() > 0)) return;
    host.selectSegment(index);
    // selecting draws the segments again, so the anchor is the new button
    const anchor = doc.querySelector<HTMLElement>(`.tl-segment[data-segment-index="${index}"]`);
    if (!anchor) return;
    const playhead = host.playhead();
    const time = playhead > segment.start && playhead < segment.end ? playhead : (segment.start + segment.end) / 2;
    show("Segment " + (index + 1), segmentItems(index, time), anchor, time, segmentLanes());
  }

  return { openForSegment, close: () => menu.close(false) };
}
