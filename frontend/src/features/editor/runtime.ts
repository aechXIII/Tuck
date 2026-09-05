import { getBackendClient } from "../../backend/client.ts";
import type { BackendClient } from "../../backend/types.ts";
import * as InspectorUi from "../panels/inspector-ui.ts";
import { installAudioTimeline } from "../audio/audio-timeline.ts";
import { installHistory, type HistoryApi } from "../history/history.ts";
import * as ClipDetails from "../library/clip-details.ts";
import { createLibrary, type LibraryApi } from "../library/library.ts";
import { installPanels, type PanelsApi } from "../panels/panels.ts";
import type { AudioClipRangeInfo } from "../panels/panels.ts";
import { installPlayer, type PlayerApi } from "../player/player.ts";
import {
  installShortcutDialog,
  type ShortcutDialogApi,
} from "../shortcuts/shortcuts-dialog.ts";
import { installShortcuts, type ShortcutsApi } from "../shortcuts/shortcuts.ts";
import { installTimeline } from "../timeline/timeline.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { installTransform, type TransformApi } from "../transform/transform.ts";
import { checkUpdates } from "./updates.ts";
import { legacyBackendResult } from "./backend-compat.ts";
import { errorSummary, formatBytes, formatTime } from "./format.ts";
import {
  closeActiveModal,
  closeMod,
  configureModalHandlers,
  confirmToast,
  showMod,
  toast,
} from "./toast.ts";
import { createEditorSession, type EditorSession } from "./session.ts";
import type { Segment } from "../../types/foundation.ts";

interface LaunchData {
  readonly files?: readonly unknown[];
  readonly sendto?: unknown;
}

interface LegacyState {
  api: BackendClient | null;
  lastComp: string;
  lastQueueHadActive: boolean;
  lastUpscale: string;
  previewRequestId: number;
  workflow: number;
}

export interface EditorRuntime {
  activateLegacyShell(): void;
  attachBackendClient(client: BackendClient): void;
  initApp(data: unknown): void;
  readonly session: EditorSession;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function isSegment(value: unknown): value is Segment {
  return (
    isRecord(value) &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function replaceRecord(target: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, value);
}

function replaceArray(target: unknown[], value: unknown): void {
  if (!Array.isArray(value)) return;
  target.splice(0, target.length, ...value);
}

function launchData(value: unknown): LaunchData {
  return isRecord(value) ? value : {};
}

function legacyCall(windowRef: Window, name: string, ...args: unknown[]): unknown {
  const handler = Reflect.get(windowRef, name);
  return typeof handler === "function"
    ? Reflect.apply(handler, windowRef, args)
    : undefined;
}

async function legacyCallAsync(
  windowRef: Window,
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  return await Promise.resolve(legacyCall(windowRef, name, ...args));
}

function exposeValue(windowRef: Window, name: string, value: unknown): void {
  Object.defineProperty(windowRef, name, {
    configurable: true,
    value,
    writable: true,
  });
}

function exposeAccessor(
  windowRef: Window,
  name: string,
  get: () => unknown,
  set: (value: unknown) => void,
): void {
  Object.defineProperty(windowRef, name, {
    configurable: true,
    enumerable: true,
    get,
    set,
  });
}

export function installEditorRuntime(
  windowRef: Window & typeof globalThis = window,
): EditorRuntime {
  const session = createEditorSession();
  const state: LegacyState = {
    api: null,
    lastComp: "",
    lastQueueHadActive: false,
    lastUpscale: "",
    previewRequestId: 0,
    workflow: 0,
  };
  let started = false;
  let legacyShellReady = false;
  let pendingLaunch: LaunchData | null = null;
  let history: HistoryApi;
  let library: LibraryApi;
  let panels: PanelsApi;
  let player: PlayerApi;
  let transform: TransformApi;
  let shortcuts: ShortcutsApi;
  let shortcutDialog: ShortcutDialogApi;
  let profileSnapshot = "";

  function panelAudioRange(): AudioClipRangeInfo | null {
    const range = audio.getSelectedClipRange();
    if (!range) return null;
    return {
      name: range.name ?? "",
      code: range.code,
      color: range.color,
      sourceIn: range.sourceIn,
      sourceOut: range.sourceOut,
      sourceSpan: range.sourceSpan,
      sourceDuration: range.sourceDuration,
      maxSourceIn: range.maxSourceIn,
      startPct: range.startPct,
      widthPct: range.widthPct,
      canSlip: range.canSlip,
      ...(typeof range.waveformUrl === "string" ? { waveformUrl: range.waveformUrl } : {}),
    };
  }

  const shortcutHost: { TuckShortcuts?: ShortcutsApi } = {};
  shortcuts = installShortcuts(shortcutHost);

  history = installHistory(
    {
      getClip: (path) => session.clips[path],
      selectedPath: () => session.selPath,
      refreshUiForClip: () => refreshEditor(),
      undoButton: () => byId<HTMLButtonElement>("btn-undo"),
      redoButton: () => byId<HTMLButtonElement>("btn-redo"),
    },
    shortcuts,
  );

  transform = installTransform({
    document: windowRef.document,
    window: windowRef,
    clips: () => session.clips,
    selPath: () => session.selPath,
    History: history,
    renderClips: () => library?.renderClips(),
    reqPreview: () => {
      legacyCall(windowRef, "reqPreview");
    },
  });

  const audio = installAudioTimeline({
    session,
    byId,
    documentRef: windowRef.document,
    windowRef,
    toast,
    setInspectorTab: (tab, persist) => panels?.setInspectorTab(tab, persist),
    renderClips: () => library?.renderClips(),
    reqPreview: () => {
      legacyCall(windowRef, "reqPreview");
    },
    setClipSegments: (clip, segments, active) =>
      timeline?.setClipSegments(clip, segments.filter(isSegment), active),
    paintTrimChrome: () => timeline?.paintTrimChrome(),
    syncTimelineTrackCount: (count) => timeline?.syncTimelineTrackCount(count),
    renderAudioMixerList: () => panels?.renderAudioMixerList(),
    renderAudioLibraryPanel: () => panels?.renderAudioLibraryPanel(),
    segmentColor: (index) => timeline?.segmentColor(index) ?? "#6D28D9",
    snapCandidateTime: (time, candidates, pixelsPerSecond) =>
      timeline?.snapCandidateTime(time, candidates, pixelsPerSecond) ?? time,
    applyTrimStart: (seconds, snap) => timeline?.applyTrimStart(seconds, snap) ?? null,
    applyTrimEnd: (seconds, snap) => timeline?.applyTrimEnd(seconds, snap) ?? null,
    selectSegment: (index, seek) => timeline?.selectSegment(index, seek),
    moveActiveSegment: (start, snap) => timeline?.moveActiveSegment(start, snap) ?? null,
    canTrimActiveSegmentToPlayhead: () =>
      timeline?.canTrimActiveSegmentToPlayhead() ?? false,
    trimActiveSegmentToPlayhead: (endpoint) =>
      timeline?.trimActiveSegmentToPlayhead(endpoint) ?? null,
    canRemoveActiveSegment: () => timeline?.canRemoveActiveSegment() ?? false,
    removeActiveSegment: () => timeline?.removeActiveSegment(),
    splitAtPlayhead: () => timeline?.splitAtPlayhead(),
    History: history,
    TuckShortcuts: shortcuts,
  });

  const timeline = installTimeline({
    session,
    byId,
    documentRef: windowRef.document,
    windowRef,
    toast,
    updateTime: () => player?.updateTime(),
    seekPreview: (seconds) => player?.seekPreview(seconds),
    seekToRatio: (ratio) => player?.seekToRatio(ratio),
    paintStageScrub: (percentage) => player?.paintStageScrub(percentage),
    renderClips: () => library?.renderClips(),
    reqPreview: () => {
      legacyCall(windowRef, "reqPreview");
    },
    paintCropOverlay: () => transform?.paintCropOverlay(),
    setPreviewSec: (seconds) => player?.setPreviewSec(seconds),
    getPreviewSec: () => player?.getPreviewSec() ?? null,
    flushVideoSeek: () => player?.flushVideoSeek(),
    AudioTimeline: audio,
    History: history,
    TuckShortcuts: shortcuts,
  });

  player = installPlayer({
    byId,
    clips: () => session.clips,
    selPath: () => session.selPath,
    getMuted: () => session.muted,
    setMuted: (value) => {
      session.muted = value;
    },
    getVolBefore: () => session.volBefore,
    setVolBefore: (value) => {
      session.volBefore = value;
    },
    playbackSegments: () => timeline.playbackSegments(),
    clipSegments: (clip, duration) => timeline.clipSegments(clip, duration),
    videoDuration: () => timeline.videoDuration() ?? 0,
    setPlayheadUI: (seconds, duration) => timeline.setPlayheadUI(seconds, duration),
    Timeline: timeline,
    AudioTimeline: audio,
    syncTimelineUI: () => timeline.syncTimelineUI(),
    document: windowRef.document,
  });

  const backend: Pick<BackendClient, "saveSettings"> = {
    saveSettings: (patch) => getBackendClient().saveSettings(patch),
  };
  panels = installPanels({
    byId,
    document: windowRef.document,
    window: windowRef,
    clips: () => session.clips,
    selPath: () => session.selPath,
    appSettings: session.appSettings,
    backend,
    toast,
    formatTime: (seconds) => {
      const minutes = Math.floor(seconds / 60);
      return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    },
    formatBytes: (bytes) => {
      if (!bytes) return "";
      if (bytes < 1024) return `${bytes} B`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },
    errorSummary: (error, limit = 140) => {
      const normalized = String(error || "Unknown error").replace(/\s+/g, " ").trim();
      return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
    },
    retryProbeClip: (path) => {
      void library?.retryProbeClip(path);
    },
    clipDetails: {
      render: ClipDetails.render,
      sourceFileRows: ClipDetails.sourceFileRows,
    },
    AudioTimeline: {
      selectTrack: audio.selectTrack,
      trackColor: audio.trackColor,
      toggleSourceMute: audio.toggleSourceMute,
      toggleTrackMute: audio.toggleTrackMute,
      setSourceGain: (value) => audio.setSourceGain(Number(value)),
      setTrackGain: (trackId, value) => audio.setTrackGain(trackId, Number(value)),
      removeTrack: audio.removeTrack,
      getSelectedClipRange: panelAudioRange,
      setSelectedSourceIn: (value, finalize) => {
        audio.setSelectedSourceIn(value, finalize);
        return panelAudioRange();
      },
      resetSelectedSource: audio.resetSelectedSource,
    },
    History: history,
  });

  library = createLibrary({
    session,
    documentRef: windowRef.document,
    windowRef,
    audio,
    history,
    applyProfile: (force) => {
      legacyCall(windowRef, "applyProfile", force);
    },
    applySelectedProfileTransform: (clip, force) => {
      legacyCall(windowRef, "applySelectedProfileTransform", clip, force);
    },
    reqPreview: () => {
      legacyCall(windowRef, "reqPreview");
    },
    updateActionButtons: () => {
      legacyCall(windowRef, "updateActionButtons");
    },
    syncFpsToClip: (force) => {
      legacyCall(windowRef, "syncFpsToClip", force);
    },
    syncResolutionToClip: (force) => {
      legacyCall(windowRef, "syncResolutionToClip", force);
    },
    syncExportSummary: () => {
      legacyCall(windowRef, "syncExportSummary");
    },
    syncTransformControls: () => transform.syncTransformControls(),
    paintCropOverlay: () => transform.paintCropOverlay(),
    renderClipDetails: () => panels.renderClipDetails(),
    renderAudioLibraryPanel: () => panels.renderAudioLibraryPanel(),
    syncTimelineUI: () => timeline.syncTimelineUI(),
    togglePlay: () => player.togglePlay(),
    openResult: (path) => {
      legacyCall(windowRef, "openResult", path);
    },
    cancelQueueItem: async (itemId) => {
      await legacyCallAsync(windowRef, "cancelQueueItem", itemId);
    },
    retryQueueItem: async (itemId) => {
      await legacyCallAsync(windowRef, "retryQueueItem", itemId);
    },
    pollQueue: async () => {
      await legacyCallAsync(windowRef, "pollQueue");
    },
    libraryTab: () => panels.getLibraryTab(),
    setInspectorTab: (tab, persist) => panels.setInspectorTab(tab, persist),
  });

  shortcutDialog = installShortcutDialog({
    document: {
      body: windowRef.document.body,
      activeElement:
        windowRef.document.activeElement instanceof HTMLElement
          ? windowRef.document.activeElement
          : null,
      getElementById: (id) =>
        windowRef.document.getElementById(id) as
          | (HTMLElement & { disabled: boolean })
          | null,
      querySelectorAll: (selectors) => windowRef.document.querySelectorAll(selectors),
    },
    addEventListener: (type, listener) => windowRef.addEventListener(type, listener),
    prepareModalBox: (className) => {
      const box = byId("mod-box");
      if (!box) throw new Error("Missing #mod-box");
      box.className = className;
      return box;
    },
    closeMod,
  });
  configureModalHandlers({
    closeMod: () => {
      windowRef.document.getElementById("mod-overlay")?.classList.remove("open");
      shortcutDialog.resetDialog(true);
    },
    prepareModalBox: (className) => {
      shortcutDialog.resetDialog(false);
      const box = byId("mod-box");
      if (!box) throw new Error("Missing #mod-box");
      box.className = className;
      return box;
    },
  });

  function refreshEditor(): void {
    library?.renderClips();
    timeline.syncTimelineUI();
    transform.syncTransformControls();
    transform.paintCropOverlay();
    panels.renderClipDetails();
  }

  function installLegacyStateCompatibility(): void {
    exposeAccessor(windowRef, "api", () => state.api, (value) => {
      state.api = value instanceof Object ? (value as BackendClient) : null;
    });
    exposeAccessor(windowRef, "clips", () => session.clips, (value) => {
      replaceRecord(session.clips, value);
    });
    exposeAccessor(windowRef, "clipOrder", () => session.clipOrder, (value) => {
      replaceArray(session.clipOrder, value);
    });
    exposeAccessor(windowRef, "selPath", () => session.selPath, (value) => {
      session.selPath = typeof value === "string" ? value : null;
    });
    exposeAccessor(windowRef, "allProfiles", () => session.allProfiles, (value) => {
      replaceArray(session.allProfiles, value);
    });
    exposeAccessor(windowRef, "availEncoders", () => session.availEncoders, (value) => {
      replaceArray(session.availEncoders, value);
    });
    exposeAccessor(windowRef, "appSettings", () => session.appSettings, (value) => {
      replaceRecord(session.appSettings, value);
    });
    exposeAccessor(windowRef, "wf", () => state.workflow, (value) => {
      state.workflow = Number(value) || 0;
    });
    exposeAccessor(windowRef, "lastComp", () => state.lastComp, (value) => {
      state.lastComp = typeof value === "string" ? value : "";
    });
    exposeAccessor(windowRef, "lastUpscale", () => state.lastUpscale, (value) => {
      state.lastUpscale = typeof value === "string" ? value : "";
    });
    exposeAccessor(windowRef, "lastQueueHadActive", () => state.lastQueueHadActive, (value) => {
      state.lastQueueHadActive = value === true;
    });
    exposeAccessor(windowRef, "muted", () => session.muted, (value) => {
      session.muted = value === true;
    });
    exposeAccessor(windowRef, "volBefore", () => session.volBefore, (value) => {
      session.volBefore = typeof value === "number" ? value : session.volBefore;
    });
    exposeAccessor(windowRef, "settingsDirty", () => session.settingsDirty, (value) => {
      session.settingsDirty = value === true;
    });
    exposeAccessor(windowRef, "previewRequestId", () => state.previewRequestId, (value) => {
      state.previewRequestId = typeof value === "number" ? value : state.previewRequestId;
    });
  }

  function installLegacyFunctionCompatibility(): void {
    const tuck = windowRef.Tuck ?? {};
    tuck.inspectorUi = InspectorUi;
    tuck.library = { isReordering: library.isReordering };
    windowRef.Tuck = tuck;
    exposeValue(windowRef, "History", history);
    exposeValue(windowRef, "AudioTimeline", audio);
    exposeValue(windowRef, "SegmentEditing", SegmentEditing);
    exposeValue(windowRef, "byId", byId);
    exposeValue(windowRef, "fmtt", formatTime);
    exposeValue(windowRef, "formatBytes", formatBytes);
    exposeValue(windowRef, "errorSummary", errorSummary);
    exposeValue(windowRef, "legacyBackendResult", legacyBackendResult);
    exposeValue(windowRef, "toast", toast);
    exposeValue(windowRef, "confirmToast", confirmToast);
    exposeValue(windowRef, "showMod", showMod);
    exposeValue(windowRef, "closeMod", closeMod);
    exposeValue(windowRef, "addFiles", library.addFiles);
    exposeValue(windowRef, "browse", library.browse);
    exposeValue(windowRef, "removeClip", library.removeClip);
    exposeValue(windowRef, "removeAllClips", library.removeAllClips);
    exposeValue(windowRef, "renderClips", library.renderClips);
    exposeValue(windowRef, "selectClip", library.selectClip);
    exposeValue(windowRef, "retryProbeClip", library.retryProbeClip);
    exposeValue(windowRef, "moveSelection", library.moveSelection);
    exposeValue(windowRef, "toggleWorkspacePanel", panels.toggleWorkspacePanel);
    exposeValue(windowRef, "closeWorkspacePanels", panels.closeWorkspacePanels);
    exposeValue(windowRef, "setLibraryTab", panels.setLibraryTab);
    exposeValue(windowRef, "setInspectorTab", panels.setInspectorTab);
    exposeValue(windowRef, "renderClipDetails", panels.renderClipDetails);
    exposeValue(windowRef, "renderAudioLibraryPanel", panels.renderAudioLibraryPanel);
    exposeValue(windowRef, "togglePlay", player.togglePlay);
    exposeValue(windowRef, "seekBy", player.seekBy);
    exposeValue(windowRef, "stepFrame", player.stepFrame);
    exposeValue(windowRef, "toggleFullscreen", player.toggleFullscreen);
    exposeValue(windowRef, "onStageScrub", player.onStageScrub);
    exposeValue(windowRef, "toggleMute", player.toggleMute);
    exposeValue(windowRef, "setVol", player.setVol);
    exposeValue(windowRef, "setCropAspect", transform.setCropAspect);
    exposeValue(windowRef, "setVideoRotation", transform.setVideoRotation);
    exposeValue(windowRef, "toggleVideoFlip", transform.toggleVideoFlip);
    exposeValue(windowRef, "setSizingMode", transform.setSizingMode);
    exposeValue(windowRef, "resetVideoTransform", transform.resetVideoTransform);
    exposeValue(windowRef, "cropTransformForRequest", transform.cropTransformForRequest);
    exposeValue(windowRef, "addSegment", timeline.addSegment);
    exposeValue(windowRef, "splitAtPlayhead", timeline.splitAtPlayhead);
    exposeValue(windowRef, "removeActiveSegment", timeline.removeActiveSegment);
    exposeValue(windowRef, "resetSegments", timeline.resetSegments);
    exposeValue(windowRef, "toggleSnap", timeline.toggleSnap);
    exposeValue(windowRef, "resetTimelineHeight", timeline.resetTimelineHeight);
    exposeValue(windowRef, "fitTimeline", timeline.fitTimeline);
    exposeValue(windowRef, "nudgeTimelineZoom", timeline.nudgeTimelineZoom);
    exposeValue(windowRef, "openKeyboardShortcuts", shortcutDialog.openDialog);
    exposeValue(windowRef, "resetKeyboardShortcutsDialog", shortcutDialog.resetDialog);
    exposeValue(windowRef, "closeActiveModal", closeActiveModal);
    exposeValue(windowRef, "profileControlState", profileControlState);
    exposeValue(windowRef, "snapProf", snapProf);
    exposeValue(windowRef, "updateDirty", updateDirty);
    exposeValue(windowRef, "resetToProfile", resetToProfile);

    for (const name of [
      "setCropAspect",
      "setVideoRotation",
      "toggleVideoFlip",
      "setSizingMode",
      "resetVideoTransform",
      "addSegment",
      "removeActiveSegment",
      "resetSegments",
      "splitAtPlayhead",
    ]) {
      history.wrap(windowRef, name);
    }
    for (const name of [
      "toggleMaster",
      "toggleSourceMute",
      "toggleFragmentMute",
      "toggleTrackMute",
      "splitSelected",
      "trimSelectedToPlayhead",
      "deleteSelected",
    ]) {
      history.wrap(audio, name);
    }
    history.updateButtons();
  }

  function controlValue(id: string): string {
    const element = byId<HTMLInputElement | HTMLSelectElement>(id);
    return element?.value ?? "";
  }

  function controlChecked(id: string): boolean {
    return byId<HTMLInputElement>(id)?.checked ?? false;
  }

  function profileControlState(): Record<string, string | boolean | number> {
    const clip = session.selPath ? session.clips[session.selPath] : undefined;
    return {
      pid: controlValue("prof-sel"),
      size: controlValue("sz-slider"),
      rm: controlValue("res-mode"),
      rw: controlValue("res-w"),
      rh: controlValue("res-h"),
      fps: controlValue("fps-val"),
      ka: controlChecked("keep-audio"),
      abr: controlValue("audio-br"),
      tp: controlValue("two-pass"),
      pre: controlValue("preset-sel"),
      sc: controlValue("scaler-sel"),
      enc: controlValue("enc-sel"),
      rc: controlValue("rc-sel"),
      q: controlValue("quality-val"),
      br: controlValue("br-val"),
      tu: controlValue("tune-sel"),
      aspect: clip?.cropAspect ?? "off",
      rotation: clip?.rotation ?? 0,
      sizing: clip?.sizingMode ?? "fit",
    };
  }

  function updateDirty(): void {
    if (!profileSnapshot) {
      byId("mod-badge")?.classList.remove("show");
      byId("prof-reset-row")?.classList.add("hid");
      legacyCall(windowRef, "syncExportSummary");
      return;
    }
    const dirty = profileSnapshot !== JSON.stringify(profileControlState());
    byId("mod-badge")?.classList.toggle("show", dirty);
    byId("prof-reset-row")?.classList.toggle("hid", !dirty);
    legacyCall(windowRef, "syncExportSummary");
  }

  function snapProf(): void {
    profileSnapshot = JSON.stringify(profileControlState());
    updateDirty();
  }

  function resetToProfile(): void {
    legacyCall(windowRef, "applyProfile", true);
    snapProf();
    toast("Settings reset to profile.", "ok");
  }

  function installEditorShortcuts(): void {
    shortcuts.registerAction("file.add-videos", () => {
      void library.browse();
    });
    shortcuts.registerAction("settings.open", () => {
      legacyCall(windowRef, "toggleSettings");
    });
    shortcuts.registerAction("app.exit", {
      enabled: () => state.api !== null,
      execute: () => {
        void state.api?.closeWindow();
      },
    });
    shortcuts.registerAction("ui.dismiss", {
      enabled: () =>
        !!windowRef.document.getElementById("mod-overlay")?.classList.contains("open") ||
        windowRef.document.body.classList.contains("settings-open") ||
        audio.hasSelection(),
      execute: () => {
        if (windowRef.document.getElementById("mod-overlay")?.classList.contains("open")) {
          closeActiveModal();
        } else if (windowRef.document.body.classList.contains("settings-open")) {
          legacyCall(windowRef, "closeSettings");
        } else {
          audio.selectVideoTrack();
        }
      },
    });
    shortcuts.registerAction("playback.toggle", {
      enabled: () => session.selPath !== null,
      execute: player.togglePlay,
    });
    shortcuts.registerAction("playback.step-backward", {
      enabled: () => session.selPath !== null,
      execute: () => player.stepFrame(-1),
    });
    shortcuts.registerAction("playback.step-forward", {
      enabled: () => session.selPath !== null,
      execute: () => player.stepFrame(1),
    });
    shortcuts.registerAction("playback.seek-backward", {
      enabled: () => session.selPath !== null,
      execute: () => player.seekBy(-3),
    });
    shortcuts.registerAction("playback.seek-forward", {
      enabled: () => session.selPath !== null,
      execute: () => player.seekBy(3),
    });
    shortcuts.registerAction("playback.seek-start", {
      enabled: () => session.selPath !== null,
      execute: () => player.seekPreview(0),
    });
    shortcuts.registerAction("playback.seek-end", {
      enabled: () => session.selPath !== null,
      execute: () => player.seekPreview(timeline.videoDuration() ?? 0),
    });
    shortcuts.registerAction("media.select-previous", {
      enabled: () => session.selPath !== null,
      execute: () => library.moveSelection(-1),
    });
    shortcuts.registerAction("media.select-next", {
      enabled: () => session.selPath !== null,
      execute: () => library.moveSelection(1),
    });
  }

  function installFileDropHandlers(): void {
    let dragDepth = 0;
    const isFileDrag = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const overlay = byId("drag-overlay");
    const dropZone = byId("drop-z");
    windowRef.document.body.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth += 1;
      overlay?.classList.add("show");
    });
    windowRef.document.body.addEventListener("dragover", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      overlay?.classList.add("show");
    });
    windowRef.document.body.addEventListener("dragleave", (event) => {
      if (!isFileDrag(event) && dragDepth === 0) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay?.classList.remove("show");
    });
    windowRef.document.body.addEventListener("drop", (event) => {
      dragDepth = 0;
      overlay?.classList.remove("show");
      dropZone?.classList.remove("over");
      if (isFileDrag(event)) event.preventDefault();
    });
    dropZone?.addEventListener("dragover", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dropZone.classList.add("over");
    });
    dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("over"));
    dropZone?.addEventListener("drop", (event) => {
      event.preventDefault();
      dropZone.classList.remove("over");
    });
  }

  async function startApp(): Promise<void> {
    if (started || !legacyShellReady || !state.api || !pendingLaunch) return;
    started = true;
    const launch = pendingLaunch;
    pendingLaunch = null;
    legacyCall(windowRef, "updateSizePresets", 10);
    try {
      await legacyCallAsync(windowRef, "loadSettings");
      panels.setInspectorTab(
        InspectorUi.startupTab(
          String(session.appSettings.inspector_start_panel ?? ""),
          String(session.appSettings.last_inspector_panel ?? ""),
        ),
        false,
      );
    } catch {
      toast("Could not load settings.", "err");
    }
    if (session.appSettings.check_updates !== false) void checkUpdates(true);
    if (Reflect.get(windowRef, "queueTimer") === null) {
      const timer = windowRef.setInterval(() => {
        void legacyCallAsync(windowRef, "pollQueue");
        void legacyCallAsync(windowRef, "pollIpc");
      }, 500);
      Reflect.set(windowRef, "queueTimer", timer);
    }
    const files = launch.files?.filter((file): file is string => typeof file === "string") ?? [];
    if (files.length) library.addFiles(files);
    if (launch.sendto !== undefined) legacyCall(windowRef, "handleSendto", launch.sendto);
  }

  function initApp(data: unknown): void {
    pendingLaunch = launchData(data);
    void startApp();
  }

  function attachBackendClient(client: BackendClient): void {
    state.api = client;
    void startApp();
  }

  installLegacyStateCompatibility();
  installLegacyFunctionCompatibility();
  installEditorShortcuts();
  installFileDropHandlers();
  exposeValue(windowRef, "handleIpcMeta", (data: unknown) => {
    legacyCall(windowRef, "handleSendto", data);
  });
  exposeValue(windowRef, "handleSendto", (data: unknown) => {
    const profileId = isRecord(data) && typeof data.profile_id === "string" ? data.profile_id : "";
    if (profileId) {
      const select = byId<HTMLSelectElement>("prof-sel");
      if (select) select.value = profileId;
      legacyCall(windowRef, "onProfileChange");
    }
  });

  return {
    activateLegacyShell() {
      legacyShellReady = true;
      void startApp();
    },
    attachBackendClient,
    initApp,
    session,
  };
}
