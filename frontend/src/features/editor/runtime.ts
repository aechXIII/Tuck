import { installPanelScrollSpacing } from "../../ui/panel-scroll-spacing.ts";
import { installFocusRings } from "../../ui/focus-rings.ts";
import { installSelectControls } from "../../ui/select.ts";
import { selectGuidance } from "../export/select-guidance.ts";
import { getBackendClient, hasBackendClient } from "../../backend/client.ts";
import { hasTauriInvoke } from "../../backend/index.ts";
import type { BackendClient } from "../../backend/types.ts";
import {
  bindDelegatedEvents,
  type DelegatedHandlers,
} from "../../ui/delegated-events.ts";
import * as InspectorUi from "../panels/inspector-ui.ts";
import { installAudioTimeline } from "../audio/audio-timeline.ts";
import {
  formatSourceTime,
  sourceRangeDetailDragValue,
  sourceRangeDetailState,
  sourceRangeKeyboardValue,
  sourceRangePointerValue,
} from "../audio/audio-core.ts";
import { installHistory, type HistoryApi } from "../history/history.ts";
import * as ClipDetails from "../library/clip-details.ts";
import { createLibrary, type LibraryApi } from "../library/library.ts";
import { installPanels, type PanelsApi } from "../panels/panels.ts";
import type { AudioClipRangeInfo } from "../panels/panels.ts";
import { installPlayer, type PlayerApi, type PlayerHost } from "../player/player.ts";
import { installNativePlayer } from "../player/native-player.ts";
import { createTauriPlayerEngine } from "../../backend/native-player.ts";
import { installFrameExport } from "../player/frame-export.ts";
import { isProbeReady } from "../../state/probe.ts";
import {
  installShortcutDialog,
  type ShortcutDialogApi,
} from "../shortcuts/shortcuts-dialog.ts";
import { installShortcuts, type ShortcutsApi } from "../shortcuts/shortcuts.ts";
import { installTimeline } from "../timeline/timeline.ts";
import { cutPointNear, SegmentEditing } from "../timeline/segments.ts";
import { installTransform, type TransformApi } from "../transform/transform.ts";
import {
  installEncodingControls,
  type EncodingControlsApi,
} from "../export/encoding-controls.ts";
import { segmentsAtExportedStarts } from "../timeline/cut-starts.ts";
import { installQueue, type QueueApi } from "../queue/queue.ts";
import { installSettings, type SettingsApi } from "../settings/settings.ts";
import { checkUpdates, checkUpdatesFromSettings } from "./updates.ts";
import { routeDroppedPaths } from "./drop-routing.ts";
import { fetchPlatformCapabilities, shouldShowUpdater } from "../../platform/capabilities.ts";
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
import { hiddenParts } from "../settings/visibility.ts";
import { applyAppearance, createInterfaceSizer } from "../appearance/appearance.ts";
import { createSessionFiles } from "../library/session-files.ts";
import { timeFormat } from "./time-format.ts";
import { onShortcutsChanged, setShortcutOverrides, syncShortcutHints } from "../shortcuts/shortcuts.ts";

interface LaunchData {
  readonly files?: readonly unknown[];
  readonly sendto?: unknown;
  // the Export task a Send To shortcut asked for
  readonly task?: "compression" | "upscale" | "cut" | null;
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
  installPanelScrollSpacing(windowRef.document);
  installFocusRings(windowRef.document);
  const selects = installSelectControls(windowRef.document, selectGuidance);
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
  let frameExport: ReturnType<typeof installFrameExport> | undefined;

  const requestPreview = (): void => {
    void encoding?.reqPreview();
  };

  const resizeInterface = createInterfaceSizer((size) => getBackendClient().setInterfaceSize(size));
  const sessionFiles = createSessionFiles({
    enabled: () => session.appSettings.reopen_last_videos === true,
    save: async (paths) => {
      const result = await getBackendClient().saveSettings({ last_session_files: [...paths] });
      if (result.ok) session.appSettings.last_session_files = [...paths];
    },
    schedule: (run, delay) => windowRef.setTimeout(run, delay),
    cancel: (handle) => windowRef.clearTimeout(handle as number),
  });

  // the look, size, and time format come from Settings and apply as soon as they are saved
  function applyPreferences(): void {
    applyAppearance(windowRef.document.documentElement, session.appSettings);
    void resizeInterface(session.appSettings.interface_size);
    player?.updateTime();
    timeline.refreshFrames();
  }

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

  // Undo and Redo stay focusable when there is nothing to do, so their tooltip can say so;
  // aria-disabled marks them unavailable, and a press then does nothing
  function historyButton(id: string): { disabled: boolean } | null {
    const button = byId<HTMLButtonElement>(id);
    if (!button) return null;
    return {
      get disabled() {
        return button.getAttribute("aria-disabled") === "true";
      },
      set disabled(value: boolean) {
        button.disabled = false;
        button.setAttribute("aria-disabled", String(value));
      },
    };
  }

  history = installHistory(
    {
      getClip: (path) => session.clips[path],
      selectedPath: () => session.selPath,
      refreshUiForClip: () => refreshEditor(),
      undoButton: () => historyButton("btn-undo"),
      redoButton: () => historyButton("btn-redo"),
      labelButtons: (undo, redo) => {
        const steps = [["btn-undo", "Undo", undo], ["btn-redo", "Redo", redo]] as const;
        for (const [id, verb, step] of steps) {
          const button = byId<HTMLButtonElement>(id);
          if (!button) continue;
          // an empty history keeps teaching the key; the dimmed, aria-disabled button says the rest
          const label = step ? `${verb} ${step}` : verb;
          button.dataset.shortcutLabel = label;
          button.setAttribute("aria-label", label);
          if (button.parentElement) syncShortcutHints(button.parentElement);
        }
      },
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
    cutTask: () => encoding?.workflow() === 2,
    byId,
    documentRef: windowRef.document,
    windowRef,
    toast,
    setInspectorTab: (tab, persist) => panels?.setInspectorTab(tab, persist),
    renderClips: () => library?.renderClips(),
    reqPreview: requestPreview,
    getPreviewSec: () => player?.getPreviewSec() ?? null,
    getTimelineTime: () => player?.timelineTime() ?? 0,
    isPlaying: () => player?.isPlaying() ?? false,
    seekPreview: (seconds) => player?.seekPreview(seconds),
    setClipSegments: (clip, segments, active) =>
      timeline?.setClipSegments(clip, segments.filter(isSegment), active),
    paintTrimChrome: () => timeline?.paintTrimChrome(),
    syncTimelineTrackCount: (count) => timeline?.syncTimelineTrackCount(count),
    renderAudioMixerList: () => panels?.renderAudioMixerList(),
    segmentColor: (index) => timeline?.segmentColor(index) ?? "var(--seg-fill)",
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
    renderClips: () => library?.renderClips(),
    reqPreview: requestPreview,
    paintCropOverlay: () => transform?.paintCropOverlay(),
    setPreviewSec: (seconds) => player?.setPreviewSec(seconds),
    getPreviewSec: () => player?.getPreviewSec() ?? null,
    flushVideoSeek: () => player?.flushVideoSeek(),
    cutTask: () => encoding?.workflow() === 2,
    timeFormat: () => timeFormat(session.appSettings.time_format),
    showCutRow: (index, time) => {
      timeline.selectSegment(index, false);
      player.seekPreview(time);
      encoding.focusCutRow(index);
    },
    AudioTimeline: audio,
    History: history,
    TuckShortcuts: shortcuts,
  });

  const playerHost: PlayerHost = {
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
    setPreviewGap: (gap) => {
      byId("stage")?.classList.toggle("timeline-gap", gap);
      const caption = byId("timeline-gap-caption");
      if (caption) caption.hidden = !gap;
      frameExport?.sync();
    },
    loopPlayback: () => session.appSettings.loop_playback !== false,
    document: windowRef.document,
  };
  player = installPlayer(playerHost);

  const settingsBackend: Pick<BackendClient, "saveSettings"> = {
    saveSettings: (patch) => getBackendClient().saveSettings(patch),
  };

  // the timeline's Snap and Keyframes switches are kept for the next launch
  function rememberTimelineToggle(patch: {timeline_snap?: boolean; timeline_keyframes?: boolean}): void {
    Object.assign(session.appSettings, patch);
    void settingsBackend.saveSettings(patch).then((result) => {
      if (!result.ok) toast("Could not remember the timeline setting.", "err");
    });
  }
  panels = installPanels({
    byId,
    document: windowRef.document,
    window: windowRef,
    timelineBesideInspector: () => encoding?.workflow() === 2,
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
      sourceSummary: ClipDetails.sourceSummary,
    },
    AudioTimeline: {
      selectTrack: audio.selectTrack,
      trackColor: audio.trackColor,
      toggleSourceMute: audio.toggleSourceMute,
      toggleTrackMute: audio.toggleTrackMute,
      toggleSourceTrackMute: audio.toggleSourceTrackMute,
      setSourceGain: (value) => audio.setSourceGain(Number(value)),
      setSourceTrackGain: (streamIndex, value) =>
        audio.setSourceTrackGain(streamIndex, Number(value)),
      setTrackGain: (trackId, value) => audio.setTrackGain(trackId, Number(value)),
      removeTrack: audio.removeTrack,
      getSelectedClipRange: panelAudioRange,
      setSelectedSourceIn: (value, finalize) => {
        audio.setSelectedSourceIn(value, finalize);
        return panelAudioRange();
      },
      resetSelectedSource: audio.resetSelectedSource,
    },
    // pure source-range math the audio Inspector's Overview/Detail picker needs;
    // without it renderAudioClipRange bails before sizing the window or wiring drag
    AudioEditing: {
      formatSourceTime,
      sourceRangeDetailState,
      sourceRangeDetailDragValue,
      sourceRangePointerValue,
      sourceRangeKeyboardValue,
    },
    History: history,
  });

  library = createLibrary({
    session,
    documentRef: windowRef.document,
    windowRef,
    audio,
    history,
    libraryChanged: (paths) => {
      if (started) sessionFiles.track(paths);
    },
    applyProfile: (force) => encoding?.applyProfile(force),
    applySelectedProfileTransform: (clip, force) =>
      encoding?.applySelectedProfileTransform(clip, force),
    reqPreview: requestPreview,
    planLibrary: () => void encoding?.planLibrary(),
    task: () => encoding?.task() ?? "compression",
    updateActionButtons: () => encoding?.updateActionButtons(),
    syncFpsToClip: (force) => encoding?.syncFpsToClip(force),
    syncResolutionToClip: (force) => encoding?.syncResolutionToClip(force),
    syncExportSummary: () => encoding?.syncExportSummary(),
    syncTransformControls: () => transform.syncTransformControls(),
    paintCropOverlay: () => transform.paintCropOverlay(),
    renderClipDetails: () => panels.renderClipDetails(),
    syncTimelineUI: () => timeline.syncTimelineUI(),
    togglePlay: () => player.togglePlay(),
    openResult: (path) => {
      void queue?.openResult(path);
    },
    retryQueueItem: async (itemId) => {
      await queue?.retryQueueItem(itemId);
    },
    pollQueue: async () => {
      await queue?.pollQueue();
    },
    setInspectorTab: (tab, persist) => panels.setInspectorTab(tab, persist),
    openMediaSettings: () => void settings.open("media"),
  });

  queue = installQueue({
    session,
    byId,
    getBackendClient,
    renderClips: () => { library.renderClips(); encoding?.updateActionButtons(); },
    isReordering: () => library.isReordering(),
    workflow: () => encoding?.workflow() ?? 0,
    addFiles: (files) => library.addFiles(files),
    removeClip: (path) => library.removeClip(path),
    editCount: (path) => history.editCount(path),
    onSendto: (data) => handleSendto(data),
  });

  let workspaceCutTask = false;

  encoding = installEncodingControls({
    session,
    byId,
    getBackendClient,
    syncFrameExport: () => frameExport?.sync(),
    syncSelects: () => selects.sync(windowRef.document),
    syncTransformControls: () => transform.syncTransformControls(),
    paintCropOverlay: () => transform.paintCropOverlay(),
    cropTransformForRequest: (clip) => transform.cropTransformForRequest(clip),
    restoreTimelineHeight: (value) => timeline.restoreTimelineHeight(value),
    orderedClipKeys: () => library.orderedClipKeys(),
    audioRequestPayload: (clip) =>
      audio.requestPayload(clip) as Record<string, unknown>,
    selectCutSegment: (index, time) => {
      timeline.selectSegment(index, false);
      player.seekPreview(SegmentEditing.timelineTimeAt(timeline.playbackSegments(), time, index));
    },
    moveCutStarts: (clip,plan) => {
      const moved = segmentsAtExportedStarts(clip,plan,clip.probeData?.duration ?? 0);
      if (!moved.ok) {
        toast(moved.message,"err");
        return false;
      }
      history.action(clip.path,() => {
        timeline.setClipSegments(clip,moved.segments,clip.activeSegment);
      },"move to keyframes");
      timeline.syncTimelineUI();
      audio.render();
      library.renderClips();
      return true;
    },
    pollQueue: () => queue.pollQueue(),
    showExport: (itemId) => queue.showExport(itemId),
    renderClips: () => library.renderClips(),
    paintCutTimeline: () => {
      timeline.paintCutOverlay();
      const cutTask = encoding?.workflow() === 2;
      if (cutTask !== workspaceCutTask) {
        workspaceCutTask = cutTask;
        panels?.applyWorkspacePanels();
        // segment and audio track labels say whether mutes apply to the current task
        timeline.syncTimelineUI();
      }
    },
  });

  settings = installSettings({
    session,
    byId,
    getBackendClient,
    syncSelects: () => selects.sync(windowRef.document),
    reloadEditorSettings: async (preserveExportSettings = false) => {
      await encoding.loadSettings(preserveExportSettings);
      panels.applyVisibility(hiddenParts(session.appSettings.hidden_ui));
      applyPreferences();
      sessionFiles.sync(library.orderedClipKeys());
      library.noticeMissingTools();
      library.renderClips();
    },
    setAvailableEncoders: (encoders) => encoding.setAvailableEncoders(encoders),
    copyDiagnostics: () => queue.copyDiagnostics(),
    checkForUpdates: () => checkUpdatesFromSettings(),
    showShortcutGuide: () => shortcutDialog.openDialog(),
  });

  selects.sync(windowRef.document);

  shortcutDialog = installShortcutDialog({
    document: {
      body: windowRef.document.body,
      get activeElement() {
        const active = windowRef.document.activeElement;
        return active instanceof HTMLElement ? active : null;
      },
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
    changeShortcuts: () => void settings.open("keyboard"),
  });
  // buttons show the keys the user chose, and follow any later change
  onShortcutsChanged(() => syncShortcutHints(windowRef.document));
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

  history.updateButtons();

  frameExport = installFrameExport({
    byId,
    notify: toast,
    client: getBackendClient,
    ready: () => isProbeReady(session.selPath ? session.clips[session.selPath] : null) && player.sourceTime() != null,
    capture: () => {
      const clip = session.selPath ? session.clips[session.selPath] : undefined;
      if (!clip || !isProbeReady(clip) || player.sourceTime() == null) return null;
      const crop = transform.cropTransformForRequest(clip);
      return {
        source: clip.path,
        name: clip.name,
        time: player.captureFrameTime(),
        ...(crop ? { transform: crop } : {}),
        lut: encoding.readLut(),
      };
    },
  });

  function refreshEditor(): void {
    library?.renderClips();
    timeline.syncTimelineUI();
    transform.syncTransformControls();
    transform.paintCropOverlay();
    panels.renderClipDetails();
    requestPreview();
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
        "inspector-tab": (target) => panels.setInspectorTab(target.dataset.actionValue ?? ""),
        "browse-videos": () => void library.browse(),
        "remove-all-clips": () => library.removeAllClips(),
        "browse-audio": () => void audio.browse(),
        "player-step-frame": (target) => player.stepFrame(numericValue(target)),
        "player-toggle-play": () => player.togglePlay(),
        "player-toggle-mute": () => player.toggleMute(),
        "player-fullscreen": () => player.toggleFullscreen(),
        "player-save-frame": () => void frameExport?.save(),
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
        "profile-menu-toggle": () => encoding.toggleProfileMenu(),
        "profile-choose": (target) => encoding.chooseProfile(target.dataset.profileId ?? ""),
        "encoding-toggle-advanced": () => encoding.toggleAdvanced(),
        "encoding-run-selected": () => void encoding.compressOne(),
        "encoding-run-all": () => void encoding.compressAll(),
        "encoding-run-copy": () => void encoding.compressCopy(),
        "playback-speed-reset": () => player.resetSpeed(),
        "timeline-add-segment": () => timeline.addSegment(),
        "timeline-keyframe": (target) => timeline.seekToKeyframe(numericValue(target) < 0 ? -1 : 1),
        "cut-set-point": (target) =>
          timeline.trimActiveSegmentToPlayhead(target.dataset.actionValue === "end" ? "end" : "start"),
        "cut-go-point": (target) => timeline.goToCutPoint(target.dataset.actionValue === "end" ? "end" : "start"),
        "timeline-split": () => timeline.splitAtPlayhead(),
        "timeline-remove-segment": () => timeline.removeActiveSegment(),
        "timeline-reset-segments": () => timeline.resetSegments(),
        "timeline-toggle-snap": () => rememberTimelineToggle({timeline_snap:timeline.toggleSnap()}),
        "timeline-toggle-keyframes": () => rememberTimelineToggle({timeline_keyframes:timeline.toggleKeyframes()}),
        "timeline-reset-height": (_target, event) =>
          timeline.resetTimelineHeight(event as MouseEvent),
        "timeline-fit": () => timeline.fitTimeline(),
        "timeline-nudge-zoom": (target) => timeline.nudgeTimelineZoom(numericValue(target)),
        "queue-stop-after-current": () => queue.stopAfterCurrent(),
        "queue-cancel-all": () => queue.cancelAll(),
        "queue-clear-completed": () => void queue.clearDone(),
        "exports-toggle": () => queue.toggleExports(),
        "export-item-cancel": (target) => void queue.cancelQueueItem(target.dataset.itemId ?? ""),
        "export-item-retry": (target) => void queue.retryQueueItem(target.dataset.itemId ?? ""),
        "export-item-show": (target) => void queue.openResult(target.dataset.resultPath ?? ""),
        "export-item-copy-file": (target) => void queue.copyResult(target.dataset.itemId ?? ""),
        "export-item-copy-details": (target) => void queue.copyDiagnostics(target.dataset.itemId ?? ""),
        "export-item-remove": (target) => void queue.removeQueueItem(target.dataset.itemId ?? ""),
        "modal-close-overlay": (target, event) => {
          if (event.target === target) closeActiveModal();
        },
      },
      input: {
        "encoding-resolution": () => encoding.onResolutionGeometryChanged(),
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
        "encoding-resolution-facade": (target) =>
          encoding.onExportResolutionChoice((target as HTMLSelectElement).value),
        "encoding-preview-dirty": () => encoding.reqPreviewAndDirty(),
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
    // the same removal as the card's remove button, so Undo and kept edits work the same way
    shortcuts.registerAction("media.remove-current", {
      enabled: () => session.selPath !== null,
      execute: () => {
        if (session.selPath) library.removeClip(session.selPath);
      },
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
      execute: () => player.togglePlay(),
    });
    shortcuts.registerAction("playback.save-frame", {
      enabled: () => frameExport?.available() ?? false,
      execute: () => void frameExport?.save(),
    });
    shortcuts.registerAction("playback.step-backward", {
      enabled: () => session.selPath !== null,
      execute: () => player.stepFrame(-1),
    });
    shortcuts.registerAction("playback.step-forward", {
      enabled: () => session.selPath !== null,
      execute: () => player.stepFrame(1),
    });
    // the skip length is a setting; anything unexpected falls back to 3 seconds
    const skipSeconds = (): number => {
      const value = Number(session.appSettings.skip_seconds);
      return [1, 3, 5, 10].includes(value) ? value : 3;
    };
    shortcuts.registerAction("playback.seek-backward", {
      enabled: () => session.selPath !== null,
      execute: () => player.seekBy(-skipSeconds()),
    });
    shortcuts.registerAction("playback.seek-forward", {
      enabled: () => session.selPath !== null,
      execute: () => player.seekBy(skipSeconds()),
    });
    for (const [command, direction] of [["playback.slower", -1], ["playback.faster", 1]] as const) {
      shortcuts.registerAction(command, {
        enabled: () => session.selPath !== null,
        execute: () => player.changeSpeed(direction),
      });
    }
    for (const [command, direction] of [["timeline.previous-cut", -1], ["timeline.next-cut", 1]] as const) {
      shortcuts.registerAction(command, {
        enabled: () => session.selPath !== null,
        execute: () => {
          const video = byId<HTMLVideoElement>("vid");
          const duration = timeline.videoDuration() ?? 0;
          if (!video || !duration) return;
          const point = cutPointNear(timeline.playbackSegments(), player.timelineTime(), direction, duration);
          if (point != null) player.seekPreview(point);
        },
      });
    }
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
    // a task hidden in Settings has no tab and no shortcut
    for (const [command, id, index] of [["task.compress", "wf-c", 0], ["task.upscale", "wf-u", 1], ["task.cut", "wf-l", 2]] as const) {
      shortcuts.registerAction(command, {
        enabled: () => !byId(id)?.classList.contains("user-hidden"),
        execute: () => encoding.setWf(index),
      });
    }
  }

  function installFileDropHandlers(): void {
    let dragDepth = 0;
    const isFileDrag = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const overlay = byId("drag-overlay");
    const dropZone = byId("drop-z");
    // armed enables the fade-out; see #drag-overlay.armed
    const showOverlay = (): void => overlay?.classList.add("show", "armed");
    windowRef.document.body.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth += 1;
      showOverlay();
    });
    windowRef.document.body.addEventListener("dragover", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      showOverlay();
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

    // Tauri intercepts OS file drops before the WebView, so HTML5 `drop` never
    // carries file paths; real import comes from the webview drag-drop event
    if (hasTauriInvoke(windowRef)) {
      void (async () => {
        try {
          const { getCurrentWebview } = await import("@tauri-apps/api/webview");
          await getCurrentWebview().onDragDropEvent((event) => {
            const payload = event.payload;
            if (payload.type === "enter" || payload.type === "over") {
              showOverlay();
            } else if (payload.type === "leave") {
              overlay?.classList.remove("show");
            } else if (payload.type === "drop") {
              overlay?.classList.remove("show");
              dropZone?.classList.remove("over");
              const { videoPaths, audioPaths } = routeDroppedPaths(payload.paths);
              if (videoPaths.length) library.addFiles(videoPaths);
              if (audioPaths.length) audio.addAudioFiles(audioPaths, []);
            }
          });
        } catch (error) {
          console.error("[tuck] could not attach webview drag-drop listener", error);
        }
      })();
    }
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
      setShortcutOverrides(session.appSettings.shortcut_overrides);
      panels.applyVisibility(hiddenParts(session.appSettings.hidden_ui));
      encoding.openTask(launch.task, true);
      timeline.setSnap(session.appSettings.timeline_snap !== false);
      timeline.setKeyframes(session.appSettings.timeline_keyframes !== false);
      applyPreferences();
      panels.setInspectorTab(
        InspectorUi.startupTab(
          String(session.appSettings.inspector_start_panel ?? ""),
          String(session.appSettings.last_inspector_panel ?? ""),
        ),
        false,
      );
      library.noticeMissingTools();
    } catch {
      toast("Could not load settings.", "err");
    }
    // a developer switch for now: the native player takes over before any video is shown
    const nativePreview = hasTauriInvoke(windowRef) ? (await fetchPlatformCapabilities()).nativePreview : "off";
    if (nativePreview === "engine" || nativePreview === "player") {
      player.dispose();
      player = installNativePlayer(playerHost, createTauriPlayerEngine());
    }
    if (
      session.appSettings.check_updates !== false &&
      shouldShowUpdater(await fetchPlatformCapabilities())
    )
      void checkUpdates(true);
    if (queueTimer === null) {
      queueTimer = windowRef.setInterval(() => {
        void queue.pollQueue();
        void queue.pollIpc();
      }, 500);
    }
    const files =
      launch.files?.filter((file): file is string => typeof file === "string") ?? [];
    const reopen = reopenFiles(files, launch.sendto);
    sessionFiles.remember(reopen);
    if (files.length) library.addFiles(files);
    else if (reopen.length) library.addFiles(reopen);
    if (launch.sendto !== undefined && launch.sendto !== null) handleSendto(launch.sendto);
  }

  // last session's videos come back only for a plain launch; files sent to Tuck win
  function reopenFiles(files: readonly string[], sendto: unknown): string[] {
    if (session.appSettings.reopen_last_videos !== true) return [];
    const stored = session.appSettings.last_session_files;
    if (!Array.isArray(stored)) return [];
    const paths = stored.filter((path): path is string => typeof path === "string");
    return files.length || (sendto !== undefined && sendto !== null) ? [] : paths;
  }

  function initApp(data: unknown): void {
    const launch = launchData(data);
    if (started) {
      const files = launch.files?.filter((file): file is string => typeof file === "string") ?? [];
      if (launch.task) encoding.openTask(launch.task, false);
      if (files.length) library.addFiles(files);
      if (launch.sendto !== undefined && launch.sendto !== null) handleSendto(launch.sendto);
      return;
    }
    pendingLaunch = launch;
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
