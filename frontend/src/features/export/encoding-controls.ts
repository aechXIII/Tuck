import { installLutControls } from "./lut-controls.ts";
import { nextSelectMatch, selectPopupPlacement, selectSearchThreshold, selectTypeaheadPrefix } from "../../ui/select-state.ts";
import { installFrameBlending } from "./frame-blending.ts";
import { installCutControls } from "./cut-controls.ts";
import { createCutState } from "./cut-state.ts";
import type { CutPlanPreview } from "../../backend/cutting-types.ts";
import type { BackendClient } from "../../backend/types.ts";
import type { LutSettingsJSON } from "../../backend/types.ts";
import { isProbeReady, probeSummary } from "../../state/probe.ts";
import * as InspectorUi from "../panels/inspector-ui.ts";
import { cropForAspect, isFullCrop, type CropTransform } from "../transform/crop-geometry.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { hiddenParts, launchTask, taskAt, taskIndex, visibleTasks } from "../settings/visibility.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import { closeMod, showMod, toast } from "../editor/toast.ts";
import { reasonSentence, withReason } from "../editor/format.ts";
import { profileChangeSummary, profileSummary } from "../profiles/profile-summary.ts";
import { pickerProfiles } from "../profiles/profile-list.ts";
import type { EditorClip } from "../editor/types.ts";
import { isQueueActive, queuedVideoLabel } from "../queue/queue-view.ts";
import { swapLabel } from "../../ui/motion.ts";
import type { EditorSession } from "../editor/session.ts";
import {
  buildPlanRequest,
  buildProfilePayload,
  buildCutRequest,
  planWarnings,
  type ExportFormState,
} from "./plan-request.ts";
import {
  isCpuEncoder,
  nativePresetForSpeed,
  speedForNativePreset,
  twoPassEligible,
  type RateControlDisplay,
} from "./encoder-options.ts";
import {
  populateEncoderSelect,
  populatePresetSelect,
  populateRateControlSelect,
  populateTuneSelect,
} from "./encoder-select.ts";
import {
  encoderForPlatform,
  encodersForPlatform,
  fetchPlatformCapabilities,
  supportsHardwareEncoders,
  type PlatformCapabilities,
} from "../../platform/capabilities.ts";

export interface EncodingControlsDeps {
  syncFrameExport?: () => void;
  syncSelects: () => void;
  session: EditorSession;
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  getBackendClient: () => BackendClient;
  syncTransformControls: () => void;
  paintCropOverlay: () => void;
  cropTransformForRequest: (clip: EditorClip | null | undefined) => CropTransform | null;
  restoreTimelineHeight: (value: unknown) => void;
  orderedClipKeys: () => string[];
  audioRequestPayload: (clip: EditorClip) => Record<string, unknown>;
  pollQueue: () => void | Promise<void>;
  // opens Exports at this export, for a video that is already in the queue
  showExport?: (itemId: string) => void;
  renderClips?: () => void;
  selectCutSegment: (index: number, time: number) => void;
  moveCutStarts: (clip: EditorClip, plan: CutPlanPreview) => boolean;
  paintCutTimeline: () => void;
}

export interface EncodingControlsApi {
  readLut: () => LutSettingsJSON;
  workflow: () => number;
  setWf: (idx: number) => void;
  applyProfile: (forceTransform?: boolean) => void;
  applySelectedProfileTransform: (clip: EditorClip | null | undefined, force?: boolean) => void;
  refilter: () => void;
  onProfileChange: () => void;
  toggleProfileMenu: () => void;
  // switches profile; unsaved changes to the old one can be brought back from the note
  chooseProfile: (profileId: string) => void;
  loadSettings: (preserveExportSettings?: boolean) => Promise<void>;
  // picks the task on launch, or when a Send To shortcut asks for one while Tuck is open
  openTask: (launch: unknown, atStart: boolean) => void;
  reqPreview: () => Promise<void>;
  // plans the other videos so each Library row can say what it becomes
  planLibrary: () => Promise<void>;
  task: () => "compression" | "upscale" | "cut";
  reqPreviewAndDirty: () => void;
  buildRequest: (source: string) => Record<string, unknown>;
  updateActionButtons: () => void;
  syncExportSummary: () => void;
  focusCutRow: (index: number) => void;
  syncFpsToClip: (force?: boolean) => void;
  syncResolutionToClip: (force?: boolean) => void;
  updateSizePresets: (value: number) => void;
  updateEncoderOptions: () => void;
  setAvailableEncoders: (encoders: string[]) => void;
  snapProf: () => void;
  updateDirty: () => void;
  resetToProfile: () => void;
  compressOne: () => Promise<void>;
  compressAll: () => Promise<void>;
  // queues the selected video again even though an export of it is already waiting or running
  compressCopy: () => Promise<void>;
  saveProfileChanges: () => Promise<void>;
  saveProfileAs: () => Promise<void>;
  onSize: (value: string) => void;
  onBadgeSize: (value: string) => void;
  onFpsSlider: (value: string) => void;
  onResolutionGeometryChanged: () => void;
  onExportResolutionChoice: (value: string) => void;
  onExportFrameRateChoice: (value: string) => void;
  onKeepAudio: () => void;
  onEncChange: () => void;
  onSpeedChange: () => void;
  onTwoPassChange: () => void;
  onNativePresetChange: () => void;
  onRcChange: () => void;
  toggleAdvanced: () => void;
}

interface ProfileRecord {
  readonly profile_id?: string;
  readonly name?: string;
  readonly workflow?: string;
  readonly transform_intent?: {
    readonly crop_aspect?: string;
    readonly rotation?: number;
    readonly sizing_mode?: string;
  } | null;
  readonly [key: string]: unknown;
}

export function installEncodingControls(deps: EncodingControlsDeps): EncodingControlsApi {
  const { session, byId, getBackendClient } = deps;
  let wf = 0;
  let encodingWf = 0;
  let lastComp = "";
  let lastUpscale = "";
  let previewRequestId = 0;
  let previewSettingsKey = "";
  let profileSnapshot = "";
  let platformCapabilities: PlatformCapabilities | null = null;

  const client = (): BackendClient => getBackendClient();
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = byId<T>(id);
    if (!found) throw new Error(`Missing #${id}`);
    return found;
  };
  const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
  const select = (id: string): HTMLSelectElement => el<HTMLSelectElement>(id);
  const profiles = (): ProfileRecord[] => session.allProfiles as ProfileRecord[];
  const availEncoders = (): string[] => session.availEncoders;
  const appSettings = (): Record<string, unknown> => session.appSettings;

  const blending = installFrameBlending(el("frame-blending-panel"), () => {
    reqPreviewAndDirty();
    updateActionButtons();
  }, () => {
    const source = Number(session.clips[session.selPath ?? ""]?.probeData?.fps) || 0;
    return { source, output: input("use-source-fps").checked ? source : Math.min(source, Number(input("fps-val").value)) };
  });

  const lut = installLutControls(el("lut-panel"), el<HTMLVideoElement>("vid"), client, (planChanged = true) => {
    if (planChanged) reqPreviewAndDirty();
    else updateDirty();
    updateActionButtons();
  });

  const cutting = installCutControls({
    session,client,request: cutRequest,
    selectSegment: deps.selectCutSegment,moveStarts: deps.moveCutStarts,
    pollQueue: deps.pollQueue,
    paintTimeline: deps.paintCutTimeline,
  });

  function cutRequest(clip: EditorClip) {
    const state = clip.cutState ??= createCutState();
    const analysis = state.analysis?.analysis;
    return buildCutRequest({clip,state,
      ...(analysis ? {frameDuration:analysis.frame_duration,duration:analysis.duration} : {}),
    });
  }

  function workflowName(): "compression" | "upscale" {
    return (wf === 2 ? encodingWf : wf) === 1 ? "upscale" : "compression";
  }

  function setWf(idx: number): void {
    if (wf === idx || ![0,1,2].includes(idx)) return;
    const previous = wf;
    if (idx === 2) encodingWf = wf;
    document.body.classList.toggle("task-cut",idx === 2);
    session.wf = idx;
    if (idx === 2 || previous === 2 && idx === encodingWf) {
      wf = idx;
      for (const [index,id] of ["wf-c","wf-u","wf-l"].entries()) {
        el(id).classList.toggle("on",idx === index);
        el(id).setAttribute("aria-pressed",String(idx === index));
      }
      cutting.setActive(idx === 2);
      updateActionButtons();
      deps.renderClips?.();
      if (idx !== 2) void reqPreview();
      void persistSession();
      return;
    }
    cutting.setActive(false);
    const curPid = select("prof-sel").value;
    if (curPid) {
      if (wf === 0 || wf === 2 && encodingWf === 0) lastComp = curPid;
      else lastUpscale = curPid;
    }
    wf = idx;
    encodingWf = idx;
    el("wf-l").classList.remove("on");
    el("wf-l").setAttribute("aria-pressed","false");
    const c = el("wf-c");
    const u = el("wf-u");
    const up = idx === 1;
    c.classList.toggle("on", !up);
    c.setAttribute("aria-pressed", String(!up));
    u.classList.toggle("on", up);
    u.setAttribute("aria-pressed", String(up));
    el("sz-grp").classList.toggle("hid", up);
    input("two-pass").disabled = up;
    el("two-pass-wrap").classList.toggle("hid", up);
    if (up) {
      select("two-pass").value = "off";
      input("use-source-res").checked = false;
      input("res-mode").value = "custom";
    } else {
      input("res-mode").value = input("use-source-res").checked ? "source" : "custom";
    }
    onResMode();
    updateRcOpts();
    updateRcVis();
    refilter();
    updateActionButtons();
    deps.renderClips?.();
    void persistSession();
  }

  async function persistSession(): Promise<void> {
    const settings = appSettings();
    if (!Object.keys(settings).length) return;
    const data: Record<string, unknown> = {
      default_profile_id: settings.default_profile_id,
      default_scaler: settings.default_scaler,
      output_dir: settings.output_dir,
      check_updates: settings.check_updates,
      clear_completed_automatically: !!settings.clear_completed_automatically,
      open_output_folder_after_queue: !!settings.open_output_folder_after_queue,
      compression_suffix: settings.compression_suffix,
      upscale_suffix: settings.upscale_suffix,
      last_task: wf === 2 ? "cut" : workflowName(),
      last_compress_profile_id: lastComp,
      last_upscale_profile_id: lastUpscale,
      left_sidebar_width: 220,
    };
    const r = await legacyBackendResult(client().saveSettings(data as never));
    if (r.ok) Object.assign(settings, data);
  }

  // the video whose plan notes are showing under the profile card
  let warningsPath: string | null = null;
  // set while an export request is with the backend, so a second press can't queue the same videos twice
  let enqueueing = false;
  // most requests return before a label could be read, so the busy state waits a moment instead of flashing
  let enqueueBusyShown = false;
  const ENQUEUE_BUSY_DELAY_MS = 250;

  function exportReadiness() {
    return probeSummary(deps.orderedClipKeys(), (path) => session.clips[path]);
  }

  // “a.mp4”, or “a.mp4” and 2 others
  function namedVideos(paths: readonly string[]): string {
    const first = paths[0];
    if (!first) return "";
    const name = `“${session.clips[first]?.name ?? first}”`;
    const others = paths.length - 1;
    return others ? `${name} and ${others} ${others === 1 ? "other" : "others"}` : name;
  }

  function allNote(readiness: ReturnType<typeof exportReadiness>): string {
    if (readiness.loading.length) return "Some videos are still being read.";
    const failed = readiness.failed;
    if (!failed.length) return "";
    // a failed read won't finish on its own, so the readable videos go ahead without it
    if (readiness.ready.length) return `${namedVideos(failed)} can’t be read and will be skipped.`;
    return `${namedVideos(failed)} can’t be read. Retry ${failed.length === 1 ? "it" : "them"} in the Library, or remove ${failed.length === 1 ? "it" : "them"}.`;
  }

  function updateActionButtons(): void {
    deps.syncFrameExport?.();
    // another video, or none, is selected now; its own plan brings its own notes
    if (warningsPath && warningsPath !== session.selPath) paintPlanWarnings(null);
    if (wf === 2) {
      el("btn-copy").hidden = true;
      cutting.render();
      return;
    }
    const up = wf === 1;
    const readiness = exportReadiness();
    const count = readiness.ready.length + readiness.loading.length + readiness.failed.length;
    const selReady = isProbeReady(session.selPath ? session.clips[session.selPath] : null);
    const allReady = readiness.ready.length > 0 && !readiness.loading.length;
    const one = el<HTMLButtonElement>("btn-one");
    const all = el<HTMLButtonElement>("btn-all");
    // the settings are shared; this button acts on the selected video only
    let label = up ? "Upscale this video" : "Compress this video";
    one.disabled = !selReady || !blending.valid() || !lut.valid() || !videoSettingsValid();
    const alreadyQueued = readiness.ready.filter((path) => isQueueActive(session.clips[path]?._queueState)).length;
    const exported = readiness.ready.length + readiness.loading.length - alreadyQueued;
    all.textContent = (up ? "Upscale all" : "Compress all") + (exported ? ` (${exported})` : "");
    all.disabled = !allReady || !blending.valid() || !lut.valid() || !videoSettingsValid();
    all.classList.toggle("upscale-batch", up);
    const selected = session.selPath ? session.clips[session.selPath] : null;
    const queued = !!selected && isQueueActive(selected._queueState);
    if (enqueueBusyShown) {
      label = "Adding to queue…";
      one.disabled = true;
      all.disabled = true;
    } else if (selected && queued) {
      // the button shows the export already on its way and opens it, so a press can't queue it twice
      label = showQueuedState(one, selected);
    } else {
      clearQueuedState(one);
    }
    swapLabel(one, label);
    const copy = el<HTMLButtonElement>("btn-copy");
    copy.hidden = !queued || enqueueBusyShown;
    copy.disabled = one.disabled && !queued;
    const note = el("btn-all-note");
    note.textContent = count > 1 ? allNote(readiness) : "";
    note.hidden = !note.textContent;
    syncExportSummary();
  }

  function syncExportSummary(): void {
    if (wf === 2) { cutting.render(); return; }
    blending.sync();
    applySectionVisibility();
    const keepAudio = input("keep-audio").checked;
    const audioBitrateKbps = input("audio-br").value;
    const speed = select("speed-sel").value;
    const videoEncoder = select("enc-sel").value;
    const summary = InspectorUi.exportSummary({
      workflow: workflowName(),
      targetSizeMb: Number(input("sz-slider").value),
      width: Number(input("res-w").value),
      height: Number(input("res-h").value),
      fps: Number(input("fps-val").value),
      videoEncoder,
      audioBitrateKbps: Number(audioBitrateKbps),
      audioEnabled: keepAudio || Number(audioBitrateKbps) > 0,
      keepAudio,
      speed,
    });
    if (document.activeElement !== input("sz-badge")) {
      input("sz-badge").value = input("sz-slider").value;
      resizeSizeInput();
    }
    el("export-summary-detail").textContent = summary.detail;
    el("export-audio-summary").textContent = InspectorUi.audioSummary({
      audioEnabled: keepAudio || Number(audioBitrateKbps) > 0,
      keepAudio,
      audioBitrateKbps: Number(audioBitrateKbps),
    });
    el("export-encoder-summary").textContent = InspectorUi.encoderPanelSummary({
      videoEncoder,
      speed,
    });
    syncExportVideoFacades();
    deps.syncSelects();
  }

  function replaceInspectorOptions(
    target: HTMLSelectElement,
    options: readonly InspectorUi.ChoiceOption[],
  ): void {
    const current = target.value;
    const unchanged =
      target.options.length === options.length &&
      options.every((choice, index) => {
        const existing = target.options[index];
        return existing?.value === choice.value && existing.textContent === choice.label;
      });
    if (unchanged) return;
    target.replaceChildren();
    for (const choice of options) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      target.appendChild(option);
    }
    if (options.some((choice) => choice.value === current)) target.value = current;
  }

  function selectedSourceVideo(): { width: number; height: number; fps: number } {
    const clip = session.selPath ? session.clips[session.selPath] : null;
    const data = clip && clip.probed && clip.probeData ? clip.probeData : null;
    return {
      width: data && data.width ? data.width : Number(input("res-w").value) || 1920,
      height: data && data.height ? data.height : Number(input("res-h").value) || 1080,
      fps: data && data.fps ? data.fps : Number(input("fps-val").value) || 30,
    };
  }

  function syncExportVideoFacades(): void {
    const resolution = byId<HTMLSelectElement>("export-res-select");
    const frameRate = byId<HTMLSelectElement>("export-fps-select");
    if (!resolution || !frameRate) return;
    const source = selectedSourceVideo();
    replaceInspectorOptions(resolution, InspectorUi.resolutionChoices(source.width, source.height));
    replaceInspectorOptions(frameRate, InspectorUi.frameRateChoices(source.fps));

    if (resolution.dataset.explicitCustom === "1") resolution.value = "custom";
    else if (input("use-source-res").checked) resolution.value = "source";
    else {
      const customResolution = `${input("res-w").value}x${input("res-h").value}`;
      resolution.value = Array.from(resolution.options).some(
        (option) => option.value === customResolution,
      )
        ? customResolution
        : "custom";
    }
    if (frameRate.dataset.explicitCustom === "1") frameRate.value = "custom";
    else if (input("use-source-fps").checked) frameRate.value = "source";
    else {
      const customFps = String(Number(input("fps-val").value) || source.fps);
      frameRate.value = Array.from(frameRate.options).some((option) => option.value === customFps)
        ? customFps
        : "custom";
    }
    el("res-cust").hidden = resolution.value !== "custom";
    el("video-custom-fps").hidden = frameRate.value !== "custom";
    const blendFps = select("blend-fps-select");
    replaceInspectorOptions(blendFps, InspectorUi.frameRateChoices(source.fps));
    blendFps.value = frameRate.value;
    input("blend-fps-input").value = input("fps-slider").value;
    input("blend-fps-input").max = input("fps-slider").max;
    el("blend-custom-fps").hidden = frameRate.value !== "custom";
    el("export-video-summary").textContent =
      resolution.value === "source" && frameRate.value === "source" ? "Source" : "Adjusted";
  }

  function onExportResolutionChoice(value: string): void {
    el("export-res-select").dataset.explicitCustom = value === "custom" ? "1" : "";
    const decision = InspectorUi.resolutionDecision(value);
    const isSource = decision.mode === "source";
    input("use-source-res").checked = isSource;
    input("res-mode").value = isSource ? "source" : "custom";
    if (decision.mode === "custom" && "width" in decision && decision.width && decision.height) {
      input("res-w").value = String(decision.width);
      input("res-h").value = String(decision.height);
    }
    if (isSource) syncResolutionToClip(true);
    onResMode();
    updateActionButtons();
    syncExportVideoFacades();
    if (value === "custom") { input("res-w").focus(); input("res-w").select(); }
  }

  function onExportFrameRateChoice(value: string): void {
    el("export-fps-select").dataset.explicitCustom = value === "custom" ? "1" : "";
    const isSource = value === "source";
    input("use-source-fps").checked = isSource;
    if (isSource) syncFpsToClip(true);
    else if (value !== "custom") onFpsSlider(value);
    updateActionButtons();
    void reqPreview();
    updateDirty();
    syncExportVideoFacades();
    if (value === "custom") { input("fps-slider").focus(); input("fps-slider").select(); }
  }

  select("blend-fps-select").addEventListener("change", () => {
    onExportFrameRateChoice(select("blend-fps-select").value);
    if (select("blend-fps-select").value === "custom") {
      input("blend-fps-input").focus(); input("blend-fps-input").select();
    } else select("blend-fps-select").focus();
  });
  input("blend-fps-input").addEventListener("input", () => onFpsSlider(input("blend-fps-input").value));

  async function loadSettings(preserveExportSettings = false): Promise<void> {
    platformCapabilities = await fetchPlatformCapabilities();
    const s = await legacyBackendResult(client().getSettings());
    void lut.refreshLibrary();
    Object.keys(session.appSettings).forEach((key) => delete session.appSettings[key]);
    Object.assign(session.appSettings, s);
    deps.restoreTimelineHeight(s.timeline_height);
    session.availEncoders.splice(
      0,
      session.availEncoders.length,
       ...encodersForPlatform(toStringArray(s.available_encoders), platformCapabilities),
    );
    session.allProfiles.splice(0, session.allProfiles.length, ...toArray(s.profiles));
    const def = typeof s.default_profile_id === "string" ? s.default_profile_id : "";
    if (!lastComp)
      lastComp = typeof s.last_compress_profile_id === "string" ? s.last_compress_profile_id || def : def;
    if (!lastUpscale)
      lastUpscale =
        typeof s.last_upscale_profile_id === "string" ? s.last_upscale_profile_id : "";
    if (s.last_task === "upscale" && !lastUpscale) lastUpscale = def;
    updateEncoderOptions();
    const hidden = hiddenParts(s.hidden_ui);
    const task = taskIndex(launchTask({start:"last", last:s.last_task, hidden}));
    if (task === 2 && wf !== 2) refilter();
    if (task !== wf) setWf(task);
    else refilter(preserveExportSettings);
    applyTaskVisibility();
    applySectionVisibility();
  }

  function applyTaskVisibility(): void {
    const visible = visibleTasks(hiddenParts(appSettings().hidden_ui));
    for (const [index, id] of ["wf-c", "wf-u", "wf-l"].entries()) {
      el(id).classList.toggle("user-hidden", !visible.includes(taskAt(index)));
    }
    // one task left needs no picker
    el("task-wf").classList.toggle("user-hidden", visible.length < 2);
    const first = visible[0];
    if (first && !visible.includes(taskAt(wf))) setWf(taskIndex(first));
  }

  // a hidden effect stays visible while it is on, so a profile never applies it unseen
  function applySectionVisibility(): void {
    const hidden = hiddenParts(appSettings().hidden_ui);
    el("frame-blending-panel").classList.toggle("user-hidden", hidden.has("frame_blending") && !blending.read().enabled);
    el("lut-panel").classList.toggle("user-hidden", hidden.has("lut") && !lut.read().enabled);
  }

  function openTask(launch: unknown, atStart: boolean): void {
    const s = appSettings();
    const task = launchTask({launch, start:atStart ? s.start_task : "last", last:taskAt(wf), hidden:hiddenParts(s.hidden_ui)});
    setWf(taskIndex(task));
    if (atStart) {
      // resolve the thumb at the starting task first, so only later switches slide
      const tabs = el("task-wf");
      void getComputedStyle(tabs, "::before").transform;
      tabs.classList.add("thumb-slides");
    }
  }

  function refilter(preserveExportSettings = false): void {
    if (wf === 2) { cutting.refresh(); return; }
    const up = wf === 1;
    const targetWf = up ? "upscale" : "compression";
    const lastId = up ? lastUpscale : lastComp;
    const s = appSettings();
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    const pinned = ids(s.pinned_profile_ids);
    const matching = pickerProfiles(
      profiles().filter((p) => (p.workflow || "compression") === targetWf),
      pinned,
      ids(s.hidden_profile_ids),
      lastId ?? "",
    );
    const sel = select("prof-sel");
    const previousId = sel.value;
    sel.replaceChildren();
    if (!matching.length) {
      renderProfileCard();
      updateActionButtons();
      return;
    }
    let selectedIndex = 0;
    matching.forEach((profile, index) => {
      const option = document.createElement("option");
      option.value = profile.profile_id ?? "";
      option.textContent = profile.name ?? "";
      sel.appendChild(option);
      if (lastId && profile.profile_id === lastId) selectedIndex = index;
    });
    sel.selectedIndex = Math.max(selectedIndex, 0);
    // saving preferences must not replace the current export edits with the saved profile
    if (preserveExportSettings && sel.value === previousId) updateDirty();
    else applyProfile();
    void reqPreview();
  }

  function onProfileChange(): void {
    const pid = select("prof-sel").value;
    if (pid) {
      if (wf === 0) lastComp = pid;
      else lastUpscale = pid;
    }
    applyProfile();
    void reqPreview();
    void persistSession();
  }

  function selectedProfile(): ProfileRecord | null {
    const pid = select("prof-sel").value;
    return profiles().find((profile) => profile.profile_id === pid) ?? null;
  }

  function applyProfileTransformToClip(
    profile: ProfileRecord | null,
    clip: EditorClip | null | undefined,
    force: boolean,
  ): void {
    if (!clip || (!force && clip.transformOverride)) return;
    const intent = profile && profile.transform_intent;
    clip.cropAspect = intent ? intent.crop_aspect || "off" : "off";
    clip.rotation = intent ? intent.rotation || 0 : 0;
    clip.sizingMode = intent ? intent.sizing_mode || "fit" : "fit";
    clip.flipHorizontal = false;
    clip.flipVertical = false;
    clip.crop = null;
    if (
      clip.cropAspect !== "free" &&
      clip.cropAspect !== "off" &&
      clip.probed &&
      clip.probeData
    ) {
      clip.crop = cropForAspect(
        null,
        clip.cropAspect,
        Number(clip.probeData.width) || 0,
        Number(clip.probeData.height) || 0,
        clip.rotation,
      );
      if (
        clip.crop &&
        isFullCrop(clip.crop, Number(clip.probeData.width) || 0, Number(clip.probeData.height) || 0)
      )
        clip.crop = null;
    }
    clip.transformOverride = false;
    clip.transformIntentTouched = false;
    clip.planData = null;
  }

  function applySelectedProfileTransform(
    clip: EditorClip | null | undefined,
    force?: boolean,
  ): void {
    applyProfileTransformToClip(selectedProfile(), clip, !!force);
  }

  // applies the chosen profile, or the given settings in its place
  function applyProfile(forceTransform?: boolean, settings?: ProfileRecord): void {
    const pid = select("prof-sel").value;
    if (!pid) return;
    const p = settings ?? profiles().find((profile) => profile.profile_id === pid);
    if (!p) return;
    for (const path of Object.keys(session.clips)) {
      applyProfileTransformToClip(p, session.clips[path], !!forceTransform);
    }
    blending.apply(p.frame_blending);
    lut.apply(p.lut);
    applySectionVisibility();
    const sizeMb = Math.round((num(p.target_size_bytes) || 0) / (1024 * 1024));
    input("sz-slider").value = String(sizeMb);
    input("sz-badge").value = String(sizeMb);
    updateSizePresets(sizeMb);
    el("export-res-select").dataset.explicitCustom = "";
    input("res-mode").value = p.resolution_mode === "custom" ? "custom" : "source";
    input("use-source-res").checked = wf === 0 && p.resolution_mode !== "custom";
    input("res-w").value = String(num(p.custom_width) || num(p.max_width) || 1920);
    input("res-h").value = String(num(p.custom_height) || num(p.max_height) || 1080);
    syncResolutionToClip();
    onResMode();
    const useSourceFps = p.fps_mode !== "custom";
    input("use-source-fps").checked = useSourceFps;
    let fpsVal = (num(p.custom_fps) || num(p.max_fps) || 30);
    const selClip = session.selPath ? session.clips[session.selPath] : undefined;
    const clipMax =
      selClip && selClip.probed
        ? (num(selClip.probeData?.fps) || fpsVal)
        : fpsVal;
    input("fps-slider").max = String(clipMax);
    if (fpsVal > clipMax) fpsVal = clipMax;
    input("fps-slider").value = String(fpsVal);
    input("fps-val").value = String(fpsVal);
    onUseSourceFps();
    input("keep-audio").checked = !!p.keep_audio;
    input("audio-br").value = String(Math.round((num(p.audio_bitrate) || 128000) / 1000));
    input("audio-br").disabled = !!p.keep_audio;
    select("two-pass").value = p.two_pass ? "on" : "off";
    const sc = typeof p.scaler === "string" ? p.scaler : "neighbor";
    select("scaler-sel").value =
      sc === "neighbor" ? "Neighbor" : sc.charAt(0).toUpperCase() + sc.slice(1);
    const profileEncoder = typeof p.video_encoder === "string" ? p.video_encoder : "libx264";
    select("enc-sel").value = platformCapabilities
      ? encoderForPlatform(profileEncoder, platformCapabilities)
      : profileEncoder;
    if (!select("enc-sel").value) select("enc-sel").selectedIndex = 0;
    updateTuneOptions();
    const tune = typeof p.tune === "string" ? p.tune : "none";
    const tuneSelect = select("tune-sel");
    for (let i = 0; i < tuneSelect.options.length; i += 1) {
      if (tuneSelect.options[i]?.value === tune) {
        tuneSelect.selectedIndex = i;
        break;
      }
    }
    input("quality-val").value = String(
      p.rate_control_method === "crf" ? num(p.crf) || 23 : num(p.cq) || num(p.qp) || 23,
    );
    input("br-val").value = String(
      num(p.explicit_bitrate_kbps) ||
        Math.round((num(p.explicit_bitrate) || 0) / 1000) ||
        2000,
    );
    updatePresetOptions();
    const preset =
      typeof p.preset === "string"
        ? p.preset
        : nativePresetForSpeed("balanced", select("enc-sel").value);
    select("preset-sel").value = preset;
    if (!select("preset-sel").value)
      select("preset-sel").value = nativePresetForSpeed("balanced", select("enc-sel").value);
    syncSpeedFromPreset();
    updateRcOpts();
    const rcMap: Record<string, RateControlDisplay> = {
      crf: "CRF",
      cq: "CQ",
      cqp: "CQ",
      cbr: "CBR",
      vbr: "VBR",
    };
    const rcDisp = rcMap[String(p.rate_control_method)] ?? "CRF";
    const rcSelect = select("rc-sel");
    for (let i = 0; i < rcSelect.options.length; i += 1) {
      if (rcSelect.options[i]?.value === rcDisp) {
        rcSelect.selectedIndex = i;
        break;
      }
    }
    updateRcVis();
    deps.syncTransformControls();
    deps.paintCropOverlay();
    snapProf();
  }

  const SIZE_PREVIEW_DELAY_MS = 120;
  let sizePreviewTimer: ReturnType<typeof setTimeout> | undefined;

  function onSize(value: string): void {
    const size = parseInt(value, 10);
    if (!size || size < 2) return;
    input("sz-badge").value = String(size);
    input("sz-slider").max = String(Math.max(500, size));
    input("sz-slider").value = String(size);
    input("sz-slider").setAttribute("aria-valuenow", String(size));
    input("sz-slider").setAttribute("aria-valuemax", input("sz-slider").max);
    updateSizePresets(size);
    resizeSizeInput();
    // a drag sends a value for every pixel; the plan waits for a short pause instead
    clearTimeout(sizePreviewTimer);
    sizePreviewTimer = setTimeout(() => void reqPreview(), SIZE_PREVIEW_DELAY_MS);
    updateDirty();
  }

  function onBadgeSize(value: string): void {
    const size = parseInt(value, 10);
    if (!size || size < 2) {
      input("sz-badge").value = input("sz-slider").value;
      resizeSizeInput();
      return;
    }
    onSize(String(size));
  }

  function updateSizePresets(value: number): void {
    const container = el("sz-presets");
    container.replaceChildren();
    for (const mb of InspectorUi.sizePresets()) {
      const button = document.createElement("button");
      button.textContent = String(mb);
      button.setAttribute("aria-label", `${mb} MB`);
      button.setAttribute("aria-pressed", String(mb === value));
      if (mb === value) button.classList.add("on");
      button.addEventListener("click", () => {
        input("sz-slider").value = String(mb);
        onSize(String(mb));
      });
      container.appendChild(button);
    }
  }

  function videoSettingsValid(): boolean {
    let error = "";
    if (!input("use-source-res").checked && (!input("res-w").validity.valid || !input("res-h").validity.valid)) {
      error = "Enter a width and height of at least 2 pixels.";
    } else if (!input("use-source-fps").checked && !input("fps-slider").validity.valid) {
      error = `Enter an FPS from 0.1 to ${input("fps-slider").max || selectedSourceVideo().fps}.`;
    }
    el("video-error").textContent = error;
    el("video-error").hidden = !error;
    return !error;
  }

  function onResMode(): void {
    const isSource = input("res-mode").value === "source";
    select("scaler-sel").disabled = isSource;
    deps.paintCropOverlay();
    void reqPreview();
    updateDirty();
  }

  function onResolutionGeometryChanged(): void {
    input("use-source-res").checked = false;
    input("res-mode").value = "custom";
    select("scaler-sel").disabled = false;
    el("export-res-select").dataset.explicitCustom = "1";
    updateActionButtons();
    deps.paintCropOverlay();
    void reqPreview();
    updateDirty();
  }

  function syncResolutionToClip(forceSourceValue?: boolean): void {
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    if (!clip || !clip.probed || !clip.probeData) return;
    if (forceSourceValue || input("use-source-res").checked) {
      input("res-w").value = String(clip.probeData.width || 1920);
      input("res-h").value = String(clip.probeData.height || 1080);
    }
  }

  function onUseSourceFps(): void {
    el("export-fps-select").dataset.explicitCustom = "";
    if (input("use-source-fps").checked) syncFpsToClip(true);
    void reqPreview();
    updateDirty();
  }

  function onFpsSlider(value: string): void {
    input("use-source-fps").checked = false;
    input("fps-val").value = value;
    input("fps-slider").value = value;
    updateActionButtons();
    void reqPreview();
    updateDirty();
  }

  function syncFpsToClip(forceSourceValue?: boolean): void {
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    if (!clip || !clip.probed || !clip.probeData) return;
    const native = Number(clip.probeData.fps) || 30;
    input("fps-slider").max = String(native);
    let cur =
      forceSourceValue || input("use-source-fps").checked
        ? native
        : Number(input("fps-val").value) || native;
    if (cur > native) cur = native;
    input("fps-slider").value = String(cur);
    input("fps-val").value = String(cur);
  }

  function onKeepAudio(): void {
    input("audio-br").disabled = input("keep-audio").checked;
    void reqPreview();
    updateDirty();
  }

  function onTwoPassChange(): void {
    void reqPreview();
    updateDirty();
  }

  function toggleAdvanced(): void {
    const section = el("adv-sec");
    const open = section.classList.contains("hid");
    section.classList.toggle("hid", !open);
    el("adv-toggle").setAttribute("aria-expanded", String(open));
  }

  function onEncChange(): void {
    updatePresetOptions();
    if (select("enc-sel").value === "auto_compression") {
      select("two-pass").value = "on";
      select("preset-sel").value = "veryslow";
    }
    updateTuneOptions();
    updateRcOpts();
    gateTwoPass();
    void reqPreview();
    updateDirty();
  }

  function onRcChange(): void {
    updateRcVis();
    void reqPreview();
    updateDirty();
  }

  function updateEncoderOptions(): void {
    const caps = platformCapabilities;
    populateEncoderSelect(
      select("enc-sel"),
      caps ? encodersForPlatform(availEncoders(), caps) : availEncoders(),
      caps ? supportsHardwareEncoders(caps) : true,
    );
  }

  function updateTuneOptions(): void {
    populateTuneSelect(select("tune-sel"), select("enc-sel").value);
  }

  function updatePresetOptions(): void {
    populatePresetSelect(select("preset-sel"), select("enc-sel").value, select("speed-sel").value);
  }

  function onSpeedChange(): void {
    select("preset-sel").value = nativePresetForSpeed(
      select("speed-sel").value,
      select("enc-sel").value,
    );
    void reqPreview();
    updateDirty();
  }

  function onNativePresetChange(): void {
    syncSpeedFromPreset();
    void reqPreview();
    updateDirty();
  }

  function syncSpeedFromPreset(): void {
    select("speed-sel").value = speedForNativePreset(select("preset-sel").value);
  }

  function updateRcOpts(): void {
    populateRateControlSelect(select("rc-sel"), workflowName(), select("enc-sel").value);
    updateRcVis();
  }

  function updateRcVis(): void {
    const rc = select("rc-sel").value;
    const up = wf === 1;
    const quality = up && (rc === "CRF" || rc === "CQ");
    el("rate-control-row").classList.toggle("hid", !up);
    el("quality-row").classList.toggle("hid", !quality);
    el("quality-label").textContent = rc === "CRF" ? "CRF value" : "CQ value";
    el("br-row").classList.toggle("hid", !(up && (rc === "CBR" || rc === "VBR")));
    el("tune-row").classList.toggle("hid", !(up && isCpuEncoder(select("enc-sel").value)));
  }

  function gateTwoPass(): void {
    const can = twoPassEligible(workflowName(), select("enc-sel").value);
    select("two-pass").disabled = !can;
    el("two-pass-note").classList.toggle("hid", can || wf === 1);
    if (!can) select("two-pass").value = "off";
  }

  function readForm(): ExportFormState {
    return {
      workflow: workflowName(),
      profileId: select("prof-sel").value,
      targetSizeMb: parseInt(input("sz-slider").value, 10) || 0,
      resolutionMode: input("res-mode").value === "custom" ? "custom" : "source",
      customWidth: parseInt(input("res-w").value, 10) || 0,
      customHeight: parseInt(input("res-h").value, 10) || 0,
      scaler: select("scaler-sel").value,
      useSourceFps: input("use-source-fps").checked,
      customFps: Number(input("fps-val").value),
      frameBlending: blending.read(),
      lut: lut.read(),
      keepAudio: input("keep-audio").checked,
      audioBitrateKbps: parseInt(input("audio-br").value, 10) || 0,
      twoPass: select("two-pass").value === "on",
      encoder: platformCapabilities
        ? encoderForPlatform(select("enc-sel").value, platformCapabilities)
        : select("enc-sel").value,
      preset: select("preset-sel").value,
      rateControl: (select("rc-sel").value as RateControlDisplay) || "CBR",
      qualityValue: parseInt(input("quality-val").value, 10) || 0,
      bitrateKbps: parseInt(input("br-val").value, 10) || 0,
      tune: select("tune-sel").value,
    };
  }

  function buildRequest(source: string, requestId?: number): Record<string, unknown> {
    const form = readForm();
    const clip = session.clips[source];
    let segments: { start: number; end: number }[] | null = null;
    let transform: CropTransform | null = null;
    let audioPayload: Record<string, unknown> | null = null;
    if (clip) {
      const full = num(clip.probeData?.duration) || 0;
      const edited =
        (clip.segments && clip.segments.length) ||
        clip.trimStart != null ||
        clip.trimEnd != null;
      if (full > 0 && edited) {
        segments = SegmentEditing.segmentsForClip(clip, full).map((segment) => ({
          start: segment.start,
          end: segment.end,
        }));
      }
      const profile = selectedProfile();
      if (clip.transformOverride || !profile || !profile.transform_intent) {
        transform = deps.cropTransformForRequest(clip);
      }
      audioPayload = deps.audioRequestPayload(clip);
    }
    return buildPlanRequest(form, {
      source,
      ...(requestId !== undefined ? { requestId } : {}),
      segments,
      transform,
      audioPayload,
      ...(platformCapabilities ? { platformCapabilities } : {}),
    });
  }

  // the selected video's plan notes, shown under the profile card; nothing shows while it is replanned
  function paintPlanWarnings(plan: unknown, path: string | null = null): void {
    const list = el("export-plan-warnings");
    const warnings = planWarnings(plan);
    warningsPath = warnings.length ? path : null;
    list.replaceChildren(...warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    }));
    list.hidden = !warnings.length;
  }

  async function reqPreview(): Promise<void> {
    if (wf === 2) { cutting.refresh(); return; }
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    paintPlanWarnings(null);
    if (!clip || !clip.probed) return;
    if (!videoSettingsValid() || !lut.valid()) {
      clip.planData = null;
      // settings that can't be planned have no estimate, so no placeholder waits for one
      clip._hadEstimate = false;
      delete clip._previewRequestId;
      return;
    }
    const settingsKey = JSON.stringify(buildPlanRequest(readForm(), { source: "" }));
    if (settingsKey !== previewSettingsKey) {
      // export controls apply to every video, including plans still being calculated
      for (const video of Object.values(session.clips)) {
        video.planData = null;
        delete video._previewRequestId;
      }
      previewSettingsKey = settingsKey;
      // an estimate for the old settings would be wrong, so rows drop it until the new plan lands
      deps.renderClips?.();
    }
    const requestId = (previewRequestId += 1);
    clip._previewRequestId = requestId;
    clip.planData = null;
    deps.paintCropOverlay();
    const req = buildRequest(path as string, requestId);
    try {
      const r = await legacyBackendResult(client().createPlan(req as never));
      const data = r.data as Record<string, unknown> | undefined;
      if (session.selPath === path && clip._previewRequestId === requestId) {
        const message = r.ok ? "" : r.error ?? "Could not prepare these settings.";
        const field = r.details?.field;
        lut.setBackendError(field === "lut" ? message : "");
        blending.setBackendError(field === "frame_blending" ? message : "");
        const generalError = el("export-plan-error");
        generalError.textContent = field === "lut" || field === "frame_blending" ? "" : message;
        generalError.hidden = !generalError.textContent;
        if (!r.ok) {
          clip._hadEstimate = false;
          deps.renderClips?.();
        }
      }
      if (
        r.ok &&
        data &&
        session.clips[path as string] === clip &&
        clip._previewRequestId === requestId &&
        r._request_id === requestId
      ) {
        clip.planData = data;
        if (session.selPath !== path) return;
        paintPlanWarnings(data, path);
        deps.renderClips?.();
        deps.paintCropOverlay();
        void planLibrary();
      }
    } catch {
      /* preview failures are non-fatal */
    }
  }

  // one plan at a time, after the selected video's; a newer run or changed settings retire an older one
  let libraryPlanRun = 0;

  async function planLibrary(): Promise<void> {
    if (wf === 2 || !videoSettingsValid() || !lut.valid()) return;
    const run = (libraryPlanRun += 1);
    const settingsKey = previewSettingsKey;
    for (const path of session.clipOrder.slice()) {
      if (run !== libraryPlanRun || wf === 2 || settingsKey !== previewSettingsKey) return;
      const clip = session.clips[path];
      if (!clip || path === session.selPath || !clip.probed || clip.error || clip.planData) continue;
      const requestId = (previewRequestId += 1);
      clip._previewRequestId = requestId;
      try {
        const r = await legacyBackendResult(client().createPlan(buildRequest(path, requestId) as never));
        if (
          r.ok &&
          r.data &&
          settingsKey === previewSettingsKey &&
          session.clips[path] === clip &&
          clip._previewRequestId === requestId &&
          r._request_id === requestId
        ) {
          clip.planData = r.data as Record<string, unknown>;
          deps.renderClips?.();
        }
      } catch {
        // a row without an estimate still lists fine
      }
    }
  }

  function reqPreviewAndDirty(): void {
    void reqPreview();
    updateDirty();
  }

  function showQueuedState(button: HTMLButtonElement, clip: EditorClip): string {
    const label = queuedVideoLabel(clip._queueState, clip._statusText, clip._progress, clip._progressIndeterminate);
    button.disabled = false;
    button.dataset.queued = "true";
    button.dataset.tip = "Show in Exports";
    button.setAttribute("aria-label", `${label}. Show in Exports`);
    return label;
  }

  function clearQueuedState(button: HTMLButtonElement): void {
    if (button.dataset.queued !== "true") return;
    delete button.dataset.queued;
    delete button.dataset.tip;
    button.removeAttribute("aria-label");
  }

  function closeExportMenu(): void {
    document.querySelector<HTMLDetailsElement>("#right-foot .export-actions")?.removeAttribute("open");
  }

  async function compressOne(): Promise<void> {
    const selected = session.selPath ? session.clips[session.selPath] : undefined;
    if (selected && isQueueActive(selected._queueState)) {
      deps.showExport?.(selected._queueItemId ?? "");
      return;
    }
    if (wf === 2) { await cutting.exportCuts(false); return; }
    await enqueueSelected(false);
  }

  async function compressCopy(): Promise<void> {
    closeExportMenu();
    if (wf === 2) return;
    await enqueueSelected(true);
  }

  async function enqueueSelected(copy: boolean): Promise<void> {
    if (enqueueing) return;
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    if (!clip) {
      toast("Select a video first.", "err");
      return;
    }
    if (!isProbeReady(clip)) {
      toast(clip.error
        ? `Tuck can’t read “${clip.name}”. Select Retry on it in the Library, then export.`
        : `“${clip.name}” is still being read. Export it once it’s ready.`, "err");
      return;
    }
    await whileEnqueueing(async () => {
      const r = await legacyBackendResult(
        client().enqueueWithOptions(buildRequest(clip.path) as never),
      );
      if (!r.ok && r.code === "BACKEND_TIMEOUT") {
        // the request may still have reached the queue, so it is checked before being called a failure
        await deps.pollQueue();
        if (!isQueueActive(clip._queueState)) {
          toast(`Tuck didn’t hear back about “${clip.name}”, and it isn’t in the queue yet. Check Exports before exporting it again.`, "err");
        }
        return;
      }
      if (!r.ok) toast(withReason(`Couldn’t add “${clip.name}” to the queue.`, r.error), "err");
      else if (copy) toast(`Added another copy of “${clip.name}”. It gets its own file name.`, "info");
    });
    void deps.pollQueue();
  }

  async function whileEnqueueing(request: () => Promise<void>): Promise<void> {
    enqueueing = true;
    const focused = document.activeElement;
    const timer = setTimeout(() => {
      enqueueBusyShown = true;
      updateActionButtons();
    }, ENQUEUE_BUSY_DELAY_MS);
    try {
      await request();
    } finally {
      clearTimeout(timer);
      const wasShown = enqueueBusyShown;
      enqueueing = false;
      enqueueBusyShown = false;
      updateActionButtons();
      // disabling the button dropped its focus; give it back so keyboard users stay in place
      if (wasShown && focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body) {
        focused.focus();
      }
    }
  }

  // the backend names each file in its reasons; a long list is cut short rather than flooding
  function enqueueReasons(errors: readonly string[]): string {
    const shown = errors.slice(0, 2).map(reasonSentence).join(" ");
    const more = errors.length - 2;
    return more > 0 ? `${shown} And ${more} more.` : shown;
  }

  async function compressAll(): Promise<void> {
    closeExportMenu();
    if (wf === 2) { await cutting.exportCuts(true); return; }
    if (enqueueing) return;
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const readiness = exportReadiness();
    if (!readiness.ready.length && !readiness.loading.length && !readiness.failed.length) {
      toast("Add videos first.", "err");
      return;
    }
    if (readiness.loading.length) {
      toast("Some videos are still being read. Export them all once they’re ready.", "err");
      return;
    }
    if (!readiness.ready.length) {
      toast(`Tuck can’t read ${namedVideos(readiness.failed)}. Retry in the Library, or remove ${readiness.failed.length === 1 ? "it" : "them"}.`, "err");
      return;
    }
    // videos that can't be read are skipped; the note under the button already says which.
    // videos already waiting or exporting are skipped too, so Compress all never doubles them
    const alreadyQueued = readiness.ready.filter((path) => isQueueActive(session.clips[path]?._queueState));
    const toQueue = readiness.ready.filter((path) => !alreadyQueued.includes(path));
    if (!toQueue.length) {
      toast(alreadyQueued.length === 1 ? "That video is already in the queue." : "These videos are already in the queue.", "info");
      return;
    }
    const requests = toQueue.map((path) => buildRequest(session.clips[path]!.path) as never);
    await whileEnqueueing(async () => {
      const r = await legacyBackendResult(client().enqueueBatch(requests));
      const errors = toStringArray(r.errors);
      if (!r.ok && r.code === "BACKEND_TIMEOUT") {
        await deps.pollQueue();
        const arrived = toQueue.filter((path) => isQueueActive(session.clips[path]?._queueState)).length;
        if (arrived < toQueue.length) {
          toast(`Tuck didn’t hear back. ${arrived} of ${toQueue.length} videos are in the queue. Check Exports before exporting the rest again.`, "err");
        }
        return;
      }
      if (!r.ok) {
        toast(errors.length
          ? `No videos were added to the queue. ${enqueueReasons(errors)}`
          : withReason("Couldn’t add the videos to the queue.", r.error), "err");
      } else if (errors.length) {
        toast(`${errors.length} of ${requests.length} videos weren’t added to the queue. ${enqueueReasons(errors)}`, "err");
      } else if (alreadyQueued.length) {
        const added = requests.length;
        toast(`Added ${added} ${added === 1 ? "video" : "videos"}. ${alreadyQueued.length} ${alreadyQueued.length === 1 ? "was" : "were"} already in the queue.`, "info");
      }
    });
    void deps.pollQueue();
  }

  function currentProfileName(): string {
    const sel = select("prof-sel");
    const label = sel.selectedOptions[0]?.textContent ?? "";
    return label.split(" (")[0]!.trim();
  }

  function profilePayload(name: string): Record<string, unknown> {
    const clip = session.selPath ? session.clips[session.selPath] : null;
    return buildProfilePayload(readForm(), {
      name,
      currentProfile: selectedProfile(),
      clip: clip
        ? {
            cropAspect: clip.cropAspect,
            rotation: clip.rotation,
            sizingMode: clip.sizingMode,
            transformIntentTouched: clip.transformIntentTouched,
          }
          : null,
      ...(platformCapabilities ? { platformCapabilities } : {}),
    });
  }

  async function saveProfileChanges(): Promise<void> {
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const pid = select("prof-sel").value;
    if (!pid) {
      toast("Select a profile.", "err");
      return;
    }
    const name = currentProfileName();
    const r = await legacyBackendResult(client().updateProfile(pid, profilePayload(name) as never));
    if (r.ok) {
      const clip = session.selPath ? session.clips[session.selPath] : null;
      if (clip) {
        clip.transformOverride = false;
        clip.transformIntentTouched = false;
      }
      await loadSettings();
      snapProf();
      toast(`Changes saved to "${name}".`, "ok");
    } else {
      toast(withReason(`Couldn’t save changes to “${name}”.`, r.error), "err");
    }
  }

  // a name typed and then dismissed with Escape or a click outside is kept for next time;
  // only Cancel or a successful save clears it
  let profileNameDraft = "";

  function saveProfileAs(): Promise<void> {
    let cancelled = false;
    showMod(
      `<h2 id="sp-title">Save profile as</h2>
    <div>
      <label for="sp-name">Profile name</label>
      <input type="text" id="sp-name" placeholder="My profile" autocomplete="off">
      <p class="mod-field-error" id="sp-error" hidden></p>
    </div>
    <div class="confirm-actions">
      <button type="button" class="btn2" id="sp-cancel">Cancel</button>
      <button type="button" class="btn1" id="sp-save">Save</button>
    </div>`,
      {
        labelledBy: "sp-title",
        onClose: () => {
          profileNameDraft = cancelled ? "" : byId<HTMLInputElement>("sp-name")?.value ?? "";
        },
      },
    );
    const nameInput = byId<HTMLInputElement>("sp-name");
    if (nameInput) {
      nameInput.value = profileNameDraft;
      nameInput.select();
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void doSaveAs();
      });
      nameInput.addEventListener("input", () => showNameError(""));
    }
    byId("sp-cancel")?.addEventListener("click", () => {
      cancelled = true;
      closeMod();
    });
    byId("sp-save")?.addEventListener("click", () => void doSaveAs());
    return Promise.resolve();
  }

  function showNameError(message: string): void {
    const error = byId("sp-error");
    const nameInput = byId<HTMLInputElement>("sp-name");
    if (!error || !nameInput) return;
    error.textContent = message;
    error.hidden = !message;
    if (message) {
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.setAttribute("aria-describedby", "sp-error");
    } else {
      nameInput.removeAttribute("aria-invalid");
      nameInput.removeAttribute("aria-describedby");
    }
  }

  async function doSaveAs(): Promise<void> {
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const name = (byId<HTMLInputElement>("sp-name")?.value ?? "").trim();
    if (!name) {
      showNameError("Enter a name for the profile.");
      byId<HTMLInputElement>("sp-name")?.focus();
      return;
    }
    closeMod();
    const r = await legacyBackendResult(client().createProfile(profilePayload(name) as never));
    if (r.ok) {
      profileNameDraft = "";
      await loadSettings();
      snapProf();
      toast(`Profile saved as “${name}”.`, "ok");
    } else {
      toast(withReason(`Couldn’t save “${name}”.`, r.error), "err");
    }
  }

  function profileControlState(): Record<string, string | number | boolean> {
    const clip = session.selPath ? session.clips[session.selPath] : undefined;
    const value = (id: string): string => byId<HTMLInputElement | HTMLSelectElement>(id)?.value ?? "";
    const checked = (id: string): boolean => byId<HTMLInputElement>(id)?.checked ?? false;
    // while size and frame rate follow the source they come from the video, not the profile
    const sourceSize = value("res-mode") === "source";
    return {
      pid: value("prof-sel"),
      blending: JSON.stringify(blending.read()),
      lut: JSON.stringify(lut.read()),
      size: value("sz-slider"),
      rm: value("res-mode"),
      rw: sourceSize ? "" : value("res-w"),
      rh: sourceSize ? "" : value("res-h"),
      fps: checked("use-source-fps") ? "source" : value("fps-val"),
      ka: checked("keep-audio"),
      abr: value("audio-br"),
      tp: value("two-pass"),
      pre: value("preset-sel"),
      sc: value("scaler-sel"),
      enc: value("enc-sel"),
      rc: value("rc-sel"),
      q: value("quality-val"),
      br: value("br-val"),
      tu: value("tune-sel"),
      aspect: clip?.cropAspect ?? "off",
      rotation: clip?.rotation ?? 0,
      sizing: clip?.sizingMode ?? "fit",
    };
  }

  function isProfileChanged(): boolean {
    return !!profileSnapshot && profileSnapshot !== JSON.stringify(profileControlState());
  }

  function updateDirty(): void {
    renderProfileCard();
    syncExportSummary();
  }

  // the card names the profile in use and says what it does, or what was changed from it
  function renderProfileCard(): void {
    const profile = selectedProfile();
    const name = currentProfileName() || "No profile";
    const changed = !!profile && isProfileChanged();
    const changes = el("prof-changed");
    const returnFocus = !changed && changes.contains(document.activeElement);
    el("prof-name").textContent = name;
    el("prof-pick").setAttribute("aria-label", `Profile: ${name}`);
    el("prof-card").classList.toggle("changed", changed);
    const summary = changed
      ? profileChangeSummary(JSON.parse(profileSnapshot) as Record<string, unknown>, profileControlState())
      : profile ? profileSummary(profile, { includeTargetSize: false }) : "Current settings";
    el("prof-sub").textContent = changed ? "Unsaved changes" : summary.charAt(0).toUpperCase() + summary.slice(1);
    el("prof-sub").title = summary;
    changes.hidden = !changed;
    if (returnFocus) el("prof-pick").focus({ preventScroll: true });
  }

  const profileMenu = el("prof-menu");
  const profileHeader = el("prof-card");
  const profilePick = el("prof-pick");
  const profileSearch = el<HTMLInputElement>("prof-search");
  const profileSearchRow = profileSearch.parentElement!;
  let profileTyped = "";
  let profileLastTyped = 0;

  function profileOptionRows(): HTMLElement[] {
    return [...el("prof-options").querySelectorAll<HTMLElement>('[role="option"]')].filter(row => !row.hidden);
  }

  // one row is lit at a time; a row lit by the pointer goes dark when it leaves, one lit by the
  // keyboard stays, and the checkmark alone marks the chosen profile
  let profilePointerActive = false;
  let profilePointerX = NaN;
  let profilePointerY = NaN;
  function profileMenuItems(): HTMLElement[] {
    return [...profileMenu.querySelectorAll<HTMLElement>('[role="option"], .profile-menu-cmd')];
  }
  function setProfileActive(row: HTMLElement | null, byPointer: boolean): void {
    profilePointerActive = byPointer && row !== null;
    for (const item of profileMenuItems()) item.toggleAttribute("data-active", item === row);
  }
  function clearProfilePointer(): void {
    setProfileActive(null, false);
    // focus waits on the menu itself, so the keyboard keeps working and nothing looks chosen
    if (document.activeElement !== profileSearch) profileMenu.focus({ preventScroll: true });
  }

  function focusProfileItem(item: HTMLElement | undefined): void {
    if (!item) return;
    setProfileActive(profileMenuItems().includes(item) ? item : null, false);
    item.focus({ preventScroll: true });
    // reveal the focused item without moving the Inspector behind the menu
    const bounds = item.getBoundingClientRect();
    const viewport = profileMenu.getBoundingClientRect();
    if (bounds.top < viewport.top + 6) profileMenu.scrollTop -= viewport.top + 6 - bounds.top;
    else if (bounds.bottom > viewport.bottom - 6) profileMenu.scrollTop += bounds.bottom - viewport.bottom + 6;
  }

  function renderProfileMenu(): void {
    el("prof-options").setAttribute("aria-label", wf === 1 ? "Upscale profiles" : "Compress profiles");
    profileSearchRow.hidden = select("prof-sel").options.length < selectSearchThreshold;
    const current = select("prof-sel").value;
    const changed = isProfileChanged();
    const pinnedValue = appSettings().pinned_profile_ids;
    const pinnedIds = new Set(Array.isArray(pinnedValue) ? pinnedValue : []);
    const rows = [...select("prof-sel").options].map((option, index) => {
      const row = document.createElement("div");
      row.className = "profile-option";
      row.id = `prof-option-${index}`;
      row.setAttribute("role", "option");
      row.tabIndex = -1;
      row.dataset.actionClick = "profile-choose";
      row.dataset.profileId = option.value;
      const selected = option.value === current;
      row.setAttribute("aria-selected", String(selected));
      // pinned profiles lead the list; a rule sets them apart from the rest
      row.classList.toggle("pinned", pinnedIds.has(option.value));
      const name = document.createElement("span");
      name.className = "profile-option-name";
      name.id = `${row.id}-name`;
      name.textContent = option.textContent ?? "";
      const note = document.createElement("span");
      note.className = "profile-option-note";
      note.id = `${row.id}-note`;
      const profile = profiles().find((entry) => entry.profile_id === option.value);
      row.title = profile ? `${option.textContent}: ${profileSummary(profile)}` : option.textContent ?? "";
      note.textContent = profile ? profileSummary(profile) : "";
      if (selected && changed) {
        row.classList.add("changed");
        note.textContent = `Changed, not saved · ${note.textContent}`;
      }
      row.setAttribute("aria-labelledby", name.id);
      row.setAttribute("aria-describedby", note.id);
      const copy = document.createElement("span");
      copy.className = "profile-option-copy";
      copy.append(name, note);
      row.append(copy);
      return row;
    });
    el("prof-options").replaceChildren(...rows);
    // the rule only shows when there are profiles on both sides of it
    const lastPinned = rows.filter((row) => row.classList.contains("pinned")).at(-1);
    if (lastPinned && lastPinned !== rows.at(-1)) lastPinned.classList.add("pinned-last");
    filterProfiles();
  }

  function filterProfiles(): void {
    const query = profileSearchRow.hidden ? "" : profileSearch.value.trim().toLocaleLowerCase();
    for (const row of el("prof-options").querySelectorAll<HTMLElement>('[role="option"]')) {
      row.hidden = !`${row.textContent ?? ""} ${row.title}`.toLocaleLowerCase().includes(query);
    }
    el("prof-empty").hidden = profileOptionRows().length > 0;
  }

  function positionProfileMenu(): void {
    if (!profilePick.getClientRects().length) { closeProfileMenu(false); return; }
    // cover the target with the menu while keeping the shared header visible
    const anchor = profileHeader.getBoundingClientRect();
    if (anchor.bottom < 8 || anchor.top > window.innerHeight - 8) { closeProfileMenu(false); return; }
    profileMenu.style.width = `${anchor.width}px`;
    const placement = selectPopupPlacement(anchor,
      Math.min(profileMenu.scrollHeight, 380), window.innerWidth, window.innerHeight, 0);
    const side = placement.top < anchor.top ? "above" : "below";
    profileMenu.dataset.side = side;
    profileHeader.dataset.menuSide = side;
    profileMenu.style.left = `${placement.left}px`;
    profileMenu.style.top = `${placement.top}px`;
    profileMenu.style.width = `${placement.width}px`;
    profileMenu.style.maxHeight = `${placement.maxHeight}px`;
  }

  function openProfileMenu(searchFocus = false, byPointer = false): void {
    if (!profileMenu.hidden) return;
    profileTyped = "";
    profileLastTyped = 0;
    profileSearch.value = "";
    renderProfileMenu();
    profileMenu.hidden = false;
    profileMenu.showPopover();
    profilePick.setAttribute("aria-expanded", "true");
    positionProfileMenu();
    const rows = profileOptionRows();
    if (searchFocus && !profileSearchRow.hidden) focusProfileItem(profileSearch);
    // a click opens with nothing lit, the keyboard opens on the chosen profile
    else if (byPointer) {
      setProfileActive(null, false);
      profileMenu.focus({ preventScroll: true });
    } else focusProfileItem(rows.find((row) => row.getAttribute("aria-selected") === "true") ?? rows[0] ??
      profileMenu.querySelector<HTMLButtonElement>(".profile-menu-cmd") ?? profilePick);
  }

  function closeProfileMenu(returnFocus: boolean): void {
    if (profileMenu.hidden) return;
    if (profileMenu.matches(":popover-open")) profileMenu.hidePopover();
    profileMenu.hidden = true;
    delete profileHeader.dataset.menuSide;
    profilePick.setAttribute("aria-expanded", "false");
    if (returnFocus) profilePick.focus();
  }

  function toggleProfileMenu(): void {
    if (profileMenu.hidden) openProfileMenu(true, true);
    else closeProfileMenu(true);
  }

  profilePick.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    openProfileMenu();
  });
  profileMenu.addEventListener("keydown", (event) => {
    const rows = profileOptionRows();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const searching = event.target === profileSearch;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeProfileMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const chosen = rows.findIndex(row => row.getAttribute("aria-selected") === "true");
      const next = index < 0
        ? (chosen >= 0 ? chosen : step === 1 ? 0 : rows.length - 1)
        : Math.max(0, Math.min(rows.length - 1, index + step));
      focusProfileItem(rows[next]);
    } else if (!searching && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      event.stopPropagation();
      focusProfileItem(rows[event.key === "Home" ? 0 : rows.length - 1]);
    } else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      chooseProfile(rows[index]?.dataset.profileId ?? "");
    } else if (searching && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const lit = rows.find(row => row.hasAttribute("data-active")) ?? rows[0];
      if (lit) chooseProfile(lit.dataset.profileId ?? "");
    } else if (!searching && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      profileTyped = selectTypeaheadPrefix(profileTyped, profileLastTyped, event.key, event.timeStamp);
      profileLastTyped = event.timeStamp;
      const choices = rows.map(row => ({
        value: row.dataset.profileId ?? "", label: row.querySelector(".profile-option-name")?.textContent ?? "",
        detail: row.title, disabled: false,
      }));
      // with nothing lit, typing starts from the chosen profile, the same as the arrow keys
      const from = index >= 0 ? index : rows.findIndex(row => row.getAttribute("aria-selected") === "true");
      focusProfileItem(rows[nextSelectMatch(choices, from, profileTyped, profileTyped.length === 1)]);
    }
  });
  profileMenu.addEventListener("pointermove", (event) => {
    // only a real move counts, so a list scrolling under a resting pointer keeps the keyboard's row
    if (event.clientX === profilePointerX && event.clientY === profilePointerY) return;
    profilePointerX = event.clientX;
    profilePointerY = event.clientY;
    const row = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[role="option"], .profile-menu-cmd')
      : null;
    if (!row || row.hidden) {
      if (profilePointerActive) clearProfilePointer();
      return;
    }
    if (row.hasAttribute("data-active")) return;
    setProfileActive(row, true);
    // typing in the search box keeps its focus; the lit row still answers Enter through the list
    if (document.activeElement !== profileSearch) row.focus({ preventScroll: true });
  });
  profileMenu.addEventListener("pointerleave", () => {
    if (profilePointerActive) clearProfilePointer();
  });
  // Tab and other focus moves light the row they land on
  profileMenu.addEventListener("focusin", (event) => {
    const row = event.target instanceof HTMLElement ? event.target : null;
    if (row && profileMenuItems().includes(row) && !row.hasAttribute("data-active")) setProfileActive(row, false);
  });
  profileSearch.addEventListener("input", () => { filterProfiles(); positionProfileMenu(); });
  profileMenu.addEventListener("toggle", () => {
    if (!profileMenu.matches(":popover-open") && !profileMenu.hidden) closeProfileMenu(false);
  });
  window.addEventListener("resize", () => closeProfileMenu(false));
  document.addEventListener("scroll", event => {
    if (!profileMenu.hidden && event.target instanceof Node && !profileMenu.contains(event.target)) positionProfileMenu();
  }, true);
  // a command closes the menu; choosing a profile closes it in chooseProfile
  profileMenu.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".profile-menu-cmd")) closeProfileMenu(false);
  });
  profileMenu.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || profileMenu.contains(next) || next === profilePick) return;
    closeProfileMenu(false);
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (profileMenu.hidden || !(target instanceof Node)) return;
    if (profileMenu.contains(target) || profilePick.contains(target)) return;
    closeProfileMenu(false);
  }, true);

  interface UnsavedProfile {
    readonly pid: string;
    readonly name: string;
    readonly settings: ProfileRecord;
    readonly snapshot: string;
  }

  function unsavedProfile(): UnsavedProfile | null {
    const pid = select("prof-sel").value;
    const saved = selectedProfile();
    if (!pid || !saved || !isProfileChanged()) return null;
    const name = currentProfileName();
    const payload = profilePayload(name);
    return {
      pid,
      name,
      snapshot: profileSnapshot,
      // the payload is shaped for saving; applying reads a stored profile's byte and bit rates
      settings: {
        ...saved,
        ...payload,
        profile_id: pid,
        target_size_bytes: num(payload.target_size_mb) * 1024 * 1024,
        audio_bitrate: num(payload.audio_bitrate_kbps) * 1000,
      },
    };
  }

  function chooseProfile(pid: string): void {
    closeProfileMenu(true);
    const sel = select("prof-sel");
    if (!pid || pid === sel.value || ![...sel.options].some((option) => option.value === pid)) return;
    const unsaved = unsavedProfile();
    sel.value = pid;
    onProfileChange();
    if (unsaved) {
      toast(`Changes to ${unsaved.name} discarded.`, "", { label: "Undo", run: () => restoreUnsaved(unsaved) });
    }
  }

  function restoreUnsaved(unsaved: UnsavedProfile): void {
    const sel = select("prof-sel");
    // after a task switch that profile is not on offer here, so there is nothing to bring back
    if (![...sel.options].some((option) => option.value === unsaved.pid)) return;
    sel.value = unsaved.pid;
    if (wf === 0) lastComp = unsaved.pid;
    else lastUpscale = unsaved.pid;
    applyProfile(false, unsaved.settings);
    profileSnapshot = unsaved.snapshot;
    updateDirty();
    void reqPreview();
    void persistSession();
  }

  function snapProf(): void {
    profileSnapshot = JSON.stringify(profileControlState());
    updateDirty();
  }

  type ClipTransform = Pick<
    EditorClip,
    "crop" | "cropAspect" | "rotation" | "sizingMode" | "flipHorizontal" | "flipVertical" | "transformOverride" | "transformIntentTouched"
  >;

  // discarding resets every video's transform to the profile's, so Undo puts those back too
  function resetToProfile(): void {
    const unsaved = unsavedProfile();
    const transforms = new Map<EditorClip, ClipTransform>();
    for (const clip of Object.values(session.clips)) {
      transforms.set(clip, {
        crop: clip.crop ? { ...clip.crop } : null,
        cropAspect: clip.cropAspect,
        rotation: clip.rotation,
        sizingMode: clip.sizingMode,
        flipHorizontal: clip.flipHorizontal,
        flipVertical: clip.flipVertical,
        transformOverride: clip.transformOverride,
        transformIntentTouched: clip.transformIntentTouched,
      });
    }
    applyProfile(true);
    snapProf();
    const name = unsaved?.name ?? currentProfileName();
    toast(name ? `Changes to ${name} discarded.` : "Changes discarded.", "", {
      label: "Undo",
      run: () => {
        if (unsaved) restoreUnsaved(unsaved);
        for (const [clip, values] of transforms) {
          if (session.clips[clip.path] !== clip) continue;
          Object.assign(clip, values);
          clip.planData = null;
        }
        deps.syncTransformControls();
        deps.paintCropOverlay();
        deps.renderClips?.();
        void reqPreview();
      },
    });
  }

  function resizeSizeInput(): void {
    input("sz-badge").style.width = `${Math.max(2, input("sz-badge").value.length)}ch`;
  }

  const sizeInput = input("sz-badge");
  sizeInput.addEventListener("focus", () => sizeInput.select());
  sizeInput.addEventListener("input", resizeSizeInput);
  sizeInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      sizeInput.value = input("sz-slider").value;
      resizeSizeInput();
      sizeInput.blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      sizeInput.blur();
    }
  });

  return {
    readLut: () => lut.read(),
    workflow: () => wf,
    setWf,
    applyProfile,
    applySelectedProfileTransform,
    refilter,
    onProfileChange,
    toggleProfileMenu,
    chooseProfile,
    loadSettings,
    openTask,
    reqPreview,
    planLibrary,
    task: () => (wf === 2 ? "cut" : wf === 1 ? "upscale" : "compression"),
    reqPreviewAndDirty,
    buildRequest: (source: string) => buildRequest(source),
    updateActionButtons,
    syncExportSummary,
    focusCutRow: (index: number) => cutting.focusRow(index),
    syncFpsToClip,
    syncResolutionToClip,
    updateSizePresets,
    updateEncoderOptions,
    setAvailableEncoders: (encoders) => {
      session.availEncoders.splice(
        0,
        session.availEncoders.length,
        ...(platformCapabilities ? encodersForPlatform(encoders, platformCapabilities) : encoders),
      );
      updateEncoderOptions();
    },
    snapProf,
    updateDirty,
    resetToProfile,
    compressOne,
    compressAll,
    compressCopy,
    saveProfileChanges,
    saveProfileAs,
    onSize,
    onBadgeSize,
    onFpsSlider,
    onResolutionGeometryChanged,
    onExportResolutionChoice,
    onExportFrameRateChoice,
    onKeepAudio,
    onEncChange,
    onSpeedChange,
    onTwoPassChange,
    onNativePresetChange,
    onRcChange,
    toggleAdvanced,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
