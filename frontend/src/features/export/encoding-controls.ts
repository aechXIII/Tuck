import { installLutControls } from "./lut-controls.ts";
import { installFrameBlending } from "./frame-blending.ts";
import { installCutControls } from "./cut-controls.ts";
import { createCutState } from "./cut-state.ts";
import type { CutPlanPreview } from "../../backend/cutting-types.ts";
import type { BackendClient } from "../../backend/types.ts";
import { allProbesReady, isProbeReady } from "../../state/probe.ts";
import * as InspectorUi from "../panels/inspector-ui.ts";
import { cropForAspect, isFullCrop, type CropTransform } from "../transform/crop-geometry.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { hiddenParts, launchTask, taskAt, taskIndex, visibleTasks } from "../settings/visibility.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import { closeMod, showMod, toast } from "../editor/toast.ts";
import { profileChangeSummary, profileSummary } from "../profiles/profile-summary.ts";
import type { EditorClip } from "../editor/types.ts";
import type { EditorSession } from "../editor/session.ts";
import {
  buildPlanRequest,
  buildProfilePayload,
  buildCutRequest,
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
  renderClips?: () => void;
  selectCutSegment: (index: number, time: number) => void;
  moveCutStarts: (clip: EditorClip, plan: CutPlanPreview) => boolean;
  paintCutTimeline: () => void;
}

export interface EncodingControlsApi {
  workflow: () => number;
  setWf: (idx: number) => void;
  applyProfile: (forceTransform?: boolean) => void;
  applySelectedProfileTransform: (clip: EditorClip | null | undefined, force?: boolean) => void;
  refilter: () => void;
  onProfileChange: () => void;
  toggleProfileMenu: () => void;
  // switches profile; unsaved changes to the old one can be brought back from the note
  chooseProfile: (profileId: string) => void;
  loadSettings: () => Promise<void>;
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
    compressInstead: () => { setWf(0); el("wf-c").focus(); },pollQueue: deps.pollQueue,
    paintTimeline: deps.paintCutTimeline,
  });

  function cutRequest(clip: EditorClip) {
    const form = readForm();
    const edits: string[] = [];
    if (clip.crop && !isFullCrop(clip.crop,Number(clip.probeData?.width),Number(clip.probeData?.height))) edits.push("crop");
    if (clip.rotation) edits.push("rotation");
    if (clip.flipHorizontal || clip.flipVertical) edits.push("flip");
    if (form.resolutionMode === "custom" && (form.customWidth !== clip.probeData?.width || form.customHeight !== clip.probeData?.height)) edits.push("resize");
    if (!form.useSourceFps && form.customFps !== clip.probeData?.fps) edits.push("fps");
    if (form.lut?.enabled) edits.push("lut");
    if (form.frameBlending?.enabled) edits.push("frame_blending");
    const state = clip.cutState ??= createCutState();
    const analysis = state.analysis?.analysis;
    return buildCutRequest({clip,state,edits,
      ...(analysis ? {frameDuration:analysis.frame_duration,duration:analysis.duration} : {}),
      ...(typeof appSettings().output_dir === "string" ? {outputDir:String(appSettings().output_dir)} : {}),
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

  function updateActionButtons(): void {
    if (wf === 2) { cutting.render(); return; }
    const up = wf === 1;
    const count = Object.keys(session.clips).length;
    const selReady = isProbeReady(session.selPath ? session.clips[session.selPath] : null);
    const allReady = allProbesReady(session.clips);
    const one = el<HTMLButtonElement>("btn-one");
    const all = el<HTMLButtonElement>("btn-all");
    // the settings are shared; this button acts on the selected video only
    one.textContent = up ? "Upscale this video" : "Compress this video";
    one.disabled = !selReady || !blending.valid() || !lut.valid() || !videoSettingsValid();
    all.textContent = (up ? "Upscale all" : "Compress all") + (count ? ` (${count})` : "");
    all.disabled = !allReady || !blending.valid() || !lut.valid() || !videoSettingsValid();
    all.classList.toggle("upscale-batch", up);
    const note = el("btn-all-note");
    note.textContent = count > 1 && !allReady ? "Some videos are still being read." : "";
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

  async function loadSettings(): Promise<void> {
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
    else refilter();
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

  function refilter(): void {
    if (wf === 2) { cutting.refresh(); return; }
    const up = wf === 1;
    const targetWf = up ? "upscale" : "compression";
    const matching = profiles().filter(
      (p) => (p.workflow || "compression") === targetWf,
    );
    const lastId = up ? lastUpscale : lastComp;
    const sel = select("prof-sel");
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
    applyProfile();
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
    void reqPreview();
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

  async function reqPreview(): Promise<void> {
    if (wf === 2) { cutting.refresh(); return; }
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    if (!clip || !clip.probed) return;
    if (!videoSettingsValid() || !lut.valid()) {
      clip.planData = null;
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

  async function compressOne(): Promise<void> {
    if (wf === 2) { await cutting.exportCuts(false); return; }
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const path = session.selPath;
    if (!path) {
      toast("Select a clip first.", "err");
      return;
    }
    if (!isProbeReady(session.clips[path])) {
      toast("Retry reading clip details before exporting.", "err");
      return;
    }
    const r = await legacyBackendResult(
      client().enqueueWithOptions(buildRequest(session.clips[path]!.path) as never),
    );
    if (!r.ok) toast(`Error: ${r.error ?? "Failed"}`, "err");
    void deps.pollQueue();
  }

  async function compressAll(): Promise<void> {
    if (wf === 2) { await cutting.exportCuts(true); return; }
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const keys = deps.orderedClipKeys();
    if (!keys.length) {
      toast("Add clips first.", "err");
      return;
    }
    if (!allProbesReady(session.clips)) {
      toast("Retry unreadable clip details before exporting all files.", "err");
      return;
    }
    const requests = keys.map((key) => buildRequest(session.clips[key]!.path) as never);
    const r = await legacyBackendResult(client().enqueueBatch(requests));
    if (!r.ok) toast(`Error: ${r.error ?? "Failed"}`, "err");
    if (Array.isArray(r.errors) && r.errors.length) toast("Some errors occurred.", "err");
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
      toast(r.error ?? "Could not save profile.", "err");
    }
  }

  function saveProfileAs(): Promise<void> {
    showMod(
      `<h2>Save Profile As</h2>
    <div>
      <span>Profile name</span>
      <input type="text" id="sp-name" placeholder="My profile">
    </div>
    <div class="mod-btns">
      <button type="button" class="btn2" id="sp-cancel">Cancel</button>
      <button type="button" class="btn1" id="sp-save" style="width:auto">Save</button>
    </div>`,
    );
    byId("sp-cancel")?.addEventListener("click", closeMod);
    byId("sp-save")?.addEventListener("click", () => void doSaveAs());
    setTimeout(() => {
      const nameInput = byId<HTMLInputElement>("sp-name");
      if (nameInput) {
        nameInput.focus();
        nameInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void doSaveAs();
        });
      }
    }, 100);
    return Promise.resolve();
  }

  async function doSaveAs(): Promise<void> {
    if (!lut.valid() || !blending.reportValidity() || !videoSettingsValid()) return;
    const name = (byId<HTMLInputElement>("sp-name")?.value ?? "").trim();
    if (!name) {
      toast("Enter a name.", "err");
      return;
    }
    closeMod();
    const r = await legacyBackendResult(client().createProfile(profilePayload(name) as never));
    if (r.ok) {
      await loadSettings();
      snapProf();
      toast(`Profile saved as "${name}".`, "ok");
    } else {
      toast(r.error ?? "Could not save profile.", "err");
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
    const changed = isProfileChanged();
    el("prof-name").textContent = name;
    el("prof-pick").setAttribute("aria-label", `Profile: ${name}`);
    el("prof-card").classList.toggle("changed", changed);
    el("prof-sub").textContent = changed
      ? profileChangeSummary(JSON.parse(profileSnapshot) as Record<string, unknown>, profileControlState())
      : profile ? profileSummary(profile) : "";
    el("prof-changed").hidden = !changed;
  }

  const profileMenu = el("prof-menu");
  const profilePick = el("prof-pick");

  function profileOptionRows(): HTMLElement[] {
    return [...el("prof-options").querySelectorAll<HTMLElement>('[role="option"]')];
  }

  function renderProfileMenu(): void {
    el("prof-menu-title").textContent = wf === 1 ? "Upscale" : "Compress";
    const current = select("prof-sel").value;
    const changed = isProfileChanged();
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
      const name = document.createElement("span");
      name.className = "profile-option-name";
      name.textContent = option.textContent ?? "";
      const note = document.createElement("span");
      note.className = "profile-option-note";
      const profile = profiles().find((entry) => entry.profile_id === option.value);
      if (selected && changed) {
        row.classList.add("changed");
        note.textContent = "Changed, not saved";
      } else {
        note.textContent = profile ? profileSummary(profile) : "";
      }
      row.append(name, note);
      return row;
    });
    el("prof-options").replaceChildren(...rows);
  }

  function openProfileMenu(): void {
    if (!profileMenu.hidden) return;
    renderProfileMenu();
    profileMenu.hidden = false;
    profilePick.setAttribute("aria-expanded", "true");
    const rows = profileOptionRows();
    (rows.find((row) => row.getAttribute("aria-selected") === "true") ?? rows[0])?.focus();
  }

  function closeProfileMenu(returnFocus: boolean): void {
    if (profileMenu.hidden) return;
    profileMenu.hidden = true;
    profilePick.setAttribute("aria-expanded", "false");
    if (returnFocus) profilePick.focus();
  }

  function toggleProfileMenu(): void {
    if (profileMenu.hidden) openProfileMenu();
    else closeProfileMenu(true);
  }

  profilePick.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openProfileMenu();
  });
  profileMenu.addEventListener("keydown", (event) => {
    const rows = profileOptionRows();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeProfileMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(Math.max(index, 0) + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
      event.preventDefault();
      chooseProfile(rows[index]?.dataset.profileId ?? "");
    }
  });
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

  function resetToProfile(): void {
    applyProfile(true);
    snapProf();
    toast("Changes discarded.", "ok");
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
