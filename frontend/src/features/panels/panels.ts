import type { BackendClient } from "../../backend/types.ts";
import type { NotificationKind } from "../../ui/notifications.ts";
import * as TuckLayout from "../../ui/layout.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import type { AudioTimelineState, AudioTrack, EditorClip } from "../editor/types.ts";
import type {
  ClipDetailsDocument,
  ClipDetailsElement,
  ClipDetailsView as LibraryClipDetailsView,
  SourceFileRowValues,
} from "../library/clip-details.ts";
import * as ClipDetails from "../library/clip-details.ts";
export type { InspectorExportState } from "./inspector-ui.ts";

export type LibraryTab = "media" | "audio";
export type InspectorTab = "edit" | "audio" | "export";
export type WorkspacePanelName = "library" | "inspector";

export type ClipDetailsView = LibraryClipDetailsView;

export interface ClipDetailsApi {
  render: typeof ClipDetails.render;
  sourceFileRows: (values: SourceFileRowValues) => ReturnType<typeof ClipDetails.sourceFileRows>;
}

export interface AudioClipRangeInfo {
  name: string;
  code: string;
  color: string;
  sourceIn: number;
  sourceOut: number;
  sourceSpan: number;
  sourceDuration: number;
  maxSourceIn: number;
  startPct: number;
  widthPct: number;
  canSlip: boolean;
  waveformUrl?: string;
}

export interface AudioEditingApi {
  formatSourceTime?: (seconds: number) => string;
  sourceRangeDetailState: (
    sourceIn: number,
    sourceSpan: number,
    sourceDuration: number,
  ) => {
    visibleSpan: number;
    selectionStartPct: number;
    selectionWidthPct: number;
    waveformWidthPct: number;
    waveformPositionPct: number;
  };
  sourceRangeDetailDragValue: (
    current: number,
    deltaX: number,
    visibleSpan: number,
    contentWidth: number,
    maxSourceIn: number,
  ) => number;
  sourceRangePointerValue: (
    clientX: number,
    contentLeft: number,
    contentWidth: number,
    grabOffset: number,
    sourceDuration: number,
    maxSourceIn: number,
  ) => number;
  sourceRangeKeyboardValue: (
    current: number,
    maximum: number,
    key: string,
    largeStep: boolean,
  ) => number | null;
}

export interface AudioTimelineApi {
  selectTrack: (trackId: string) => void;
  trackColor: (index: number) => string;
  toggleSourceMute: () => void;
  toggleTrackMute: (trackId: string) => void;
  setSourceGain: (value: string | number) => void;
  setTrackGain: (trackId: string, value: string | number) => void;
  removeTrack: (trackId: string) => void;
  getSelectedClipRange: () => AudioClipRangeInfo | null;
  setSelectedSourceIn: (
    value: number,
    finalize: boolean,
  ) => AudioClipRangeInfo | null;
  resetSelectedSource: () => void;
}

export interface PanelsHost {
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  document: Document;
  window: Window & typeof globalThis;
  clips: () => Readonly<Record<string, EditorClip>>;
  selPath: () => string | null;
  appSettings: Record<string, unknown>;
  backend: Pick<BackendClient, "saveSettings">;
  toast: (message: string, kind?: NotificationKind | string) => void;
  formatTime: (seconds: number) => string;
  formatBytes: (bytes: number) => string;
  errorSummary: (error: string, limit?: number) => string;
  retryProbeClip: (path: string) => void;
  clipDetails: ClipDetailsApi;
  AudioTimeline?: AudioTimelineApi;
  AudioEditing?: AudioEditingApi;
  History?: { begin: (path: string | null) => void; commit: () => void };
}

export interface PanelsApi {
  toggleWorkspacePanel: (panel: WorkspacePanelName) => void;
  closeWorkspacePanels: (restoreFocus?: boolean) => void;
  setLibraryTab: (tab: string) => void;
  setInspectorTab: (tab: string, remember?: boolean) => void;
  applyWorkspacePanels: (restoreFocus?: boolean) => void;
  syncWorkspaceForViewport: () => void;
  renderClipDetails: () => void;
  renderAudioLibraryPanel: () => void;
  renderAudioMixerList: () => void;
  renderAudioClipRange: () => void;
  trapWorkspaceDrawerFocus: (event: KeyboardEvent) => boolean;
  getLibraryTab: () => LibraryTab;
  getInspectorTab: () => InspectorTab;
  getWorkspaceViewportMode: () => string;
  readonly inspectorSettingsSave: Promise<void>;
  dispose: () => void;
}

interface MixerRowModel {
  id: string;
  code: string;
  name: string;
  role: string;
  muted: boolean;
  gain: number;
  removable: boolean;
  color: string;
}

const CODEC_LABELS: Readonly<Record<string, string>> = {
  h264: "H.264",
  hevc: "H.265",
  vp9: "VP9",
  av1: "AV1",
  mpeg4: "MPEG-4",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  flac: "FLAC",
  ac3: "AC3",
  eac3: "E-AC3",
  pcm_s16le: "PCM",
};

let active: PanelsApi | null = null;

function requireActive(): PanelsApi {
  if (!active) throw new Error("installPanels() must be called first");
  return active;
}

function formatCodec(name: string | null | undefined): string {
  if (!name) return "";
  return CODEC_LABELS[name.toLowerCase()] || name.toUpperCase();
}

function formatGainDb(value: string | number): string {
  const gain = Math.max(-60, Math.min(12, Number(value) || 0));
  return (gain > 0 ? "+" : "") + gain + " dB";
}

export function installPanels(host: PanelsHost): PanelsApi {
  const doc = host.document;
  const win = host.window;

  let libraryTab: LibraryTab = "media";
  let inspectorTab: InspectorTab = "export";
  let inspectorSettingsSave: Promise<void> = Promise.resolve();
  let workspaceViewportMode = "";
  let workspacePanels = { libraryOpen: true, inspectorOpen: true };
  let workspaceReturnFocus: HTMLElement | null = null;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return host.byId<T>(id);
  }

  function applyWorkspacePanels(restoreFocus?: boolean): void {
    const overlay = workspaceViewportMode === "overlay";
    const drawerOpen =
      overlay && (workspacePanels.libraryOpen || workspacePanels.inspectorOpen);
    doc.body.classList.add("workspace-ready");
    doc.body.classList.toggle("workspace-overlay", overlay);
    doc.body.classList.toggle("library-panel-open", workspacePanels.libraryOpen);
    doc.body.classList.toggle("inspector-panel-open", workspacePanels.inspectorOpen);
    doc.body.classList.toggle("workspace-drawer-open", drawerOpen);
    const center = byId("center");
    const audioEditor = byId("audio-editor");
    const qbar = byId("qbar");
    if (center) center.inert = drawerOpen;
    if (audioEditor) audioEditor.inert = drawerOpen;
    if (qbar) qbar.inert = drawerOpen;

    (
      [
        ["library", "left", "panel-toggle-library", "library-panel-close"],
        ["inspector", "right", "panel-toggle-inspector", "inspector-panel-close"],
      ] as const
    ).forEach((entry) => {
      const open =
        entry[0] === "library"
          ? workspacePanels.libraryOpen
          : workspacePanels.inspectorOpen;
      const panel = byId(entry[1]);
      const toggle = byId(entry[2]);
      const close = byId(entry[3]);
      if (!panel || !toggle || !close) return;
      panel.setAttribute("aria-hidden", String(!open));
      panel.inert = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("on", open);
      close.setAttribute("aria-label", (overlay ? "Close " : "Hide ") + entry[0]);
      if (overlay && open) {
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute(
          "aria-label",
          entry[0] === "library" ? "Library" : "Inspector",
        );
      } else {
        panel.removeAttribute("role");
        panel.removeAttribute("aria-modal");
        panel.removeAttribute("aria-label");
      }
    });
    if (restoreFocus && workspaceReturnFocus && workspaceReturnFocus.isConnected)
      workspaceReturnFocus.focus();
    if (!workspacePanels.libraryOpen && !workspacePanels.inspectorOpen)
      workspaceReturnFocus = null;
  }

  function toggleWorkspacePanel(panel: WorkspacePanelName): void {
    if (panel !== "library" && panel !== "inspector") return;
    const wasOpen =
      panel === "library" ? workspacePanels.libraryOpen : workspacePanels.inspectorOpen;
    if (workspaceViewportMode === "overlay" && !wasOpen) {
      const activeElement = doc.activeElement;
      workspaceReturnFocus =
        activeElement instanceof HTMLElement ? activeElement : null;
    } else if (workspaceViewportMode === "docked" && wasOpen) {
      workspaceReturnFocus = byId(
        panel === "library" ? "panel-toggle-library" : "panel-toggle-inspector",
      );
    }
    workspacePanels = TuckLayout.toggleWorkspacePanelState(
      workspacePanels,
      panel,
      win.innerWidth,
    );
    applyWorkspacePanels(wasOpen);
    if (workspaceViewportMode === "overlay" && !wasOpen) {
      const close = byId(
        panel === "library" ? "library-panel-close" : "inspector-panel-close",
      );
      const visibleClose = close && close.offsetParent !== null ? close : null;
      const activeTab = byId(
        panel === "library"
          ? libraryTab === "audio"
            ? "lib-tab-audio"
            : "lib-tab-media"
          : "insp-tab-" + inspectorTab,
      );
      if (visibleClose) visibleClose.focus();
      else if (activeTab) activeTab.focus();
    }
  }

  function closeWorkspacePanels(restoreFocus?: boolean): void {
    if (workspaceViewportMode !== "overlay") return;
    workspacePanels = { libraryOpen: false, inspectorOpen: false };
    applyWorkspacePanels(!!restoreFocus);
  }

  function trapWorkspaceDrawerFocus(event: KeyboardEvent): boolean {
    if (event.key !== "Tab" || workspaceViewportMode !== "overlay") return false;
    const panel = workspacePanels.libraryOpen
      ? byId("left")
      : workspacePanels.inspectorOpen
        ? byId("right")
        : null;
    if (!panel) return false;
    const focusable = Array.prototype.filter.call(
      panel.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ),
      (element: Element) => {
        const html = element as HTMLElement;
        return html.offsetParent !== null && !html.inert;
      },
    ) as HTMLElement[];
    if (!focusable.length) return false;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (!panel.contains(doc.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return true;
  }

  function syncWorkspaceForViewport(): void {
    const nextMode = TuckLayout.workspaceMode(win.innerWidth);
    if (nextMode !== workspaceViewportMode) {
      workspaceViewportMode = nextMode;
      workspacePanels = TuckLayout.initialWorkspacePanels(win.innerWidth);
    }
    applyWorkspacePanels(false);
  }

  function setLibraryTab(tab: string): void {
    libraryTab = tab === "audio" ? "audio" : "media";
    const mediaTab = byId("lib-tab-media");
    const audioTab = byId("lib-tab-audio");
    mediaTab?.classList.toggle("on", libraryTab === "media");
    mediaTab?.setAttribute("aria-pressed", String(libraryTab === "media"));
    audioTab?.classList.toggle("on", libraryTab === "audio");
    audioTab?.setAttribute("aria-pressed", String(libraryTab === "audio"));
    byId("lib-add-row-media")?.classList.toggle("hid", libraryTab !== "media");
    byId("lib-add-row-audio")?.classList.toggle("hid", libraryTab !== "audio");
    byId("lib-panel-media")?.classList.toggle("hid", libraryTab !== "media");
    byId("lib-panel-audio")?.classList.toggle("hid", libraryTab !== "audio");
    byId("library-summary")?.classList.toggle("hid", libraryTab !== "media");
    if (libraryTab === "audio") renderAudioLibraryPanel();
  }

  function renderAudioLibraryPanel(): void {
    const list = byId("audio-lib-list");
    const empty = byId("audio-lib-empty");
    if (!list || !empty) return;
    const path = host.selPath();
    const clip = path ? host.clips()[path] : null;
    if (!clip) {
      list.replaceChildren();
      empty.textContent = "Choose a video to see its audio tracks.";
      empty.classList.remove("hid");
      return;
    }
    const tracks: readonly AudioTrack[] =
      (clip.audioTimeline && clip.audioTimeline.tracks) || [];
    if (!tracks.length) {
      list.replaceChildren();
      empty.textContent = "No audio yet.";
      empty.classList.remove("hid");
      return;
    }
    empty.classList.add("hid");
    list.replaceChildren();
    tracks.forEach((track) => {
      const div = doc.createElement("div");
      div.className = "clip audio-lib-item";
      div.tabIndex = 0;
      const c1 = doc.createElement("div");
      c1.className = "c1";
      const c2 = doc.createElement("div");
      c2.className = "c2";
      c2.textContent = track.name || "";
      const c3 = doc.createElement("div");
      c3.className = "c3";
      const meta = doc.createElement("span");
      meta.className = "c-meta";
      const codec =
        typeof track.codec === "string" && track.codec ? track.codec : "audio";
      meta.textContent = codec.toUpperCase();
      const time = doc.createElement("span");
      time.className = "c-time";
      time.textContent = host.formatTime(track.sourceDuration || 0);
      c3.append(meta, time);
      c1.append(c2, c3);
      div.appendChild(c1);
      div.addEventListener("click", () => {
        host.AudioTimeline?.selectTrack(track.id);
      });
      list.appendChild(div);
    });
  }

  function rememberInspectorTab(tab: InspectorTab): void {
    const panel = tab === "edit" ? "video" : tab;
    host.appSettings.last_inspector_panel = panel;
    inspectorSettingsSave = inspectorSettingsSave
      .catch(() => {})
      .then(async () => {
        const result = await legacyBackendResult(
          host.backend.saveSettings({ last_inspector_panel: panel }),
        );
        if (!result.ok)
          host.toast(
            typeof result.error === "string"
              ? result.error
              : "Could not remember the Inspector panel.",
            "err",
          );
      })
      .catch(() => {
        host.toast("Could not remember the Inspector panel.", "err");
      });
  }

  function setInspectorTab(tab: string, remember?: boolean): void {
    inspectorTab = tab === "audio" || tab === "export" ? tab : "edit";
    (["edit", "audio", "export"] as const).forEach((t) => {
      const isActive = t === inspectorTab;
      const tabButton = byId("insp-tab-" + t);
      const panel = byId("insp-" + t);
      tabButton?.classList.toggle("on", isActive);
      tabButton?.setAttribute("aria-pressed", String(isActive));
      panel?.classList.toggle("hid", !isActive);
    });
    byId("right-foot")?.classList.toggle("hid", inspectorTab !== "export");
    if (inspectorTab === "audio") renderAudioMixerList();
    if (remember !== false) rememberInspectorTab(inspectorTab);
  }

  function renderClipDetails(): void {
    const detailsHost = byId("clip-details-body");
    if (!detailsHost) return;
    const detailsDoc = doc as unknown as ClipDetailsDocument;
    const detailsEl = detailsHost as unknown as ClipDetailsElement;
    const path = host.selPath();
    const clip = path ? host.clips()[path] : null;
    const empty = byId("video-inspector-empty");
    const content = byId("video-inspector-content");
    const selection = byId("video-selection-name");
    const selectionMeta = byId("video-selection-meta");
    if (empty) empty.classList.toggle("hid", Boolean(clip));
    if (content) content.classList.toggle("hid", !clip);
    if (!clip) {
      host.clipDetails.render(detailsDoc, detailsEl, { state: "empty" }, host.retryProbeClip);
      return;
    }
    if (selection) selection.textContent = clip.name || "Selected video";
    if (selectionMeta) selectionMeta.textContent = "Reading clip details…";
    if (clip.error) {
      host.clipDetails.render(
        detailsDoc,
        detailsEl,
        {
          state: "error",
          path: clip.path,
          error: host.errorSummary(clip.error, 160),
        },
        host.retryProbeClip,
      );
      return;
    }
    if (!clip.probed || !clip.probeData) {
      host.clipDetails.render(
        detailsDoc,
        detailsEl,
        { state: "loading" },
        host.retryProbeClip,
      );
      return;
    }
    const d = clip.probeData;
    if (selectionMeta) {
      selectionMeta.textContent =
        (d.width && d.height ? d.width + "×" + d.height + " · " : "") +
        host.formatTime(d.duration || 0);
    }
    const format = [
      formatCodec(typeof d.video_codec === "string" ? d.video_codec : ""),
      d.has_audio
        ? formatCodec(typeof d.audio_codec === "string" ? d.audio_codec : "")
        : null,
    ]
      .filter(Boolean)
      .join(" / ");
    const rows = host.clipDetails.sourceFileRows({
      duration: host.formatTime(d.duration || 0),
      resolution: d.width && d.height ? d.width + "×" + d.height : "—",
      frameRate: d.fps ? Math.round(d.fps * 100) / 100 + " fps" : "—",
      format: format || "—",
      size: clip._fileSize ? host.formatBytes(clip._fileSize) : "—",
    });
    host.clipDetails.render(
      detailsDoc,
      detailsEl,
      { state: "ready", rows },
      host.retryProbeClip,
    );
  }

  function appendMixerRow(hostEl: HTMLElement, row: MixerRowModel): HTMLElement {
    const gain = Math.max(-24, Math.min(12, Number(row.gain) || 0));
    const gainDisplay = formatGainDb(gain);
    const muteLabel = (row.muted ? "Unmute " : "Mute ") + row.name;

    const root = doc.createElement("div");
    root.className = "mixer-row";
    root.dataset.mixerId = row.id;
    root.dataset.removable = row.removable ? "true" : "false";
    root.style.setProperty("--track-color", row.color);

    const identity = doc.createElement("div");
    identity.className = "mixer-row-identity";
    const code = doc.createElement("span");
    code.className = "mixer-track-code";
    code.setAttribute("aria-hidden", "true");
    code.textContent = row.code;
    const identityBody = doc.createElement("span");
    identityBody.className = "mixer-identity";
    const name = doc.createElement("span");
    name.className = "mixer-name";
    name.title = row.name;
    name.textContent = row.name;
    identityBody.appendChild(name);
    identity.append(code, identityBody);

    const actions = doc.createElement("div");
    actions.className = "mixer-row-actions";
    const mute = doc.createElement("button");
    mute.type = "button";
    mute.className = "mixer-mute";
    mute.setAttribute("aria-pressed", row.muted ? "true" : "false");
    mute.setAttribute("aria-label", muteLabel);
    mute.dataset.tip = muteLabel;
    mute.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h2.2l3-2.7v9.4l-3-2.7H2z"></path><path class="mixer-sound-waves" d="M10.2 5.2a4 4 0 0 1 0 5.6"></path><path class="mixer-mute-cross" d="m10.2 6.2 3.4 3.6m0-3.6-3.4 3.6"></path></svg>';
    actions.appendChild(mute);
    if (row.removable) {
      const remove = doc.createElement("button");
      remove.type = "button";
      remove.className = "mixer-remove";
      remove.setAttribute("aria-label", "Remove " + row.name);
      remove.dataset.tip = "Remove imported audio track";
      remove.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5l.4-1.5h3.2l.4 1.5M4.8 4.5l.6 8h5.2l.6-8M7 7v3.5M9 7v3.5"></path></svg>';
      actions.appendChild(remove);
    }

    const level = doc.createElement("div");
    level.className = "mixer-row-level";
    const slider = doc.createElement("input");
    slider.type = "range";
    slider.className = "mixer-gain";
    slider.min = "-24";
    slider.max = "12";
    slider.step = "1";
    slider.value = String(gain);
    slider.setAttribute("aria-label", row.name + " gain in decibels");
    const db = doc.createElement("span");
    db.className = "mixer-db";
    db.textContent = gainDisplay;
    level.append(slider, db);

    root.append(identity, actions, level);
    hostEl.appendChild(root);
    return root;
  }

  function renderAudioMixerList(): void {
    const mixerHost = byId("audio-track-mixer");
    const count = byId("audio-track-count");
    if (!mixerHost) return;
    const path = host.selPath();
    const clip = path ? host.clips()[path] : null;
    if (!clip || !clip.audioTimeline) {
      if (count) count.textContent = "0";
      mixerHost.replaceChildren();
      const empty = doc.createElement("div");
      empty.className = "cd-empty";
      empty.textContent = "Choose a video to adjust its audio.";
      mixerHost.appendChild(empty);
      renderAudioClipRange();
      return;
    }
    const state: AudioTimelineState = clip.audioTimeline;
    const rows: MixerRowModel[] = [];
    let trackNumber = 1;
    if (clip.probeData && clip.probeData.has_audio) {
      rows.push({
        id: "source",
        code: "A1",
        name: "Source audio",
        role: "Original",
        muted: state.sourceMuted,
        gain: state.sourceGainDb,
        removable: false,
        color: "#5B469B",
      });
      trackNumber = 2;
    }
    state.tracks.forEach((track, index) => {
      rows.push({
        id: track.id,
        code: "A" + (trackNumber + index),
        name: track.name || "Audio",
        role: "Imported",
        muted: !!track.muted,
        gain:
          typeof track.gainDb === "number"
            ? track.gainDb
            : Number(track.gainDb) || 0,
        removable: true,
        color: host.AudioTimeline ? host.AudioTimeline.trackColor(index) : "#5B469B",
      });
    });
    if (count) count.textContent = String(rows.length);
    mixerHost.replaceChildren();
    if (!rows.length) {
      const empty = doc.createElement("div");
      empty.className = "cd-empty";
      empty.textContent =
        "This video has no audio tracks. Use Add audio in the timeline toolbar to add one.";
      mixerHost.appendChild(empty);
      renderAudioClipRange();
      return;
    }
    rows.forEach((row) => {
      appendMixerRow(mixerHost, row);
    });

    const bindTracks: Array<{ id: string }> = state.tracks.map((track) => ({
      id: track.id,
    }));
    if (clip.probeData && clip.probeData.has_audio) bindTracks.push({ id: "source" });
    bindTracks.forEach((track) => {
      const row = Array.prototype.find.call(
        mixerHost.querySelectorAll(".mixer-row"),
        (candidate: Element) =>
          candidate instanceof HTMLElement &&
          candidate.dataset.mixerId === String(track.id),
      ) as HTMLElement | undefined;
      if (!row) return;
      const muteButton = row.querySelector(".mixer-mute");
      const slider = row.querySelector(".mixer-gain");
      const removeBtn = row.querySelector(".mixer-remove");
      if (muteButton instanceof HTMLElement) {
        muteButton.addEventListener("click", () => {
          if (track.id === "source") host.AudioTimeline?.toggleSourceMute();
          else host.AudioTimeline?.toggleTrackMute(track.id);
        });
      }
      if (slider instanceof HTMLInputElement) {
        slider.addEventListener("pointerdown", () => {
          host.History?.begin(host.selPath());
        });
        slider.addEventListener("input", () => {
          const output = row.querySelector(".mixer-db");
          if (output) output.textContent = formatGainDb(slider.value);
          if (track.id === "source") host.AudioTimeline?.setSourceGain(slider.value);
          else host.AudioTimeline?.setTrackGain(track.id, slider.value);
        });
        slider.addEventListener("change", () => {
          host.History?.commit();
        });
        slider.addEventListener("dblclick", (event) => {
          event.preventDefault();
          host.History?.begin(host.selPath());
          slider.value = "0";
          const output = row.querySelector(".mixer-db");
          if (output) output.textContent = formatGainDb(0);
          if (track.id === "source") host.AudioTimeline?.setSourceGain(0);
          else host.AudioTimeline?.setTrackGain(track.id, 0);
          host.History?.commit();
        });
      }
      if (removeBtn instanceof HTMLElement) {
        removeBtn.addEventListener("click", () => {
          host.AudioTimeline?.removeTrack(track.id);
        });
      }
    });
    renderAudioClipRange();
  }

  function renderAudioClipRange(): void {
    const rangeHost = byId("audio-clip-range");
    if (!rangeHost) return;
    let info =
      host.AudioTimeline && typeof host.AudioTimeline.getSelectedClipRange === "function"
        ? host.AudioTimeline.getSelectedClipRange()
        : null;
    if (!info) {
      rangeHost.classList.add("hid");
      rangeHost.replaceChildren();
      return;
    }
    rangeHost.classList.remove("hid");
    const formatTime =
      host.AudioEditing && typeof host.AudioEditing.formatSourceTime === "function"
        ? host.AudioEditing.formatSourceTime
        : host.formatTime;

    rangeHost.replaceChildren();
    const head = doc.createElement("div");
    head.className = "audio-clip-range-head";
    const headLeft = doc.createElement("div");
    const title = doc.createElement("span");
    title.className = "audio-range-title";
    title.textContent = "Selected clip";
    const name = doc.createElement("span");
    name.className = "audio-range-name";
    name.title = info.name;
    name.textContent = info.name;
    headLeft.append(title, name);
    const code = doc.createElement("span");
    code.className = "mixer-track-code";
    code.style.setProperty("--track-color", info.color);
    code.setAttribute("aria-hidden", "true");
    code.textContent = info.code;
    head.append(headLeft, code);

    const meta = doc.createElement("div");
    meta.className = "audio-range-meta";
    const metaLabel = doc.createElement("span");
    metaLabel.textContent = "Source";
    const output = doc.createElement("output");
    output.className = "audio-range-value";
    meta.append(metaLabel, output);

    const picker = doc.createElement("div");
    picker.className = "audio-source-picker";
    const overviewLabel = doc.createElement("div");
    overviewLabel.className = "audio-source-label";
    overviewLabel.textContent = "Overview";
    const overview = doc.createElement("div");
    overview.className = "audio-source-overview";
    overview.setAttribute("role", "slider");
    overview.setAttribute("aria-label", "Audio source overview");
    overview.setAttribute("aria-describedby", "audio-range-hint");
    overview.setAttribute("aria-valuemin", "0");
    overview.setAttribute("aria-valuemax", String(info.maxSourceIn));
    overview.setAttribute("aria-valuenow", String(info.sourceIn));
    overview.tabIndex = info.canSlip ? 0 : -1;
    overview.setAttribute("aria-disabled", info.canSlip ? "false" : "true");
    const overviewWindow = doc.createElement("div");
    overviewWindow.className = "audio-source-overview-window";
    overviewWindow.setAttribute("aria-hidden", "true");
    overview.appendChild(overviewWindow);

    const detailLabel = doc.createElement("div");
    detailLabel.className = "audio-source-label";
    detailLabel.textContent = "Detail";
    const detail = doc.createElement("div");
    detail.className = "audio-source-detail";
    detail.setAttribute("role", "slider");
    detail.setAttribute("aria-label", "Audio source detail");
    detail.setAttribute("aria-describedby", "audio-range-hint");
    detail.setAttribute("aria-valuemin", "0");
    detail.setAttribute("aria-valuemax", String(info.maxSourceIn));
    detail.setAttribute("aria-valuenow", String(info.sourceIn));
    detail.tabIndex = info.canSlip ? 0 : -1;
    detail.setAttribute("aria-disabled", info.canSlip ? "false" : "true");
    const detailBefore = doc.createElement("span");
    detailBefore.className = "audio-source-detail-scrim before";
    detailBefore.setAttribute("aria-hidden", "true");
    const detailAfter = doc.createElement("span");
    detailAfter.className = "audio-source-detail-scrim after";
    detailAfter.setAttribute("aria-hidden", "true");
    const detailWindow = doc.createElement("div");
    detailWindow.className = "audio-source-detail-window";
    detailWindow.setAttribute("aria-hidden", "true");
    const grip = doc.createElement("span");
    grip.className = "audio-source-grip";
    detailWindow.appendChild(grip);
    detail.append(detailBefore, detailAfter, detailWindow);
    picker.append(overviewLabel, overview, detailLabel, detail);

    const foot = doc.createElement("div");
    foot.className = "audio-range-foot";
    const hint = doc.createElement("span");
    hint.className = "audio-range-hint";
    hint.id = "audio-range-hint";
    hint.textContent = info.canSlip
      ? "Click overview to jump · Drag waveform to fine-tune"
      : "Entire source is in use";
    const reset = doc.createElement("button");
    reset.type = "button";
    reset.className = "audio-range-reset";
    reset.textContent = "Reset";
    if (!info.canSlip) reset.disabled = true;
    foot.append(hint, reset);

    rangeHost.append(head, meta, picker, foot);

    overview.style.setProperty("--track-color", info.color);
    detail.style.setProperty("--track-color", info.color);
    if (info.waveformUrl) {
      const waveformImage = "url('" + info.waveformUrl.replace(/'/g, "%27") + "')";
      overview.style.backgroundImage = waveformImage;
      detail.style.backgroundImage = waveformImage;
    }

    let detailState: ReturnType<AudioEditingApi["sourceRangeDetailState"]> | null =
      null;
    const audioEditing = host.AudioEditing;

    function paintRange(next: AudioClipRangeInfo | null): void {
      if (!audioEditing) return;
      info = next || info;
      if (!info) return;
      detailState = audioEditing.sourceRangeDetailState(
        info.sourceIn,
        info.sourceSpan,
        info.sourceDuration,
      );
      overviewWindow.style.left = info.startPct + "%";
      overviewWindow.style.width = info.widthPct + "%";
      detail.style.backgroundSize = detailState.waveformWidthPct + "% 100%";
      detail.style.backgroundPosition = detailState.waveformPositionPct + "% center";
      detailWindow.style.left = detailState.selectionStartPct + "%";
      detailWindow.style.width = detailState.selectionWidthPct + "%";
      detailBefore.style.width = detailState.selectionStartPct + "%";
      detailAfter.style.left =
        detailState.selectionStartPct + detailState.selectionWidthPct + "%";
      const valueText =
        formatTime(info.sourceIn) + " to " + formatTime(info.sourceOut);
      [overview, detail].forEach((control) => {
        control.setAttribute("aria-valuenow", String(info!.sourceIn));
        control.setAttribute("aria-valuetext", valueText);
      });
      output.textContent =
        formatTime(info.sourceIn) +
        "–" +
        formatTime(info.sourceOut) +
        " / " +
        formatTime(info.sourceDuration);
    }

    if (!audioEditing) {
      output.textContent =
        formatTime(info.sourceIn) +
        "–" +
        formatTime(info.sourceOut) +
        " / " +
        formatTime(info.sourceDuration);
      return;
    }

    paintRange(info);
    if (!info.canSlip) return;

    let pointer: {
      pointerId: number;
      mode: "overview" | "detail";
      element: HTMLElement;
      startX: number;
      sourceIn: number;
      visibleSpan: number;
      rect: { left: number; width: number };
      grabOffset: number;
      cursorClass: string;
    } | null = null;

    function updateFromPointer(clientX: number): void {
      if (!pointer || !info || !audioEditing || !detailState) return;
      const nextSourceIn =
        pointer.mode === "detail"
          ? audioEditing.sourceRangeDetailDragValue(
              pointer.sourceIn,
              clientX - pointer.startX,
              pointer.visibleSpan,
              pointer.rect.width,
              info.maxSourceIn,
            )
          : audioEditing.sourceRangePointerValue(
              clientX,
              pointer.rect.left,
              pointer.rect.width,
              pointer.grabOffset,
              info.sourceDuration,
              info.maxSourceIn,
            );
      const next = host.AudioTimeline?.setSelectedSourceIn(nextSourceIn, false) ?? null;
      if (next) paintRange(next);
    }

    function startPointer(
      mode: "overview" | "detail",
      element: HTMLElement,
      event: PointerEvent,
    ): void {
      if (!info || !detailState) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const windowRect = overviewWindow.getBoundingClientRect();
      const onOverviewWindow =
        mode === "overview" && overviewWindow.contains(event.target as Node);
      pointer = {
        pointerId: event.pointerId,
        mode,
        element,
        startX: event.clientX,
        sourceIn: info.sourceIn,
        visibleSpan: detailState.visibleSpan,
        rect: {
          left: rect.left + element.clientLeft,
          width: element.clientWidth,
        },
        grabOffset: onOverviewWindow
          ? event.clientX - windowRect.left
          : windowRect.width / 2,
        cursorClass:
          mode === "detail"
            ? "audio-range-detail-dragging"
            : "audio-range-overview-dragging",
      };
      host.History?.begin(host.selPath());
      element.classList.add("dragging");
      doc.body.classList.add(pointer.cursorClass);
      if (element.setPointerCapture) {
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          /* optional */
        }
      }
      if (mode === "overview") updateFromPointer(event.clientX);
    }

    function movePointer(event: PointerEvent): void {
      if (!pointer || event.pointerId !== pointer.pointerId) return;
      event.preventDefault();
      updateFromPointer(event.clientX);
    }

    function finishPointer(event: PointerEvent): void {
      if (!pointer || !info || event.pointerId !== pointer.pointerId) return;
      if (event.type !== "pointercancel") updateFromPointer(event.clientX);
      if (
        pointer.element.releasePointerCapture &&
        pointer.element.hasPointerCapture &&
        pointer.element.hasPointerCapture(event.pointerId)
      )
        pointer.element.releasePointerCapture(event.pointerId);
      pointer.element.classList.remove("dragging");
      pointer = null;
      doc.body.classList.remove(
        "audio-range-overview-dragging",
        "audio-range-detail-dragging",
      );
      host.AudioTimeline?.setSelectedSourceIn(info.sourceIn, true);
      host.History?.commit();
    }

    overview.addEventListener("pointerdown", (event) => {
      startPointer("overview", overview, event);
    });
    detail.addEventListener("pointerdown", (event) => {
      startPointer("detail", detail, event);
    });
    [overview, detail].forEach((control) => {
      control.addEventListener("pointermove", movePointer);
      control.addEventListener("pointerup", finishPointer);
      control.addEventListener("pointercancel", finishPointer);
    });

    function moveFromKeyboard(event: KeyboardEvent): void {
      if (!info || !audioEditing) return;
      const next = audioEditing.sourceRangeKeyboardValue(
        info.sourceIn,
        info.maxSourceIn,
        event.key,
        event.shiftKey,
      );
      if (next == null) return;
      event.preventDefault();
      host.History?.begin(host.selPath());
      host.AudioTimeline?.setSelectedSourceIn(next, true);
      host.History?.commit();
    }
    overview.addEventListener("keydown", moveFromKeyboard);
    detail.addEventListener("keydown", moveFromKeyboard);

    function resetRange(event: Event): void {
      event.preventDefault();
      host.History?.begin(host.selPath());
      host.AudioTimeline?.resetSelectedSource();
      host.History?.commit();
    }
    overview.addEventListener("dblclick", resetRange);
    detail.addEventListener("dblclick", resetRange);
    reset.addEventListener("click", resetRange);
  }

  const onResize = (): void => {
    syncWorkspaceForViewport();
  };
  win.addEventListener("resize", onResize);
  cleanups.push(() => {
    win.removeEventListener("resize", onResize);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (trapWorkspaceDrawerFocus(event)) return;
    if (event.key !== "Escape" || workspaceViewportMode !== "overlay") return;
    if (!workspacePanels.libraryOpen && !workspacePanels.inspectorOpen) return;
    if (doc.body.classList.contains("settings-open")) return;
    const overlay = byId("mod-overlay");
    if (overlay?.classList.contains("open")) return;
    event.preventDefault();
    closeWorkspacePanels(true);
  };
  doc.addEventListener("keydown", onKeyDown, true);
  cleanups.push(() => {
    doc.removeEventListener("keydown", onKeyDown, true);
  });

  syncWorkspaceForViewport();

  const api = {
    toggleWorkspacePanel,
    closeWorkspacePanels,
    setLibraryTab,
    setInspectorTab,
    applyWorkspacePanels,
    syncWorkspaceForViewport,
    renderClipDetails,
    renderAudioLibraryPanel,
    renderAudioMixerList,
    renderAudioClipRange,
    trapWorkspaceDrawerFocus,
    getLibraryTab: () => libraryTab,
    getInspectorTab: () => inspectorTab,
    getWorkspaceViewportMode: () => workspaceViewportMode,
    get inspectorSettingsSave() {
      return inspectorSettingsSave;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      if (active === api) active = null;
    },
  } satisfies PanelsApi;

  active = api;
  return api;
}

export function toggleWorkspacePanel(panel: WorkspacePanelName): void {
  requireActive().toggleWorkspacePanel(panel);
}
export function closeWorkspacePanels(restoreFocus?: boolean): void {
  requireActive().closeWorkspacePanels(restoreFocus);
}
export function setLibraryTab(tab: string): void {
  requireActive().setLibraryTab(tab);
}
export function setInspectorTab(tab: string, remember?: boolean): void {
  requireActive().setInspectorTab(tab, remember);
}
export function applyWorkspacePanels(restoreFocus?: boolean): void {
  requireActive().applyWorkspacePanels(restoreFocus);
}
export function syncWorkspaceForViewport(): void {
  requireActive().syncWorkspaceForViewport();
}
export function renderClipDetails(): void {
  requireActive().renderClipDetails();
}
export function renderAudioLibraryPanel(): void {
  requireActive().renderAudioLibraryPanel();
}
export function renderAudioMixerList(): void {
  requireActive().renderAudioMixerList();
}
export function renderAudioClipRange(): void {
  requireActive().renderAudioClipRange();
}
export function trapWorkspaceDrawerFocus(event: KeyboardEvent): boolean {
  return requireActive().trapWorkspaceDrawerFocus(event);
}
