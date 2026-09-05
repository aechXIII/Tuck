import { getBackendClient, hasBackendClient } from "../../backend/client.ts";
import type { JsonObject } from "../../backend/types.ts";
import type { EditorClip, EditorSession } from "../editor/session.ts";
import type {
  AudioClip,
  AudioTimelineState,
  AudioTrack,
} from "../editor/types.ts";
import { confirmToast, toast } from "../editor/toast.ts";
import * as SegmentEditing from "../timeline/segments.ts";
import * as TimelineCore from "../timeline/timeline-core.ts";
import * as core from "./audio-core.ts";

const waveformGenerations = new Map<string, number>();

function nextWaveformGeneration(path: string): number {
  const next = (waveformGenerations.get(path) ?? 0) + 1;
  waveformGenerations.set(path, next);
  return next;
}

function currentWaveformGeneration(path: string): number {
  return waveformGenerations.get(path) ?? 0;
}

export interface AudioTimelineHost {
  session: EditorSession;
  byId: (id: string) => HTMLElement | null;
  documentRef?: Document;
  windowRef?: Window & typeof globalThis;
  toast?: (msg: string, kind?: string) => void;
  confirmToast?: (msg: string, cb: () => void) => void;
  setInspectorTab?: (tab: string, persist?: boolean) => void;
  renderClips?: () => void;
  reqPreview?: () => void;
  setClipSegments?: (clip: EditorClip, segments: unknown[], active?: number) => void;
  paintTrimChrome?: () => void;
  syncTimelineTrackCount?: (count: number) => void;
  renderAudioMixerList?: () => void;
  renderAudioLibraryPanel?: () => void;
  segmentColor?: (index: number) => string;
  snapCandidateTime?: (time: number, candidates: number[], pxPerSecond: number) => number;
  applyTrimStart?: (sec: number, snap?: boolean) => number | null;
  applyTrimEnd?: (sec: number, snap?: boolean) => number | null;
  selectSegment?: (index: number, shouldSeek?: boolean) => void;
  moveActiveSegment?: (start: number, snap?: boolean) => { start: number; end: number } | null;
  canTrimActiveSegmentToPlayhead?: () => boolean;
  trimActiveSegmentToPlayhead?: (endpoint: "start" | "end") => number | null;
  canRemoveActiveSegment?: () => boolean;
  removeActiveSegment?: () => void;
  splitAtPlayhead?: () => void;
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

export type AudioTimelineApi = ReturnType<typeof installAudioTimeline>;

interface AudioClipState extends AudioClip {
  gainDb: number;
}

interface AudioTrackState extends AudioTrack {
  clips: AudioClipState[];
  gainDb: number;
  name: string;
  path: string;
  sourceDuration: number;
}

interface AudioTimelineModel extends Omit<AudioTimelineState, "tracks"> {
  tracks: AudioTrackState[];
}

interface SelectedAudioClip {
  readonly clip: AudioClipState;
  readonly index: number;
  readonly track: AudioTrackState;
  readonly trackIndex: number;
}

type SegmentLike = { start: number; end: number; muted?: boolean; badge?: string; index?: number };

interface PointerGeometry {
  readonly rect: DOMRect;
  readonly startX: number;
  readonly total: number;
}

interface GroupMoveDrag extends PointerGeometry {
  readonly kind: "group-move";
  readonly index: number;
  readonly offset: number;
}

interface GroupTrimDrag extends PointerGeometry {
  readonly kind: "group-trim";
  readonly edge: "start" | "end";
}

interface ImportedDrag extends PointerGeometry {
  readonly kind: "imported";
  readonly action: "move" | "slip" | "trim-start" | "trim-end";
  readonly track: AudioTrackState;
  readonly clip: AudioClipState;
  readonly original: AudioClipState;
  readonly index: number;
  readonly element: HTMLElement;
}

type DragState = GroupMoveDrag | GroupTrimDrag | ImportedDrag;

function isElement(value: EventTarget | null): value is Element {
  return (
    value !== null &&
    typeof value === "object" &&
    "closest" in value &&
    typeof value.closest === "function"
  );
}

function isHtmlElement(value: EventTarget | null): value is HTMLElement {
  return (
    value !== null &&
    typeof value === "object" &&
    "classList" in value &&
    "dataset" in value
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

function isButtonElement(value: HTMLElement | null): value is HTMLButtonElement {
  return value !== null && "disabled" in value && "type" in value;
}

function arrayItem<T>(items: readonly T[], index: number): T | null {
  return items[index] ?? null;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonNumber(value: JsonObject, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function jsonString(value: JsonObject, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function isTimelineModel(
  target: AudioTimelineModel | AudioTrackState,
): target is AudioTimelineModel {
  return "tracks" in target;
}

export function installAudioTimeline(host: AudioTimelineHost) {
  const session = host.session;
  const byId = (id: string): HTMLElement | null => host.byId(id);
  const documentRef = host.documentRef ?? document;
  const windowRef = host.windowRef ?? window;
  const notify = host.toast ?? toast;
  const confirm = host.confirmToast ?? confirmToast;
  const backend = null;

  let selectedClipId: string | null = null;
  let selectedTrackId = "source";
  let idCounter = 0;
  let dragState: DragState | null = null;
  let previewElements: Record<string, HTMLAudioElement> = {};
  let _DRAG_THRESHOLD = 5;
  let _groupDragRaf = 0;
  let _groupDragEvent: PointerEvent | null = null;
  let _MIN_TRIM = SegmentEditing.MIN_DURATION;

  function trackColor(index: number) {
    return core.trackColor(index);
  }

  function nextId(prefix: string) {
    idCounter += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + idCounter.toString(36);
  }

  function selectedVideo() {
    return session.selPath ? session.clips[session.selPath] ?? null : null;
  }

  function normalizeAudioClip(audioClip: AudioClip): AudioClipState {
    return Object.assign(audioClip, {
      gainDb: Number.isFinite(audioClip.gainDb) ? Number(audioClip.gainDb) : 0,
    });
  }

  function normalizeSplitAudioClip(audioClip: core.AudioClip): AudioClipState | null {
    if (typeof audioClip.id !== "string") return null;
    const normalized: AudioClipState = {
      id: audioClip.id,
      timelineStart: audioClip.timelineStart,
      timelineDuration: audioClip.timelineDuration,
      sourceIn: audioClip.sourceIn,
      sourceOut: audioClip.sourceOut,
      fadeIn: audioClip.fadeIn,
      fadeOut: audioClip.fadeOut,
      gainDb: typeof audioClip.gainDb === "number" ? audioClip.gainDb : 0,
      loop: audioClip.loop === true,
    };
    if (typeof audioClip.muted === "boolean") normalized.muted = audioClip.muted;
    return normalized;
  }

  function normalizeAudioTrack(track: AudioTrack): AudioTrackState {
    return Object.assign(track, {
      clips: track.clips.map(normalizeAudioClip),
      gainDb: Number.isFinite(track.gainDb) ? Number(track.gainDb) : 0,
      name: typeof track.name === "string" ? track.name : "Audio track",
      path: typeof track.path === "string" ? track.path : "",
      sourceDuration: Number.isFinite(track.sourceDuration)
        ? Number(track.sourceDuration)
        : 0,
    });
  }

  function ensureState(clip: EditorClip | null | undefined): AudioTimelineModel | null {
    if (!clip) return null;
    if (!clip.audioTimeline) {
      clip.audioTimeline = {
        enabled: true,
        sourceMuted: false,
        sourceGainDb: 0,
        sourceWaveformUrl: "",
        sourceWaveformToken: "",
        sourceWaveformLoading: false,
        tracks: [],
      };
    }
    const normalized: AudioTimelineModel = {
      ...clip.audioTimeline,
      tracks: clip.audioTimeline.tracks.map(normalizeAudioTrack),
    };
    clip.audioTimeline = normalized;
    return normalized;
  }

  function sourceDuration(clip: EditorClip | null | undefined) {
    return clip && clip.probeData ? Number(clip.probeData.duration) || 0 : 0;
  }

  function sourceTime() {
    let candidate = byId("vid");
    let video = isVideoElement(candidate) ? candidate : null;
    return video ? Number(video.currentTime) || 0 : 0;
  }

  function audioSegments(clip: EditorClip | null | undefined) {
    let full = sourceDuration(clip);
    if (!full || !SegmentEditing) return [];
    return SegmentEditing.audioSegmentsForClip(clip, full);
  }

  function dbToGain(db: number) {
    return Math.pow(10, Number(db || 0) / 20);
  }

  function setPlanDirty(clip: EditorClip | null | undefined) {
    if (clip) clip.planData = null;
    if (typeof host.renderClips === "function") host.renderClips();
    if (typeof host.reqPreview === "function") host.reqPreview();
  }

  function reconcile(clip: EditorClip | null | undefined) {
    let state = ensureState(clip);
    let total = sourceDuration(clip);
    if (!state || total <= 0) return;
    state.tracks.forEach(function(track: AudioTrackState) {
      track.clips.sort(function(a: AudioClipState, b: AudioClipState) {
        return a.timelineStart - b.timelineStart;
      });
      let cursor = 0;
      track.clips = track.clips.filter(function(audioClip: AudioClipState) {
        audioClip.timelineStart = Math.max(cursor, Math.min(audioClip.timelineStart, total));
        let remaining = total - audioClip.timelineStart;
        let sourceSpan = Math.max(0, audioClip.sourceOut - audioClip.sourceIn);
        audioClip.timelineDuration = Math.min(audioClip.timelineDuration, remaining);
        if (!audioClip.loop)
          audioClip.timelineDuration = Math.min(audioClip.timelineDuration, sourceSpan);
        if (audioClip.timelineDuration < _MIN_TRIM - 0.000001) return false;
        audioClip.fadeIn = Math.max(0, Math.min(audioClip.fadeIn, audioClip.timelineDuration));
        audioClip.fadeOut = Math.max(
          0,
          Math.min(audioClip.fadeOut, audioClip.timelineDuration - audioClip.fadeIn),
        );
        cursor = audioClip.timelineStart + audioClip.timelineDuration;
        return true;
      });
    });
    if (selectedClipId && !findSelected(clip)) selectedClipId = null;
  }

  function findTrack(trackId: string, clip: EditorClip | null | undefined) {
    let state = ensureState(clip || selectedVideo());
    if (!state) return null;
    return state.tracks.find(function(track) {
      return track.id === trackId;
    }) ?? null;
  }

  function findSelected(clip: EditorClip | null | undefined): SelectedAudioClip | null {
    let state = ensureState(clip || selectedVideo());
    if (!state || !selectedClipId) return null;
    for (const [trackIndex, track] of state.tracks.entries()) {
      for (const [index, audioClip] of track.clips.entries()) {
        if (audioClip.id === selectedClipId) {
          return { track, clip: audioClip, index, trackIndex };
        }
      }
    }
    return null;
  }

  function selectedClipRangeData(clip: EditorClip | null | undefined) {
    let videoClip = clip || selectedVideo();
    let selected = findSelected(videoClip);
    if (!selected) return null;
    let index = selected.trackIndex;
    return Object.assign(core.sourceRangeState(selected.clip, selected.track.sourceDuration), {
      clipId: selected.clip.id,
      trackId: selected.track.id,
      code: "A" + (index + 2),
      name: selected.track.name,
      color: trackColor(index),
      waveformUrl: selected.track.waveformUrl || "",
      timelineStart: selected.clip.timelineStart,
      timelineDuration: selected.clip.timelineDuration,
    });
  }

  function waveformStyle(track: AudioTrackState, audioClip: AudioClipState) {
    if (!track.waveformUrl) return "";
    let sourceSpan = Math.max(_MIN_TRIM, audioClip.sourceOut - audioClip.sourceIn);
    let size = audioClip.loop
      ? Math.max(12, (track.sourceDuration / sourceSpan) * 100)
      : Math.max(100, (track.sourceDuration / sourceSpan) * 100);
    let position = Math.max(
      0,
      Math.min(
        100,
        core.waveformPositionPct(audioClip.sourceIn, sourceSpan, track.sourceDuration),
      ),
    );
    return (
      "background-image:url('" +
      track.waveformUrl.replace(/'/g, "%27") +
      "');background-size:" +
      size +
      "% 100%;background-position:" +
      position +
      "% center"
    );
  }

  function pct(value: number, total: number) {
    return (value / Math.max(total, 0.0001)) * 100 + "%";
  }

  function timelineItemsTouch(previousEnd: number, nextStart: number) {
    return Math.abs(Number(previousEnd) - Number(nextStart)) < 0.001;
  }

  function addJoinClasses(element: HTMLElement, touchesPrevious: boolean, touchesNext: boolean) {
    element.classList.toggle("joins-previous", !!touchesPrevious);
    element.classList.toggle("joins-next", !!touchesNext);
  }

  function paintTimelineSelection() {
    let videoTrack = byId("video-track");
    let sourceTrack = byId("source-audio-track");
    let sourceGroupSelected = selectedTrackId === "source";
    if (videoTrack) videoTrack.classList.toggle("selected", sourceGroupSelected);
    if (sourceTrack) sourceTrack.classList.toggle("selected", sourceGroupSelected);

    Array.from(documentRef.querySelectorAll("#tl-segments .tl-segment")).forEach(
      function(segment) {
        const selected = sourceGroupSelected && segment.classList.contains("active");
        segment.setAttribute("aria-pressed", selected ? "true" : "false");
      },
    );

    let importedTracks = byId("imported-audio-tracks");
    if (importedTracks) {
      Array.from(importedTracks.querySelectorAll(".seq-row.audio.imported")).forEach(
        function(row) {
          if (!isHtmlElement(row)) return;
          row.classList.toggle("selected", row.dataset.trackId === selectedTrackId);
        },
      );
    }
    Array.from(
      documentRef.querySelectorAll(".seq-audio-clip.imported[data-clip-id]"),
    ).forEach(function(audioClipElement) {
      if (!isHtmlElement(audioClipElement)) return;
      let selected = audioClipElement.dataset.clipId === selectedClipId;
      audioClipElement.classList.toggle("selected", selected);
      audioClipElement.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function setTimelineSelection(trackId: string, clipId: string | null | undefined) {
    let selection = core.timelineSelection(trackId, clipId);
    selectedTrackId = selection.trackId;
    selectedClipId = selection.clipId;
    paintTimelineSelection();
    if (
      selection.trackId !== "source" &&
      typeof host.setInspectorTab === "function"
    )
      host.setInspectorTab("audio");
  }

  function renderSourceTrack(clip: EditorClip | null | undefined, state: AudioTimelineState, total: number) {
    let lane = byId("source-audio-lane");
    let sourceTrack = byId("source-audio-track");
    if (!lane || !sourceTrack) return;
    let hasAudio = !!(clip && clip.probeData && clip.probeData.has_audio);
    sourceTrack.classList.toggle("disabled", !hasAudio || !state.enabled);
    sourceTrack.classList.toggle("muted", state.sourceMuted);
    sourceTrack.setAttribute(
      "aria-label",
      state.sourceMuted ? "Source audio track, muted" : "Source audio track",
    );
    let sourceLabel = byId("source-audio-label");
    if (sourceLabel) {
      sourceLabel.classList.toggle("muted", state.sourceMuted);
      sourceLabel.dataset.tip = state.sourceMuted ? "Unmute source audio" : "Mute source audio";
      sourceLabel.setAttribute("aria-pressed", state.sourceMuted ? "true" : "false");
      sourceLabel.setAttribute(
        "aria-label",
        state.sourceMuted ? "Unmute source audio" : "Mute source audio",
      );
    }
    paintSourceLane(clip, state, total);
  }

  function paintSourceLane(clip: EditorClip | null | undefined, state: AudioTimelineState, total: number) {
    let lane = byId("source-audio-lane");
    if (!lane) return;
    lane.replaceChildren();
    if (!clip || !state || total <= 0) return;
    if (!clip.probeData || !clip.probeData.has_audio || !state.enabled) return;
    let videoSegs = SegmentEditing.segmentsForClip(clip, total);
    let videoActive =
      clip && Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
    videoSegs.forEach(function(segment: SegmentLike, index: number) {
      lane.appendChild(
        sourceAudioBlock(
          segment,
          index,
          index === videoActive,
          state,
          total,
          index > 0 &&
            timelineItemsTouch(arrayItem(videoSegs, index - 1)?.end ?? 0, segment.start),
          index + 1 < videoSegs.length &&
            timelineItemsTouch(segment.end, arrayItem(videoSegs, index + 1)?.start ?? total),
        ),
      );
    });
  }

  function sourceAudioBlock(segment: SegmentLike, index: number, selected: boolean, state: AudioTimelineState, total: number, touchesPrevious: boolean, touchesNext: boolean, ) {
    let block = documentRef.createElement("div");
    block.className =
      "seq-audio-clip" + (selected ? " selected" : "") + (segment.muted ? " muted" : "");
    addJoinClasses(block, touchesPrevious, touchesNext);
    if (segment.muted) block.dataset.tip = "Source audio muted for this segment";
    block.dataset.audioKind = "source";
    block.dataset.segmentIndex = String(index);
    block.style.setProperty("--segment-color", host.segmentColor?.(index) ?? "#6D28D9");
    block.style.setProperty(
      "--clip-fill",
      TimelineCore.clipFill("source", selected, !!segment.muted),
    );
    block.style.left = pct(segment.start, total);
    block.style.width = pct(Math.max(0, segment.end - segment.start), total);
    if (state.sourceWaveformUrl) {
      let wave = documentRef.createElement("div");
      wave.className = "audio-waveform";
      wave.style.backgroundImage =
        "url('" + state.sourceWaveformUrl.replace(/'/g, "%27") + "')";
      wave.style.backgroundSize =
        Math.max(100, (total / Math.max(segment.end - segment.start, _MIN_TRIM)) * 100) +
        "% 100%";
      wave.style.backgroundPosition =
        core.waveformPositionPct(segment.start, segment.end - segment.start, total) +
        "% center";
      block.appendChild(wave);
    }
    if (segment.muted) {
      let mutedIndicator = documentRef.createElement("span");
      mutedIndicator.className = "audio-muted-indicator";
      mutedIndicator.textContent = "Muted";
      mutedIndicator.setAttribute("aria-hidden", "true");
      block.appendChild(mutedIndicator);
    }
    let edgeIn = documentRef.createElement("span");
    edgeIn.className = "clip-edge start";
    edgeIn.dataset.edge = "start";
    let edgeOut = documentRef.createElement("span");
    edgeOut.className = "clip-edge end";
    edgeOut.dataset.edge = "end";
    block.append(edgeIn, edgeOut);
    return block;
  }

  function renderImportedTrack(track: AudioTrackState, total: number, index: number) {
    let row = documentRef.createElement("div");
    row.className = "seq-row audio imported" + (track.muted ? " muted" : "");
    row.dataset.trackId = track.id;
    row.style.setProperty("--segment-color", trackColor(index));
    row.setAttribute(
      "aria-label",
      track.name + " audio track" + (track.muted ? ", muted" : ""),
    );

    let head = documentRef.createElement("div");
    head.className = "seq-head";
    let codeEl = documentRef.createElement("span");
    codeEl.className = "seq-track-code";
    codeEl.textContent = "A" + (index + 2);
    codeEl.setAttribute("aria-hidden", "true");
    head.appendChild(codeEl);

    let nameEl = documentRef.createElement("span");
    nameEl.className = "seq-track-name";
    nameEl.textContent = track.name;
    nameEl.title = track.name;
    head.appendChild(nameEl);

    let actions = TimelineCore ? TimelineCore.trackActions("imported") : ["mute", "remove"];
    if (actions.indexOf("mute") >= 0) {
      let muteEl = documentRef.createElement("button");
      muteEl.type = "button";
      muteEl.className = "seq-track-mute" + (track.muted ? " muted" : "");
      muteEl.dataset.trackAction = "mute";
      muteEl.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true">' +
        '<path d="M1.5 6h2.3l3.4-3v10l-3.4-3H1.5z"></path>' +
        '<path class="track-sound-waves" d="M10 5.1a4 4 0 0 1 0 5.8M12 3.3a6.5 6.5 0 0 1 0 9.4"></path>' +
        '<path class="track-mute-cross" d="M10.4 6.2l3.4 3.6M13.8 6.2l-3.4 3.6"></path>' +
        "</svg>";
      muteEl.dataset.tip = track.muted ? "Unmute " + track.name : "Mute " + track.name;
      muteEl.setAttribute("aria-pressed", track.muted ? "true" : "false");
      muteEl.setAttribute("aria-label", muteEl.dataset.tip);
      muteEl.addEventListener("click", function(event: PointerEvent) {
        event.stopPropagation();
        selectedTrackId = track.id;
        apiObject.toggleTrackMute(track.id);
      });
      head.appendChild(muteEl);
    }

    if (actions.indexOf("remove") >= 0) {
      let removeEl = documentRef.createElement("button");
      removeEl.type = "button";
      removeEl.className = "seq-track-remove";
      removeEl.dataset.trackAction = "remove";
      removeEl.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true">' +
        '<path d="M3.5 4.5h9M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"></path>' +
        '<path d="M6.7 7v4M9.3 7v4"></path>' +
        "</svg>";
      removeEl.dataset.tip = "Remove " + track.name;
      removeEl.setAttribute("aria-label", removeEl.dataset.tip);
      removeEl.addEventListener("click", function(event: PointerEvent) {
        event.stopPropagation();
        selectedTrackId = track.id;
        apiObject.removeTrack(track.id);
      });
      head.appendChild(removeEl);
    }

    row.appendChild(head);

    let lane = documentRef.createElement("div");
    lane.className = "seq-lane audio-lane";
    lane.dataset.trackId = track.id;
    lane.addEventListener("pointerdown", onLanePointerDown);
    track.clips.forEach(function(audioClip, clipIndex) {
      let selected = audioClip.id === selectedClipId;
      let el = documentRef.createElement("div");
      el.className =
        "seq-audio-clip imported" +
        (selected ? " selected" : "") +
        (audioClip.muted ? " muted" : "");
      let previousClip = clipIndex > 0 ? arrayItem(track.clips, clipIndex - 1) : null;
      let nextClip = arrayItem(track.clips, clipIndex + 1);
      addJoinClasses(
        el,
        previousClip !== null &&
          timelineItemsTouch(
            previousClip.timelineStart + previousClip.timelineDuration,
            audioClip.timelineStart,
          ),
        nextClip !== null &&
          timelineItemsTouch(
            audioClip.timelineStart + audioClip.timelineDuration,
            nextClip.timelineStart,
          ),
      );
      el.dataset.clipId = audioClip.id;
      el.dataset.trackId = track.id;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.setAttribute("aria-pressed", selected ? "true" : "false");
      el.setAttribute(
        "aria-label",
        track.name +
          " audio clip" +
          (audioClip.loop ? ", looping" : "") +
          (audioClip.muted ? ", muted" : ""),
      );
      el.dataset.tip = "Drag to move · Alt-drag to choose another source fragment";
      el.style.left = pct(audioClip.timelineStart, total);
      el.style.width = pct(audioClip.timelineDuration, total);
      el.style.setProperty(
        "--clip-fill",
        TimelineCore.clipFill(
          "imported",
          selected,
          !!audioClip.muted,
          trackColor(index),
        ),
      );

      let wave = documentRef.createElement("div");
      wave.className = "audio-waveform";
      wave.setAttribute("style", waveformStyle(track, audioClip));
      el.appendChild(wave);
      let clipLabel = documentRef.createElement("span");
      clipLabel.className = "audio-clip-label";
      clipLabel.textContent = track.name;
      el.appendChild(clipLabel);
      if (audioClip.muted) {
        let clipMutedIndicator = documentRef.createElement("span");
        clipMutedIndicator.className = "audio-muted-indicator";
        clipMutedIndicator.textContent = "Muted";
        clipMutedIndicator.setAttribute("aria-hidden", "true");
        el.appendChild(clipMutedIndicator);
      }
      if (selected) {
        let sourceReadout = documentRef.createElement("span");
        sourceReadout.className = "audio-source-range-readout";
        sourceReadout.textContent =
          "Source " +
          core.formatSourceTime(audioClip.sourceIn) +
          "–" +
          core.formatSourceTime(audioClip.sourceOut);
        el.appendChild(sourceReadout);
      }
      if (audioClip.fadeIn > 0) {
        let fadeIn = documentRef.createElement("span");
        fadeIn.className = "audio-fade in";
        fadeIn.style.width =
          Math.min(100, (audioClip.fadeIn / audioClip.timelineDuration) * 100) + "%";
        el.appendChild(fadeIn);
      }
      if (audioClip.fadeOut > 0) {
        let fadeOut = documentRef.createElement("span");
        fadeOut.className = "audio-fade out";
        fadeOut.style.width =
          Math.min(100, (audioClip.fadeOut / audioClip.timelineDuration) * 100) + "%";
        el.appendChild(fadeOut);
      }
      let edgeIn = documentRef.createElement("span");
      edgeIn.className = "clip-edge start";
      edgeIn.dataset.edge = "start";
      let edgeOut = documentRef.createElement("span");
      edgeOut.className = "clip-edge end";
      edgeOut.dataset.edge = "end";
      el.append(edgeIn, edgeOut);
      lane.appendChild(el);
    });
    row.appendChild(lane);
    return row;
  }

  function render() {
    let clip = selectedVideo();
    let editor = byId("audio-editor");
    if (!editor) return;
    if (!clip || !clip.probed) {
      editor.classList.add("disabled");
      let emptyLane = byId("source-audio-lane");
      if (emptyLane) emptyLane.replaceChildren();
      let tracks = byId("imported-audio-tracks");
      if (tracks) tracks.replaceChildren();
      if (typeof host.syncTimelineTrackCount === "function") host.syncTimelineTrackCount(0);
      paintMixer(clip);
      return;
    }
    editor.classList.remove("disabled");
    let state = ensureState(clip);
    if (!state) return;
    reconcile(clip);
    let total = sourceDuration(clip);
    let master = byId("audio-master-toggle");
    if (master) {
      master.classList.toggle("on", state.enabled);
      master.setAttribute("aria-checked", state.enabled ? "true" : "false");
      master.setAttribute("aria-label", "Include audio in export");
    }
    renderSourceTrack(clip, state, total);
    let tracks = byId("imported-audio-tracks");
    if (!tracks) return;
    tracks.replaceChildren();
    state.tracks.forEach(function(track: AudioTrackState, index: number) {
      tracks.appendChild(renderImportedTrack(track, total, index));
    });
    if (typeof host.syncTimelineTrackCount === "function")
      host.syncTimelineTrackCount(state.tracks.length);
    paintMixer(clip);
    paintTimelineSelection();
    updatePlayheads(sourceTime(), total);
    applyPreviewVolume();
  }

  function paintMixer(clip: EditorClip | null | undefined) {
    if (!clip || !clip.probed) {
      let fragMuteEmpty = byId("audio-fragment-mute");
      if (fragMuteEmpty) fragMuteEmpty.classList.add("hid");
      if (typeof host.renderAudioMixerList === "function") host.renderAudioMixerList();
      if (typeof host.renderAudioLibraryPanel === "function") host.renderAudioLibraryPanel();
      return;
    }
    if (!ensureState(clip)) return;
    if (
      selectedTrackId !== "source" &&
      !findTrack(selectedTrackId, clip)
    ) {
      selectedTrackId = "source";
    }
    let fragMute = byId("audio-fragment-mute");
    let fragmentMuted = false;
    let selectedFragment = null;
    if (selectedTrackId === "source" && SegmentEditing) {
      let segs = SegmentEditing.segmentsForClip(clip, sourceDuration(clip));
      let active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
      fragmentMuted = !!arrayItem(segs, active)?.muted;
    } else {
      selectedFragment = findSelected(clip);
      fragmentMuted = !!(selectedFragment && selectedFragment.clip.muted);
    }
    if (fragMute) {
      let hasFragmentTarget = selectedTrackId === "source" || !!selectedFragment;
      fragMute.classList.toggle("hid", !hasFragmentTarget);
      fragMute.classList.toggle("on", fragmentMuted);
      fragMute.setAttribute("aria-pressed", fragmentMuted ? "true" : "false");
      let fragMuteLabel;
      if (selectedFragment) {
        fragMuteLabel = fragmentMuted
          ? "Unmute selected audio fragment"
          : "Mute selected audio fragment";
      } else {
        fragMuteLabel = fragmentMuted
          ? "Unmute this segment's source audio"
          : "Mute this segment's source audio";
      }
      fragMute.setAttribute("aria-label", fragMuteLabel);
      fragMute.dataset.tip = fragMuteLabel;
    }
    if (typeof host.renderAudioMixerList === "function") host.renderAudioMixerList();
    if (typeof host.renderAudioLibraryPanel === "function") host.renderAudioLibraryPanel();
  }

  function updatePlayheads(time: number, total: number) {
    let pctValue = total > 0 ? Math.max(0, Math.min(100, (time / total) * 100)) : 0;
    let layer = byId("seq-playhead-layer");
    if (layer) layer.style.setProperty("--playhead", pctValue + "%");
  }

  function neighborBounds(track: AudioTrackState, index: number, total: number, duration: number) {
    return {
      min: index > 0
        ? (arrayItem(track.clips, index - 1)?.timelineStart ?? 0) +
          (arrayItem(track.clips, index - 1)?.timelineDuration ?? 0)
        : 0,
      max:
        (arrayItem(track.clips, index + 1)?.timelineStart ?? total) -
        duration,
    };
  }

  function onLanePointerDown(event: PointerEvent) {
    if (event.button != null && event.button !== 0) return;
    const lane = isHtmlElement(event.currentTarget) ? event.currentTarget : null;
    const target = isElement(event.target) ? event.target : null;
    const clipCandidate = target?.closest(".seq-audio-clip, .audio-clip") ?? null;
    const clipEl = isHtmlElement(clipCandidate) ? clipCandidate : null;
    let videoClip = selectedVideo();
    let total = sourceDuration(videoClip);
    if (!lane || !videoClip || total <= 0 || lane.clientWidth <= 0) return;
    if (!clipEl) {
      let ratio = (event.clientX - lane.getBoundingClientRect().left) / lane.clientWidth;
      apiObject.seekSource(Math.max(0, Math.min(total, ratio * total)));
      return;
    }
    if (clipEl.dataset.audioKind === "source") {
      setTimelineSelection("source", null);
      const edgeCandidate = target?.closest(".clip-edge") ?? null;
      const edge = isHtmlElement(edgeCandidate) ? edgeCandidate : null;
      const edgeName = edge?.dataset.edge;
      let sourceSegmentIndex = Number(clipEl.dataset.segmentIndex);
      let ratio = (event.clientX - lane.getBoundingClientRect().left) / lane.clientWidth;
      let time = Math.max(0, Math.min(total, ratio * total));
      if (
        (edgeName === "start" || edgeName === "end") &&
        (typeof host.applyTrimStart === "function" || typeof host.applyTrimEnd === "function")
      ) {
        if (Number.isInteger(sourceSegmentIndex) && typeof host.selectSegment === "function")
          host.selectSegment(sourceSegmentIndex, false);
        dragState = {
          kind: "group-trim",
          edge: edgeName,
          startX: event.clientX,
          rect: lane.getBoundingClientRect(),
          total: total,
        };
        if (event.pointerId != null) {
          try {
            lane.setPointerCapture(event.pointerId);
          } catch (err) {}
        }
        event.preventDefault();
        return;
      }
      let videoSegs = SegmentEditing.segmentsForClip(videoClip, total);
      let videoIndex = SegmentEditing.segmentIndexAtTime(videoSegs, time, 0);
      if (videoIndex >= 0 && typeof host.selectSegment === "function")
        host.selectSegment(videoIndex, false);
      apiObject.seekSource(time);
      dragState = {
        kind: "group-move",
        index: videoIndex,
        offset: videoIndex >= 0 ? time - (arrayItem(videoSegs, videoIndex)?.start ?? time) : 0,
        startX: event.clientX,
        rect: lane.getBoundingClientRect(),
        total: total,
      };
      if (event.pointerId != null) {
        try {
          lane.setPointerCapture(event.pointerId);
        } catch (err) {}
      }
      event.preventDefault();
      paintMixer(videoClip);
      return;
    }
    let track = findTrack(clipEl.dataset.trackId ?? "", videoClip);
    if (!track) return;
    let index = track.clips.findIndex(function(item: AudioClipState) {
      return item.id === clipEl.dataset.clipId;
    });
    if (index < 0) return;
    const selectedAudioClip = arrayItem(track.clips, index);
    if (!selectedAudioClip) return;
    setTimelineSelection(track.id, selectedAudioClip.id);
    const importedEdgeCandidate = target?.closest(".clip-edge") ?? null;
    const importedEdge = isHtmlElement(importedEdgeCandidate) ? importedEdgeCandidate : null;
    let importedAction = core.importedDragAction(
      importedEdge ? importedEdge.dataset.edge : null,
      !!event.altKey,
      isHtmlElement(event.target) ? event.target.dataset.audioAction : null,
    );
    if (importedAction === "slip" && !clipEl.querySelector(".audio-source-range-readout")) {
      let slipReadout = documentRef.createElement("span");
      slipReadout.className = "audio-source-range-readout";
      slipReadout.textContent =
        "Source " +
        core.formatSourceTime(selectedAudioClip.sourceIn) +
        "–" +
        core.formatSourceTime(selectedAudioClip.sourceOut);
      clipEl.appendChild(slipReadout);
    }
    host.History?.begin?.(session.selPath);
    dragState = {
      action: importedAction,
      kind: "imported",
      track: track,
      clip: selectedAudioClip,
      index: index,
      original: { ...selectedAudioClip },
      startX: event.clientX,
      rect: lane.getBoundingClientRect(),
      total: total,
      element: clipEl,
    };
    if (event.pointerId != null) {
      try {
        lane.setPointerCapture(event.pointerId);
      } catch (err) {}
    }
    event.preventDefault();
  }

  function audioClipSnapCandidates(excludeClipId: string | null | undefined) {
    let clip = selectedVideo();
    let total = sourceDuration(clip);
    let points = [0, total, sourceTime()];
    if (clip && SegmentEditing) {
      SegmentEditing.segmentsForClip(clip, total).forEach(function(segment: SegmentLike) {
        points.push(segment.start, segment.end);
      });
    }
    let state = ensureState(clip);
    if (!state) return points;
    state.tracks.forEach(function(track: AudioTrackState) {
      track.clips.forEach(function(audioClip: AudioClipState) {
        if (audioClip.id === excludeClipId) return;
        points.push(audioClip.timelineStart, audioClip.timelineStart + audioClip.timelineDuration);
      });
    });
    return points;
  }

  function paintDragged() {
    if (!dragState || dragState.kind !== "imported") return;
    dragState.element.style.left = pct(dragState.clip.timelineStart, dragState.total);
    dragState.element.style.width = pct(dragState.clip.timelineDuration, dragState.total);
    let wave = dragState.element.querySelector(".audio-waveform");
    if (wave) wave.setAttribute("style", waveformStyle(dragState.track, dragState.clip));
    let readout = dragState.element.querySelector(".audio-source-range-readout");
    if (readout)
      readout.textContent =
        "Source " +
        core.formatSourceTime(dragState.clip.sourceIn) +
        "–" +
        core.formatSourceTime(dragState.clip.sourceOut);
  }

  function processGroupDragMove(event: PointerEvent) {
    if (!dragState) return;
    if (dragState.kind === "group-move") {
      if (Math.abs(event.clientX - dragState.startX) < _DRAG_THRESHOLD) return;
      let time =
        ((event.clientX - dragState.rect.left) / dragState.rect.width) * dragState.total;
      if (typeof host.moveActiveSegment === "function") {
        let moved = host.moveActiveSegment(time - dragState.offset);
        if (moved && typeof host.paintTrimChrome === "function") host.paintTrimChrome();
      }
      updatePlayheads(
        Math.max(0, Math.min(dragState.total, time)),
        dragState.total,
      );
      return;
    }
    if (dragState.kind !== "group-trim") return;
    let trimTime =
      ((event.clientX - dragState.rect.left) / dragState.rect.width) * dragState.total;
    if (dragState.edge === "start" && typeof host.applyTrimStart === "function")
      host.applyTrimStart(trimTime);
    else if (typeof host.applyTrimEnd === "function") host.applyTrimEnd(trimTime);
    if (typeof host.paintTrimChrome === "function") host.paintTrimChrome();
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragState) return;
    if (dragState.kind === "group-move" || dragState.kind === "group-trim") {
      event.preventDefault();
      _groupDragEvent = event;
      if (_groupDragRaf) return;
      _groupDragRaf = requestAnimationFrame(function () {
        _groupDragRaf = 0;
        let evt = _groupDragEvent;
        _groupDragEvent = null;
        if (evt) processGroupDragMove(evt);
      });
      return;
    }
    if (dragState.kind !== "imported") return;
    let delta = ((event.clientX - dragState.startX) / dragState.rect.width) * dragState.total;
    let original = dragState.original;
    let audioClip = dragState.clip;
    let bounds = neighborBounds(
      dragState.track,
      dragState.index,
      dragState.total,
      original.timelineDuration,
    );
    if (dragState.action === "move") {
      if (Math.abs(event.clientX - dragState.startX) < _DRAG_THRESHOLD) {
        event.preventDefault();
        return;
      }
      let proposedStart = Math.max(
        bounds.min,
        Math.min(bounds.max, original.timelineStart + delta),
      );
      if (typeof host.snapCandidateTime === "function") {
        let pxPerSecond = dragState.rect.width / dragState.total;
        let candidates = audioClipSnapCandidates(audioClip.id);
        let snappedStart = host.snapCandidateTime(proposedStart, candidates, pxPerSecond);
        let snappedEnd = host.snapCandidateTime(
          proposedStart + original.timelineDuration,
          candidates,
          pxPerSecond,
        );
        if (snappedEnd !== proposedStart + original.timelineDuration)
          proposedStart = snappedEnd - original.timelineDuration;
        else proposedStart = snappedStart;
        proposedStart = Math.max(bounds.min, Math.min(bounds.max, proposedStart));
      }
      audioClip.timelineStart = proposedStart;
    } else if (dragState.action === "slip") {
      let slipped = core.slipClip(original, dragState.track.sourceDuration, delta);
      audioClip.sourceIn = slipped.sourceIn;
      audioClip.sourceOut = slipped.sourceOut;
      dragState.element.classList.add("slipping");
    } else if (dragState.action === "trim-start") {
      let maximumDelta = original.timelineDuration - _MIN_TRIM;
      let minimumDelta = bounds.min - original.timelineStart;
      if (!original.loop) {
        maximumDelta = Math.min(maximumDelta, original.sourceOut - original.sourceIn - _MIN_TRIM);
        // Keep the trim inside the source
        minimumDelta = Math.max(minimumDelta, -original.sourceIn);
      }
      let actual = Math.max(minimumDelta, Math.min(maximumDelta, delta));
      audioClip.timelineStart = original.timelineStart + actual;
      audioClip.timelineDuration = original.timelineDuration - actual;
      if (!original.loop) audioClip.sourceIn = original.sourceIn + actual;
    } else {
      let nextStart =
        dragState.index + 1 < dragState.track.clips.length
          ? (arrayItem(dragState.track.clips, dragState.index + 1)?.timelineStart ?? dragState.total)
          : dragState.total;
      let maxDuration = nextStart - original.timelineStart;
      // Use all audio left in the source
      if (!original.loop)
        maxDuration = Math.min(maxDuration, dragState.track.sourceDuration - original.sourceIn);
      audioClip.timelineDuration = Math.max(
        _MIN_TRIM,
        Math.min(maxDuration, original.timelineDuration + delta),
      );
      if (!original.loop) audioClip.sourceOut = original.sourceIn + audioClip.timelineDuration;
    }
    audioClip.fadeIn = Math.min(audioClip.fadeIn, audioClip.timelineDuration);
    audioClip.fadeOut = Math.min(
      audioClip.fadeOut,
      audioClip.timelineDuration - audioClip.fadeIn,
    );
    paintDragged();
    updatePlayheads(sourceTime(), dragState.total);
    event.preventDefault();
  }

  function onPointerUp() {
    if (!dragState) return;
    if (_groupDragRaf) {
      cancelAnimationFrame(_groupDragRaf);
      _groupDragRaf = 0;
    }
    if (_groupDragEvent) {
      processGroupDragMove(_groupDragEvent);
      _groupDragEvent = null;
    }
    let completedDrag = dragState;
    dragState = null;
    if (completedDrag.kind === "imported") {
      completedDrag.element.classList.remove("slipping");
    }
    render();
    setPlanDirty(selectedVideo());
    host.History?.commit?.();
  }

  function updateSelectedSourceRange(value: number, finalize: boolean) {
    let videoClip = selectedVideo();
    let selected = findSelected(videoClip);
    if (!selected) return null;
    let desired = Number(value);
    if (!Number.isFinite(desired)) desired = selected.clip.sourceIn;
    let slipped = core.slipClip(
      selected.clip,
      selected.track.sourceDuration,
      desired - selected.clip.sourceIn,
    );
    selected.clip.sourceIn = slipped.sourceIn;
    selected.clip.sourceOut = slipped.sourceOut;
    if (finalize) {
      render();
      setPlanDirty(videoClip);
    } else {
      let element = documentRef.querySelector(
        '[data-clip-id="' + selected.clip.id + '"]',
      );
      if (element) {
        let wave = element.querySelector(".audio-waveform");
        if (wave) wave.setAttribute("style", waveformStyle(selected.track, selected.clip));
        let readout = element.querySelector(".audio-source-range-readout");
        if (readout)
          readout.textContent =
            "Source " +
            core.formatSourceTime(selected.clip.sourceIn) +
            "–" +
            core.formatSourceTime(selected.clip.sourceOut);
        element.classList.add("slipping");
      }
      syncPreview();
    }
    return selectedClipRangeData(videoClip);
  }

  function clipFadeFactor(audioClip: AudioClipState, localTime: number) {
    let factor = 1;
    if (audioClip.fadeIn > 0 && localTime < audioClip.fadeIn)
      factor = Math.min(factor, localTime / audioClip.fadeIn);
    let remaining = audioClip.timelineDuration - localTime;
    if (audioClip.fadeOut > 0 && remaining < audioClip.fadeOut)
      factor = Math.min(factor, remaining / audioClip.fadeOut);
    return Math.max(0, Math.min(1, factor));
  }

  function previewElement(track: AudioTrackState) {
    let element = previewElements[track.id] ?? null;
    if (!element && track.mediaUrl) {
      element = documentRef.createElement("audio");
      element.preload = "auto";
      element.src = track.mediaUrl;
      previewElements[track.id] = element;
    }
    return element;
  }

  function previewBaseVolume() {
    let slider = byId("vbar");
    if (session.muted || !isInputElement(slider)) return 0;
    return Math.max(0, Math.min(1, Number(slider.value) / 100));
  }

  function sourceAudioAudibleAt(clip: EditorClip | null | undefined, time: number) {
    let segs = audioSegments(clip);
    if (!segs.length) return false;
    return SegmentEditing.segmentIndexAtTime(segs, time, 0.02) >= 0;
  }

  function applyPreviewVolume() {
    let videoClip = selectedVideo();
    let videoCandidate = byId("vid");
    let video = isVideoElement(videoCandidate) ? videoCandidate : null;
    if (!videoClip || !video) return;
    let state = ensureState(videoClip);
    if (!state) return;
    let base = previewBaseVolume();
    let time = Number(video.currentTime) || 0;
    let sourceAudible =
      state.enabled &&
      !state.sourceMuted &&
      videoClip.probeData &&
      videoClip.probeData.has_audio &&
      sourceAudioAudibleAt(videoClip, time);
    video.volume = sourceAudible
      ? Math.max(0, Math.min(1, base * dbToGain(state.sourceGainDb)))
      : 0;
    syncPreview();
  }

  function syncPreview() {
    let videoClip = selectedVideo();
    let videoCandidate = byId("vid");
    let video = isVideoElement(videoCandidate) ? videoCandidate : null;
    if (!videoClip || !video || !videoClip.probed) return;
    let state = ensureState(videoClip);
    if (!state) return;
    let total = sourceDuration(videoClip);
    let time = Number(video.currentTime) || 0;
    updatePlayheads(time, total);
    let base = previewBaseVolume();
    let sourceAudible =
      state.enabled &&
      !state.sourceMuted &&
      videoClip.probeData &&
      videoClip.probeData.has_audio &&
      sourceAudioAudibleAt(videoClip, time);
    video.volume = sourceAudible
      ? Math.max(0, Math.min(1, base * dbToGain(state.sourceGainDb)))
      : 0;
    state.tracks.forEach(function(track: AudioTrackState) {
      let element = previewElement(track);
      if (!element) return;
      let active = null;
      for (const candidate of track.clips) {
        if (
          time >= candidate.timelineStart - 0.02 &&
          time < candidate.timelineStart + candidate.timelineDuration - 0.01
        ) {
          active = candidate;
          break;
        }
      }
      if (!state.enabled || track.muted || !active || active.muted || video.paused) {
        if (!element.paused) element.pause();
        return;
      }
      let local = Math.max(0, time - active.timelineStart);
      let span = Math.max(_MIN_TRIM, active.sourceOut - active.sourceIn);
      let sourcePos = active.sourceIn + (active.loop ? local % span : local);
      if (!Number.isFinite(element.currentTime) || Math.abs(element.currentTime - sourcePos) > 0.12) {
        try {
          element.currentTime = sourcePos;
        } catch (err) {}
      }
      element.volume = Math.max(
        0,
        Math.min(
          1,
          base *
            dbToGain(track.gainDb + active.gainDb) *
            clipFadeFactor(active, local),
        ),
      );
      let promise = element.play();
      if (promise && typeof promise.catch === "function") promise.catch(function () {});
    });
  }

  function stopPreviewElements() {
    Object.keys(previewElements).forEach(function(key: string) {
      try {
        const element = previewElements[key];
        if (!element) return;
        element.pause();
        element.src = "";
      } catch (err) {}
    });
    previewElements = {};
  }

  async function loadWaveform(
    clip: EditorClip | null | undefined,
    target: AudioTimelineModel | AudioTrackState,
    path: string,
  ) {
    if (!hasBackendClient()) return;
    if (!clip) return;
    const generation = nextWaveformGeneration(path);
    const clipPath = clip.path;
    try {
      let result = await getBackendClient().getWaveform(path);
      if (currentWaveformGeneration(path) !== generation) return;
      if (selectedVideo() !== clip || clip.path !== clipPath) return;
      if (!result.ok || !clip.audioTimeline) return;
      if (isTimelineModel(target)) {
        target.sourceWaveformUrl = result.value.url;
        target.sourceWaveformToken = result.value.token ?? "";
        target.sourceWaveformLoading = false;
      } else {
        target.waveformUrl = result.value.url;
        target.waveformToken = result.value.token ?? "";
      }
      if (selectedVideo() === clip) render();
    } catch (err) {
      if (isTimelineModel(target)) target.sourceWaveformLoading = false;
    }
  }

  function loadSourceWaveform(clip: EditorClip | null | undefined) {
    if (!clip) return;
    let state = ensureState(clip);
    if (!state) return;
    if (
      !clip.probeData ||
      !clip.probeData.has_audio ||
      state.sourceWaveformUrl ||
      state.sourceWaveformLoading
    )
      return;
    state.sourceWaveformLoading = true;
    loadWaveform(clip, state, clip.path);
  }

  async function addPaths(paths: string[], rejected: unknown[] | null | undefined) {
    let videoClip = selectedVideo();
    if (!videoClip) {
      notify("Select a video before adding audio.", "err");
      return;
    }
    let state = ensureState(videoClip);
    if (!state) return;
    let start = sourceTime();
    let total = sourceDuration(videoClip);
    if (total <= 0) {
      notify("Wait for the video to finish loading before adding audio.", "err");
      return;
    }
    let added = 0;
    for (const path of paths) {
      try {
        if (
          state.tracks.some(function(track: AudioTrackState) {
            return track.path.toLowerCase() === path.toLowerCase();
          })
        ) {
          throw new Error("This audio source is already on the timeline; split its clip to reuse it");
        }
        let probed = await getBackendClient().probeAudioFile(path);
        if (!probed.ok) throw new Error(probed.error.message || "Could not read audio");
        let media = await getBackendClient().getMediaUrl(path);
        if (!media.ok) throw new Error(media.error.message || "Could not load audio");
        let duration = jsonNumber(probed.value.data, "duration") ?? 0;
        if (duration < _MIN_TRIM) throw new Error("Audio file is too short");
        let placement = core.fitClipToTimeline(duration, total, start, _MIN_TRIM);
        let track: AudioTrackState = {
          id: nextId("track"),
          name: path.split(/[\\/]/).pop() ?? path,
          path,
          codec: jsonString(probed.value.data, "codec") ?? "audio",
          sourceDuration: duration,
          muted: false,
          gainDb: 0,
          mediaUrl: media.value.url,
          mediaToken: media.value.token ?? "",
          waveformUrl: "",
          waveformToken: "",
          clips: [
            {
              id: nextId("audio"),
              timelineStart: placement.timelineStart,
              sourceIn: placement.sourceIn,
              sourceOut: placement.sourceOut,
              timelineDuration: placement.timelineDuration,
              gainDb: 0,
              fadeIn: 0,
              fadeOut: 0,
              loop: false,
              muted: false,
            },
          ],
        };
        state.tracks.push(track);
        setTimelineSelection(track.id, track.clips[0]?.id ?? null);
        added += 1;
        void loadWaveform(videoClip, track, path);
      } catch (err) {
        notify(
          "Could not add " + path.split(/[\\/]/).pop() + ": " + asErrorMessage(err),
          "err",
        );
      }
    }
    if (added) {
      stopPreviewElements();
      render();
      setPlanDirty(videoClip);
      notify("Added " + added + " audio " + (added === 1 ? "track." : "tracks."), "ok");
    }
    if (rejected && rejected.length)
      notify("Skipped " + rejected.length + " unsupported audio file(s).", "err");
  }

  function releaseToken(token: string | null | undefined) {
    if (token && hasBackendClient()) void getBackendClient().releaseMediaToken(token);
  }

  function disposeClip(videoClip: EditorClip | null | undefined) {
    const state = ensureState(videoClip);
    if (!state) return;
    releaseToken(state.sourceWaveformToken);
    state.tracks.forEach(function(track) {
      releaseToken(track.mediaToken);
      releaseToken(track.waveformToken);
      const element = previewElements[track.id];
      if (element) {
        element.pause();
        delete previewElements[track.id];
      }
    });
  }

  function requestPayload(videoClip: EditorClip | null | undefined) {
    let state = ensureState(videoClip);
    if (!state) return {};
    reconcile(videoClip);
    let payload: {
      audio_enabled: boolean;
      source_audio_muted: boolean;
      source_audio_gain_db: number;
      audio_tracks: Array<{
        track_id: string;
        name: string;
        gain_db: number;
        muted: boolean;
        clips: Array<{
          source: string;
          timeline_start: number;
          source_in: number;
          source_out: number;
          timeline_duration: number;
          gain_db: number;
          fade_in: number;
          fade_out: number;
          loop: boolean;
          muted: boolean;
        }>;
      }>;
      source_audio_segments?: Array<{ start: number; end: number }>;
    } = {
      audio_enabled: !!state.enabled,
      source_audio_muted: !!state.sourceMuted,
      source_audio_gain_db: Number(state.sourceGainDb) || 0,
      audio_tracks: state.tracks.map(function(track: AudioTrackState) {
        return {
          track_id: track.id,
          name: track.name,
          gain_db: Number(track.gainDb) || 0,
          muted: !!track.muted,
          clips: track.clips.map(function(audioClip: AudioClipState) {
            return {
              source: track.path,
              timeline_start: audioClip.timelineStart,
              source_in: audioClip.sourceIn,
              source_out: audioClip.sourceOut,
              timeline_duration: audioClip.timelineDuration,
              gain_db: Number(audioClip.gainDb) || 0,
              fade_in: audioClip.fadeIn,
              fade_out: audioClip.fadeOut,
              loop: !!audioClip.loop,
              muted: !!audioClip.muted,
            };
          }),
        };
      }),
    };
    let videoSegs = SegmentEditing
      ? SegmentEditing.segmentsForClip(videoClip, sourceDuration(videoClip))
      : [];
    let keptAudio = SegmentEditing.audioSegmentsForClip(
      videoClip,
      sourceDuration(videoClip),
    );
    let followsVideo =
      keptAudio.length === videoSegs.length &&
      videoSegs.every(function(segment: SegmentLike, index: number) {
        const matchingAudioSegment = arrayItem(keptAudio, index);
        return (
          matchingAudioSegment !== null &&
          Math.abs(matchingAudioSegment.start - segment.start) < 1e-6 &&
          Math.abs(matchingAudioSegment.end - segment.end) < 1e-6
        );
      });
    if (!followsVideo)
      payload.source_audio_segments = keptAudio.map(function(segment: SegmentLike) {
        return { start: segment.start, end: segment.end };
      });
    return payload;
  }

  let apiObject = {
    render: render,
    trackColor: trackColor,
    selectVideo: function(clip: EditorClip | null | undefined) {
      stopPreviewElements();
      setTimelineSelection("source", null);
      if (clip) {
        ensureState(clip);
        loadSourceWaveform(clip);
      }
      render();
    },
    onProbe: function(clip: EditorClip | null | undefined) {
      ensureState(clip);
      if (selectedVideo() === clip) {
        loadSourceWaveform(clip);
        render();
      }
    },
    disposeClip: disposeClip,
    requestPayload: requestPayload,
    paintSource: function () {
      let clip = selectedVideo();
      if (!clip) return;
      const state = ensureState(clip);
      if (state) paintSourceLane(clip, state, sourceDuration(clip));
    },
    paintMixer: function () {
      paintMixer(selectedVideo());
    },
    syncPreview: syncPreview,
    applyPreviewVolume: applyPreviewVolume,
    hasSelection: function () {
      return !!selectedClipId;
    },
    getSelectedClipRange: function () {
      return selectedClipRangeData(selectedVideo());
    },
    setSelectedSourceIn: function(value: number, finalize: boolean) {
      return updateSelectedSourceRange(value, !!finalize);
    },
    resetSelectedSource: function () {
      let selected = findSelected(selectedVideo());
      if (!selected) return null;
      return updateSelectedSourceRange(0, true);
    },
    browse: async function () {
      if (!hasBackendClient()) return;
      try {
        let result = await getBackendClient().pickAudioFiles();
        if (result.ok && result.value.files.length) void addPaths([...result.value.files], []);
        else if (!result.ok) notify(result.error.message || "Could not choose audio files.", "err");
      } catch (err) {
        notify("Could not choose audio files.", "err");
      }
    },
    addPaths: addPaths,
    toggleMaster: function () {
      let clip = selectedVideo();
      let state = ensureState(clip);
      if (!state) return;
      state.enabled = !state.enabled;
      render();
      setPlanDirty(clip);
    },
    toggleFragmentMute: function () {
      let clip = selectedVideo();
      if (!clip) return;
      if (selectedTrackId !== "source") {
        let selected = findSelected(clip);
        if (!selected) return;
        host.History?.begin?.(session.selPath);
        selected.clip.muted = !selected.clip.muted;
        render();
        setPlanDirty(clip);
        host.History?.commit?.();
        return;
      }
      if (!SegmentEditing) return;
      let full = sourceDuration(clip);
      let segs = SegmentEditing.segmentsForClip(clip, full);
      let active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
        const activeSegment = arrayItem(segs, active);
        if (!activeSegment) return;
        activeSegment.muted = !activeSegment.muted;
      if (typeof host.setClipSegments === "function")
        host.setClipSegments(clip, segs, active);
      if (typeof host.paintTrimChrome === "function") host.paintTrimChrome();
      render();
      setPlanDirty(clip);
    },
    selectTrack: function(trackId: string) {
      setTimelineSelection(trackId || "source", null);
      paintMixer(selectedVideo());
    },
    selectClip: function(trackId: string, clipId: string | null | undefined) {
      setTimelineSelection(trackId, clipId);
      paintMixer(selectedVideo());
    },
    selectVideoTrack: function () {
      setTimelineSelection("video", null);
      paintMixer(selectedVideo());
    },
    isSourceGroupSelected: function () {
      return selectedTrackId === "source";
    },
    toggleSourceMute: function () {
      let clip = selectedVideo();
      let state = ensureState(clip);
      if (!state) return;
      selectedTrackId = "source";
      state.sourceMuted = !state.sourceMuted;
      render();
      setPlanDirty(clip);
    },
    setSourceGain: function(value: number) {
      let clip = selectedVideo();
      let state = ensureState(clip);
      if (!state) return;
      state.sourceGainDb = Math.max(-60, Math.min(12, Number(value) || 0));
      applyPreviewVolume();
      setPlanDirty(clip);
    },
    toggleTrackMute: function(trackId: string) {
      let clip = selectedVideo();
      let track = findTrack(trackId, clip);
      if (!track) return;
      selectedTrackId = trackId;
      track.muted = !track.muted;
      render();
      setPlanDirty(clip);
    },
    toggleMixerMute: function () {
      if (selectedTrackId === "source") return apiObject.toggleSourceMute();
      apiObject.toggleTrackMute(selectedTrackId);
    },
    setMixerGain: function(value: number) {
      if (selectedTrackId === "source") return apiObject.setSourceGain(value);
      apiObject.setTrackGain(selectedTrackId, value);
    },
    setTrackGain: function(trackId: string, value: number) {
      let clip = selectedVideo();
      let track = findTrack(trackId, clip);
      if (!track) return;
      track.gainDb = Math.max(-60, Math.min(12, Number(value) || 0));
      syncPreview();
      setPlanDirty(clip);
    },
    removeTrack: function(trackId: string) {
      let clip = selectedVideo();
      let state = ensureState(clip);
      let track = findTrack(trackId, clip);
      if (!state || !track) return;
      confirm("Remove audio track “" + track.name + "”?", function () {
        host.History?.begin?.(session.selPath);
        let selected = findSelected(clip);
        releaseToken(track.mediaToken);
        releaseToken(track.waveformToken);
        const element = previewElements[track.id];
        if (element) {
          element.pause();
          delete previewElements[track.id];
        }
        state.tracks = state.tracks.filter(function(item) {
          return item.id !== trackId;
        });
        if (selected && selected.track.id === trackId) selectedClipId = null;
        render();
        setPlanDirty(clip);
        host.History?.commit?.();
      });
    },
    splitSelected: function () {
      let videoClip = selectedVideo();
      if (!videoClip) return;
      let at = sourceTime();
      let selected = findSelected(videoClip);
      if (!selected) return;
      let split = core.splitClip(selected.clip, at, nextId("audio"));
      if (!split) {
        notify("Move the playhead inside the selected audio clip to split it.", "err");
        return;
      }
      const [left, right] = split;
      const normalizedLeft = normalizeSplitAudioClip(left);
      const normalizedRight = normalizeSplitAudioClip(right);
      if (!normalizedLeft || !normalizedRight) {
        notify("Could not split the selected audio clip.", "err");
        return;
      }
      selected.track.clips.splice(selected.index, 1, normalizedLeft, normalizedRight);
      selectedClipId = normalizedRight.id;
      render();
      setPlanDirty(videoClip);
    },
    trimSelectedToPlayhead: function(endpoint: "start" | "end") {
      let videoClip = selectedVideo();
      let selected = findSelected(videoClip);
      if (!videoClip || !selected) return null;
      let previousEnd =
        selected.index > 0
          ? (arrayItem(selected.track.clips, selected.index - 1)?.timelineStart ?? 0) +
            (arrayItem(selected.track.clips, selected.index - 1)?.timelineDuration ?? 0)
          : 0;
      let nextStart =
        selected.index + 1 < selected.track.clips.length
          ? (arrayItem(selected.track.clips, selected.index + 1)?.timelineStart ??
            sourceDuration(videoClip))
          : sourceDuration(videoClip);
      let trimmed = core.trimClipToTimelinePoint(
        selected.clip,
        endpoint,
        sourceTime(),
        previousEnd,
        nextStart,
        selected.track.sourceDuration,
        _MIN_TRIM,
      );
      Object.assign(selected.clip, trimmed);
      render();
      setPlanDirty(videoClip);
      return selectedClipRangeData(videoClip);
    },
    deleteSelected: function () {
      let videoClip = selectedVideo();
      if (!videoClip) return;
      let selected = findSelected(videoClip);
      if (!selected) return;
      selected.track.clips.splice(selected.index, 1);
      selectedClipId = null;
      render();
      setPlanDirty(videoClip);
    },
    removeSelectedTrack: function () {
      if (selectedTrackId === "source") return;
      apiObject.removeTrack(selectedTrackId);
    },
    seekSource: function(seconds: number) {
      let videoClip = selectedVideo();
      let videoCandidate = byId("vid");
      let video = isVideoElement(videoCandidate) ? videoCandidate : null;
      if (!videoClip || !video || !videoClip.probeData) return;
      video.currentTime = Math.max(0, Math.min(sourceDuration(videoClip), seconds));
      syncPreview();
    },
    seekOutput: function(seconds: number) {
      let videoClip = selectedVideo();
      let videoCandidate = byId("vid");
      let video = isVideoElement(videoCandidate) ? videoCandidate : null;
      if (!videoClip || !video || !videoClip.probeData) return;
      let segments = SegmentEditing.segmentsForClip(
        videoClip,
        Number(videoClip.probeData.duration),
      );
      video.currentTime = core.outputToSourceTime(segments, seconds);
      syncPreview();
    },
  };

  let sourceLane = documentRef.getElementById("source-audio-lane");
  if (sourceLane) sourceLane.addEventListener("pointerdown", onLanePointerDown);
  windowRef.addEventListener("pointermove", onPointerMove);
  windowRef.addEventListener("pointerup", onPointerUp);
  let video = documentRef.getElementById("vid");
  if (video) {
    video.addEventListener("play", syncPreview);
    video.addEventListener("pause", syncPreview);
    video.addEventListener("timeupdate", syncPreview);
    video.addEventListener("seeked", syncPreview);
  }
  function canSetSelectionBoundary() {
    let clip = selectedVideo();
    if (!clip) return false;
    if (findSelected(clip)) return true;
    return (
      selectedTrackId === "source" &&
      typeof host.canTrimActiveSegmentToPlayhead === "function" &&
      host.canTrimActiveSegmentToPlayhead()
    );
  }
  function setSelectionBoundary(endpoint: "start" | "end") {
    if (findSelected(selectedVideo())) apiObject.trimSelectedToPlayhead(endpoint);
    else host.trimActiveSegmentToPlayhead?.(endpoint);
  }
  host.TuckShortcuts?.registerAction("edit.delete-selection", {
    enabled: function () {
      return (
        !!selectedClipId ||
        (typeof host.canRemoveActiveSegment === "function" &&
          host.canRemoveActiveSegment())
      );
    },
    execute: function () {
      if (selectedClipId) apiObject.deleteSelected();
      else host.removeActiveSegment?.();
    },
  });
  host.TuckShortcuts?.registerAction("audio.toggle-fragment-mute", {
    enabled: function () {
      let clip = selectedVideo();
      if (!clip) return false;
      return (
        selectedTrackId === "source" ||
        selectedTrackId === "video" ||
        !!findSelected(clip)
      );
    },
    execute: function () {
      if (selectedTrackId === "video") selectedTrackId = "source";
      apiObject.toggleFragmentMute();
    },
  });
  host.TuckShortcuts?.registerAction("timeline.set-selection-start", {
    enabled: canSetSelectionBoundary,
    execute: function () {
      setSelectionBoundary("start");
    },
  });
  host.TuckShortcuts?.registerAction("timeline.set-selection-end", {
    enabled: canSetSelectionBoundary,
    execute: function () {
      setSelectionBoundary("end");
    },
  });
  host.TuckShortcuts?.registerAction("timeline.split", function () {
    if (typeof host.splitAtPlayhead === "function") host.splitAtPlayhead();
    else apiObject.splitSelected();
  });

  function addAudioFiles(paths: string[], rejected: unknown[] | null | undefined) {
    if (!Array.isArray(paths)) return;
    addPaths(paths, rejected || []);
  }

  return Object.assign(apiObject, { addAudioFiles, addPaths });

}
