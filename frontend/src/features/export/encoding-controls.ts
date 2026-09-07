import type { BackendClient } from "../../backend/types.ts";
import { allProbesReady, isProbeReady } from "../../state/probe.ts";
import * as InspectorUi from "../panels/inspector-ui.ts";
import { cropForAspect, isFullCrop, type CropTransform } from "../transform/crop-geometry.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import { formatTime } from "../editor/format.ts";
import { closeMod, showMod, toast } from "../editor/toast.ts";
import type { EditorClip } from "../editor/types.ts";
import type { EditorSession } from "../editor/session.ts";
import {
  buildPlanRequest,
  buildProfilePayload,
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
}

export interface EncodingControlsApi {
  workflow: () => number;
  setWf: (idx: number) => void;
  applyProfile: (forceTransform?: boolean) => void;
  applySelectedProfileTransform: (clip: EditorClip | null | undefined, force?: boolean) => void;
  refilter: () => void;
  onProfileChange: () => void;
  loadSettings: () => Promise<void>;
  reqPreview: () => Promise<void>;
  reqPreviewAndDirty: () => void;
  buildRequest: (source: string) => Record<string, unknown>;
  updateActionButtons: () => void;
  syncExportSummary: () => void;
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
  onUseSourceResolution: () => void;
  onResolutionGeometryChanged: () => void;
  onExportResolutionChoice: (value: string) => void;
  onExportFrameRateChoice: (value: string) => void;
  onUseSourceFps: () => void;
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
  let lastComp = "";
  let lastUpscale = "";
  let previewRequestId = 0;
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

  function workflowName(): "compression" | "upscale" {
    return wf === 1 ? "upscale" : "compression";
  }

  function setWf(idx: number): void {
    if (wf === idx) return;
    const curPid = select("prof-sel").value;
    if (curPid) {
      if (wf === 0) lastComp = curPid;
      else lastUpscale = curPid;
    }
    wf = idx;
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
    el("res-source-wrap").classList.toggle("hid", up);
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
      last_task: workflowName(),
      last_compress_profile_id: lastComp,
      last_upscale_profile_id: lastUpscale,
      left_sidebar_width: 220,
    };
    const r = await legacyBackendResult(client().saveSettings(data as never));
    if (r.ok) Object.assign(settings, data);
  }

  function updateActionButtons(): void {
    const up = wf === 1;
    const count = Object.keys(session.clips).length;
    const selReady = isProbeReady(session.selPath ? session.clips[session.selPath] : null);
    const allReady = allProbesReady(session.clips);
    const one = el<HTMLButtonElement>("btn-one");
    const all = el<HTMLButtonElement>("btn-all");
    one.textContent = up ? "Upscale selected" : "Compress selected";
    one.disabled = !selReady;
    all.textContent = (up ? "Upscale all" : "Compress all") + (count ? ` (${count})` : "");
    all.disabled = !allReady;
    all.style.background = up ? "#2a2a3e" : "";
    syncExportSummary();
  }

  function syncExportSummary(): void {
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
      modified: el("mod-badge").classList.contains("show"),
    });
    el("export-summary-title").textContent = summary.title;
    el("export-summary-detail").textContent = summary.detail;
    el("export-summary-modified").classList.toggle("show", summary.modified);
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
      fps: data && data.fps ? Math.round(data.fps) : Number(input("fps-val").value) || 30,
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
    const nativeControls = el("export-native-video-controls");
    nativeControls.classList.toggle("show-resolution", resolution.value === "custom");
    nativeControls.classList.toggle("show-scaler", resolution.value !== "source");
    nativeControls.classList.toggle("show-fps", frameRate.value === "custom");
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
    syncExportVideoFacades();
  }

  function onExportFrameRateChoice(value: string): void {
    el("export-fps-select").dataset.explicitCustom = value === "custom" ? "1" : "";
    const isSource = value === "source";
    input("use-source-fps").checked = isSource;
    if (isSource) syncFpsToClip(true);
    else if (value !== "custom") onFpsSlider(value);
    void reqPreview();
    updateDirty();
    syncExportVideoFacades();
  }

  async function loadSettings(): Promise<void> {
    platformCapabilities = await fetchPlatformCapabilities();
    const s = await legacyBackendResult(client().getSettings());
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
    const task = s.last_task === "upscale" ? 1 : 0;
    if (task !== wf) setWf(task);
    else refilter();
  }

  function refilter(): void {
    const up = wf === 1;
    const targetWf = up ? "upscale" : "compression";
    const matching = profiles().filter(
      (p) => (p.workflow || "compression") === targetWf,
    );
    const lastId = up ? lastUpscale : lastComp;
    const sel = select("prof-sel");
    sel.replaceChildren();
    if (!matching.length) {
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

  function applyProfile(forceTransform?: boolean): void {
    const pid = select("prof-sel").value;
    if (!pid) return;
    const p = profiles().find((profile) => profile.profile_id === pid);
    if (!p) return;
    for (const path of Object.keys(session.clips)) {
      applyProfileTransformToClip(p, session.clips[path], !!forceTransform);
    }
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
    let fpsVal = Math.round(num(p.custom_fps) || num(p.max_fps) || 30);
    const selClip = session.selPath ? session.clips[session.selPath] : undefined;
    const clipMax =
      selClip && selClip.probed
        ? Math.round(num(selClip.probeData?.fps) || fpsVal)
        : fpsVal;
    input("fps-slider").max = String(clipMax);
    if (fpsVal > clipMax) fpsVal = clipMax;
    input("fps-slider").value = String(fpsVal);
    input("fps-val").value = String(fpsVal);
    el("fps-badge").textContent = `${fpsVal} fps`;
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
    input("sz-slider").setAttribute("aria-valuenow", String(size));
    updateSizePresets(size);
    void reqPreview();
    updateDirty();
  }

  function onBadgeSize(value: string): void {
    const size = parseInt(value, 10);
    if (!size || size < 2) {
      input("sz-badge").value = input("sz-slider").value;
      return;
    }
    input("sz-slider").value = String(size);
    onSize(String(size));
  }

  function updateSizePresets(value: number): void {
    const container = el("sz-presets");
    container.replaceChildren();
    for (const mb of InspectorUi.sizePresets()) {
      const button = document.createElement("button");
      button.textContent = `${mb} MB`;
      if (mb === value) button.classList.add("on");
      button.addEventListener("click", () => {
        input("sz-slider").value = String(mb);
        onSize(String(mb));
      });
      container.appendChild(button);
    }
  }

  function onUseSourceResolution(): void {
    el("export-res-select").dataset.explicitCustom = "";
    input("res-mode").value = input("use-source-res").checked ? "source" : "custom";
    if (input("use-source-res").checked) syncResolutionToClip(true);
    onResMode();
  }

  function onResMode(): void {
    const isSource = input("res-mode").value === "source";
    input("res-w").disabled = isSource;
    input("res-h").disabled = isSource;
    el("scaler-row").classList.toggle("hid", isSource);
    deps.paintCropOverlay();
    void reqPreview();
    updateDirty();
  }

  function onResolutionGeometryChanged(): void {
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
    input("fps-val").value = value;
    el("fps-badge").textContent = `${value} fps`;
    input("fps-slider").setAttribute("aria-valuenow", value);
    void reqPreview();
    updateDirty();
  }

  function syncFpsToClip(forceSourceValue?: boolean): void {
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    if (!clip || !clip.probed || !clip.probeData) return;
    const native = Math.round(Number(clip.probeData.fps)) || 30;
    input("fps-slider").max = String(native);
    let cur =
      forceSourceValue || input("use-source-fps").checked
        ? native
        : parseInt(input("fps-val").value, 10) || native;
    if (cur > native) cur = native;
    input("fps-slider").value = String(cur);
    input("fps-val").value = String(cur);
    el("fps-badge").textContent = `${cur} fps`;
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
    const arrow = el("adv-toggle").querySelector(".advanced-arrow");
    if (arrow) arrow.textContent = open ? "⌃" : "⌄";
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
      customFps: parseInt(input("fps-val").value, 10) || 0,
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
    const path = session.selPath;
    const clip = path ? session.clips[path] : undefined;
    if (!clip || !clip.probed) return;
    const requestId = (previewRequestId += 1);
    clip._previewRequestId = requestId;
    clip.planData = null;
    deps.paintCropOverlay();
    const req = buildRequest(path as string, requestId);
    try {
      const r = await legacyBackendResult(client().createPlan(req as never));
      const data = r.data as Record<string, unknown> | undefined;
      if (
        r.ok &&
        data &&
        session.clips[path as string] === clip &&
        clip._previewRequestId === requestId &&
        r._request_id === requestId
      ) {
        clip.planData = data;
        if (session.selPath !== path) return;
        el("calc-br").textContent =
          wf === 0
            ? `Calculated bitrate: ${String(data.video_bitrate_kbps)} kbps · ${String(
                data.segment_count,
              )}${data.segment_count === 1 ? " segment · " : " segments · "}${formatTime(
                Number(data.selected_duration),
              )} selected`
            : "";
        deps.paintCropOverlay();
      }
    } catch {
      /* preview failures are non-fatal */
    }
  }

  function reqPreviewAndDirty(): void {
    void reqPreview();
    updateDirty();
  }

  async function compressOne(): Promise<void> {
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
    return {
      pid: value("prof-sel"),
      size: value("sz-slider"),
      rm: value("res-mode"),
      rw: value("res-w"),
      rh: value("res-h"),
      fps: value("fps-val"),
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

  function updateDirty(): void {
    if (!profileSnapshot) {
      byId("mod-badge")?.classList.remove("show");
      byId("prof-reset-row")?.classList.add("hid");
      syncExportSummary();
      return;
    }
    const dirty = profileSnapshot !== JSON.stringify(profileControlState());
    byId("mod-badge")?.classList.toggle("show", dirty);
    byId("prof-reset-row")?.classList.toggle("hid", !dirty);
    syncExportSummary();
  }

  function snapProf(): void {
    profileSnapshot = JSON.stringify(profileControlState());
    updateDirty();
  }

  function resetToProfile(): void {
    applyProfile(true);
    snapProf();
    toast("Settings reset to profile.", "ok");
  }

  return {
    workflow: () => wf,
    setWf,
    applyProfile,
    applySelectedProfileTransform,
    refilter,
    onProfileChange,
    loadSettings,
    reqPreview,
    reqPreviewAndDirty,
    buildRequest: (source: string) => buildRequest(source),
    updateActionButtons,
    syncExportSummary,
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
    onUseSourceResolution,
    onResolutionGeometryChanged,
    onExportResolutionChoice,
    onExportFrameRateChoice,
    onUseSourceFps,
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
