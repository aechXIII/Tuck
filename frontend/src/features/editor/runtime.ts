import { getBackendClient, hasBackendClient } from "../../backend/client.ts";
import type { BackendClient } from "../../backend/types.ts";
import {
  bindDelegatedEvents,
  type DelegatedHandlers,
} from "../../ui/delegated-events.ts";
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
import {
  installEncodingControls,
  type EncodingControlsApi,
} from "../export/encoding-controls.ts";
import { installQueue, type QueueApi } from "../queue/queue.ts";
import { installSettings, type SettingsApi } from "../settings/settings.ts";
import { checkUpdates, checkUpdatesFromSettings } from "./updates.ts";
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
import type { EditorClip } from "./types.ts";
import type { Segment } from "../../types/foundation.ts";

interface LaunchData {
  readonly files?: readonly unknown[];
  readonly sendto?: unknown;
}

export interface EditorRuntime {
  start(): void;
  attachBackendClient(): void;
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

function launchData(value: unknown): LaunchData {
  return isRecord(value) ? value : {};
}

export function installEditorRuntime(
  windowRef: Window & typeof globalThis = window,
): EditorRuntime {
  const session = createEditorSession();
  let started = false;
  let shellReady = false;
  let backendReady = false;
  let pendingLaunch: LaunchData | null = null;

  let history: HistoryApi;
  let library: LibraryApi;
  let panels: PanelsApi;
  let player: PlayerApi;
  let transform: TransformApi;
  let shortcuts: ShortcutsApi;
  let shortcutDialog: ShortcutDialogApi;
  let encoding: EncodingControlsApi;
  let queue: QueueApi;
  let settings: SettingsApi;

  const requestPreview = (): void => {
    void encoding?.reqPreview();
  };

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
    reqPreview: requestPreview,
  });

  const audio = installAudioTimeline({
    session,
    byId,
    documentRef: windowRef.document,
    windowRef,
    toast,
    setInspectorTab: (tab, persist) => panels?.setInspectorTab(tab, persist),
    renderClips: () => library?.renderClips(),
    reqPreview: requestPreview,
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
    reqPreview: requestPreview,
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

  const settingsBackend: Pick<BackendClient, "saveSettings"> = {
    saveSettings: (patch) => getBackendClient().saveSettings(patch),
  };
  panels = installPanels({
    byId,
    document: windowRef.document,
    window: windowRef,
    clips: () => session.clips,
    selPath: () => session.selPath,
    appSettings: session.appSettings,
    backend: settingsBackend,
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
    applyProfile: (force) => encoding?.applyProfile(force),
    applySelectedProfileTransform: (clip, force) =>
      encoding?.applySelectedProfileTransform(clip, force),
    reqPreview: requestPreview,
    updateActionButtons: () => encoding?.updateActionButtons(),
    syncFpsToClip: (force) => encoding?.syncFpsToClip(force),
    syncResolutionToClip: (force) => encoding?.syncResolutionToClip(force),
    syncExportSummary: () => encoding?.syncExportSummary(),
    syncTransformControls: () => transform.syncTransformControls(),
    paintCropOverlay: () => transform.paintCropOverlay(),
    renderClipDetails: () => panels.renderClipDetails(),
    renderAudioLibraryPanel: () => panels.renderAudioLibraryPanel(),
    syncTimelineUI: () => timeline.syncTimelineUI(),
    togglePlay: () => player.togglePlay(),
    openResult: (path) => {
      void queue?.openResult(path);
    },
    cancelQueueItem: async (itemId) => {
      await queue?.cancelQueueItem(itemId);
    },
    retryQueueItem: async (itemId) => {
      await queue?.retryQueueItem(itemId);
    },
    pollQueue: async () => {
      await queue?.pollQueue();
    },
    libraryTab: () => panels.getLibraryTab(),
    setInspectorTab: (tab, persist) => panels.setInspectorTab(tab, persist),
  });

  queue = installQueue({
    session,
    byId,
    getBackendClient,
    renderClips: () => library.renderClips(),
    removeClip: (path) => library.removeClip(path),
    isReordering: () => library.isReordering(),
    workflow: () => encoding?.workflow() ?? 0,
    addFiles: (files) => library.addFiles(files),
    onSendto: (data) => handleSendto(data),
  });

  encoding = installEncodingControls({
    session,
    byId,
    getBackendClient,
    syncTransformControls: () => transform.syncTransformControls(),
    paintCropOverlay: () => transform.paintCropOverlay(),
    cropTransformForRequest: (clip) => transform.cropTransformForRequest(clip),
    restoreTimelineHeight: (value) => timeline.restoreTimelineHeight(value),
    orderedClipKeys: () => library.orderedClipKeys(),
    audioRequestPayload: (clip) =>
      audio.requestPayload(clip) as Record<string, unknown>,
    pollQueue: () => queue.pollQueue(),
  });

  settings = installSettings({
    session,
    byId,
    getBackendClient,
    reloadEditorSettings: () => encoding.loadSettings(),
    setAvailableEncoders: (encoders) => encoding.setAvailableEncoders(encoders),
    copyDiagnostics: () => queue.copyDiagnostics(),
    checkForUpdates: () => checkUpdatesFromSettings(),
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

  for (const name of [
    "setCropAspect",
    "setVideoRotation",
    "toggleVideoFlip",
    "setSizingMode",
    "resetVideoTransform",
  ]) {
    history.wrap(transform, name);
  }
  for (const name of [
    "addSegment",
    "removeActiveSegment",
    "resetSegments",
    "splitAtPlayhead",
  ]) {
    history.wrap(timeline, name);
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

  function refreshEditor(): void {
    library?.renderClips();
    timeline.syncTimelineUI();
    transform.syncTransformControls();
    transform.paintCropOverlay();
    panels.renderClipDetails();
  }

  function handleSendto(data: unknown): void {
    const profileId =
      isRecord(data) && typeof data.profile_id === "string" ? data.profile_id : "";
    if (!profileId) return;
    const select = byId<HTMLSelectElement>("prof-sel");
    if (select) select.value = profileId;
    encoding.onProfileChange();
  }

  function numericValue(target: HTMLElement): number {
    return Number(target.dataset.actionValue);
  }

  function installActionBindings(): void {
    const handlers: DelegatedHandlers = {
      click: {
        "workspace-toggle": (target) =>
          panels.toggleWorkspacePanel(
            (target.dataset.actionValue ?? "") as never,
          ),
        "workspace-close-panels": () => panels.closeWorkspacePanels(true),
        "history-undo": () => history.undo(),
        "history-redo": () => history.redo(),
        "shortcuts-open": () => shortcutDialog.openDialog(),
        "settings-toggle": () => settings.toggle(),
        "settings-open-profiles": () => void settings.open("profiles"),
        "library-tab": (target) => panels.setLibraryTab(target.dataset.actionValue ?? ""),
        "inspector-tab": (target) => panels.setInspectorTab(target.dataset.actionValue ?? ""),
        "browse-videos": () => void library.browse(),
        "remove-all-clips": () => library.removeAllClips(),
        "browse-audio": () => void audio.browse(),
        "player-step-frame": (target) => player.stepFrame(numericValue(target)),
        "player-toggle-play": () => player.togglePlay(),
        "player-toggle-mute": () => player.toggleMute(),
        "player-fullscreen": () => player.toggleFullscreen(),
        "transform-crop-aspect": (target) =>
          transform.setCropAspect(target.dataset.aspect ?? "off"),
        "transform-rotation": (target) =>
          transform.setVideoRotation(Number(target.dataset.rotation)),
        "transform-flip": (target) =>
          transform.toggleVideoFlip(
            (target.dataset.actionValue as "horizontal" | "vertical") ?? "horizontal",
          ),
        "transform-sizing": (target) =>
          transform.setSizingMode(target.dataset.sizing ?? "fit"),
        "transform-reset-all": () => transform.resetVideoTransform(),
        "audio-toggle-master": () => audio.toggleMaster(),
        "audio-toggle-fragment-mute": () => audio.toggleFragmentMute(),
        "audio-toggle-source-mute": () => audio.toggleSourceMute(),
        "encoding-workflow": (target) => encoding.setWf(numericValue(target)),
        "encoding-save-profile": () => void encoding.saveProfileChanges(),
        "encoding-save-profile-as": () => void encoding.saveProfileAs(),
        "encoding-reset-profile": () => encoding.resetToProfile(),
        "encoding-toggle-advanced": () => encoding.toggleAdvanced(),
        "encoding-run-selected": () => void encoding.compressOne(),
        "encoding-run-all": () => void encoding.compressAll(),
        "timeline-add-segment": () => timeline.addSegment(),
        "timeline-split": () => timeline.splitAtPlayhead(),
        "timeline-remove-segment": () => timeline.removeActiveSegment(),
        "timeline-reset-segments": () => timeline.resetSegments(),
        "timeline-toggle-snap": () => timeline.toggleSnap(),
        "timeline-reset-height": (_target, event) =>
          timeline.resetTimelineHeight(event as MouseEvent),
        "timeline-fit": () => timeline.fitTimeline(),
        "timeline-nudge-zoom": (target) => timeline.nudgeTimelineZoom(numericValue(target)),
        "queue-stop-after-current": () => queue.stopAfterCurrent(),
        "queue-cancel-all": () => queue.cancelAll(),
        "queue-clear-completed": () => void queue.clearDone(),
        "modal-close-overlay": (target, event) => {
          if (event.target === target) closeActiveModal();
        },
      },
      input: {
        "player-scrub": (target) => player.onStageScrub((target as HTMLInputElement).value),
        "player-volume": (target) => player.setVol((target as HTMLInputElement).value),
        "encoding-target-size": (target) =>
          encoding.onSize((target as HTMLInputElement).value),
        "encoding-frame-rate": (target) =>
          encoding.onFpsSlider((target as HTMLInputElement).value),
        "timeline-zoom": (target) =>
          timeline.setTimelineZoom(Number((target as HTMLInputElement).value)),
      },
      change: {
        "encoding-profile": () => encoding.onProfileChange(),
        "encoding-badge-size": (target) =>
          encoding.onBadgeSize((target as HTMLInputElement).value),
        "encoding-source-resolution": () => encoding.onUseSourceResolution(),
        "encoding-resolution": () => encoding.onResolutionGeometryChanged(),
        "encoding-resolution-facade": (target) =>
          encoding.onExportResolutionChoice((target as HTMLSelectElement).value),
        "encoding-preview-dirty": () => encoding.reqPreviewAndDirty(),
        "encoding-source-fps": () => encoding.onUseSourceFps(),
        "encoding-frame-rate-facade": (target) =>
          encoding.onExportFrameRateChoice((target as HTMLSelectElement).value),
        "encoding-keep-audio": () => encoding.onKeepAudio(),
        "encoding-encoder": () => encoding.onEncChange(),
        "encoding-speed": () => encoding.onSpeedChange(),
        "encoding-two-pass": () => encoding.onTwoPassChange(),
        "encoding-native-preset": () => encoding.onNativePresetChange(),
        "encoding-rate-control": () => encoding.onRcChange(),
      },
    };
    bindDelegatedEvents(windowRef.document.body, handlers);
  }

  function installEditorShortcuts(): void {
    shortcuts.registerAction("file.add-videos", () => {
      void library.browse();
    });
    shortcuts.registerAction("settings.open", () => {
      settings.toggle();
    });
    shortcuts.registerAction("app.exit", {
      enabled: () => hasBackendClient(),
      execute: () => {
        if (hasBackendClient()) void getBackendClient().closeWindow();
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
          settings.close();
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

  let queueTimer: number | null = null;

  async function startApp(): Promise<void> {
    if (started || !shellReady || !backendReady || !pendingLaunch) return;
    started = true;
    const launch = pendingLaunch;
    pendingLaunch = null;
    encoding.updateSizePresets(10);
    try {
      await encoding.loadSettings();
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
    if (queueTimer === null) {
      queueTimer = windowRef.setInterval(() => {
        void queue.pollQueue();
        void queue.pollIpc();
      }, 500);
    }
    const files =
      launch.files?.filter((file): file is string => typeof file === "string") ?? [];
    if (files.length) library.addFiles(files);
    if (launch.sendto !== undefined && launch.sendto !== null) handleSendto(launch.sendto);
  }

  function initApp(data: unknown): void {
    pendingLaunch = launchData(data);
    void startApp();
  }

  function attachBackendClient(): void {
    backendReady = true;
    void startApp();
  }

  installActionBindings();
  installEditorShortcuts();
  installFileDropHandlers();

  return {
    start() {
      shellReady = true;
      void startApp();
    },
    attachBackendClient,
    initApp,
    session,
  };
}

export type { EditorClip };
export { formatBytes, formatTime, errorSummary, showMod, closeMod, confirmToast, SegmentEditing };
