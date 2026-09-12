import type { BackendClient } from "../../backend/types.ts";
import { bindDelegatedEvents } from "../../ui/delegated-events.ts";
import { escapeHtml } from "../../ui/dom.ts";
import { settingsAreDirty, settingsSnapshot } from "../../state/settings-state.ts";
import {
  encoderDisplaySummary,
  isCpuEncoder,
  nativePresetForSpeed,
  speedForNativePreset,
  twoPassEligible,
  type Workflow,
} from "../export/encoder-options.ts";
import {
  populateEncoderSelect,
  populatePresetSelect,
  populateRateControlSelect,
  populateTuneSelect,
} from "../export/encoder-select.ts";
import {
  bindProfileActions,
  renderProfileList,
  renderShortcutChoices,
  type ProfileListEntry,
} from "../profiles/profile-list.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import {
  encoderForPlatform,
  encodersForPlatform,
  fetchPlatformCapabilities,
  shouldShowSendTo,
  shouldShowUpdater,
  supportsHardwareEncoders,
  type PlatformCapabilities,
} from "../../platform/capabilities.ts";
import { confirmToast, toast } from "../editor/toast.ts";
import type { EditorSession } from "../editor/session.ts";

const esc = escapeHtml;

export interface SettingsDeps {
  session: EditorSession;
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  getBackendClient: () => BackendClient;
  reloadEditorSettings: () => Promise<void>;
  setAvailableEncoders: (encoders: string[]) => void;
  copyDiagnostics: () => void | Promise<void>;
  checkForUpdates: () => void | Promise<void>;
}

export interface SettingsApi {
  toggle: () => void;
  open: (page?: string, view?: string, profileId?: string) => Promise<void>;
  close: () => void;
  isOpen: () => boolean;
}

type SettingsRecord = Record<string, unknown>;

export function installSettings(deps: SettingsDeps): SettingsApi {
  const { session, byId, getBackendClient } = deps;
  const client = (): BackendClient => getBackendClient();
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = byId<T>(id);
    if (!found) throw new Error(`Missing #${id}`);
    return found;
  };
  const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
  const select = (id: string): HTMLSelectElement => el<HTMLSelectElement>(id);
  const appSettings = (): SettingsRecord => session.appSettings;

  let settingsPage = "general";
  let settingsView: "page" | "editor" = "page";
  let settingsProfileId = "";
  let settingsFilter = "all";
  let editorOriginal: SettingsRecord = {};
  let editorSnapshot = "";
  let snapshot = "";
  let settingsDirty = false;
  let settingsReturnFocus: Element | null = null;
  let editorCapabilities: PlatformCapabilities | null = null;

  function valueOr<T>(value: T | undefined | null, fallback: T): T {
    return value === undefined || value === null ? fallback : value;
  }

  function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
  }

  function trapSettingsFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !document.body.classList.contains("settings-open")) return;
    // a confirmation above settings owns focus until it is dismissed
    const dialog = byId("mod-overlay")?.classList.contains("open")
      ? byId("mod-box")
      : document.querySelector<HTMLElement>(".settings-dialog");
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  }
  document.addEventListener("keydown", trapSettingsFocus);

  function settingsShell(
    page: string,
    content: string,
    actions: { html?: string; split?: boolean; plain?: boolean },
    caps: PlatformCapabilities,
  ): void {
    const actionBar = el("settings-actions");
    const opening = !document.body.classList.contains("settings-open");
    const previousFocus = document.activeElement;
    if (opening) {
      settingsReturnFocus = document.activeElement;
      // keep modal focus separate from the editor's responsive drawer state
      el("editor-shell").inert = true;
    }
    document.body.classList.add("settings-open");
    const titles: Record<string, string> = {
      general: "General",
      output: "Output & naming",
      profiles: "Profiles",
      explorer: "File Explorer",
      system: "System & support",
    };
    const heading = settingsView === "editor"
      ? settingsTitle(settingsProfileId ? "Edit profile" : "New profile", "back-profiles")
      : settingsTitle(titles[page] || "General");
    el("settings-content-header").innerHTML = heading;
    el("settings-page").innerHTML = `<div class="settings-page-inner">${content}</div>`;
    el("settings-page").scrollTop = 0;
    actionBar.className = `settings-actions ${actions.split ? "split" : ""}`;
    actionBar.innerHTML = actions.html
      ? actions.plain
        ? actions.html
        : `<span class="settings-unsaved" id="settings-unsaved" role="status">
          Unsaved changes
        </span>
        <span class="settings-action-spacer"></span>
        ${actions.html}`
      : "";
    const integrations = byId("settings-integrations");
    if (integrations) integrations.hidden = !shouldShowSendTo(caps);
    for (const name of ["general", "output", "profiles", "explorer", "system"]) {
      const button = byId(`settings-nav-${name}`);
      if (!button) continue;
      const active = name === page;
      button.classList.toggle("on", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    }
    if (opening) {
      byId(`settings-nav-${page}`)?.focus();
    } else if (previousFocus && !previousFocus.isConnected && settingsView !== "editor") {
      el("settings-page-title").focus();
    }
  }

  function settingButton(
    label: string,
    action: string,
    primary?: boolean,
    dirtyAware?: boolean,
  ): string {
    return (
      `<button type="button" class="${primary ? "btn1" : "btn2"}${
        dirtyAware ? '" data-settings-save="true" disabled' : '"'
      } data-settings-click="${action}">${label}</button>`
    );
  }

  function settingsTitle(title: string, action?: string): string {
    const backButton = action
      ? `<button type="button" class="settings-title-back" aria-label="Back to profiles" data-settings-click="${action}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
      </button>`
      : "";
    return `<div class="settings-title-row">
    ${backButton}
    <h2 class="settings-title" id="settings-page-title" tabindex="-1">${esc(title)}</h2>
  </div>`;
  }

  function profileSummary(p: ProfileListEntry): string {
    const up = (p.workflow || "compression") === "upscale";
    const res =
      p.resolution_mode === "custom"
        ? `${num(p.custom_width) || num(p.max_width)} × ${num(p.custom_height) || num(p.max_height)}`
        : "Source resolution";
    const fps =
      p.fps_mode === "custom"
        ? `${Math.round(num(p.custom_fps) || num(p.max_fps) || 30)} FPS`
        : "Source FPS";
    const audio = p.keep_audio
      ? "Keep audio"
      : `${num(p.audio_bitrate_kbps) || 128} kbps audio`;
    const transform = p.transform_intent as SettingsRecord | undefined;
    const transformSummary = transform
      ? ` · ${
          transform.crop_aspect === "free" ? "Free aspect" : String(transform.crop_aspect)
        } · ${String(transform.sizing_mode || "fit").replace(/^./, (v) => v.toUpperCase())}${
          transform.rotation ? ` · ${String(transform.rotation)}°` : ""
        }`
      : "";
    return (
      `${up ? "Upscale" : "Compress"} · ${
        up ? "" : `${Math.round(num(p.target_size_bytes) / (1024 * 1024))} MB · `
      }${res} · ${fps} · ${audio}${transformSummary}`
    );
  }

  function profileShortcutName(id: string): string {
    const profile = (session.allProfiles as ProfileListEntry[]).find((x) => x.profile_id === id);
    return profile ? profile.name ?? "Profile shortcut" : "Profile shortcut";
  }

  async function refreshProfileManagerList(filter?: string): Promise<void> {
    settingsFilter = filter || settingsFilter;
    const list = byId("pm-list");
    if (!list) return;
    const profiles = (await legacyBackendResult(client().getProfilesJson())) as unknown as
      | ProfileListEntry[]
      | { ok: false };
    const rows = Array.isArray(profiles) ? profiles : [];
    for (const key of ["all", "compression", "upscale"]) {
      byId(`pm-${key}`)?.setAttribute("aria-pressed", String(key === settingsFilter));
    }
    const visible = rows.filter(
      (p) => !(settingsFilter !== "all" && (p.workflow || "compression") !== settingsFilter),
    );
    renderProfileList(document, list, visible, {
      ...(typeof appSettings().default_profile_id === "string"
        ? { defaultProfileId: appSettings().default_profile_id as string }
        : {}),
      summarize: profileSummary,
    });
    bindProfileActions(list, (action, profileId, name) => {
      if (action === "edit") void editProfile(profileId);
      else if (action === "export") void exportProfile(profileId);
      else if (action === "duplicate") void duplicateProfile(profileId);
      else if (action === "delete") deleteProfile(profileId, name);
    });
  }

  async function editProfile(pid: string): Promise<void> {
    await open("profiles", "editor", pid);
  }

  async function newProfile(): Promise<void> {
    await open("profiles", "editor", "");
  }

  async function duplicateProfile(pid: string): Promise<void> {
    const r = await legacyBackendResult(client().duplicateProfile(pid));
    if (r.ok) {
      await deps.reloadEditorSettings();
      await refreshProfileManagerList();
      toast("Profile duplicated.", "ok");
    } else {
      toast(r.error ?? "Could not duplicate profile.", "err");
    }
  }

  function deleteProfile(pid: string, name: string): void {
    confirmToast(`Delete "${name}"?`, () => {
      void legacyBackendResult(client().deleteProfile(pid)).then(async (r) => {
        if (r.ok) {
          await deps.reloadEditorSettings();
          await refreshProfileManagerList();
          toast("Profile deleted.", "ok");
        } else {
          toast(r.error ?? "Could not delete profile.", "err");
        }
      });
    });
  }

  async function importProfiles(): Promise<void> {
    const picked = await legacyBackendResult(client().pickImportFile());
    if (!picked.ok || typeof picked.path !== "string") return;
    const result = await legacyBackendResult(client().importProfilesFromFile(picked.path));
    if (result.ok) {
      await deps.reloadEditorSettings();
      await refreshProfileManagerList();
      toast("Profiles imported.", "ok");
    } else {
      toast(result.error ?? "Could not import profiles.", "err");
    }
  }

  async function exportProfile(pid: string): Promise<void> {
    const picked = await legacyBackendResult(client().pickSaveFile(`${pid}.json`));
    if (!picked.ok || typeof picked.path !== "string") return;
    const result = await legacyBackendResult(client().exportProfileToFile(picked.path, pid));
    if (result.ok) toast("Profile exported.", "ok");
    else toast(result.error ?? "Could not export profile.", "err");
  }

  function profileEditorTaskHtml(): string {
    return `<div class="settings-field full">
    <label for="pe-name">Profile name</label>
    <input id="pe-name" type="text">
  </div>
  <div class="settings-field full">
    <label>Task</label>
    <div class="profile-editor-task">
      <button type="button" id="pe-c" data-settings-click="profile-task" data-settings-value="compression">Compress</button>
      <button type="button" id="pe-u" data-settings-click="profile-task" data-settings-value="upscale">Upscale</button>
    </div>
  </div>`;
  }

  function profileEditorVideoHtml(): string {
    return `<div class="settings-sec full" id="pe-size-sec">
    <h3>Target size</h3>
    <div class="sl-row">
      <input id="pe-size-range" type="range" min="2" max="500" value="50" data-settings-input="profile-size">
      <input id="pe-size" type="number" min="2" value="50" aria-label="Target size in MB" data-settings-input="profile-size">
      <span>MB</span>
    </div>
    <div class="pset">
      <button type="button" data-settings-click="profile-size" data-settings-value="20">20 MB</button>
      <button type="button" data-settings-click="profile-size" data-settings-value="50">50 MB</button>
      <button type="button" data-settings-click="profile-size" data-settings-value="100">100 MB</button>
      <button type="button" data-settings-click="profile-size" data-settings-value="500">500 MB</button>
    </div>
  </div>
  <div class="settings-sec full">
    <h3>Resolution</h3>
    <div class="info-row" id="pe-source-res-row">
      <span>Use source resolution</span>
      <label class="chk">
        <input id="pe-source-res" type="checkbox" data-settings-change="profile-visibility">
        <span class="chk-box" aria-hidden="true"></span>
        <span>Source</span>
      </label>
    </div>
    <div class="row" id="pe-dim">
      <input id="pe-w" type="number" min="1" aria-label="Custom width">
      <span>×</span>
      <input id="pe-h" type="number" min="1" aria-label="Custom height">
    </div>
    <div id="pe-scaler-row" class="settings-field">
      <label for="pe-scaler">Scaler</label>
      <select id="pe-scaler">
        <option>Bilinear</option>
        <option>Bicubic</option>
        <option>Lanczos</option>
        <option>Point</option>
        <option>Neighbor</option>
      </select>
    </div>
  </div>
  <div class="settings-sec full">
    <h3>Frame rate</h3>
    <div class="info-row">
      <span>Use source frame rate</span>
      <label class="chk">
        <input id="pe-source-fps" type="checkbox" data-settings-change="profile-visibility">
        <span class="chk-box" aria-hidden="true"></span>
        <span>Source</span>
      </label>
    </div>
    <div id="pe-fps-row" class="sl-row">
      <input id="pe-fps-range" type="range" min="1" max="240" value="30" data-settings-input="profile-fps">
      <input id="pe-fps" type="number" min="1" max="240" value="30" aria-label="Custom frame rate" data-settings-input="profile-fps">
      <span>fps</span>
    </div>
  </div>`;
  }

  function profileEditorTransformHtml(): string {
    return `<div class="settings-sec full">
    <h3>Transform defaults</h3>
    <div class="info-row">
      <span>Apply transform settings from this profile</span>
      <label class="chk">
        <input id="pe-transform-enabled" type="checkbox" data-settings-change="profile-visibility">
        <span class="chk-box" aria-hidden="true"></span>
        <span>Enabled</span>
      </label>
    </div>
    <div id="pe-transform-fields">
      <div class="settings-field">
        <label for="pe-aspect">Target aspect</label>
        <select id="pe-aspect">
          <option value="free">Free</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="4:3">4:3</option>
        </select>
      </div>
      <div class="settings-field">
        <label for="pe-sizing">Sizing</label>
        <select id="pe-sizing">
          <option value="fit">Fit</option>
          <option value="fill">Fill</option>
          <option value="stretch">Stretch</option>
        </select>
      </div>
      <div class="settings-field">
        <label for="pe-rotation">Rotation</label>
        <select id="pe-rotation">
          <option value="0">None</option>
          <option value="90">90° clockwise</option>
          <option value="180">180°</option>
          <option value="270">90° counterclockwise</option>
        </select>
      </div>
      <span class="setting-note">Profiles save the crop shape, but not its exact position or size.</span>
    </div>
  </div>`;
  }

  function profileEditorAudioHtml(): string {
    return `<div class="settings-sec full">
    <h3>Audio</h3>
    <div class="info-row">
      <span>Keep source audio</span>
      <label class="chk">
        <input id="pe-audio-source" type="checkbox" data-settings-change="profile-visibility">
        <span class="chk-box" aria-hidden="true"></span>
        <span>Source</span>
      </label>
    </div>
    <div class="settings-field">
      <label for="pe-audio">Audio bitrate (kbps)</label>
      <input id="pe-audio" type="number" min="0" max="320">
    </div>
  </div>`;
  }

  function profileEditorEncodingHtml(): string {
    return `<div class="settings-sec full">
    <h3>Encoding</h3>
    <div class="settings-field">
      <label for="pe-enc">Encoder</label>
      <select id="pe-enc" data-settings-change="profile-encoder"></select>
    </div>
    <span class="setting-note">Hardware is faster; software can produce smaller files.</span>
    <div class="settings-field">
      <label for="pe-speed">Encoding speed</label>
      <select id="pe-speed" data-settings-change="profile-speed">
        <option value="fast">Fast</option>
        <option value="balanced">Balanced</option>
        <option value="best">Best compression</option>
      </select>
    </div>
    <div id="pe-two-pass-row" class="settings-field">
      <label for="pe-two-pass">Two-pass encoding</label>
      <select id="pe-two-pass">
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
      <span id="pe-two-pass-note" class="help-tip">Two-pass is available only for software compression.</span>
    </div>
    <button type="button" class="advanced-toggle" id="pe-advanced-button" data-settings-click="toggle-advanced" aria-expanded="false">
      <span>Advanced encoding</span>
      <span class="advanced-arrow">⌄</span>
    </button>
    <div id="pe-advanced" class="hid">
      <div class="settings-field">
        <label for="pe-preset">Native FFmpeg preset</label>
        <select id="pe-preset" data-settings-change="profile-preset"></select>
      </div>
      <div class="settings-field" id="pe-rc-row">
        <label for="pe-rc">Quality method</label>
        <select id="pe-rc" data-settings-change="profile-visibility"></select>
      </div>
      <div class="settings-field" id="pe-quality-row">
        <label id="pe-quality-label" for="pe-quality">CQ</label>
        <input id="pe-quality" type="number" min="0" max="51">
        <span class="help-tip">Lower value = higher quality.</span>
      </div>
      <div class="settings-field" id="pe-bitrate-row">
        <label for="pe-bitrate">Bitrate (kbps)</label>
        <input id="pe-bitrate" type="number" min="50" max="50000">
      </div>
      <div class="settings-field" id="pe-tune-row">
        <label for="pe-tune">Tune</label>
        <select id="pe-tune"></select>
      </div>
    </div>
  </div>`;
  }

  function profileEditorHtml(): string {
    return `<div class="settings-grid">
      ${profileEditorTaskHtml()}
      ${profileEditorVideoHtml()}
      ${profileEditorTransformHtml()}
      ${profileEditorAudioHtml()}
      ${profileEditorEncodingHtml()}
    </div>`;
  }

  function peTask(): Workflow {
    return el("pe-u").classList.contains("on") ? "upscale" : "compression";
  }

  function peSetTask(task: Workflow): void {
    el("pe-c").classList.toggle("on", task === "compression");
    el("pe-u").classList.toggle("on", task === "upscale");
    el("pe-size-sec").classList.toggle("hid", task === "upscale");
    el("pe-source-res-row").classList.toggle("hid", task === "upscale");
    if (task === "upscale") input("pe-source-res").checked = false;
    peRateControls();
    peVisibility();
  }

  function peSetSize(value: string | number): void {
    const n = Math.max(2, parseInt(String(value), 10) || 2);
    input("pe-size").value = String(n);
    input("pe-size-range").max = String(Math.max(500, n));
    input("pe-size-range").value = String(n);
  }

  function peSetFps(value: string | number): void {
    const n = Math.max(1, Math.min(240, parseFloat(String(value)) || 30));
    input("pe-fps").value = String(n);
    input("pe-fps-range").value = String(n);
  }

  function pePresets(): void {
    populatePresetSelect(select("pe-preset"), select("pe-enc").value, select("pe-speed").value);
  }

  function peTunes(): void {
    populateTuneSelect(select("pe-tune"), select("pe-enc").value);
  }

  function peRateControls(): void {
    populateRateControlSelect(select("pe-rc"), peTask(), select("pe-enc").value);
  }

  function peEncoderChanged(): void {
    pePresets();
    if (select("pe-enc").value === "auto_compression") {
      select("pe-two-pass").value = "on";
      select("pe-preset").value = "veryslow";
    }
    peTunes();
    peRateControls();
    peVisibility();
  }

  function peSpeedChanged(): void {
    select("pe-preset").value = nativePresetForSpeed(
      select("pe-speed").value,
      select("pe-enc").value,
    );
  }

  function pePresetChanged(): void {
    select("pe-speed").value = speedForNativePreset(select("pe-preset").value);
  }

  function peVisibility(): void {
    const up = peTask() === "upscale";
    const source = input("pe-source-res").checked;
    const sourceFps = input("pe-source-fps").checked;
    const keep = input("pe-audio-source").checked;
    const rc = select("pe-rc").value;
    const cpu =
      !["auto", "auto_compression", "auto_fast"].includes(select("pe-enc").value) &&
      isCpuEncoder(select("pe-enc").value);
    const twoPass = twoPassEligible(peTask(), select("pe-enc").value);
    const quality = up && (rc === "CRF" || rc === "CQ");
    el("pe-dim").classList.toggle("hid", source);
    el("pe-scaler-row").classList.toggle("hid", source);
    el("pe-fps-row").classList.toggle("hid", sourceFps);
    input("pe-audio").disabled = keep;
    el("pe-two-pass-row").classList.toggle("hid", up);
    el("pe-two-pass-note").classList.toggle("hid", !(!up && !twoPass));
    select("pe-two-pass").disabled = !twoPass;
    if (!twoPass) select("pe-two-pass").value = "off";
    el("pe-rc-row").classList.toggle("hid", !up);
    el("pe-quality-row").classList.toggle("hid", !quality);
    el("pe-bitrate-row").classList.toggle("hid", !(up && (rc === "CBR" || rc === "VBR")));
    el("pe-tune-row").classList.toggle("hid", !(up && cpu));
    el("pe-transform-fields").classList.toggle("hid", !input("pe-transform-enabled").checked);
    el("pe-quality-label").textContent = rc === "CRF" ? "CRF" : "CQ";
  }

  function peToggleAdvanced(): void {
    const element = el("pe-advanced");
    const open = element.classList.contains("hid");
    element.classList.toggle("hid", !open);
    el("pe-advanced-button").setAttribute("aria-expanded", String(open));
    const arrow = el("pe-advanced-button").querySelector(".advanced-arrow");
    if (arrow) arrow.textContent = open ? "⌃" : "⌄";
  }

  function peInt(id: string, fallback: number): number {
    const parsed = parseInt(input(id).value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function peFloat(id: string, fallback: number): number {
    const parsed = parseFloat(input(id).value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function pePayload(): SettingsRecord {
    const original = editorOriginal;
    const task = peTask();
    const rcDisplay = select("pe-rc").value;
    const rcMap: Record<string, string> = { CRF: "crf", CQ: "cq", CBR: "cbr", VBR: "vbr" };
    let rc = rcMap[rcDisplay] ?? "crf";
    let quality = parseInt(input("pe-quality").value, 10);
    if (!Number.isFinite(quality)) quality = 23;
    if (original.rate_control_method === "cqp" && rcDisplay === "CQ") rc = "cqp";
    const selectedEncoder = select("pe-enc").value;
    const encoder = editorCapabilities
      ? encoderForPlatform(selectedEncoder, editorCapabilities)
      : selectedEncoder;
    const data: SettingsRecord = {
      name: input("pe-name").value.trim() || "Profile",
      target_size_mb: peInt("pe-size", 50),
      resolution_mode: input("pe-source-res").checked ? "source" : "custom",
      custom_width: peInt("pe-w", 1920),
      custom_height: peInt("pe-h", 1080),
      max_width: peInt("pe-w", 1920),
      max_height: peInt("pe-h", 1080),
      fps_mode: input("pe-source-fps").checked ? "source" : "custom",
      custom_fps: peFloat("pe-fps", 30),
      max_fps: peFloat("pe-fps", 30),
      audio_bitrate_kbps: peInt("pe-audio", 0),
      keep_audio: input("pe-audio-source").checked,
      two_pass:
        twoPassEligible(task, encoder) && select("pe-two-pass").value === "on",
      preset: select("pe-preset").value,
      scaler: select("pe-scaler").value.toLowerCase(),
      video_encoder: encoder,
      workflow: task,
      rate_control_method: rc,
      rate_control:
        task === "upscale" && (rc === "cbr" || rc === "vbr")
          ? "explicit_bitrate"
          : "target_size",
      crf: rc === "crf" ? quality : valueOr(original.crf as number, 23),
      cq: rc === "cq" ? quality : valueOr(original.cq as number, 23),
      qp: rc === "cqp" ? quality : valueOr(original.qp as number, 23),
      tune:
        task === "upscale" &&
        isCpuEncoder(encoder) &&
        select("pe-tune").value !== "none"
          ? select("pe-tune").value
          : "",
      transform_intent: input("pe-transform-enabled").checked
        ? {
            crop_aspect: select("pe-aspect").value,
            sizing_mode: select("pe-sizing").value,
            rotation: parseInt(select("pe-rotation").value, 10) || 0,
          }
        : null,
    };
    if (task === "upscale" && (rc === "cbr" || rc === "vbr"))
      data.explicit_bitrate_kbps = peInt("pe-bitrate", 2000);
    return data;
  }

  async function hydrateEditor(caps: PlatformCapabilities): Promise<void> {
    editorCapabilities = caps;
    populateEncoderSelect(
      select("pe-enc"),
      encodersForPlatform(session.availEncoders, caps),
      supportsHardwareEncoders(caps),
    );
    let p: ProfileListEntry | undefined;
    if (settingsProfileId) {
      const profiles = (await legacyBackendResult(client().getProfilesJson())) as unknown as
        | ProfileListEntry[]
        | { ok: false };
      if (Array.isArray(profiles)) p = profiles.find((x) => x.profile_id === settingsProfileId);
    }
    editorOriginal = (p as SettingsRecord | undefined) ?? {};
    const scaler = p ? String(p.scaler) : String(appSettings().default_scaler || "neighbor");
    const fps = p ? Math.round(valueOr(num(p.custom_fps), valueOr(num(p.max_fps), 30))) : 30;
    input("pe-name").value = p ? p.name ?? "" : "";
    peSetSize(
      p ? Math.round(valueOr(num(p.target_size_bytes), 50 * 1024 * 1024) / (1024 * 1024)) : 50,
    );
    input("pe-w").value = String(p ? valueOr(num(p.custom_width), valueOr(num(p.max_width), 1920)) : 1920);
    input("pe-h").value = String(
      p ? valueOr(num(p.custom_height), valueOr(num(p.max_height), 1080)) : 1080,
    );
    select("pe-scaler").value =
      scaler === "neighbor" ? "Neighbor" : scaler[0]!.toUpperCase() + scaler.slice(1);
    input("pe-source-res").checked = p ? p.resolution_mode !== "custom" : true;
    input("pe-source-fps").checked = p ? p.fps_mode !== "custom" : true;
    peSetFps(fps);
    input("pe-audio-source").checked = !!(p && p.keep_audio);
    input("pe-audio").value = String(p ? valueOr(num(p.audio_bitrate_kbps), 128) : 128);
    const intent = (p && p.transform_intent) as SettingsRecord | null | undefined;
    input("pe-transform-enabled").checked = !!intent;
    select("pe-aspect").value = intent ? String(intent.crop_aspect || "free") : "free";
    select("pe-sizing").value = intent ? String(intent.sizing_mode || "fit") : "fit";
    select("pe-rotation").value = String(intent ? intent.rotation || 0 : 0);
    select("pe-enc").value = encoderForPlatform(
      p ? String(valueOr(p.video_encoder as string, "libx264")) : "libx264",
      caps,
    );
    if (!select("pe-enc").value) select("pe-enc").selectedIndex = 0;
    peEncoderChanged();
    select("pe-preset").value = p
      ? String(valueOr(p.preset as string, nativePresetForSpeed("balanced", select("pe-enc").value)))
      : nativePresetForSpeed("balanced", select("pe-enc").value);
    if (!select("pe-preset").value)
      select("pe-preset").value = nativePresetForSpeed("balanced", select("pe-enc").value);
    pePresetChanged();
    select("pe-two-pass").value = p && p.two_pass ? "on" : "off";
    input("pe-quality").value = String(
      p
        ? p.rate_control_method === "crf"
          ? valueOr(num(p.crf), 23)
          : p.rate_control_method === "cqp"
            ? valueOr(num(p.qp), 23)
            : valueOr(num(p.cq), 23)
        : 23,
    );
    input("pe-bitrate").value = String(p ? valueOr(num(p.explicit_bitrate_kbps), 2000) : 2000);
    peSetTask(p && p.workflow === "upscale" ? "upscale" : "compression");
    const rcMap: Record<string, string> = {
      crf: "CRF",
      cq: "CQ",
      cqp: "CQ",
      cbr: "CBR",
      vbr: "VBR",
    };
    const rateControl = rcMap[String(p ? p.rate_control_method : "cbr")] ?? "CRF";
    if (Array.from(select("pe-rc").options).some((option) => option.value === rateControl))
      select("pe-rc").value = rateControl;
    peVisibility();
    editorSnapshot = JSON.stringify(pePayload());
  }

  function editorDirty(): boolean {
    return !!editorSnapshot && JSON.stringify(pePayload()) !== editorSnapshot;
  }

  function backToProfiles(): void {
    const goBack = (): void => {
      settingsView = "page";
      settingsProfileId = "";
      void open("profiles");
    };
    if (editorDirty()) confirmToast("Discard unsaved profile changes?", goBack);
    else goBack();
  }

  async function saveProfileEditor(): Promise<void> {
    const r = settingsProfileId
      ? await legacyBackendResult(client().updateProfile(settingsProfileId, pePayload() as never))
      : await legacyBackendResult(client().createProfile(pePayload() as never));
    if (r.ok) {
      await deps.reloadEditorSettings();
      settingsView = "page";
      settingsProfileId = "";
      await open("profiles");
      toast("Profile saved.", "ok");
    } else {
      toast(r.error ?? "Could not save profile.", "err");
    }
  }

  function markSettingsDirty(): void {
    settingsDirty = settingsAreDirty(snapshot, settingsPageState());
    const indicator = byId("settings-unsaved");
    if (indicator) {
      indicator.textContent = "Unsaved changes";
      indicator.classList.toggle("on", settingsDirty);
    }
    const saveButton = document.querySelector<HTMLButtonElement>('[data-settings-save="true"]');
    if (saveButton) saveButton.disabled = !settingsDirty;
  }

  function settingsPageState(): SettingsRecord {
    if (settingsPage === "general")
      return {
        defaultProfile: select("set-dp").value,
        defaultScaler: select("set-ds").value,
        inspectorStartPanel: select("set-inspector-start").value,
        openOutput: input("set-open-output-folder").checked,
        autoClear: input("set-auto-clear").checked,
      };
    if (settingsPage === "output")
      return {
        outputDirectory: el("set-od").dataset.path || "",
        compressionSuffix: input("set-cs").value,
        upscaleSuffix: input("set-us").value,
      };
    if (settingsPage === "system")
      return {
        ffmpegPath: el("set-ffmpeg").dataset.path || "",
        ffprobePath: el("set-ffprobe").dataset.path || "",
        encoderCacheDays: select("set-encoder-cache-days").value,
        checkUpdates: byId<HTMLInputElement>("set-check-updates")?.checked ?? false,
      };
    return {};
  }

  function captureSettingsSnapshot(): void {
    snapshot = settingsSnapshot(settingsPageState());
    settingsDirty = false;
    markSettingsDirty();
  }

  function generalSettingsHtml(s: SettingsRecord, profiles: readonly ProfileListEntry[]): string {
    const options = profiles
      .map((p) => `<option value="${esc(p.profile_id)}">${esc(p.name)}</option>`)
      .join("");
    const scalers = ["Bilinear", "Bicubic", "Lanczos", "Point", "Neighbor"]
      .map((x) => {
        const selected = x.toLowerCase() === String(s.default_scaler || "neighbor") ? "selected" : "";
        return `<option ${selected}>${x}</option>`;
      })
      .join("");
    const autoClear = s.clear_completed_automatically ? "checked" : "";
    const openOutput = s.open_output_folder_after_queue ? "checked" : "";
    const inspectorStart = String(s.inspector_start_panel || "export");
    const inspectorOptions = (
      [
        ["last", "Last used"],
        ["video", "Transform"],
        ["audio", "Audio"],
        ["export", "Export"],
      ] as const
    )
      .map(([value, label]) => {
        const selected = value === inspectorStart ? "selected" : "";
        return `<option value="${value}" ${selected}>${label}</option>`;
      })
      .join("");
    return `<div class="settings-card">
    <h3 class="settings-card-title">Task defaults</h3>
    <p class="settings-card-copy">Use these when a profile does not specify a setting.</p>
    <div class="settings-grid">
      <div class="settings-field">
        <label for="set-dp">Default profile</label>
        <select id="set-dp" data-settings-change="mark-dirty">${options}</select>
      </div>
      <div class="settings-field">
        <label for="set-ds">Default scaler</label>
        <select id="set-ds" data-settings-change="mark-dirty">${scalers}</select>
      </div>
    </div>
  </div>
  <div class="settings-card">
    <h3 class="settings-card-title">Inspector</h3>
    <div class="settings-grid">
      <div class="settings-field full">
        <label for="set-inspector-start">Open on launch</label>
        <select id="set-inspector-start" data-settings-change="mark-dirty">${inspectorOptions}</select>
      </div>
    </div>
  </div>
  <div class="settings-card">
    <h3 class="settings-card-title">When the queue finishes</h3>
    <div class="settings-option-list">
      <label class="chk settings-option">
        <input id="set-open-output-folder" type="checkbox" ${openOutput} data-settings-change="mark-dirty">
        <span class="chk-box" aria-hidden="true"></span>
        <span class="settings-option-copy">
          <strong>Open the output folder</strong>
          <small>Opens the folder containing the last successful export.</small>
        </span>
      </label>
      <label class="chk settings-option">
        <input id="set-auto-clear" type="checkbox" ${autoClear} data-settings-change="mark-dirty">
        <span class="chk-box" aria-hidden="true"></span>
        <span class="settings-option-copy">
          <strong>Clear completed jobs automatically</strong>
          <small>Keep failed and cancelled jobs so you can retry them.</small>
        </span>
      </label>
    </div>
  </div>`;
  }

  function outputSettingsHtml(s: SettingsRecord): string {
    const outputDir = esc(s.output_dir || "");
    const outputLabel = esc(s.output_dir || "Next to each source file");
    const compressionSuffix = esc(s.compression_suffix || "_tucked_{size}");
    const upscaleSuffix = esc(s.upscale_suffix || "_upscaled_{width}x{height}");
    return `<div class="settings-card">
    <h3 class="settings-card-title">Output folder</h3>
    <div class="settings-card-copy">Save beside each source file, or choose one folder for every completed export.</div>
    <div class="settings-output-location">
      <div id="set-od" class="settings-readonly selectable" data-path="${outputDir}">${outputLabel}</div>
      <button type="button" class="btn2" data-settings-click="browse-output">Browse…</button>
      <button type="button" class="btn2" data-settings-click="clear-output">Use source folder</button>
    </div>
  </div>
  <section class="file-naming">
    <h3>File names</h3>
    <div class="settings-grid">
      <div class="settings-field">
        <label for="set-cs">Compress suffix</label>
        <input id="set-cs" value="${compressionSuffix}" data-settings-input="preview-output">
        <div class="settings-token-row">
          <button type="button" class="settings-token" data-settings-click="insert-token" data-settings-target="set-cs" data-settings-token="{size}">{size}</button>
        </div>
      </div>
      <div class="settings-field">
        <label for="set-us">Upscale suffix</label>
        <input id="set-us" value="${upscaleSuffix}" data-settings-input="preview-output">
        <div class="settings-token-row">
          <button type="button" class="settings-token" data-settings-click="insert-token" data-settings-target="set-us" data-settings-token="{width}">{width}</button>
          <button type="button" class="settings-token" data-settings-click="insert-token" data-settings-target="set-us" data-settings-token="{height}">{height}</button>
        </div>
      </div>
      <div class="file-naming-example full">
        <span>Compress preview</span>
        <div class="example-out" id="ex-out"></div>
      </div>
      <div class="file-naming-example full">
        <span>Upscale preview</span>
        <div class="example-out" id="ex-up-out"></div>
      </div>
    </div>
  </section>`;
  }

  function profilesSettingsHtml(): string {
    return `<div class="settings-profile-filterbar">
    <div class="profile-filters" role="group" aria-label="Filter profiles">
      <button type="button" id="pm-all" aria-pressed="true" data-settings-click="filter-profiles" data-settings-value="all">All</button>
      <button type="button" id="pm-compression" aria-pressed="false" data-settings-click="filter-profiles" data-settings-value="compression">Compress</button>
      <button type="button" id="pm-upscale" aria-pressed="false" data-settings-click="filter-profiles" data-settings-value="upscale">Upscale</button>
    </div>
  </div>
  <div id="pm-list" class="settings-list"></div>`;
  }

  function explorerSettingsHtml(): string {
    return `<div class="settings-card">
    <h3 class="settings-card-title">Send to shortcuts</h3>
    <div class="settings-card-copy">
      Open videos in Tuck from File Explorer.
      If a shortcut stops working, you can repair it here.
    </div>
    <div id="st-list" class="settings-list"></div>
  </div>`;
  }

  function systemStatusHtml(s: SettingsRecord, caps: PlatformCapabilities): string {
    const ffmpegReady = !!s.ffmpeg_available;
    const ffprobeReady = !!s.ffprobe_available;
    const ffmpegPath = esc(s.ffmpeg_path || s.detected_ffmpeg_path || "Automatic detection");
    const ffprobePath = esc(s.ffprobe_path || s.detected_ffprobe_path || "Automatic detection");
    const encoders = esc(encoderDisplaySummary(encodersForPlatform(toStringArray(s.available_encoders), caps)));
    const webViewStatus =
      caps.platform === "windows"
        ? `<div class="settings-status-row">
        <div>WebView2</div>
        <div class="settings-status-value">
          <span class="status-good">Ready</span> · Edge runtime
        </div>
        <div class="settings-status-actions"></div>
      </div>`
        : "";
    return `<div class="settings-card">
    <h3 class="settings-card-title">System status</h3>
    <div class="settings-status-table" aria-label="System readiness">
      <div class="settings-status-row">
        <div>FFmpeg</div>
        <div class="settings-status-value">
          <span class="${ffmpegReady ? "status-good" : "status-warn"}">
            ${ffmpegReady ? "Ready" : "Missing"}
          </span>
          · ${ffmpegPath}
        </div>
        <div class="settings-status-actions">
          <button type="button" class="btn2" data-settings-click="browse-ffmpeg">Change</button>
        </div>
      </div>
      <div class="settings-status-row">
        <div>FFprobe</div>
        <div class="settings-status-value">
          <span class="${ffprobeReady ? "status-good" : "status-warn"}">
            ${ffprobeReady ? "Ready" : "Missing"}
          </span>
          · ${ffprobePath}
        </div>
        <div class="settings-status-actions">
          <button type="button" class="btn2" data-settings-click="browse-ffprobe">Change</button>
        </div>
      </div>
      <div class="settings-status-row">
        <div>Encoders</div>
        <div class="settings-status-value">${encoders}</div>
        <div class="settings-status-actions">
          <button type="button" class="btn2" data-settings-click="refresh-encoders">Rescan</button>
        </div>
      </div>
      ${webViewStatus}
    </div>
  </div>`;
  }

  function systemUpdatesHtml(s: SettingsRecord, caps: PlatformCapabilities): string {
    if (!shouldShowUpdater(caps)) return "";
    const updateStatus = s.last_update_check
      ? `Last checked: ${esc(s.last_update_check)}`
      : "Not checked yet.";
    const checkUpdates = s.check_updates ? "checked" : "";
    return `<div class="settings-card">
    <h3 class="settings-card-title">Updates</h3>
    <div class="settings-list-row">
      <div class="settings-list-main">
        <strong>Tuck ${esc(s.version || "")}</strong>
        <span>${updateStatus}</span>
      </div>
      <button type="button" class="btn2" data-settings-click="check-updates">Check now</button>
    </div>
    <label class="chk" style="margin-top:12px">
      <input id="set-check-updates" type="checkbox" ${checkUpdates} data-settings-change="mark-dirty">
      <span class="chk-box" aria-hidden="true"></span>
      <span>Check automatically at startup</span>
    </label>
  </div>`;
  }

  function systemSupportHtml(): string {
    return `<div class="settings-card">
    <h3 class="settings-card-title">Support</h3>
    <div class="settings-card-copy">
      Copy a diagnostic report with app versions, encoder status, and recent errors.
      Personal folder paths are removed.
    </div>
    <div class="settings-support-actions">
      <button type="button" class="btn1" data-settings-click="copy-diagnostics">Copy diagnostics</button>
      <button type="button" class="btn2" data-settings-click="open-support" data-settings-value="logs">Open logs folder</button>
      <button type="button" class="btn2" data-settings-click="open-support" data-settings-value="config">Open configuration folder</button>
    </div>
  </div>`;
  }

  function systemAdvancedHtml(s: SettingsRecord): string {
    const ffmpegPath = esc(s.ffmpeg_path || "");
    const ffprobePath = esc(s.ffprobe_path || "");
    const ffmpegLabel = esc(s.ffmpeg_path || "Use PATH or automatic detection");
    const ffprobeLabel = esc(s.ffprobe_path || "Use PATH or automatic detection");
    return `<details class="settings-advanced">
    <summary>Advanced system settings</summary>
    <div class="settings-advanced-body settings-grid">
      <div class="settings-field full">
        <label for="set-ffmpeg">Custom FFmpeg path</label>
        <div class="row">
          <div id="set-ffmpeg" class="settings-readonly" style="flex:1" data-path="${ffmpegPath}">
            ${ffmpegLabel}
          </div>
          <button type="button" class="btn2" data-settings-click="clear-ffmpeg">Use automatic</button>
        </div>
      </div>
      <div class="settings-field full">
        <label for="set-ffprobe">Custom FFprobe path</label>
        <div class="row">
          <div id="set-ffprobe" class="settings-readonly" style="flex:1" data-path="${ffprobePath}">
            ${ffprobeLabel}
          </div>
          <button type="button" class="btn2" data-settings-click="clear-ffprobe">Use automatic</button>
        </div>
      </div>
      <div class="settings-field full">
        <label for="set-encoder-cache-days">Encoder detection cache</label>
        <select id="set-encoder-cache-days" data-settings-change="mark-dirty">
          <option value="0">Disabled</option>
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
        <span class="help-tip">Caching hardware probes makes startup faster.</span>
      </div>
    </div>
  </details>`;
  }

  function systemSettingsHtml(s: SettingsRecord, caps: PlatformCapabilities): string {
    return (
      systemStatusHtml(s, caps) +
      systemUpdatesHtml(s, caps) +
      systemSupportHtml() +
      systemAdvancedHtml(s)
    );
  }

  function toggle(): void {
    if (document.body.classList.contains("settings-open")) close();
    else void open();
  }

  async function open(page?: string, view?: string, profileId?: string): Promise<void> {
    settingsPage = page || settingsPage;
    settingsView = view === "editor" ? "editor" : "page";
    if (profileId !== undefined) settingsProfileId = profileId;
    const caps = await fetchPlatformCapabilities();
    if (!shouldShowSendTo(caps) && settingsPage === "explorer") settingsPage = "general";
    const s = (await legacyBackendResult(client().getSettings())) as SettingsRecord;
    const profiles = (Array.isArray(s.profiles) ? s.profiles : []) as ProfileListEntry[];
    if (settingsPage === "profiles" && settingsView === "editor") {
      settingsShell(
        "profiles",
        profileEditorHtml(),
        {
          html:
            settingButton("Cancel", "back-profiles") +
            settingButton("Save profile", "save-profile", true),
        },
        caps,
      );
      await hydrateEditor(caps);
      input("pe-name").focus();
      return;
    }
    let content = "";
    let actions: { html?: string; split?: boolean; plain?: boolean } = { html: "" };
    if (settingsPage === "general") {
      content = generalSettingsHtml(s, profiles);
      actions = { html: settingButton("Save changes", "save-general", true, true) };
    } else if (settingsPage === "output") {
      content = outputSettingsHtml(s);
      actions = { html: settingButton("Save changes", "save-output", true, true) };
    } else if (settingsPage === "profiles") {
      content = profilesSettingsHtml();
      actions = {
        plain: true,
        html:
          settingButton("Import", "import-profiles") +
          '<span class="settings-action-spacer"></span>' +
          settingButton("New profile", "new-profile", true),
      };
    } else if (settingsPage === "explorer") {
      content = explorerSettingsHtml();
      actions = { html: settingButton("Add shortcut", "add-shortcut", true) };
    } else {
      content = systemSettingsHtml(s, caps);
      actions = { html: settingButton("Save changes", "save-system", true, true) };
    }
    settingsShell(settingsPage, content, actions, caps);
    settingsDirty = false;
    if (settingsPage === "general") select("set-dp").value = String(s.default_profile_id || "");
    if (settingsPage === "output") updateExampleOutput();
    if (settingsPage === "profiles") await refreshProfileManagerList(settingsFilter);
    if (settingsPage === "explorer" && shouldShowSendTo(caps)) await refreshShortcutList();
    if (settingsPage === "system")
      select("set-encoder-cache-days").value = String(s.encoder_cache_days || 0);
    if (["general", "output", "system"].indexOf(settingsPage) >= 0) captureSettingsSnapshot();
  }

  function navigateSettings(page: string): void {
    if (settingsView === "editor") {
      if (editorDirty()) {
        confirmToast("Discard unsaved profile changes?", () => void open(page));
      } else void open(page);
      return;
    }
    if (settingsDirty)
      confirmToast("Discard unsaved settings?", () => {
        settingsDirty = false;
        void open(page);
      });
    else void open(page);
  }

  function close(): void {
    if (settingsView === "editor" && editorDirty())
      return confirmToast("Discard unsaved profile changes?", () => {
        settingsView = "page";
        settingsProfileId = "";
        closeSettingsWorkspace();
      });
    if (settingsDirty)
      return confirmToast("Discard unsaved settings?", () => {
        settingsDirty = false;
        closeSettingsWorkspace();
      });
    closeSettingsWorkspace();
  }

  function closeSettingsWorkspace(): void {
    document.body.classList.remove("settings-open");
    el("editor-shell").inert = false;
    if (
      settingsReturnFocus &&
      settingsReturnFocus.isConnected &&
      settingsReturnFocus instanceof HTMLElement
    )
      settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }

  function clearPath(id: string, placeholder: string): void {
    const node = el(id);
    node.dataset.path = "";
    node.textContent = placeholder;
  }

  async function browseOutput(): Promise<void> {
    const r = await legacyBackendResult(client().pickFolder());
    if (r.ok && typeof r.path === "string" && r.path) {
      const node = el("set-od");
      node.dataset.path = r.path;
      node.textContent = r.path;
      markSettingsDirty();
    }
  }

  function clearOutput(): void {
    clearPath("set-od", "Next to each source file");
    markSettingsDirty();
  }

  async function browseFfmpeg(): Promise<void> {
    const r = await legacyBackendResult(client().pickFfmpegFile());
    if (r.ok && typeof r.path === "string" && r.path) {
      const node = el("set-ffmpeg");
      node.dataset.path = r.path;
      node.textContent = r.path;
      markSettingsDirty();
    }
  }

  async function browseFfprobe(): Promise<void> {
    const r = await legacyBackendResult(client().pickFfprobeFile());
    if (r.ok && typeof r.path === "string" && r.path) {
      const node = el("set-ffprobe");
      node.dataset.path = r.path;
      node.textContent = r.path;
      markSettingsDirty();
    }
  }

  function clearFfmpeg(): void {
    clearPath("set-ffmpeg", "Use PATH or automatic detection");
    markSettingsDirty();
  }

  function clearFfprobe(): void {
    clearPath("set-ffprobe", "Use PATH or automatic detection");
    markSettingsDirty();
  }

  async function persistSettings(data: SettingsRecord): Promise<boolean> {
    const r = await legacyBackendResult(client().saveSettings(data as never));
    if (r.ok) {
      Object.assign(session.appSettings, data);
      snapshot = settingsSnapshot(settingsPageState());
      settingsDirty = false;
      const saveButton = document.querySelector<HTMLButtonElement>('[data-settings-save="true"]');
      if (saveButton) saveButton.disabled = true;
      await deps.reloadEditorSettings();
      const indicator = byId("settings-unsaved");
      if (indicator) {
        indicator.textContent = "Saved";
        indicator.classList.add("on");
        setTimeout(() => {
          if (indicator.isConnected) indicator.classList.remove("on");
        }, 1200);
      }
      toast("Settings saved.", "ok");
      return true;
    }
    toast(r.error ?? "Could not save settings.", "err");
    return false;
  }

  async function saveGeneralSettings(): Promise<void> {
    await persistSettings({
      default_profile_id: select("set-dp").value,
      default_scaler: select("set-ds").value.toLowerCase(),
      inspector_start_panel: select("set-inspector-start").value,
      clear_completed_automatically: input("set-auto-clear").checked,
      open_output_folder_after_queue: input("set-open-output-folder").checked,
    });
  }

  async function saveOutputSettings(): Promise<void> {
    await persistSettings({
      output_dir: el("set-od").dataset.path || "",
      compression_suffix: input("set-cs").value.trim() || "_tucked_{size}",
      upscale_suffix: input("set-us").value.trim() || "_upscaled_{width}x{height}",
    });
  }

  async function saveSystemSettings(): Promise<void> {
    const data: SettingsRecord = {
      ffmpeg_path: el("set-ffmpeg").dataset.path || "",
      ffprobe_path: el("set-ffprobe").dataset.path || "",
      encoder_cache_days: parseInt(select("set-encoder-cache-days").value, 10),
    };
    const checkUpdates = byId<HTMLInputElement>("set-check-updates");
    if (checkUpdates) data.check_updates = checkUpdates.checked;
    await persistSettings(data);
  }

  async function refreshEncoders(): Promise<void> {
    if (settingsDirty) {
      confirmToast("Refresh encoders and discard unsaved settings?", () => {
        settingsDirty = false;
        void refreshEncoders();
      });
      return;
    }
    const r = await legacyBackendResult(client().refreshEncoders());
    if (r.ok) {
      deps.setAvailableEncoders(toStringArray(r.available_encoders));
      toast("Encoder detection refreshed.", "ok");
      void open("system");
    } else {
      toast(r.error ?? "Could not refresh encoders.", "err");
    }
  }

  function insertNamingToken(id: string, token: string): void {
    const field = input(id);
    if (!field.value.includes(token)) field.value += token;
    markSettingsDirty();
    updateExampleOutput();
    field.focus();
  }

  async function openSupportFolder(kind: string): Promise<void> {
    const r =
      kind === "logs"
        ? await legacyBackendResult(client().openLogsFolder())
        : await legacyBackendResult(client().openConfigFolder());
    if (!r.ok) toast(r.error ?? "Could not open folder.", "err");
  }

  function updateExampleOutput(): void {
    const compress = byId<HTMLInputElement>("set-cs");
    const upscale = byId<HTMLInputElement>("set-us");
    if (compress && byId("ex-out")) {
      el("ex-out").textContent =
        `video${(compress.value.trim() || "_tucked_{size}").replace("{size}", "20MB")}.mp4`;
    }
    if (upscale && byId("ex-up-out")) {
      el("ex-up-out").textContent =
        `video${(upscale.value.trim() || "_upscaled_{width}x{height}")
          .replace("{width}", "1920")
          .replace("{height}", "1080")}.mp4`;
    }
  }

  interface ShortcutRecord {
    readonly type?: string;
    readonly name?: string;
    readonly profile_id?: string;
    readonly status?: string;
  }

  async function refreshShortcutList(): Promise<void> {
    const list = byId("st-list");
    if (!list) return;
    const r = await legacyBackendResult(client().listSendtoShortcuts());
    list.replaceChildren();
    const shortcuts = (Array.isArray(r.shortcuts) ? r.shortcuts : []) as ShortcutRecord[];
    for (const shortcut of shortcuts) {
      const row = document.createElement("div");
      row.className = "settings-list-row";
      const profile =
        shortcut.type === "profile"
          ? profileShortcutName(shortcut.profile_id || shortcut.name || "")
          : "Default shortcut";
      const status =
        shortcut.status === "ok"
          ? "Installed"
          : shortcut.status === "broken"
            ? "Needs repair"
            : shortcut.status === "missing"
              ? "Missing"
              : shortcut.status || "Unknown";
      const main = document.createElement("div");
      main.className = "settings-list-main";
      main.appendChild(elementWithText("strong", shortcut.name || profile));
      main.appendChild(elementWithText("span", profile));
      const badge = elementWithText("span", status);
      badge.className = shortcut.status === "ok" ? "settings-badge" : "status-warn";
      main.appendChild(badge);
      row.appendChild(main);
      const repair = document.createElement("button");
      repair.className = "btn2";
      repair.textContent = "Repair";
      repair.addEventListener("click", () => void repairShortcut(shortcut));
      const remove = document.createElement("button");
      remove.className = "btn2";
      remove.style.color = "var(--danger)";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeShortcut(shortcut));
      row.appendChild(repair);
      row.appendChild(remove);
      list.appendChild(row);
    }
    if (!list.children.length) {
      list.appendChild(elementWithText("div", "No Explorer shortcuts installed.", "settings-empty"));
    }
  }

  async function addShortcutFlow(): Promise<void> {
    const caps = await fetchPlatformCapabilities();
    if (!shouldShowSendTo(caps)) return;
    const profiles = (await legacyBackendResult(client().getProfilesJson())) as unknown as
      | ProfileListEntry[]
      | { ok: false };
    const content = `${settingsTitle("Add shortcut", "open-explorer")}
    <div id="profile-shortcut-choices" style="display:flex;flex-direction:column;gap:6px"></div>`;
    settingsShell("explorer", content, { html: "" }, caps);
    const choices = el("profile-shortcut-choices");
    renderShortcutChoices(document, choices, Array.isArray(profiles) ? profiles : [], {
      summarize: profileSummary,
    });
    bindProfileActions(choices, (action, profileId, name) => {
      if (action === "install-generic-shortcut") void installGenericShortcut();
      else if (action === "install-profile-shortcut") void installProfileShortcut(profileId, name);
    });
  }

  async function installGenericShortcut(): Promise<void> {
    const r = await legacyBackendResult(client().installGenericSendto());
    if (r.ok) toast("Explorer shortcuts installed.", "ok");
    else toast(r.error ?? "Could not add the Explorer shortcuts.", "err");
    void open("explorer");
  }

  async function installProfileShortcut(pid: string, name: string): Promise<void> {
    const r = await legacyBackendResult(client().installProfileSendto(pid, "start"));
    if (r.ok) toast(`Added "${name}" to Explorer.`, "ok");
    else toast(r.error ?? "Could not add the profile shortcut.", "err");
    void open("explorer");
  }

  function removeShortcut(data: ShortcutRecord): void {
    confirmToast(
      data.type === "generic" ? "Remove both Tuck shortcuts?" : "Remove shortcut?",
      () => {
        void legacyBackendResult(
          data.type === "generic"
            ? client().removeGenericSendto()
            : client().removeProfileSendto(data.profile_id || data.name || ""),
        ).then((r) => {
          if (r.ok) toast("Shortcut removed.", "ok");
          else toast(r.error ?? "Could not remove the shortcut.", "err");
          void refreshShortcutList();
        });
      },
    );
  }

  async function repairShortcut(data: ShortcutRecord): Promise<void> {
    const r =
      data.type === "generic"
        ? await legacyBackendResult(client().installGenericSendto())
        : await legacyBackendResult(
            client().repairProfileSendto(data.profile_id || data.name || ""),
          );
    if (r.ok) toast("Shortcut repaired.", "ok");
    else toast(r.error ?? "Could not repair the shortcut.", "err");
    void refreshShortcutList();
  }

  bindDelegatedEvents(
    el("settings-workspace"),
    {
      click: {
        "close-overlay": (target, event) => {
          if (event.target === target) close();
        },
        close: () => close(),
        navigate: (target) => navigateSettings(target.dataset.settingsValue ?? ""),
        "back-profiles": () => backToProfiles(),
        "save-profile": () => void saveProfileEditor(),
        "save-general": () => void saveGeneralSettings(),
        "save-output": () => void saveOutputSettings(),
        "import-profiles": () => void importProfiles(),
        "new-profile": () => void newProfile(),
        "add-shortcut": () => void addShortcutFlow(),
        "save-system": () => void saveSystemSettings(),
        "open-explorer": () => void open("explorer"),
        "profile-task": (target) => peSetTask((target.dataset.settingsValue as Workflow) ?? "compression"),
        "profile-size": (target) => peSetSize(target.dataset.settingsValue ?? "50"),
        "toggle-advanced": () => peToggleAdvanced(),
        "browse-output": () => void browseOutput(),
        "clear-output": () => clearOutput(),
        "insert-token": (target) =>
          insertNamingToken(
            target.dataset.settingsTarget ?? "",
            target.dataset.settingsToken ?? "",
          ),
        "filter-profiles": (target) =>
          void refreshProfileManagerList(target.dataset.settingsValue ?? "all"),
        "browse-ffmpeg": () => void browseFfmpeg(),
        "browse-ffprobe": () => void browseFfprobe(),
        "refresh-encoders": () => void refreshEncoders(),
        "check-updates": () => void deps.checkForUpdates(),
        "copy-diagnostics": () => void deps.copyDiagnostics(),
        "open-support": (target) => void openSupportFolder(target.dataset.settingsValue ?? "logs"),
        "clear-ffmpeg": () => clearFfmpeg(),
        "clear-ffprobe": () => clearFfprobe(),
      },
      input: {
        "profile-size": (target) => peSetSize((target as HTMLInputElement).value),
        "profile-fps": (target) => peSetFps((target as HTMLInputElement).value),
        "preview-output": () => {
          markSettingsDirty();
          updateExampleOutput();
        },
      },
      change: {
        "profile-visibility": () => peVisibility(),
        "profile-encoder": () => peEncoderChanged(),
        "profile-speed": () => peSpeedChanged(),
        "profile-preset": () => pePresetChanged(),
        "mark-dirty": () => markSettingsDirty(),
      },
    },
    "settings",
  );

  return {
    toggle,
    open,
    close,
    isOpen: () => document.body.classList.contains("settings-open"),
  };
}

function elementWithText(tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
