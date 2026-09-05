import { getBackendClient, hasBackendClient } from "../../backend/client.ts";
import { probeStatus } from "../../state/probe.ts";
import * as TuckLayout from "../../ui/layout.ts";
import { formatTime } from "../editor/format.ts";
import type { EditorClip, EditorSession } from "../editor/session.ts";
import { toast } from "../editor/toast.ts";
import * as SegmentEditing from "./segments.ts";
import * as TimelineCore from "./timeline-core.ts";

export interface TimelineHost {
  session: EditorSession;
  byId: (id: string) => HTMLElement | null;
  documentRef?: Document;
  windowRef?: Window & typeof globalThis;
  toast?: (msg: string, kind?: string) => void;
  formatTime?: (seconds: number) => string;
  updateTime?: () => void;
  seekPreview?: (sec: number) => void;
  seekToRatio?: (ratio: number) => void;
  paintStageScrub?: (pct: number) => void;
  renderClips?: () => void;
  reqPreview?: () => void;
  paintCropOverlay?: () => void;
  setPreviewSec?: (sec: number | null) => void;
  getPreviewSec?: () => number | null;
  flushVideoSeek?: () => void;
  AudioTimeline?: {
    isSourceGroupSelected?: () => boolean;
    paintSource?: () => void;
    paintMixer?: () => void;
    render: () => void;
    splitSelected?: () => void;
    hasSelection?: () => boolean;
    selectVideoTrack?: () => void;
  };
  History?: {
    begin?: (path: string | null) => void;
    commit?: () => void;
    cancel?: () => void;
  };
  TuckShortcuts?: {
    registerAction: (
      id: string,
      action: (() => void) | { enabled?: () => boolean; execute: () => void },
    ) => void;
  };
}

export type TimelineApi = ReturnType<typeof installTimeline>;

type SegmentLike = { start: number; end: number; muted?: boolean; badge?: string; index?: number };

type TimelineDrag = "in" | "out" | "ruler" | "seek" | "segment-pending" | "segment";

const EMPTY_TIMELINE_STATUS: "empty" = "empty";

function isHtmlElement(value: EventTarget | null): value is HTMLElement {
  return (
    value !== null &&
    typeof value === "object" &&
    "classList" in value &&
    "dataset" in value
  );
}

function isElement(value: EventTarget | null): value is Element {
  return (
    value !== null &&
    typeof value === "object" &&
    "closest" in value &&
    typeof value.closest === "function"
  );
}

function isVideoElement(value: HTMLElement | null): value is HTMLVideoElement {
  return (
    value !== null &&
    "currentTime" in value &&
    "volume" in value &&
    "paused" in value
  );
}

function isInputElement(value: HTMLElement | null): value is HTMLInputElement {
  return value !== null && "value" in value;
}

function isButtonElement(value: Element | null): value is HTMLButtonElement {
  return value !== null && "disabled" in value && "type" in value;
}

function isDisableableElement(
  value: HTMLElement | null,
): value is HTMLButtonElement | HTMLInputElement {
  return value !== null && "disabled" in value;
}

function arrayItem<T>(items: readonly T[], index: number): T | null {
  return items[index] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedClip(session: EditorSession): EditorClip | null {
  return session.selPath ? session.clips[session.selPath] ?? null : null;
}

interface ErrorTimelineViewState {
  readonly status: "error";
  readonly items: SegmentEditing.TimelineViewItem[];
}

type DisplayTimelineViewState = SegmentEditing.TimelineViewState | ErrorTimelineViewState;

export function installTimeline(host: TimelineHost) {
  const session = host.session;
  const byId = (id: string): HTMLElement | null => host.byId(id);
  const documentRef = host.documentRef ?? document;
  const windowRef = host.windowRef ?? window;
  const fmtt = host.formatTime ?? formatTime;
  const notify = host.toast ?? toast;
  const currentVideo = (): HTMLVideoElement | null => {
    const candidate = byId("vid");
    return isVideoElement(candidate) ? candidate : null;
  };
  let _previewSecLocal: number | null = null;
let snapOn = true;
  let timelineZoom = 1;
  let TL_ZOOM_MIN = TimelineCore.ZOOM_MIN;
  let TL_SNAP_PX = 8;

let _tlDrag: TimelineDrag | null = null;
let _MIN_TRIM = SegmentEditing.MIN_DURATION;

let _segmentDragOffset = 0;
let _segmentPointerX = 0;
let _segmentClickTime = 0;
let _SEGMENT_DRAG_THRESHOLD = 5;
let _SEGMENT_COLORS = [
  "#6D28D9",
  "#A855F7",
  "#8B5CF6",
  "#C084FC",
  "#7E22CE",
  "#9333EA",
];

 function segmentColor(index: number) {
   return _SEGMENT_COLORS[index % _SEGMENT_COLORS.length] ?? _SEGMENT_COLORS[0] ?? "#6D28D9";
 }

function formatSelectedDuration(seconds: number) {
  if (seconds < 60)
    return seconds.toFixed(2).replace(/\.?0+$/, "") + "s";
  return fmtt(seconds);
}

function videoDuration() {
  const selected = selectedClip(session);
  if (selected?.probeData && Number.isFinite(selected.probeData.duration)) {
    return selected.probeData.duration ?? 0;
  }
  const candidate = byId("vid");
  const v = isVideoElement(candidate) ? candidate : null;
  if (v && v.duration && isFinite(v.duration)) return v.duration;
  return 0;
}

function clipSegments(c: EditorClip | null | undefined, fullDur: number) {
  if (!fullDur || fullDur <= 0) return [];
  return SegmentEditing.segmentsForClip(c, fullDur);
}

function activeSegmentIndex(c: EditorClip | null | undefined, segments: SegmentLike[]) {
  let index = c && Number.isInteger(c.activeSegment) ? c.activeSegment : 0;
  return Math.max(0, Math.min(segments.length - 1, index));
}

function clipHasTrim(c: EditorClip | null | undefined, fullDur: number) {
  let segments = clipSegments(c, fullDur);
  return !SegmentEditing.isFullSource(segments, fullDur);
}

function setClipSegments(c: EditorClip | null | undefined, segments: SegmentLike[], active: unknown) {
  if (!c) return;
  c.segments = segments.map(function(segment: SegmentLike) {
    const item: { start: number; end: number; muted?: boolean } = {
      start: segment.start,
      end: segment.end,
    };
    if (segment.muted) item.muted = true;
    return item;
  });
  const requested = typeof active === "number" && Number.isFinite(active) ? active : 0;
  c.activeSegment = Math.max(0, Math.min(c.segments.length - 1, requested));
  c.trimStart = null;
  c.trimEnd = null;
  c.planData = null;
}

function playbackSegments() {
  return clipSegments(selectedClip(session), videoDuration());
}


function formatSegmentTime(seconds: number) {
  let centiseconds = Math.round(Math.max(0, seconds) * 100);
  let wholeSeconds = Math.floor(centiseconds / 100);
  let fraction = centiseconds % 100;
  return fmtt(wholeSeconds) +
    (fraction ? "." + String(fraction).padStart(2, "0").replace(/0$/, "") : "");
}

function paintTrimChrome() {
  let c = selectedClip(session);
  const status = c ? probeStatus(c) : "empty";
  let full = status === "ready" ? videoDuration() : 0;
  let view: DisplayTimelineViewState = SegmentEditing.timelineViewState(c, full);
  if (status === "error") view = { status: "error", items: [] };
  let ready = view.status === "ready";
  let editor = byId("audio-editor");
  let emptyState = byId("timeline-empty");
  if (editor) {
    editor.classList.toggle("is-empty", view.status === "empty");
    editor.classList.toggle("is-loading", view.status === "loading");
    editor.classList.toggle("is-error", view.status === "error");
  }
  if (emptyState) {
    emptyState.hidden = ready;
    let emptyTitle = emptyState.querySelector(".timeline-empty-title");
    let emptyCopy = emptyState.querySelector(".timeline-empty-copy");
    if (emptyTitle)
      emptyTitle.textContent =
        view.status === "loading"
          ? "Preparing timeline"
          : view.status === "error"
            ? "Clip details unavailable"
            : "No video selected";
    if (emptyCopy)
      emptyCopy.textContent =
        view.status === "loading"
          ? "Reading clip duration and audio tracks"
          : view.status === "error"
            ? "Retry from the Video inspector to enable editing."
          : "Choose a video from the Library to view its timeline.";
  }
  let ruler = byId("sequence-ruler");
  if (ruler) {
    ruler.classList.toggle("hid", !ready);
    if (ready) paintSequenceRuler(full);
  }
  let segmentsLayer = byId("tl-segments");
  if (segmentsLayer) segmentsLayer.replaceChildren();
  let timeline = byId("timeline");
  if (timeline) {
    timeline.setAttribute("aria-disabled", ready ? "false" : "true");
    timeline.setAttribute("tabindex", ready ? "0" : "-1");
  }
  for (const id of ["tl-in", "tl-out", "seq-playhead-layer"]) {
    byId(id)?.classList.toggle("hid", !ready);
  }
  for (const id of ["btn-seq-split", "btn-snap-toggle", "audio-add", "tl-zoom-slider"]) {
    const control = byId(id);
    if (isDisableableElement(control)) control.disabled = !ready;
  }
  let zoomButtons = documentRef.querySelectorAll(".dock-zoom-btn, .dock-fit-btn");
  for (const button of zoomButtons) {
    if (isButtonElement(button)) button.disabled = !ready;
  }

  let resetButton = byId("btn-segments-reset");
  let removeButton = byId("btn-segment-remove");
  let addButton = byId("btn-segment-add");
  if (!ready) {
    if (isButtonElement(resetButton)) {
      resetButton.disabled = true;
      resetButton.classList.add("hid");
    }
    if (isButtonElement(removeButton)) removeButton.disabled = true;
    if (isButtonElement(addButton)) {
      addButton.disabled = true;
      addButton.setAttribute("aria-disabled", "true");
      addButton.dataset.tip =
        view.status === "loading"
          ? "Preparing timeline"
          : view.status === "error"
            ? "Retry clip details first"
            : "Add a video first";
    }
    return {
      full: 0,
      bounds: { start: 0, end: 0 },
      has: false,
      segments: [],
      active: 0,
      status: view.status,
    };
  }

  let segments = view.items;
  let active = activeSegmentIndex(c, segments);
  let sourceGroupSelected =
    host.AudioTimeline && typeof host.AudioTimeline.isSourceGroupSelected === "function"
      ? host.AudioTimeline.isSourceGroupSelected()
      : true;
  let bounds = segments[active];
  if (!bounds) {
    return {
      full: 0,
      bounds: { start: 0, end: 0 },
      has: false,
      segments: [],
      active: 0,
      status: EMPTY_TIMELINE_STATUS,
    };
  }
  let startPct = full > 0 ? (bounds.start / full) * 100 : 0;
  let endPct = full > 0 ? (bounds.end / full) * 100 : 100;
  for (const [i, segment] of segments.entries()) {
    let segmentAudioMuted = !!segment.muted;
    let presentation = TimelineCore.segmentPresentationState(i, active);
    let range = documentRef.createElement("button");
    range.type = "button";
    range.className = presentation.className;
    range.dataset.segmentIndex = String(i);
    range.style.setProperty("--segment-color", segmentColor(i));
    range.style.setProperty(
      "--clip-fill",
      TimelineCore.clipFill(
        "video",
        TimelineCore.videoSegmentSelected(i, active, sourceGroupSelected),
        false,
        segmentColor(i),
      ),
    );
    range.style.left = (segment.start / (full || 1)) * 100 + "%";
    range.style.width =
      ((segment.end - segment.start) / (full || 1)) * 100 + "%";
    range.setAttribute(
      "aria-label",
      "Segment " +
        (i + 1) +
        ", " +
        formatSegmentTime(segment.start) +
        " to " +
        formatSegmentTime(segment.end) +
        (segmentAudioMuted ? ", source audio muted" : "") +
        ". Click to seek; drag to move",
    );
    range.setAttribute(
      "aria-pressed",
      i === active && sourceGroupSelected ? "true" : "false",
    );
    range.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
    let surface = documentRef.createElement("span");
    surface.className = "tl-segment-surface";
    let touchesPrevious =
      i > 0 && Math.abs((arrayItem(segments, i - 1)?.end ?? 0) - segment.start) < 0.001;
    let touchesNext =
      i + 1 < segments.length &&
      Math.abs(segment.end - (arrayItem(segments, i + 1)?.start ?? full)) < 0.001;
    range.classList.toggle("joins-previous", touchesPrevious);
    range.classList.toggle("joins-next", touchesNext);
    let badgeLabel = documentRef.createElement("span");
    badgeLabel.className = "tl-segment-badge";
    badgeLabel.setAttribute("aria-hidden", "true");
    badgeLabel.textContent = segment.badge ?? "";
    let copy = documentRef.createElement("span");
    copy.className = "tl-segment-copy";
    let nameLabel = documentRef.createElement("span");
    nameLabel.className = "tl-segment-label";
    nameLabel.textContent = c ? c.name : "";
    let rangeLabel = documentRef.createElement("span");
    rangeLabel.className = "tl-segment-range";
    rangeLabel.setAttribute("aria-hidden", "true");
    let timeText =
      formatSegmentTime(segment.start) +
      "–" +
      formatSegmentTime(segment.end) +
      " · " +
      formatSelectedDuration(segment.end - segment.start);
    rangeLabel.textContent = timeText;
    copy.append(nameLabel, rangeLabel);
    surface.append(badgeLabel, copy);
    range.appendChild(surface);
    let timeLabel = documentRef.createElement("span");
    timeLabel.className = "tl-segment-time";
    timeLabel.setAttribute("aria-hidden", "true");
    timeLabel.textContent = timeText;
    range.appendChild(timeLabel);
    let edgeIn = documentRef.createElement("span");
    edgeIn.className = "clip-edge start";
    edgeIn.dataset.edge = "start";
    let edgeOut = documentRef.createElement("span");
    edgeOut.className = "clip-edge end";
    edgeOut.dataset.edge = "end";
    range.append(edgeIn, edgeOut);
    segmentsLayer?.appendChild(range);
  }
  paintSelectionFrame(startPct, endPct, segmentColor(active));
  byId("tl-in")?.setAttribute(
    "aria-valuemin",
    String(active > 0 ? arrayItem(segments, active - 1)?.end ?? 0 : 0),
  );
  byId("tl-in")?.setAttribute("aria-valuemax", String(bounds.end - _MIN_TRIM));
  byId("tl-in")?.setAttribute("aria-valuenow", String(bounds.start));
  byId("tl-out")?.setAttribute("aria-valuemin", String(bounds.start + _MIN_TRIM));
  byId("tl-out")?.setAttribute(
    "aria-valuemax",
    String(active + 1 < segments.length ? arrayItem(segments, active + 1)?.start ?? full : full),
  );
  byId("tl-out")?.setAttribute("aria-valuenow", String(bounds.end));

  let has = clipHasTrim(c, full);
  if (isButtonElement(resetButton)) {
    resetButton.disabled = !has;
    resetButton.classList.toggle("hid", !has);
  }
  if (isButtonElement(removeButton)) removeButton.disabled = segments.length <= 1;
  let canAdd = SegmentEditing.canAddSegment(segments, full || 1);
  if (isButtonElement(addButton)) {
    addButton.disabled = !canAdd;
    addButton.setAttribute("aria-disabled", canAdd ? "false" : "true");
    addButton.dataset.tip = canAdd ? "Add segment (A)" : "Shorten a segment first";
  }
  if (host.AudioTimeline && host.AudioTimeline.paintSource)
    host.AudioTimeline.paintSource();
  if (host.AudioTimeline && host.AudioTimeline.paintMixer)
    host.AudioTimeline.paintMixer();
  return {
    full: full,
    bounds: bounds,
    has: has,
    segments: segments,
    active: active,
    status: view.status,
  };
}

function paintSelectionFrame(startPct: number, endPct: number, color: string) {
  let frame = byId("seq-selection");
  if (frame) frame.hidden = true;
  let tlIn = byId("tl-in");
  if (tlIn) {
    tlIn.classList.remove("hid");
    tlIn.classList.add("sr-handle");
    tlIn.style.left = startPct + "%";
    tlIn.style.setProperty("--segment-color", color);
  }
  let tlOut = byId("tl-out");
  if (tlOut) {
    tlOut.classList.remove("hid");
    tlOut.classList.add("sr-handle");
    tlOut.style.left = endPct + "%";
    tlOut.style.setProperty("--segment-color", color);
  }
}

function paintSequenceRuler(full: number) {
  let ruler = byId("sequence-ruler");
  if (!ruler) return;
  ruler.replaceChildren();
  if (full <= 0) return;
  let pixelsPerSecond = timelinePxPerSecond();
  let step = TimelineCore.rulerStep(full, pixelsPerSecond);
  let majorEvery = TimelineCore.rulerMajorEvery(step, pixelsPerSecond);
  let index = 0;
  for (let t = 0; t <= full + 0.0001; t += step, index += 1) {
    let tick = documentRef.createElement("span");
    let isEndpoint = Math.abs(t - full) < 0.001;
    let isMajor = index % majorEvery === 0 || isEndpoint;
    tick.className = "seq-tick" + (isMajor ? " major" : "");
    tick.style.left = (t / full) * 100 + "%";
    if (isMajor) {
      let label = documentRef.createElement("span");
      label.textContent = fmtt(t);
      tick.appendChild(label);
    }
    ruler.appendChild(tick);
  }
}

function syncTimelineUI() {
  paintTrimChrome();
  host.updateTime?.();
  if (host.AudioTimeline) host.AudioTimeline.render();
  applyTimelineZoom();
}

function setPlayheadUI(sec: number, full?: number) {
  full = full || videoDuration();
  sec = Number.isFinite(sec) ? sec : 0;
  let pct = full > 0 ? Math.max(0, Math.min(100, (sec / full) * 100)) : 0;
  let layer = byId("seq-playhead-layer");
  if (layer) layer.style.setProperty("--playhead", pct + "%");
  if (full > 0) {
    byId("timeline")?.setAttribute("aria-valuemax", String(Math.round(full)));
    byId("timeline")?.setAttribute("aria-valuenow", String(Math.round(sec)));
  }
  const timeDisplay = byId("ptime");
  if (timeDisplay) timeDisplay.textContent = fmtt(sec) + " / " + fmtt(full || 0);
  let tlTime = byId("tl-time");
  if (tlTime)
    tlTime.textContent =
      formatTimelineTime(sec) + " / " + formatTimelineTime(full || 0);
  let playheadTime = byId("seq-playhead-time");
  if (playheadTime) playheadTime.textContent = formatTimelineTime(sec);
  host.paintStageScrub?.(pct);
  _previewSecLocal = sec;
  host.setPreviewSec?.(sec);
}

function formatTimelineTime(seconds: number) {
  let centiseconds = Math.round(Math.max(0, seconds) * 100);
  let whole = Math.floor(centiseconds / 100);
  let fraction = centiseconds % 100;
  return fmtt(whole) + "." + String(fraction).padStart(2, "0");
}


function splitAtPlayhead() {
  if (
    host.AudioTimeline?.splitSelected &&
    host.AudioTimeline.hasSelection?.()
  ) {
    host.AudioTimeline.splitSelected();
    return;
  }
  const c = selectedClip(session);
  if (!c) return;
  let full = videoDuration() || c.probeData?.duration || 0;
  let video = currentVideo();
  let time = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  let result = SegmentEditing.splitAt(clipSegments(c, full), time, full);
  if (!result) {
    notify("Move the playhead inside a video clip to split it.", "err");
    return;
  }
  setClipSegments(c, result.segments, result.index);
  paintTrimChrome();
  host.seekPreview?.(time);
  host.renderClips?.();
  host.reqPreview?.();
  if (host.AudioTimeline) host.AudioTimeline.render();
}


let _tlMoveRaf = 0;
let _tlMoveEvent: PointerEvent | null = null;


function timelineRatioFromEvent(e: PointerEvent) {
  let track = byId("tl-track");
  if (!track) return 0;
  let rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  let x = e.clientX - rect.left;
  return Math.max(0, Math.min(1, x / rect.width));
}

function segmentSnapCandidates(segments: SegmentLike[], active: unknown, full: number) {
  let points = [0, full];
  let v = currentVideo();
  if (v) points.push(v.currentTime);
  for (const [i, segment] of segments.entries()) {
    if (i === active) continue;
    points.push(segment.start, segment.end);
  }
  return points;
}

function applyTrimStart(sec: number, snap?: boolean) {
  const c = selectedClip(session);
  if (!c) return null;
  let full = videoDuration() || c.probeData?.duration || 0;
  if (full <= 0) return null;
  let segments = clipSegments(c, full);
  let active = activeSegmentIndex(c, segments);
  if (snap !== false && typeof snapCandidateTime === "function")
    sec = snapCandidateTime(
      sec,
      segmentSnapCandidates(segments, active, full),
      timelinePxPerSecond(),
    );
  segments = SegmentEditing.editEndpoint(segments, active, "start", sec, full);
  setClipSegments(c, segments, active);
  return arrayItem(segments, active)?.start ?? null;
}

function applyTrimEnd(sec: number, snap?: boolean) {
  const c = selectedClip(session);
  if (!c) return null;
  let full = videoDuration() || c.probeData?.duration || 0;
  if (full <= 0) return null;
  let segments = clipSegments(c, full);
  let active = activeSegmentIndex(c, segments);
  if (snap !== false && typeof snapCandidateTime === "function")
    sec = snapCandidateTime(
      sec,
      segmentSnapCandidates(segments, active, full),
      timelinePxPerSecond(),
    );
  segments = SegmentEditing.editEndpoint(segments, active, "end", sec, full);
  setClipSegments(c, segments, active);
  return arrayItem(segments, active)?.end ?? null;
}

function canTrimActiveSegmentToPlayhead() {
  const clip = selectedClip(session);
  if (!clip) return false;
  let full =
    videoDuration() ||
    clip.probeData?.duration ||
    0;
  let video = currentVideo();
  return full > 0 && !!video && Number.isFinite(video.currentTime);
}

function trimActiveSegmentToPlayhead(endpoint: "start" | "end") {
  if (!canTrimActiveSegmentToPlayhead()) return null;
  let video = currentVideo();
  if (!video) return null;
  let time = video.currentTime;
  let value =
    endpoint === "start"
      ? applyTrimStart(time, false)
      : applyTrimEnd(time, false);
  paintTrimChrome();
  host.renderClips?.();
  host.reqPreview?.();
  if (host.AudioTimeline) host.AudioTimeline.render();
  return value;
}

function moveActiveSegment(start: number, snap?: boolean) {
  const c = selectedClip(session);
  if (!c) return null;
  let full = videoDuration() || c.probeData?.duration || 0;
  if (full <= 0) return null;
  let segments = clipSegments(c, full);
  let active = activeSegmentIndex(c, segments);
  if (snap !== false && typeof snapCandidateTime === "function") {
    const activeSegment = arrayItem(segments, active);
    if (!activeSegment) return null;
    let duration = activeSegment.end - activeSegment.start;
    let candidates = segmentSnapCandidates(segments, active, full).reduce<number[]>(function(acc, point) {
      acc.push(point, point - duration);
      return acc;
    }, []);
    start = snapCandidateTime(start, candidates, timelinePxPerSecond());
  }
  segments = SegmentEditing.moveSegment(segments, active, start, full);
  setClipSegments(c, segments, active);
  return arrayItem(segments, active);
}

function resetSegments() {
  const c = selectedClip(session);
  if (!c) return;
  let full = videoDuration() || c.probeData?.duration || 0;
  if (full <= 0) return;
  setClipSegments(c, SegmentEditing.fullSegment(full), 0);
  paintTrimChrome();
  host.seekPreview?.(0);
  host.renderClips?.();
  host.reqPreview?.();
  if (host.AudioTimeline) host.AudioTimeline.render();
}

function selectSegment(index: number, shouldSeek?: boolean) {
  const c = selectedClip(session);
  if (!c) return;
  let full = videoDuration() || c.probeData?.duration || 0;
  let segments = clipSegments(c, full);
  if (!segments.length) return;
  index = Math.max(0, Math.min(segments.length - 1, Number(index)));
  c.activeSegment = index;
  paintTrimChrome();
  if (shouldSeek !== false) host.seekPreview?.(arrayItem(segments, index)?.start ?? 0);
}

function addSegment() {
  const c = selectedClip(session);
  if (!c) return;
  let full = videoDuration() || c.probeData?.duration || 0;
  if (full <= 0) return;
  try {
    let pixelsPerSecond = timelinePxPerSecond();
    let preferredDuration = pixelsPerSecond > 0 ? Math.max(1, 64 / pixelsPerSecond) : 1;
    let result = SegmentEditing.addSegment(
      clipSegments(c, full),
      full,
      currentVideo()?.currentTime ?? 0,
      preferredDuration,
    );
    setClipSegments(c, result.segments, result.index);
    paintTrimChrome();
    host.seekPreview?.(arrayItem(result.segments, result.index)?.start ?? 0);
    host.renderClips?.();
    host.reqPreview?.();
    if (host.AudioTimeline) host.AudioTimeline.render();
  } catch (err) {
    notify(errorMessage(err) || "No room for another segment.", "err");
  }
}

function canRemoveActiveSegment() {
  const clip = selectedClip(session);
  if (!clip) return false;
  let full = videoDuration() || clip.probeData?.duration || 0;
  return clipSegments(clip, full).length > 1;
}

function removeActiveSegment() {
  const c = selectedClip(session);
  if (!c) return;
  let full = videoDuration() || c.probeData?.duration || 0;
  let segments = clipSegments(c, full);
  let active = activeSegmentIndex(c, segments);
  if (segments.length <= 1) return;
  segments = SegmentEditing.removeSegment(segments, active, full);
  active = Math.min(active, segments.length - 1);
  setClipSegments(c, segments, active);
  paintTrimChrome();
  host.seekPreview?.(arrayItem(segments, active)?.start ?? 0);
  host.renderClips?.();
  host.reqPreview?.();
  if (host.AudioTimeline) host.AudioTimeline.render();
}

function setTrimDragCursor(active: unknown) {
  let timeline = byId("timeline");
  if (timeline) timeline.classList.toggle("trim-dragging", !!active);
  documentRef.body.classList.toggle("tl-trim-dragging", !!active);
}

function setSegmentDragCursor(active: unknown) {
  let timeline = byId("timeline");
  if (timeline) timeline.classList.toggle("segment-dragging", !!active);
  documentRef.body.classList.toggle("tl-segment-dragging", !!active);
}

function setRulerScrubCursor(active: unknown) {
  let ruler = byId("sequence-ruler");
  if (ruler) ruler.classList.toggle("scrubbing", !!active);
  documentRef.body.classList.toggle("timeline-scrubbing", !!active);
}

function onTimelinePointerDown(e: PointerEvent) {
  if (e.button != null && e.button !== 0) return;
  host.AudioTimeline?.selectVideoTrack?.();
  const target = isHtmlElement(e.target) ? e.target : null;
  const edgeCandidate = target?.closest(".clip-edge") ?? null;
  let edge = isHtmlElement(edgeCandidate) ? edgeCandidate : null;
  const isSegment = target?.classList.contains("tl-segment") ?? false;
  if (edge && edge.dataset.edge) {
    let edgeName = edge.dataset.edge;
    let edgeSegmentCandidate = edge.closest(".tl-segment");
    let edgeSegment = isHtmlElement(edgeSegmentCandidate) ? edgeSegmentCandidate : null;
    if (edgeSegment) {
      let edgeIndex = parseInt(edgeSegment.dataset.segmentIndex ?? "", 10);
      selectSegment(edgeIndex, false);
      const segmentLayer = byId("tl-segments");
      const replacement = segmentLayer?.querySelector(
        '.tl-segment[data-segment-index="' + edgeIndex + '"] .clip-edge.' +
          (edgeName === "start" ? "start" : "end"),
      ) ?? null;
      edge = isHtmlElement(replacement) ? replacement : null;
    }
    _tlDrag = edgeName === "start" ? "in" : "out";
    if (edge) edge.classList.add("dragging");
    setTrimDragCursor(true);
  } else if (isSegment) {
    let index = parseInt(target?.dataset.segmentIndex ?? "", 10);
    let full = videoDuration();
    let segments = playbackSegments();
    const segment = arrayItem(segments, index);
    if (!full || !segment) return;
    let pointerTime = timelineRatioFromEvent(e) * full;
    _segmentDragOffset = pointerTime - segment.start;
    _segmentPointerX = e.clientX;
    _segmentClickTime = pointerTime;
    selectSegment(index, false);
    _tlDrag = "segment-pending";
  } else if (target && target.id === "tl-in") _tlDrag = "in";
  else if (target && target.id === "tl-out") _tlDrag = "out";
  else _tlDrag = "seek";
  if (_tlDrag === "in" || _tlDrag === "out" || _tlDrag === "segment-pending") {
    host.History?.begin?.(session.selPath);
  }
  if (target?.classList.contains("tl-handle")) {
    target.classList.add("dragging");
    setTrimDragCursor(true);
  }
  const currentTarget = isHtmlElement(e.currentTarget) ? e.currentTarget : null;
  if (e.pointerId != null && currentTarget) {
    try {
      currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
  }
  if (_tlDrag !== "segment-pending") processTimelineMove(e);
  e.preventDefault();
}

function processTimelineMove(e: PointerEvent) {
  if (!_tlDrag) return;
  if (_tlDrag === "segment-pending") {
    if (Math.abs(e.clientX - _segmentPointerX) < _SEGMENT_DRAG_THRESHOLD) return;
    _tlDrag = "segment";
    setSegmentDragCursor(true);
  }
  let ratio = timelineRatioFromEvent(e);
  let full = videoDuration();
  if (full <= 0) return;
  let time = ratio * full;
  if (_tlDrag === "in") {
    let start = applyTrimStart(time);
    if (start == null) return;
    paintTrimChrome();
    host.seekPreview?.(start);
  } else if (_tlDrag === "out") {
    let end = applyTrimEnd(time);
    if (end == null) return;
    paintTrimChrome();
    host.seekPreview?.(end);
  } else if (_tlDrag === "segment") {
    let moved = moveActiveSegment(time - _segmentDragOffset);
    if (!moved) return;
    paintTrimChrome();
    host.seekPreview?.(moved.start);
  } else {
    host.seekToRatio?.(ratio);
  }
}

function onTimelinePointerMove(e: PointerEvent) {
  if (!_tlDrag) return;
  _tlMoveEvent = e;
  if (_tlMoveRaf) return;
  _tlMoveRaf = requestAnimationFrame(function () {
    _tlMoveRaf = 0;
    let event = _tlMoveEvent;
    _tlMoveEvent = null;
    if (event) processTimelineMove(event);
  });
  e.preventDefault();
}

function onTimelinePointerUp(e: PointerEvent) {
  if (!_tlDrag) return;
  if (_tlMoveRaf) {
    cancelAnimationFrame(_tlMoveRaf);
    _tlMoveRaf = 0;
  }
  if (_tlMoveEvent) {
    processTimelineMove(_tlMoveEvent);
    _tlMoveEvent = null;
  }
  let wasSegmentClick =
    _tlDrag === "segment-pending" && (!e || e.type !== "pointercancel");
  let wasEdit = _tlDrag === "in" || _tlDrag === "out" || _tlDrag === "segment";
  if (wasEdit) host.History?.commit?.();
  else host.History?.cancel?.();
  if (wasSegmentClick) host.seekPreview?.(_segmentClickTime);
  byId("tl-in")?.classList.remove("dragging");
  byId("tl-out")?.classList.remove("dragging");
  let edgeHandles = documentRef.querySelectorAll(".clip-edge.dragging");
  for (const handle of edgeHandles) handle.classList.remove("dragging");
  setTrimDragCursor(false);
  setSegmentDragCursor(false);
  if (_tlDrag === "ruler") setRulerScrubCursor(false);
  _tlDrag = null;
  if (_previewSecLocal != null) {
    host.setPreviewSec?.(_previewSecLocal);
    host.flushVideoSeek?.();
  }
  if (wasEdit) {
    if (host.AudioTimeline) host.AudioTimeline.render();
    host.renderClips?.();
    host.reqPreview?.();
  }
}

function handleTimelineEditKey(e: KeyboardEvent) {
  let v = currentVideo();
  if (!v || !v.duration) return;
  let intent = TimelineCore.editKeyIntent(
    isHtmlElement(e.target) ? e.target : null,
    e.key,
    e.shiftKey,
  );
  if (!intent) return;
  e.preventDefault();
  let full = videoDuration();
  let c = selectedClip(session);
  let segments = clipSegments(c, full);
  if (!c) return;
  if (intent.type === "segment") {
    const segment = arrayItem(segments, intent.index);
    if (!segment) return;
    c.activeSegment = intent.index;
    let moved = moveActiveSegment(
      segment.start + intent.delta,
      intent.snap,
    );
    paintTrimChrome();
    if (moved) host.seekPreview?.(moved.start);
  } else {
    let state = paintTrimChrome();
    let current = state.bounds[intent.endpoint];
    let value =
      intent.endpoint === "start"
        ? applyTrimStart(current + intent.delta, intent.snap)
        : applyTrimEnd(current + intent.delta, intent.snap);
    paintTrimChrome();
    if (value != null) host.seekPreview?.(value);
  }
  host.renderClips?.();
  host.reqPreview?.();
}

(function bindTimeline() {
  let timeline = byId("timeline");
  if (!timeline) return;
  let ruler = byId("sequence-ruler");
  if (ruler) {
    ruler.addEventListener("pointerdown", function(e: PointerEvent) {
      if (e.button != null && e.button !== 0) return;
      _tlDrag = "ruler";
      setRulerScrubCursor(true);
      if (e.pointerId != null && ruler.setPointerCapture) {
        try {
          ruler.setPointerCapture(e.pointerId);
        } catch (err) {}
      }
      processTimelineMove(e);
      e.preventDefault();
    });
    ruler.addEventListener("pointermove", onTimelinePointerMove);
    ruler.addEventListener("pointerup", onTimelinePointerUp);
    ruler.addEventListener("pointercancel", onTimelinePointerUp);
  }
  timeline.addEventListener("pointerdown", onTimelinePointerDown);
  timeline.addEventListener("pointermove", onTimelinePointerMove);
  timeline.addEventListener("pointerup", onTimelinePointerUp);
  timeline.addEventListener("pointercancel", onTimelinePointerUp);
  let selectionLayer = byId("seq-selection-layer");
  if (selectionLayer) {
    selectionLayer.addEventListener("pointerdown", function(e: PointerEvent) {
      if (e.button != null && e.button !== 0) return;
      const target = isHtmlElement(e.target) ? e.target : null;
      if (!target || (target.id !== "tl-in" && target.id !== "tl-out")) return;
      _tlDrag = target.id === "tl-in" ? "in" : "out";
      target.classList.add("dragging");
      setTrimDragCursor(true);
      if (e.pointerId != null && selectionLayer.setPointerCapture) {
        try {
          selectionLayer.setPointerCapture(e.pointerId);
        } catch (err) {}
      }
      processTimelineMove(e);
      e.preventDefault();
    });
    selectionLayer.addEventListener("pointermove", onTimelinePointerMove);
    selectionLayer.addEventListener("pointerup", onTimelinePointerUp);
    selectionLayer.addEventListener("pointercancel", onTimelinePointerUp);
    selectionLayer.addEventListener("keydown", handleTimelineEditKey);
  }
  timeline.addEventListener("click", function(e: MouseEvent) {
    const target = isHtmlElement(e.target) ? e.target : null;
    if (target?.classList.contains("tl-segment") && e.detail === 0) {
      selectSegment(parseInt(target.dataset.segmentIndex ?? "", 10), true);
    }
  });
  timeline.addEventListener("keydown", handleTimelineEditKey);
})();


function toggleSnap() {
  snapOn = !snapOn;
  let btn = byId("btn-snap-toggle");
  if (btn) {
    btn.classList.toggle("on", snapOn);
    btn.setAttribute("aria-pressed", String(snapOn));
  }
}

function snapCandidateTime(time: number, candidates: number[], pxPerSecond: number) {
  if (!snapOn || !pxPerSecond) return time;
  let thresholdSec = TL_SNAP_PX / pxPerSecond;
  let best = time;
  let bestDist = thresholdSec;
  for (let i = 0; i < candidates.length; i++) {
    let c = candidates[i];
    if (c == null) continue;
    let dist = Math.abs(c - time);
    if (dist <= bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

function timelinePxPerSecond() {
  let track = byId("tl-track");
  let full = typeof videoDuration === "function" ? videoDuration() : 0;
  if (!track || !full) return 0;
  return track.getBoundingClientRect().width / full;
}

function timelineAnchorRatio() {
  let full = videoDuration();
  let video = currentVideo();
  if (!full || !video || !Number.isFinite(video.currentTime)) return 0;
  return Math.min(1, Math.max(0, video.currentTime / full));
}

function applyTimelineZoom(anchorRatio?: number) {
  let frame = byId("sequence-frame");
  if (!frame) return;
  let anchor = Number.isFinite(anchorRatio) ? anchorRatio : timelineAnchorRatio();
  let zoomed = timelineZoom > TL_ZOOM_MIN;
  frame.classList.toggle("is-zoomed", zoomed);
  if (zoomed) {
    let base = Math.max(0, frame.clientWidth - 1);
    if (base > 0) {
      let contentWidth = base * timelineZoom;
      frame.style.setProperty("--tl-width", contentWidth + "px");
      frame.scrollLeft = TimelineCore.anchorScrollLeft(
        frame.clientWidth,
        contentWidth,
        anchor,
      );
    }
  } else {
    frame.style.removeProperty("--tl-width");
    frame.scrollLeft = 0;
  }
  let slider = byId("tl-zoom-slider");
  if (isInputElement(slider) && documentRef.activeElement !== slider) {
    slider.value = String(timelineZoom);
  }
  let full = videoDuration();
  if (full > 0) paintSequenceRuler(full);
}

function setTimelineZoom(level: number) {
  let anchor = timelineAnchorRatio();
  timelineZoom = TimelineCore.clampZoom(level);
  applyTimelineZoom(anchor);
}

function nudgeTimelineZoom(delta: number) {
  setTimelineZoom(timelineZoom + delta);
}

function fitTimeline() {
  timelineZoom = TL_ZOOM_MIN;
  applyTimelineZoom(0);
}

let timelineResizeState: { pointerId: number; startY: number; startHeight: number } | null = null;
let timelineHeightSetting = 0;
let timelineTrackCount = 2;

function updateTimelineResizeA11y(height: number) {
  let separator = byId("timeline-resizer");
  if (!separator || !TuckLayout) return;
  let bounds = TuckLayout.timelineHeightBounds(windowRef.innerHeight);
  separator.setAttribute("aria-valuemin", String(bounds.min));
  separator.setAttribute("aria-valuemax", String(bounds.max));
  separator.setAttribute("aria-valuenow", String(height));
  separator.setAttribute("aria-valuetext", height + " pixels");
}

function refreshAfterTimelineResize() {
  applyTimelineZoom();
  host.paintCropOverlay?.();
}

function applyTimelineHeight(value: number) {
  let editor = byId("audio-editor");
  if (!editor || !TuckLayout) return 0;
  let height = TuckLayout.clampTimelineHeight(
    value,
    windowRef.innerHeight,
    timelineTrackCount,
  );
  editor.style.height = height + "px";
  updateTimelineResizeA11y(height);
  refreshAfterTimelineResize();
  return height;
}

function syncTimelineTrackCount(importedCount: number) {
  let count = Math.max(0, Math.round(Number(importedCount) || 0));
  timelineTrackCount = 2 + count;
  if (!TuckLayout) return;
  let height = TuckLayout.timelineHeightForTrackCount(
    timelineHeightSetting,
    timelineTrackCount,
    windowRef.innerHeight,
  );
  if (height != null) applyTimelineHeight(height);
}

function saveTimelineHeight(value: number) {
  timelineHeightSetting = value > 0 ? Math.round(value) : 0;
  session.appSettings.timeline_height = timelineHeightSetting;
  if (!hasBackendClient()) return;
  void getBackendClient().saveSettings({ timeline_height: timelineHeightSetting })
    .then(function(response) {
      if (!response.ok) notify(response.error.message || "Could not save timeline height.", "err");
    })
    .catch(function () {
      notify("Could not save timeline height.", "err");
    });
}

function restoreTimelineHeight(value: unknown) {
  timelineHeightSetting = TuckLayout.normalizeTimelineHeightSetting(
    value,
    windowRef.innerHeight,
  );
  return applyTimelineHeight(timelineHeightSetting);
}

function beginTimelineResize(event: PointerEvent) {
  if (event.button !== 0 || !TuckLayout) return;
  let editor = byId("audio-editor");
  let separator = byId("timeline-resizer");
  if (!editor || !separator) return;
  event.preventDefault();
  timelineResizeState = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: editor.getBoundingClientRect().height,
  };
  documentRef.body.classList.add("timeline-resizing");
  if (separator.setPointerCapture && event.pointerId != null) {
    try {
      separator.setPointerCapture(event.pointerId);
    } catch (error) {}
  }
}

function moveTimelineResize(event: PointerEvent) {
  if (!timelineResizeState || event.pointerId !== timelineResizeState.pointerId) return;
  event.preventDefault();
  applyTimelineHeight(
    timelineResizeState.startHeight + timelineResizeState.startY - event.clientY,
  );
}

function endTimelineResize(event: PointerEvent) {
  if (!timelineResizeState || event.pointerId !== timelineResizeState.pointerId) return;
  let separator = byId("timeline-resizer");
  let editor = byId("audio-editor");
  timelineResizeState = null;
  documentRef.body.classList.remove("timeline-resizing");
  if (
    separator &&
    event.pointerId != null &&
    separator.releasePointerCapture &&
    separator.hasPointerCapture(event.pointerId)
  ) {
    separator.releasePointerCapture(event.pointerId);
  }
  if (editor) saveTimelineHeight(editor.getBoundingClientRect().height);
}

function handleTimelineResizeKey(event: KeyboardEvent) {
  if (!TuckLayout) return;
  let editor = byId("audio-editor");
  if (!editor) return;
  let next = TuckLayout.timelineHeightForKey(
    editor.getBoundingClientRect().height,
    event.key,
    event.shiftKey,
    windowRef.innerHeight,
  );
  if (next == null) return;
  event.preventDefault();
  saveTimelineHeight(applyTimelineHeight(next));
}

function resetTimelineHeight(event?: MouseEvent) {
  if (event) event.preventDefault();
  saveTimelineHeight(0);
  applyTimelineHeight(0);
}

function initTimelineResizer() {
  let separator = byId("timeline-resizer");
  if (!separator) return;
  windowRef.addEventListener("resize", function () {
    applyTimelineHeight(timelineHeightSetting);
  });
  separator.addEventListener("pointerdown", beginTimelineResize);
  windowRef.addEventListener("pointermove", moveTimelineResize);
  windowRef.addEventListener("pointerup", endTimelineResize);
  windowRef.addEventListener("pointercancel", endTimelineResize);
  separator.addEventListener("keydown", handleTimelineResizeKey);
  separator.addEventListener("dblclick", resetTimelineHeight);
  restoreTimelineHeight(TuckLayout.initialTimelineHeightSetting(session.appSettings));
}



  host.TuckShortcuts?.registerAction("timeline.add-segment", {
    enabled: function () {
      const clip = selectedClip(session);
      if (!clip) return false;
      let full = videoDuration() || clip.probeData?.duration || 0;
      return full > 0 && SegmentEditing.canAddSegment(clipSegments(clip, full), full);
    },
    execute: addSegment,
  });
  host.TuckShortcuts?.registerAction("timeline.zoom-in", {
    enabled: function () {
      return !!session.selPath;
    },
    execute: function () {
      nudgeTimelineZoom(1);
    },
  });
  host.TuckShortcuts?.registerAction("timeline.zoom-out", {
    enabled: function () {
      return !!session.selPath;
    },
    execute: function () {
      nudgeTimelineZoom(-1);
    },
  });
  host.TuckShortcuts?.registerAction("timeline.fit", {
    enabled: function () {
      return !!session.selPath;
    },
    execute: fitTimeline,
  });

  let api = {
    isDragging: function () { return !!_tlDrag; },
    addSegment: addSegment,
    applyTimelineZoom: applyTimelineZoom,
    canTrimActiveSegmentToPlayhead: canTrimActiveSegmentToPlayhead,
    canRemoveActiveSegment: canRemoveActiveSegment,
    clipSegments: clipSegments,
    fitTimeline: fitTimeline,
    nudgeTimelineZoom: nudgeTimelineZoom,
    paintTrimChrome: paintTrimChrome,
    playbackSegments: playbackSegments,
    removeActiveSegment: removeActiveSegment,
    resetTimelineHeight: resetTimelineHeight,
    resetSegments: resetSegments,
    restoreTimelineHeight: restoreTimelineHeight,
    segmentColor: segmentColor,
    setClipSegments: setClipSegments,
    setPlayheadUI: setPlayheadUI,
    setTimelineZoom: setTimelineZoom,
    snapCandidateTime: snapCandidateTime,
    splitAtPlayhead: splitAtPlayhead,
    syncTimelineTrackCount: syncTimelineTrackCount,
    syncTimelineUI: syncTimelineUI,
    timelinePxPerSecond: timelinePxPerSecond,
    toggleSnap: toggleSnap,
    trimActiveSegmentToPlayhead: trimActiveSegmentToPlayhead,
    videoDuration: videoDuration,
  };
  const extended = Object.assign({}, api, {
    applyTrimStart,
    applyTrimEnd,
    selectSegment,
    moveActiveSegment,
  });
  initTimelineResizer();
  return extended;

}
