import type { BackendClient, SendToKind } from "../../backend/types.ts";
import { bindDelegatedEvents } from "../../ui/delegated-events.ts";
import { settingsSnapshot } from "../../state/settings-state.ts";
import {
  encoderDisplaySummary,
  encoderLabel,
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
import { confirmToast, discardChangesIntent, toast } from "../editor/toast.ts";
import { lutSettings } from "../export/lut-controls.ts";
import { HIDEABLE_PARTS, hiddenParts, isTaskName, visibleTasks, type HideablePart, type TaskName } from "./visibility.ts";
import {
  bindingFromEvent,
  bindingKeys,
  commandsUsing,
  displayShortcut,
  editableCommands,
  isAssignableBinding,
  sameBinding,
  setShortcutOverrides,
  shortcutOverrides,
  type EditableCommand,
} from "../shortcuts/shortcuts.ts";
import type { EditorSession } from "../editor/session.ts";
import {
  button,
  card,
  choiceGroup,
  fragment,
  h,
  icon,
  row,
  section,
  select as selectControl,
  switchRow,
  textInput,
  toolbar,
  type Content,
  type IconName,
} from "./settings-markup.ts";
import {
  highlightParts,
  pageTitle,
  searchSettings,
  SETTINGS_INDEX,
  SETTINGS_PAGES,
  settingsPage,
  type SettingsEntry,
  type SettingsPage,
} from "./settings-search.ts";

export interface SettingsDeps {
  syncSelects: () => void;
  session: EditorSession;
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  getBackendClient: () => BackendClient;
  reloadEditorSettings: (preserveExportSettings?: boolean) => Promise<void>;
  setAvailableEncoders: (encoders: string[]) => void;
  copyDiagnostics: () => void | Promise<void>;
  checkForUpdates: () => void | Promise<void>;
  showShortcutGuide: () => void;
}

export interface SettingsApi {
  toggle: () => void;
  open: (page?: string, view?: string, profileId?: string) => Promise<void>;
  close: () => void;
  isOpen: () => boolean;
}

type SettingsRecord = Record<string, unknown>;
type View = "page" | "editor" | "shortcut-choices" | "search";

const DEFAULT_COMPRESSION_SUFFIX = "_tucked_{size}";
const DEFAULT_UPSCALE_SUFFIX = "_upscaled_{width}x{height}";
const DEFAULT_CUT_SUFFIX = "_cut";
const EXAMPLE_NAME = "Morning ride";

// the page heading can say more than the short name in the sidebar
const HEADINGS: Partial<Record<SettingsPage, string>> = { keyboard: "Keyboard shortcuts" };

const ACCENTS: readonly { value: string; label: string }[] = [
  { value: "violet", label: "Violet" },
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "green", label: "Green" },
  { value: "amber", label: "Amber" },
  { value: "rose", label: "Rose" },
];

const SCALERS = ["Bilinear", "Bicubic", "Lanczos", "Point", "Neighbor"] as const;

const NAMING_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "set-cs": ["{size}"],
  "set-us": ["{width}", "{height}"],
};

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

  let page: SettingsPage = "general";
  let view: View = "page";
  let settingsProfileId = "";
  let profileFilter = "all";
  let searchQuery = "";
  let editorOriginal: SettingsRecord = {};
  let editorSnapshot = "";
  let snapshot = "";
  let settingsDirty = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let settingsReturnFocus: Element | null = null;
  let capabilities: PlatformCapabilities | null = null;

  function valueOr<T>(value: T | undefined | null, fallback: T): T {
    return value === undefined || value === null ? fallback : value;
  }

  function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
  }

  function str(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
  }

  function isOpen(): boolean {
    return document.body.classList.contains("settings-open");
  }

  function trapSettingsFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !isOpen()) return;
    // a confirmation above settings owns focus until it is dismissed
    const dialog = byId("mod-overlay")?.classList.contains("open")
      ? byId("mod-box")
      : document.querySelector<HTMLElement>(".settings-dialog");
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }
  document.addEventListener("keydown", trapSettingsFocus);

  function setEditorInert(inert: boolean): void {
    el("editor-shell").inert = inert;
    for (const group of document.querySelectorAll<HTMLElement>("#tb .tb-editor")) group.inert = inert;
  }

  function pageAvailable(candidate: SettingsPage): boolean {
    return candidate !== "explorer" || !capabilities || shouldShowSendTo(capabilities);
  }

  function paintNav(current: SettingsPage | null, counts?: ReadonlyMap<SettingsPage, number>): void {
    for (const info of SETTINGS_PAGES) {
      const nav = byId(`settings-nav-${info.id}`);
      if (!nav) continue;
      nav.hidden = !pageAvailable(info.id);
      const active = info.id === current;
      nav.classList.toggle("on", active);
      nav.setAttribute("aria-current", active ? "page" : "false");
      const count = counts?.get(info.id) ?? 0;
      nav.classList.toggle("dimmed", !!counts && !count);
      const badge = nav.querySelector<HTMLElement>(".settings-nav-count");
      if (badge) badge.textContent = counts && count ? String(count) : "";
    }
  }

  interface ShellOptions {
    readonly title: string;
    readonly back?: { readonly action: string; readonly label: string };
    readonly footer?: Content;
    readonly navPage: SettingsPage | null;
    readonly counts?: ReadonlyMap<SettingsPage, number>;
    readonly headExtra?: Content;
    /** pages whose changes save as they are made say so in the header */
    readonly autosaves?: boolean;
  }

  function renderShell(content: Content, options: ShellOptions): void {
    const opening = !isOpen();
    const previousFocus = document.activeElement;
    if (opening) {
      settingsReturnFocus = document.activeElement;
      // keep modal focus separate from the editor's responsive drawer state; the window's own
      // title bar buttons stay usable
      setEditorInert(true);
    }
    document.body.classList.add("settings-open");
    const back = el<HTMLButtonElement>("settings-back");
    back.hidden = !options.back;
    if (options.back) {
      back.dataset.settingsClick = options.back.action;
      back.setAttribute("aria-label", options.back.label);
      back.title = options.back.label;
    }
    el("settings-page-title").textContent = options.title;
    el("settings-head-extra").replaceChildren(fragment(options.headExtra));
    const status = el("settings-status");
    status.textContent = "";
    status.classList.remove("on");
    clearTimeout(statusTimer);
    el("settings-autosave").hidden = !options.autosaves;
    // the profile editor has its own Back and Save, so search can't replace it mid-edit
    el<HTMLInputElement>("settings-search").disabled = view === "editor";
    el("settings-page").replaceChildren(h("div", { class: "settings-page-inner" }, content));
    el("settings-page").scrollTop = 0;
    el("settings-actions").replaceChildren(fragment(options.footer));
    paintNav(options.navPage, options.counts);
    if (opening) {
      if (options.navPage) byId(`settings-nav-${options.navPage}`)?.focus();
    } else if (previousFocus && !previousFocus.isConnected && view !== "editor") {
      el("settings-page-title").focus();
    }
  }

  // a save that takes a moment says so; a quick one goes straight to "Saved"
  const SAVING_NOTE_DELAY_MS = 250;
  let savingTimer: ReturnType<typeof setTimeout> | undefined;

  function showSaving(): void {
    clearTimeout(savingTimer);
    savingTimer = setTimeout(() => {
      const status = byId("settings-status");
      if (!status) return;
      clearTimeout(statusTimer);
      status.classList.remove("on", "failed");
      status.textContent = "Saving…";
    }, SAVING_NOTE_DELAY_MS);
  }

  // the changed values stay on the page, so Try again (or the next change) saves them
  function showNotSaved(canRetry: boolean): void {
    clearTimeout(savingTimer);
    clearTimeout(statusTimer);
    const status = byId("settings-status");
    const note = byId("settings-autosave");
    if (status) {
      status.classList.remove("on");
      status.classList.add("failed");
      status.textContent = "Not saved";
    }
    if (note) note.hidden = true;
    const retry = byId("settings-retry");
    if (retry) retry.hidden = !canRetry;
  }

  function showSaved(): void {
    clearTimeout(savingTimer);
    const status = byId("settings-status");
    const note = byId("settings-autosave");
    if (!status || !note) return;
    const retry = byId("settings-retry");
    if (retry) retry.hidden = true;
    status.classList.remove("failed");
    const autosaves = !note.hidden || status.classList.contains("on");
    status.textContent = "Saved";
    status.classList.add("on");
    note.hidden = true;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.textContent = "";
      status.classList.remove("on");
      note.hidden = !autosaves;
    }, 1600);
  }

  function generalPage(s: SettingsRecord): Content {
    const hidden = hiddenParts(s.hidden_ui);
    const visible = visibleTasks(hidden);
    const taskOptions: (readonly [string, string])[] = [
      ["last", "Last used task"],
      ...([["compression", "Compress"], ["upscale", "Upscale"], ["cut", "Lossless cut"]] as const)
        .filter(([value]) => visible.includes(value)),
    ];
    const videoHidden = hidden.has("panel_video") && hidden.has("panel_audio");
    const inspectorOptions: (readonly [string, string])[] = [
      ["last", "Last used tab"],
      ...(videoHidden ? [] : [["video", "This video"] as const]),
      ["export", "Export"],
    ];
    // a stored "audio" choice opens This video, which holds the audio controls
    const inspector = s.inspector_start_panel === "audio" ? "video" : str(s.inspector_start_panel, "export");
    const startTask = str(s.start_task, "last");
    return [section("Startup", card(
      row({
        setting: "start-task",
        label: "Start with",
        labelFor: "set-start-task",
        control: selectControl("set-start-task", taskOptions,
          taskOptions.some(([value]) => value === startTask) ? startTask : "last",
          { "data-settings-change": "save" }),
      }),
      row({
        setting: "inspector-start",
        label: "Inspector opens on",
        labelFor: "set-inspector-start",
        control: selectControl("set-inspector-start", inspectorOptions,
          inspectorOptions.some(([value]) => value === inspector) ? inspector : "export",
          { "data-settings-change": "save" }),
      }),
      switchRow({
        setting: "reopen",
        id: "set-reopen",
        label: "Reopen last videos",
        description: "Bring back the Library from your last session.",
        checked: s.reopen_last_videos === true,
        attributes: { "data-settings-change": "save" },
      }),
    )), section("Playback", card(
      switchRow({
        setting: "loop",
        id: "set-loop",
        label: "Loop playback",
        description: "Start again from the first segment after the last one ends.",
        checked: s.loop_playback !== false,
        attributes: { "data-settings-change": "save" },
      }),
      row({
        setting: "skip-length",
        label: "Skip length",
        description: "How far Shift with ← or → jumps.",
        control: choiceGroup("set-skip", "Skip length", ["1", "3", "5", "10"].map((value) => ({
          value,
          label: `${value} s`,
        })), str(s.skip_seconds, "3"), { "data-settings-change": "save" }),
      }),
    )), section("Timeline", card(
      row({
        setting: "time-format",
        label: "Time format",
        description: "Used in the player and the timeline.",
        control: choiceGroup("set-time-format", "Time format", [
          { value: "seconds", label: "1:03.40", mono: true },
          { value: "timecode", label: "00:01:03:12", mono: true },
          { value: "frames", label: "1902 f", mono: true },
        ], str(s.time_format, "seconds"), { "data-settings-change": "save" }),
      }),
      switchRow({
        setting: "timeline-frames",
        id: "set-timeline-frames",
        label: "Show frames",
        description: "Show pictures from the video on the video track.",
        checked: s.timeline_frames !== false,
        attributes: { "data-settings-change": "save" },
      }),
      row({
        setting: "timeline-frame-mode",
        label: "Frames",
        description: "Zoom to center hides HUDs and makes small details easier to see.",
        control: choiceGroup("set-timeline-frame-mode", "Frames", [
          { value: "center", label: "Zoom to center" },
          { value: "whole", label: "Whole frame" },
        ], str(s.timeline_frame_mode, "center"), { "data-settings-change": "save" }),
      }),
    ))];
  }

  function appearancePage(s: SettingsRecord): Content {
    const accent = str(s.accent_color, "violet");
    const swatches = ACCENTS.map((option) =>
      h("label", { class: "set-swatch", "data-accent-swatch": option.value, title: option.label },
        h("input", {
          type: "radio",
          name: "set-accent",
          value: option.value,
          "aria-label": option.label,
          "data-settings-change": "save",
          checked: option.value === accent,
        })));
    const preview = h("div", { class: "set-accent-preview", "aria-hidden": "true" },
      h("span", { class: "set-btn primary" }, "Compress this video"),
      h("span", { class: "set-preview-play" }, icon("play")),
      h("span", { class: "set-preview-switch" }),
      h("span", { class: "set-preview-slider" }, h("span")),
      h("span", { class: "set-preview-timeline" },
        h("span", { class: "tl-segment-surface set-preview-clip" },
          h("span", { class: "tl-segment-labels" },
            h("span", { class: "tl-segment-badge" }, "S1"),
            h("span", { class: "tl-segment-copy" },
              h("span", { class: "tl-segment-label" }, "12s"))))));
    return [section("Color", [preview, card(
      row({
        setting: "accent",
        label: "Accent color",
        description: "Used for the main button, selection, and focus.",
        control: h("span", { class: "set-swatches", role: "radiogroup", "aria-label": "Accent color" }, swatches),
      }),
    )]), section("Layout", card(
      row({
        setting: "interface-size",
        label: "Layout density",
        description: "Change spacing without changing text size.",
        control: choiceGroup("set-interface-size", "Layout density", [
          { value: "compact", label: "Compact" },
          { value: "default", label: "Default" },
          { value: "large", label: "Large" },
        ], str(s.interface_size, "default"), { "data-settings-change": "save" }),
      }),
      row({
        setting: "text-size",
        label: "Text size",
        description: "Change text throughout Tuck, including Settings.",
        control: choiceGroup("set-text-size", "Text size", [
          { value: "default", label: "Default" },
          { value: "large", label: "Large" },
          { value: "extra_large", label: "Extra large" },
        ], str(s.text_size, "default"), { "data-settings-change": "save" }),
      }),
      row({
        setting: "timeline-style",
        label: "Timeline",
        description: "Graphite keeps clips gray. Violet tints them with the accent color.",
        control: choiceGroup("set-timeline-style", "Timeline", [
          { value: "graphite", label: "Graphite" },
          { value: "violet", label: "Violet" },
        ], str(s.timeline_style, "graphite"), { "data-settings-change": "save" }),
      }),
      switchRow({
        setting: "animations",
        id: "set-animations",
        label: "Animations",
        description: "Turn off to make panels and menus appear instantly.",
        checked: s.animations !== false,
        attributes: { "data-settings-change": "save" },
      }),
    ))];
  }

  function toolsPage(s: SettingsRecord): Content {
    const hidden = hiddenParts(s.hidden_ui);
    const visible = visibleTasks(hidden);
    const part = (id: HideablePart, setting: string, label: string, description?: string, icon?: "compress" | "upscale" | "cut") =>
      switchRow({
        setting,
        id: `set-show-${id}`,
        label,
        ...(description ? { description } : {}),
        ...(icon ? { icon } : {}),
        checked: !hidden.has(id),
        // one task always stays on
        disabled: isTaskName(id) && visible.length === 1 && visible[0] === id,
        attributes: { "data-hide-part": id, "data-settings-change": "visibility" },
      });
    return [section("Tasks", card(
      part("compression", "task-compression", "Compress", undefined, "compress"),
      part("upscale", "task-upscale", "Upscale", undefined, "upscale"),
      part("cut", "task-cut", "Lossless cut", undefined, "cut"),
    ), { description: "Turn off tasks you never use. At least one stays on." }),
    section("Editing tools", card(
      part("panel_video", "panel-video", "Transform panel"),
      part("panel_audio", "panel-audio", "Audio panel"),
      part("audio_editing", "audio-editing", "Audio editing", "Add audio tracks to a video."),
      part("frame_blending", "frame-blending", "Frame blending", "Still shown when a profile uses it."),
      part("lut", "lut", "Color LUT", "Still shown when a profile uses it."),
    ))];
  }

  function tokenButton(target: string): Content {
    const tokens = NAMING_TOKENS[target];
    if (!tokens) return null;
    const items = tokens.map((token) => h("button", {
      type: "button",
      role: "menuitem",
      "data-settings-click": "insert-token",
      "data-settings-target": target,
      "data-settings-token": token,
    }, token));
    return h("details", { class: "set-token-menu" },
      h("summary", { "aria-label": "Insert a name token", title: "Insert a name token" }, icon("braces")),
      h("span", { class: "set-token-popover", role: "menu" }, items));
  }

  function filesPage(s: SettingsRecord): Content {
    const location = str(s.output_location, s.output_dir ? "folder" : "source");
    const folder = str(s.output_dir);
    const naming = (setting: string, id: string, label: string, value: string, icon: "compress" | "upscale" | "cut") =>
      row({
        setting,
        label,
        labelFor: id,
        icon,
        description: exampleName(id, value),
        descriptionMono: true,
        control: [textInput(id, value, `${label} suffix`, {
          mono: true,
          width: 264,
          extra: tokenButton(id),
          attributes: { "data-settings-input": "preview-output", "data-settings-change": "save" },
        }), fieldError(id)],
      });
    return [section("Where exports go", card(
      row({
        setting: "save-to",
        label: "Save to",
        control: choiceGroup("set-location", "Save exports", [
          { value: "source", label: "Next to source" },
          { value: "subfolder", label: "In a subfolder" },
          { value: "folder", label: "One folder" },
        ], location, { "data-settings-change": "location" }),
      }),
      row({
        setting: "subfolder",
        label: "Folder name",
        labelFor: "set-subfolder",
        description: "Made next to each source file.",
        sub: true,
        hidden: location !== "subfolder",
        control: [textInput("set-subfolder", str(s.output_subfolder, "Tucked"), "Folder name", {
          width: 200,
          attributes: { "data-settings-change": "save" },
        }), fieldError("set-subfolder")],
      }),
      row({
        setting: "folder",
        label: "Folder",
        description: folder || "Not chosen yet",
        descriptionMono: !!folder,
        sub: true,
        hidden: location !== "folder",
        control: [pathHolder("set-od", folder), button("Change…", { action: "browse-output", icon: "folder" })],
      }),
      switchRow({
        setting: "keep-dates",
        id: "set-keep-dates",
        label: "Keep original file dates",
        description: "Exports sort next to their source.",
        checked: s.keep_file_dates === true,
        attributes: { "data-settings-change": "save" },
      }),
    )), section("File names", card(
      naming("suffix-compression", "set-cs", "Compress", str(s.compression_suffix, DEFAULT_COMPRESSION_SUFFIX) || DEFAULT_COMPRESSION_SUFFIX, "compress"),
      naming("suffix-upscale", "set-us", "Upscale", str(s.upscale_suffix, DEFAULT_UPSCALE_SUFFIX) || DEFAULT_UPSCALE_SUFFIX, "upscale"),
      naming("suffix-cut", "set-cuts", "Lossless cut", str(s.cut_suffix, DEFAULT_CUT_SUFFIX) || DEFAULT_CUT_SUFFIX, "cut"),
      row({
        setting: "name-taken",
        label: "If the name is taken",
        description: "A replaced file is swapped out only once the new one is finished.",
        control: choiceGroup("set-name-taken", "If the name is taken", [
          { value: "number", label: "Add a number" },
          { value: "replace", label: "Replace the old file" },
        ], str(s.name_taken, "number"), { "data-settings-change": "save" }),
      }),
    ), { description: "Added to the source name." })];
  }

  function queuePage(s: SettingsRecord): Content {
    const flag = (setting: string, id: string, label: string, checked: boolean, description?: string) =>
      switchRow({
        setting,
        id,
        label,
        ...(description ? { description } : {}),
        checked,
        attributes: { "data-settings-change": "save" },
      });
    return [section("When the queue finishes", card(
      flag("show-folder", "set-open-output-folder", "Show the last export in its folder", s.open_output_folder_after_queue === true),
      flag("clear-finished", "set-auto-clear", "Clear finished jobs", s.clear_completed_automatically === true,
        "Failed and canceled jobs stay so you can retry them."),
      flag("remove-exported", "set-remove-exported", "Remove videos after they export", s.remove_after_export === true,
        "Finished videos leave the Library."),
      flag("notify", "set-notify", "Notify me", s.notify_when_done !== false,
        "Shows a notification when Tuck is in the background."),
    )), section("While exporting", card(
      flag("keep-awake", "set-keep-awake", "Keep the PC awake", s.keep_awake !== false,
        "Sleep waits until the queue is done."),
      flag("background", "set-background", "Run exports in the background", s.background_exports === true,
        "Keeps games smooth. Exports take a bit longer."),
    ))];
  }

  function profilesPage(s: SettingsRecord): Content {
    const scaler = str(s.default_scaler, "neighbor");
    const filters = choiceGroup("set-profile-filter", "Filter profiles", [
      { value: "all", label: "All" },
      { value: "compression", label: "Compress" },
      { value: "upscale", label: "Upscale" },
    ], profileFilter, { "data-settings-change": "filter-profiles" });
    return [
      toolbar(
        filters,
        h("span", { class: "set-toolbar-spacer" }),
        button("Import…", { action: "import-profiles", kind: "quiet" }),
        button("New profile", { action: "new-profile", kind: "primary", icon: "plus" }),
      ),
      h("div", { "data-setting": "profiles" },
        section("Your profiles", h("div", { id: "pm-own", class: "set-card set-profile-list", role: "list", "aria-label": "Your profiles" }), { id: "pm-own-section" }),
        section("Built in", h("div", { id: "pm-builtin", class: "set-card set-profile-list", role: "list", "aria-label": "Built-in profiles" }), { id: "pm-builtin-section" })),
      section("When a profile doesn’t choose", card(
        row({
          setting: "default-scaler",
          label: "Scaler",
          labelFor: "set-ds",
          control: selectControl("set-ds", SCALERS.map((name) => [name, name] as const),
            SCALERS.find((name) => name.toLowerCase() === scaler) ?? "Neighbor",
            { "data-settings-change": "save" }),
        }),
      )),
    ];
  }

  function mediaPage(s: SettingsRecord, caps: PlatformCapabilities): Content {
    const tool = (setting: string, id: string, name: string, custom: string, detected: string, ready: boolean, browse: string, clear: string) => {
      const where = custom || detected;
      const state = ready
        ? h("span", { class: "set-state ok" }, "Ready")
        : h("span", { class: "set-state warn" }, icon("warn"), "Not found");
      const path = where
        ? [h("span", { class: "set-desc-sep" }, "·"), h("span", { class: "mono set-path" }, where)]
        : null;
      return row({
        setting,
        label: name,
        descriptionExtra: [state, path],
        control: [
          pathHolder(id, custom),
          custom && button("Use automatic", { action: clear, kind: "quiet" }),
          button(ready ? "Change…" : "Choose file…", { action: browse, ...(ready ? {} : { kind: "primary" as const }) }),
        ],
      });
    };
    const encoders = encodersForPlatform(toStringArray(s.available_encoders), caps);
    const chips = encoders.length
      ? h("span", { class: "set-chips" }, encoders.map((name) => h("span", { class: "set-chip" }, encoderLabel(name))))
      : h("span", {}, encoderDisplaySummary(encoders));
    return [section("Tools", card(
      tool("ffmpeg", "set-ffmpeg", "FFmpeg", str(s.ffmpeg_path), str(s.detected_ffmpeg_path), !!s.ffmpeg_available, "browse-ffmpeg", "clear-ffmpeg"),
      tool("ffprobe", "set-ffprobe", "FFprobe", str(s.ffprobe_path), str(s.detected_ffprobe_path), !!s.ffprobe_available, "browse-ffprobe", "clear-ffprobe"),
    )), section("Encoding", card(
      row({
        setting: "encoders",
        label: "Available encoders",
        descriptionExtra: chips,
        control: button("Rescan", { action: "refresh-encoders", icon: "refresh" }),
      }),
      row({
        setting: "encoder-check",
        label: "Encoder check",
        labelFor: "set-encoder-cache-days",
        description: "Remembering what was found saves time at startup.",
        control: selectControl("set-encoder-cache-days", [
          ["0", "Every launch"],
          ["1", "Every day"],
          ["7", "Every 7 days"],
          ["30", "Every 30 days"],
          ["90", "Every 90 days"],
        ], String(num(s.encoder_cache_days)), { "data-settings-change": "save" }),
      }),
    ))];
  }

  function aboutPage(s: SettingsRecord, caps: PlatformCapabilities): Content {
    const version = str(s.version);
    const updater = shouldShowUpdater(caps);
    const checked = str(s.last_update_check);
    const hero = h("div", { class: "set-row set-about", "data-setting": "updates" },
      h("span", { class: "set-row-text" },
        h("span", { class: "set-logo" }, icon("logo")),
        h("span", { class: "set-row-words" },
          h("span", { class: "set-label set-about-name" }, "Tuck ", h("span", { class: "mono" }, version)),
          h("span", { class: "set-desc" },
            updater ? (checked ? `Last checked ${checked}` : "Not checked yet") : "Updates aren’t available in this build."))),
      h("span", { class: "set-row-control" },
        updater && button("Check for updates", { action: "check-updates", icon: "refresh" })));
    const updates = updater
      && switchRow({
        setting: "auto-updates",
        id: "set-check-updates",
        label: "Check for updates automatically",
        checked: s.check_updates !== false,
        attributes: { "data-settings-change": "save" },
      });
    return [section(updater ? "Updates" : "Version", card(hero, updates)),
      section("Help", card(
        row({
          setting: "diagnostics",
          label: "Diagnostic report",
          description: "Versions, encoders, and recent errors. Folder paths are removed.",
          control: button("Copy", { action: "copy-diagnostics", label: "Copy diagnostic report" }),
        }),
        row({
          setting: "logs",
          label: "Logs",
          control: button("Open folder", { action: "open-support", value: "logs", icon: "folder", label: "Open logs folder" }),
        }),
        row({
          setting: "settings-folder",
          label: "Settings folder",
          control: button("Open folder", { action: "open-support", value: "config", icon: "folder", label: "Open settings folder" }),
        }),
      )),
      section("Licenses", card(
        row({
          setting: "license",
          label: "License",
          description: "Read Tuck's license.",
          control: [button("Open", { action: "open-document", value: "license", label: "Open license" }), fieldError("set-license")],
        }),
        row({
          setting: "third-party-notices",
          label: "Third-party notices",
          description: "Licenses for bundled software.",
          control: [button("Open", { action: "open-document", value: "third_party_notices", label: "Open third-party notices" }), fieldError("set-third_party_notices")],
        }),
      )),
      section("Your settings", card(
        row({
          setting: "backup",
          label: "Back up",
          description: "Settings, profiles, and shortcuts in one file.",
          control: [
            button("Export…", { action: "export-settings", label: "Export settings to a file" }),
            button("Import…", { action: "import-settings", label: "Import settings from a file" }),
          ],
        }),
        row({
          setting: "reset",
          label: "Reset settings",
          description: "Your profiles are kept.",
          control: button("Reset…", { action: "reset-settings", kind: "danger", label: "Reset settings" }),
        }),
      ))];
  }

  function keyboardPage(): Content {
    const search = h("span", { class: "set-input set-search-shortcuts" },
      icon("search"),
      h("input", {
        type: "search",
        id: "kb-search",
        placeholder: "Search shortcuts",
        "aria-label": "Search shortcuts",
        autocomplete: "off",
        "data-settings-input": "filter-shortcuts",
      }));
    return [
      toolbar(
        search,
        h("span", { class: "set-toolbar-spacer" }),
        button("Shortcut guide", { action: "show-shortcut-guide", kind: "quiet" }),
        button("Reset all", { action: "reset-shortcuts", kind: "quiet", id: "kb-reset-all" }),
      ),
      h("div", { id: "kb-list", class: "kb-list", "data-setting": "keyboard" }),
      h("span", { id: "kb-status", class: "sr-only", role: "status" }),
    ];
  }

  function explorerPage(): Content {
    return [
      section("Send to", h("div", { id: "st-fixed", class: "set-card" }), {
        description: "Right-click videos in File Explorer, then choose Send to.",
      }),
      h("div", { "data-setting": "profile-shortcuts" }, section("Profile shortcuts", h("div", { id: "st-list", class: "set-card" }), {
        description: "One Send to entry per profile.",
        aside: button("Add", { action: "add-shortcut", icon: "plus", label: "Add profile shortcut" }),
      })),
    ];
  }

  function checked(id: string): boolean {
    return byId<HTMLInputElement>(id)?.checked ?? false;
  }

  function radio(name: string, fallback: string): string {
    return document.querySelector<HTMLInputElement>(`#settings-page input[name="${name}"]:checked`)?.value ?? fallback;
  }

  function chosenHiddenParts(): HideablePart[] {
    const switches = Array.from(document.querySelectorAll<HTMLInputElement>("#settings-page [data-hide-part]"));
    return HIDEABLE_PARTS.filter((id) => switches.some((node) => node.dataset.hidePart === id && !node.checked));
  }

  /** What the open page would save; pages without autosaved fields return null. */
  function pagePatch(): SettingsRecord | null {
    if (view !== "page") return null;
    switch (page) {
      case "general":
        return {
          start_task: select("set-start-task").value,
          inspector_start_panel: select("set-inspector-start").value,
          reopen_last_videos: checked("set-reopen"),
          loop_playback: checked("set-loop"),
          skip_seconds: radio("set-skip", "3"),
          time_format: radio("set-time-format", "seconds"),
          timeline_frames: checked("set-timeline-frames"),
          timeline_frame_mode: radio("set-timeline-frame-mode", "center"),
        };
      case "appearance":
        return {
          accent_color: radio("set-accent", "violet"),
          interface_size: radio("set-interface-size", "default"),
          text_size: radio("set-text-size", "default"),
          timeline_style: radio("set-timeline-style", "graphite"),
          animations: checked("set-animations"),
        };
      case "tools":
        return { hidden_ui: chosenHiddenParts() };
      case "files": {
        const location = radio("set-location", "source");
        return {
          output_location: location,
          output_dir: el("set-od").dataset.path || "",
          ...(location === "subfolder" ? { output_subfolder: input("set-subfolder").value.trim() } : {}),
          keep_file_dates: checked("set-keep-dates"),
          compression_suffix: input("set-cs").value.trim() || DEFAULT_COMPRESSION_SUFFIX,
          upscale_suffix: input("set-us").value.trim() || DEFAULT_UPSCALE_SUFFIX,
          cut_suffix: input("set-cuts").value.trim() || DEFAULT_CUT_SUFFIX,
          name_taken: radio("set-name-taken", "number"),
        };
      }
      case "queue":
        return {
          open_output_folder_after_queue: checked("set-open-output-folder"),
          clear_completed_automatically: checked("set-auto-clear"),
          remove_after_export: checked("set-remove-exported"),
          notify_when_done: checked("set-notify"),
          keep_awake: checked("set-keep-awake"),
          background_exports: checked("set-background"),
        };
      case "profiles":
        return { default_scaler: select("set-ds").value.toLowerCase() };
      case "media":
        return {
          ffmpeg_path: el("set-ffmpeg").dataset.path || "",
          ffprobe_path: el("set-ffprobe").dataset.path || "",
          encoder_cache_days: parseInt(select("set-encoder-cache-days").value, 10) || 0,
        };
      case "about": {
        const updates = byId<HTMLInputElement>("set-check-updates");
        return updates ? { check_updates: updates.checked } : null;
      }
      default:
        return null;
    }
  }

  function markSettingsDirty(): void {
    const patch = pagePatch();
    settingsDirty = !!patch && settingsSnapshot(patch) !== snapshot;
  }

  function captureSettingsSnapshot(): void {
    const patch = pagePatch();
    snapshot = patch ? settingsSnapshot(patch) : "";
    settingsDirty = false;
  }

  // the field a rejected save most likely came from, so its message shows beside it
  function errorTarget(patch: SettingsRecord, error: string): string | null {
    const lower = error.toLowerCase();
    if (lower.includes("lossless cut suffix") || lower.includes("cut_suffix")) return "set-cuts";
    if (lower.includes("compress suffix") || lower.includes("compression_suffix")) return "set-cs";
    if (lower.includes("upscale suffix") || lower.includes("upscale_suffix")) return "set-us";
    if ((lower.includes("folder name") || lower.includes("export folder")) && "output_subfolder" in patch)
      return "set-subfolder";
    return null;
  }

  function clearFieldErrors(): void {
    for (const node of document.querySelectorAll<HTMLElement>("#settings-page .set-row-error")) {
      node.hidden = true;
      node.textContent = "";
      const field = node.id ? byId<HTMLInputElement>(node.id.replace(/-error$/, "")) : null;
      field?.removeAttribute("aria-invalid");
      field?.closest(".set-input")?.classList.remove("invalid");
    }
  }

  async function persistSettings(patch: SettingsRecord): Promise<boolean> {
    const savedPage = page;
    const result = await legacyBackendResult(client().saveSettings(patch as never));
    if (result.ok) {
      clearFieldErrors();
      Object.assign(session.appSettings, patch);
      // remember what was written, not what the page shows now: a change made while the save
      // was running must still count as unsaved so the next queued save picks it up
      if (view === "page" && page === savedPage) {
        snapshot = settingsSnapshot(patch);
        markSettingsDirty();
      }
      await deps.reloadEditorSettings(true);
      showSaved();
      return true;
    }
    const message = result.error ?? "Could not save settings.";
    const target = errorTarget(patch, message);
    const note = target ? byId(`${target}-error`) : null;
    if (target && note) {
      note.textContent = message;
      note.hidden = false;
      byId<HTMLInputElement>(target)?.setAttribute("aria-invalid", "true");
      byId(target)?.closest(".set-input")?.classList.add("invalid");
      // the field has to change before saving again can work
      showNotSaved(false);
    } else {
      toast(message, "err");
      showNotSaved(true);
    }
    return false;
  }

  // changes save as they are made; saves run one at a time and read the page when they start,
  // so quick changes cannot land out of order
  let saving: Promise<unknown> = Promise.resolve();
  function autosave(): Promise<unknown> {
    markSettingsDirty();
    if (!settingsDirty) return saving;
    const savingPage = page;
    saving = saving.then(() => {
      markSettingsDirty();
      const patch = pagePatch();
      if (!settingsDirty || !patch || page !== savingPage) return undefined;
      showSaving();
      return persistSettings(patch);
    });
    return saving;
  }

  byId("settings-retry")?.addEventListener("click", () => {
    void autosave();
  });

  async function loadSettings(): Promise<SettingsRecord> {
    return (await legacyBackendResult(client().getSettings())) as SettingsRecord;
  }

  async function open(requested?: string, requestedView?: string, profileId?: string): Promise<void> {
    if (requested) page = settingsPage(requested);
    view = requestedView === "editor" ? "editor" : "page";
    if (profileId !== undefined) settingsProfileId = profileId;
    const caps = await fetchPlatformCapabilities();
    capabilities = caps;
    if (!pageAvailable(page)) page = "general";
    clearSearchField();
    stopCapture();
    if (page === "profiles" && view === "editor") {
      renderShell(profileEditorPage(), {
        title: settingsProfileId ? "Edit profile" : "New profile",
        back: { action: "back-profiles", label: "Back to profiles" },
        navPage: "profiles",
        footer: [
          h("span", { class: "settings-editor-note", id: "settings-editor-note", role: "status" }),
          h("span", { class: "set-toolbar-spacer" }),
          button("Cancel", { action: "back-profiles" }),
          button("Save profile", { action: "save-profile", kind: "primary" }),
        ],
      });
      await hydrateEditor(caps);
      const name = input("pe-name").value.trim();
      if (name) el("settings-page-title").textContent = name;
      input("pe-name").focus();
      deps.syncSelects();
      return;
    }
    const s = await loadSettings();
    const builders: Record<SettingsPage, () => Content> = {
      general: () => generalPage(s),
      appearance: () => appearancePage(s),
      tools: () => toolsPage(s),
      keyboard: () => keyboardPage(),
      files: () => filesPage(s),
      queue: () => queuePage(s),
      profiles: () => profilesPage(s),
      explorer: () => explorerPage(),
      media: () => mediaPage(s, caps),
      about: () => aboutPage(s, caps),
    };
    renderShell(builders[page](), {
      title: HEADINGS[page] ?? pageTitle(page),
      navPage: page,
      autosaves: true,
    });
    if (page === "profiles") await refreshProfileManagerList();
    if (page === "explorer") await refreshShortcutList();
    if (page === "keyboard") renderKeyboardList();
    captureSettingsSnapshot();
    deps.syncSelects();
  }

  function toggle(): void {
    if (isOpen()) close();
    else void open();
  }

  function navigateSettings(target: string): void {
    const go = (): void => void open(target);
    if (view === "editor") {
      if (editorDirty()) confirmToast("Discard unsaved profile changes?", go, discardChangesIntent);
      else go();
      return;
    }
    void autosave().then(() => {
      if (!settingsDirty) return go();
      confirmToast("Discard unsaved settings?", () => {
        settingsDirty = false;
        go();
      }, discardChangesIntent);
    });
  }

  function close(): void {
    if (view === "editor" && editorDirty())
      return confirmToast("Discard unsaved profile changes?", () => {
        view = "page";
        settingsProfileId = "";
        closeSettingsWorkspace();
      }, discardChangesIntent);
    void autosave().then(() => {
      if (!settingsDirty) return closeSettingsWorkspace();
      confirmToast("Discard unsaved settings?", () => {
        settingsDirty = false;
        closeSettingsWorkspace();
      }, discardChangesIntent);
    });
  }

  function closeSettingsWorkspace(): void {
    stopCapture();
    clearSearchField();
    document.body.classList.remove("settings-open");
    setEditorInert(false);
    if (settingsReturnFocus && settingsReturnFocus.isConnected && settingsReturnFocus instanceof HTMLElement)
      settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }

  function searchEntries(): SettingsEntry[] {
    const shortcuts = editableCommands().map((command) => ({
      id: `kb-${command.id}`,
      page: "keyboard" as const,
      label: command.label,
      keywords: "shortcut keys",
    }));
    return [...SETTINGS_INDEX, ...shortcuts];
  }

  function clearSearchField(): void {
    searchQuery = "";
    const field = byId<HTMLInputElement>("settings-search");
    if (field) field.value = "";
    const clear = byId("settings-search-clear");
    if (clear) clear.hidden = true;
  }

  function resultLabel(label: string, query: string): Content {
    return highlightParts(label, query).map((part) => (part.match ? h("mark", {}, part.text) : part.text));
  }

  function renderSearch(query: string): void {
    if (view === "editor") return;
    stopCapture();
    view = "search";
    const results = searchSettings(query, searchEntries(), pageAvailable);
    const counts = new Map<SettingsPage, number>();
    for (const entry of results) counts.set(entry.page, (counts.get(entry.page) ?? 0) + 1);
    const groups = SETTINGS_PAGES.filter((info) => counts.has(info.id)).map((info) => {
      const rows = results.filter((entry) => entry.page === info.id).map((entry) =>
        h("button", {
          type: "button",
          class: "set-row set-result",
          "data-settings-click": "search-result",
          "data-settings-value": `${entry.page}|${entry.id}`,
        },
        h("span", { class: "set-row-text" },
          h("span", { class: "set-row-words" }, h("span", { class: "set-label" }, resultLabel(entry.label, query)))),
        h("span", { class: "set-row-control" }, icon("chevron"))));
      return h("section", { class: "set-section" },
        h("header", { class: "set-section-head" }, h("span", {}, h("h3", { class: "set-crumb" }, info.title))),
        h("div", { class: "set-card" }, rows));
    });
    const empty = h("p", { class: "set-empty" }, `No settings match “${query.trim()}”.`);
    renderShell(groups.length ? groups : empty, {
      title: `Results for “${query.trim()}”`,
      navPage: null,
      counts,
      headExtra: results.length > 0
        && h("span", { class: "settings-head-count" }, `${results.length} ${results.length === 1 ? "setting" : "settings"}`),
    });
    snapshot = "";
    settingsDirty = false;
  }

  function onSearchInput(field: HTMLInputElement): void {
    const query = field.value;
    const clear = byId("settings-search-clear");
    if (clear) clear.hidden = !query;
    if (query.trim() === searchQuery.trim()) return;
    searchQuery = query;
    if (!query.trim()) {
      leaveSearch();
      return;
    }
    // a page with a change that hasn't saved yet saves before it is replaced by results
    void autosave().then(() => {
      if (searchQuery === query) renderSearch(query);
    });
  }

  // only the results view goes back to its page; any other view stays as it is
  function leaveSearch(): void {
    if (view === "search") void open(page);
  }

  async function openSearchResult(value: string): Promise<void> {
    const [target, setting] = value.split("|");
    if (!target || !setting) return;
    await open(target);
    const anchor = document.querySelector<HTMLElement>(`#settings-page [data-setting="${CSS.escape(setting)}"]`)
      ?? document.querySelector<HTMLElement>(`#settings-page [data-command="${CSS.escape(setting.replace(/^kb-/, ""))}"]`);
    if (!anchor) return;
    anchor.scrollIntoView({ block: "center" });
    anchor.classList.add("set-flash");
    setTimeout(() => anchor.classList.remove("set-flash"), 1400);
    const control = anchor.matches("input, select, button")
      ? anchor
      : anchor.querySelector<HTMLElement>("input:not([type=hidden]), select, button, summary");
    (control ?? el("settings-page-title")).focus();
  }

  function syncVisibilityChoices(): void {
    const switches = Array.from(document.querySelectorAll<HTMLInputElement>("#settings-page [data-hide-part]"));
    const hidden = hiddenParts(chosenHiddenParts());
    const visible = visibleTasks(hidden);
    for (const node of switches) {
      node.disabled = visible.length === 1 && node.dataset.hidePart === visible[0];
    }
  }

  function exampleName(id: string, value: string): string {
    const suffix = value.trim();
    if (id === "set-cs")
      return `${EXAMPLE_NAME}${(suffix || DEFAULT_COMPRESSION_SUFFIX).replace("{size}", "20MB")}.mp4`;
    if (id === "set-us")
      return `${EXAMPLE_NAME}${(suffix || DEFAULT_UPSCALE_SUFFIX).replace("{width}", "2560").replace("{height}", "1440")}.mp4`;
    return `${EXAMPLE_NAME}${suffix || DEFAULT_CUT_SUFFIX}.mp4`;
  }

  function updateExampleOutput(field: HTMLInputElement): void {
    const description = field.closest(".set-row")?.querySelector(".set-desc");
    if (description) description.textContent = exampleName(field.id, field.value);
  }

  function insertNamingToken(id: string, token: string, from: HTMLElement): void {
    const field = input(id);
    if (!field.value.includes(token)) {
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      field.value = field.value.slice(0, start) + token + field.value.slice(end);
    }
    from.closest("details")?.removeAttribute("open");
    updateExampleOutput(field);
    field.focus();
    void autosave();
  }

  function showLocation(location: string): void {
    const subfolder = document.querySelector<HTMLElement>('#settings-page [data-setting="subfolder"]');
    const folder = document.querySelector<HTMLElement>('#settings-page [data-setting="folder"]');
    if (subfolder) subfolder.hidden = location !== "subfolder";
    if (folder) folder.hidden = location !== "folder";
  }

  function setOutputFolder(path: string): void {
    const node = el("set-od");
    node.dataset.path = path;
    const description = node.closest(".set-row")?.querySelector<HTMLElement>(".set-desc");
    if (description) {
      description.textContent = path || "Not chosen yet";
      description.classList.toggle("mono", !!path);
    }
  }

  async function chooseLocation(target: HTMLInputElement): Promise<void> {
    if (target.value === "folder" && !el("set-od").dataset.path) {
      // one folder needs a folder; keep the previous choice if none is picked
      const picked = await legacyBackendResult(client().pickFolder());
      if (!(picked.ok && typeof picked.path === "string" && picked.path)) {
        const previous = str(appSettings().output_location, "source");
        const restore = document.querySelector<HTMLInputElement>(`#settings-page input[name="set-location"][value="${previous}"]`);
        if (restore) restore.checked = true;
        showLocation(previous);
        return;
      }
      setOutputFolder(picked.path);
    }
    showLocation(target.value);
    void autosave();
  }

  async function browseOutput(): Promise<void> {
    const picked = await legacyBackendResult(client().pickFolder());
    if (picked.ok && typeof picked.path === "string" && picked.path) {
      setOutputFolder(picked.path);
      void autosave();
    }
  }

  async function browseTool(id: "set-ffmpeg" | "set-ffprobe"): Promise<void> {
    const picked = await legacyBackendResult(
      id === "set-ffmpeg" ? client().pickFfmpegFile() : client().pickFfprobeFile(),
    );
    if (picked.ok && typeof picked.path === "string" && picked.path) {
      el(id).dataset.path = picked.path;
      await saveAndReload();
    }
  }

  async function clearTool(id: "set-ffmpeg" | "set-ffprobe"): Promise<void> {
    el(id).dataset.path = "";
    await saveAndReload();
  }

  // the Media tools page shows what Python found, so it is drawn again after a path changes
  async function saveAndReload(): Promise<boolean> {
    await autosave();
    if (settingsDirty) return false;
    await open("media");
    showSaved();
    return true;
  }

  // the check can take a few seconds; the button says so and ignores repeat presses meanwhile
  async function checkForUpdatesNow(target: HTMLElement): Promise<void> {
    if (target.dataset.pending === "true") return;
    const label = target.lastChild;
    const text = label?.textContent ?? "";
    target.dataset.pending = "true";
    target.setAttribute("aria-disabled", "true");
    if (label) label.textContent = "Checking…";
    try {
      await deps.checkForUpdates();
    } finally {
      delete target.dataset.pending;
      target.removeAttribute("aria-disabled");
      if (label) label.textContent = text;
    }
  }

  async function refreshEncoders(): Promise<void> {
    // a new FFmpeg path must be saved before encoders are detected with it
    await autosave();
    if (settingsDirty) {
      toast("Save a working FFmpeg path before refreshing encoders.", "err");
      return;
    }
    const result = await legacyBackendResult(client().refreshEncoders());
    if (result.ok) {
      deps.setAvailableEncoders(toStringArray(result.available_encoders));
      toast("Encoder detection refreshed.", "ok");
      void open("media");
    } else {
      toast(result.error ?? "Could not refresh encoders.", "err");
    }
  }

  async function openSupportFolder(kind: string): Promise<void> {
    const result = kind === "logs"
      ? await legacyBackendResult(client().openLogsFolder())
      : await legacyBackendResult(client().openConfigFolder());
    if (!result.ok) toast(result.error ?? "Could not open folder.", "err");
  }

  async function openDocument(target: HTMLElement): Promise<void> {
    const kind = target.dataset.settingsValue;
    if (kind !== "license" && kind !== "third_party_notices") return;
    const control = target as HTMLButtonElement;
    const note = byId(`set-${kind}-error`);
    if (control.disabled) return;
    const wasFocused = document.activeElement === control;
    control.disabled = true;
    if (note) note.hidden = true;
    try {
      const result = await client().openLocalDocument(kind);
      if (!result.ok) {
        const message = result.error.message || "Could not open this document. Try again.";
        if (note) {
          note.textContent = message;
          note.hidden = false;
        }
        toast(message, "err");
      }
    } finally {
      control.disabled = false;
      if (wasFocused && control.isConnected
        && (document.activeElement === document.body || document.activeElement === control)) {
        control.focus({ preventScroll: true });
      }
    }
  }

  async function exportSettings(): Promise<void> {
    const picked = await legacyBackendResult(client().pickSaveFile("tuck-settings.json"));
    if (!picked.ok || typeof picked.path !== "string" || !picked.path) return;
    const result = await legacyBackendResult(client().exportSettingsToFile(picked.path));
    if (result.ok) toast("Settings exported.", "ok");
    else toast(result.error ?? "Could not export your settings.", "err");
  }

  async function importSettings(): Promise<void> {
    const picked = await legacyBackendResult(client().pickImportFile());
    if (!picked.ok || typeof picked.path !== "string" || !picked.path) return;
    const result = await legacyBackendResult(client().importSettingsFromFile(picked.path));
    if (!result.ok) {
      toast(result.error ?? "Could not import those settings.", "err");
      return;
    }
    await afterSettingsReplaced();
    const skipped = toStringArray(result.skipped);
    toast(skipped.length
      ? "Settings imported. Folders and tools that aren’t on this computer were left as they were."
      : "Settings imported.", "ok");
  }

  function resetSettings(): void {
    confirmToast("Every setting goes back to how Tuck started. Your profiles are kept.", () => {
      void legacyBackendResult(client().resetSettings()).then(async (result) => {
        if (!result.ok) {
          toast(result.error ?? "Could not reset your settings.", "err");
          return;
        }
        await afterSettingsReplaced();
        toast("Settings reset.", "ok");
      });
    }, { title: "Reset settings?", confirmLabel: "Reset", cancelLabel: "Keep my settings", danger: true });
  }

  async function afterSettingsReplaced(): Promise<void> {
    await deps.reloadEditorSettings();
    setShortcutOverrides(session.appSettings.shortcut_overrides);
    await open(page);
  }

  function profileSummary(p: ProfileListEntry): string {
    const up = (p.workflow || "compression") === "upscale";
    const res = p.resolution_mode === "custom"
      ? `${num(p.custom_width) || num(p.max_width)} × ${num(p.custom_height) || num(p.max_height)}`
      : "Source resolution";
    const fps = p.fps_mode === "custom" ? `${num(p.custom_fps) || num(p.max_fps) || 30} FPS` : "Source FPS";
    const audio = p.keep_audio ? "Keep audio" : `${num(p.audio_bitrate_kbps) || 128} kbps audio`;
    const transform = p.transform_intent as SettingsRecord | undefined;
    const transformSummary = transform
      ? ` · ${transform.crop_aspect === "free" ? "Free aspect" : String(transform.crop_aspect)} · ${String(transform.sizing_mode || "fit").replace(/^./, (v) => v.toUpperCase())}${
        transform.rotation ? ` · ${String(transform.rotation)}°` : ""}`
      : "";
    return `${up ? "Upscale" : "Compress"} · ${up ? "" : `${Math.round(num(p.target_size_bytes) / (1024 * 1024))} MB · `}${res} · ${fps} · ${audio}${transformSummary}`;
  }

  function profileShortcutName(id: string): string {
    const profile = (session.allProfiles as ProfileListEntry[]).find((x) => x.profile_id === id);
    return profile ? profile.name ?? "Profile shortcut" : "Profile shortcut";
  }

  async function refreshProfileManagerList(): Promise<void> {
    const own = byId("pm-own");
    const builtin = byId("pm-builtin");
    if (!own || !builtin) return;
    const profiles = (await legacyBackendResult(client().getProfilesJson())) as unknown as ProfileListEntry[] | { ok: false };
    const rows = Array.isArray(profiles) ? profiles : [];
    const visible = rows.filter((p) => profileFilter === "all" || (p.workflow || "compression") === profileFilter);
    const defaultProfileId = str(appSettings().default_profile_id);
    const options = {
      defaultProfileId,
      summarize: profileSummary,
      pinned: new Set(profileIdList("pinned_profile_ids")),
      hidden: new Set(profileIdList("hidden_profile_ids")),
    };
    renderProfileList(document, own, visible.filter((p) => !p.builtin), {
      ...options,
      empty: profileFilter === "all" ? "None yet. Duplicate a built-in profile or select New profile." : "None of yours for this task.",
    });
    renderProfileList(document, builtin, visible.filter((p) => !!p.builtin), { ...options, empty: "No built-in profiles for this task." });
    for (const list of [own, builtin]) {
      bindProfileActions(list, (action, profileId, name) => {
        if (action === "edit") void editProfile(profileId);
        else if (action === "default") void setDefaultProfile(profileId, name);
        else if (action === "pin" || action === "unpin")
          void setPickerChoice("pinned_profile_ids", profileId, action === "pin", name);
        else if (action === "hide" || action === "show")
          void setPickerChoice("hidden_profile_ids", profileId, action === "hide", name);
        else if (action === "export") {
          const profile = rows.find((entry) => entry.profile_id === profileId);
          const lut = lutSettings(profile?.lut);
          if (lut.path) {
            const selection = lut.name ? `“${lut.name}”` : "a color LUT";
            confirmToast(
              `This profile references ${selection}. To use it on another computer, import that LUT separately and select it in the profile.`,
              () => void exportProfile(profileId),
              { title: "LUT file isn’t included", confirmLabel: "Export profile", cancelLabel: "Cancel" },
            );
          } else void exportProfile(profileId);
        } else if (action === "duplicate") void duplicateProfile(profileId);
        else if (action === "delete") deleteProfile(profileId, name);
      });
    }
  }

  // where a profile's row sits, so focus can stay in place when the lists are rebuilt
  function profileRowPlace(profileId: string): { list: HTMLElement; index: number } | null {
    for (const list of [byId("pm-own"), byId("pm-builtin")]) {
      if (!list) continue;
      const rows = Array.from(list.querySelectorAll<HTMLElement>(".set-profile-row"));
      const index = rows.findIndex((row) => row.querySelector(`[data-profile-id="${CSS.escape(profileId)}"]`));
      if (index >= 0) return { list, index };
    }
    return null;
  }

  // the profile's menu button, or the row that took a deleted profile's place
  function focusProfileRow(profileId: string, place: ReturnType<typeof profileRowPlace>): void {
    if (view !== "page" || page !== "profiles") return;
    const match = document
      .querySelector(`#settings-page .set-profile-row [data-profile-id="${CSS.escape(profileId)}"]`)
      ?.closest<HTMLElement>(".set-profile-row");
    const rows = place ? Array.from(place.list.querySelectorAll<HTMLElement>(".set-profile-row")) : [];
    const row = match ?? rows[Math.min(place?.index ?? 0, rows.length - 1)];
    (row?.querySelector<HTMLElement>("summary") ?? byId("settings-page-title"))?.focus();
  }

  type PickerList = "pinned_profile_ids" | "hidden_profile_ids";

  function profileIdList(key: PickerList): string[] {
    const value = appSettings()[key];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  }

  // pinning and hiding only change how the editor's profile picker lists profiles
  async function setPickerChoice(key: PickerList, profileId: string, on: boolean, name: string): Promise<void> {
    const place = profileRowPlace(profileId);
    const current = profileIdList(key);
    const next = on ? [...current.filter((id) => id !== profileId), profileId] : current.filter((id) => id !== profileId);
    const result = await legacyBackendResult(client().saveSettings({ [key]: next }));
    if (!result.ok) {
      toast(result.error ?? "Could not change the profile picker.", "err");
      return;
    }
    session.appSettings[key] = next;
    await deps.reloadEditorSettings();
    await refreshProfileManagerList();
    focusProfileRow(profileId, place);
    const done = key === "pinned_profile_ids"
      ? on ? "is pinned to the top of the picker" : "is no longer pinned"
      : on ? "is hidden from the picker" : "is back in the picker";
    toast(`“${name}” ${done}.`, "ok");
  }

  async function setDefaultProfile(profileId: string, name: string): Promise<void> {
    const place = profileRowPlace(profileId);
    const result = await legacyBackendResult(client().saveSettings({ default_profile_id: profileId }));
    if (!result.ok) {
      toast(result.error ?? "Could not change the default profile.", "err");
      return;
    }
    session.appSettings.default_profile_id = profileId;
    await deps.reloadEditorSettings();
    await refreshProfileManagerList();
    focusProfileRow(profileId, place);
    toast(`“${name}” is now the default profile.`, "ok");
  }

  async function editProfile(pid: string): Promise<void> {
    await open("profiles", "editor", pid);
  }

  async function newProfile(): Promise<void> {
    await open("profiles", "editor", "");
  }

  async function duplicateProfile(pid: string): Promise<void> {
    const place = profileRowPlace(pid);
    const result = await legacyBackendResult(client().duplicateProfile(pid));
    if (result.ok) {
      await deps.reloadEditorSettings();
      await refreshProfileManagerList();
      // the copy is the one the user will want to change next
      focusProfileRow(typeof result.profile_id === "string" ? result.profile_id : pid, place);
      toast("Profile duplicated.", "ok");
    } else {
      toast(result.error ?? "Could not duplicate profile.", "err");
    }
  }

  function deleteProfile(pid: string, name: string): void {
    const place = profileRowPlace(pid);
    confirmToast(`Delete "${name}"?`, () => {
      void legacyBackendResult(client().deleteProfile(pid)).then(async (result) => {
        if (result.ok) {
          await deps.reloadEditorSettings();
          await refreshProfileManagerList();
          focusProfileRow(pid, place);
          toast("Profile deleted.", "ok");
        } else {
          toast(result.error ?? "Could not delete profile.", "err");
        }
      });
    }, { title: "Delete profile?", confirmLabel: "Delete", cancelLabel: "Keep profile", danger: true });
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

  function editorSwitch(id: string, label: string, setting: string, change = "profile-visibility", description?: string): HTMLElement {
    return switchRow({
      setting,
      id,
      label,
      ...(description ? { description } : {}),
      checked: false,
      attributes: { "data-settings-change": change },
    });
  }

  function emptySelect(id: string, change?: string): HTMLElement {
    return h("select", { id, class: "set-select", "data-settings-change": change });
  }

  function profileEditorPage(): Content {
    const sizePresets = [20, 50, 100, 500].map((size) => h("button", {
      type: "button",
      class: "set-choice-btn mono",
      "data-settings-click": "profile-size",
      "data-settings-value": String(size),
      "aria-label": `${size} MB`,
    }, String(size)));
    const taskButton = (id: string, value: Workflow, label: string) =>
      h("button", { type: "button", id, class: "set-choice-btn", "data-settings-click": "profile-task", "data-settings-value": value }, label);
    const task = h("span", { class: "set-choice", role: "group", "aria-label": "Task" },
      taskButton("pe-c", "compression", "Compress"),
      taskButton("pe-u", "upscale", "Upscale"));
    const scalers = SCALERS.map((name) => [name, name] as const);
    return [section("Profile", card(
      row({ setting: "pe-name", label: "Profile name", labelFor: "pe-name", control: textInput("pe-name", "", "Profile name", { width: 280, attributes: { "data-settings-input": "editor-name" } }) }),
      row({ setting: "pe-task", label: "Task", control: task }),
    )), h("div", { id: "pe-size-sec" }, section("Size", card(
      row({
        setting: "pe-size",
        label: "Target size",
        labelFor: "pe-size",
        control: [
          h("span", { class: "set-choice", role: "group", "aria-label": "Size presets" }, sizePresets),
          textInput("pe-size", "50", "Target size in MB", { mono: true, width: 96, unit: "MB", attributes: { type: "number", min: "2", "data-settings-input": "profile-size" } }),
        ],
      }),
    ))), section("Video", card(
      h("div", { id: "pe-source-res-row" }, editorSwitch("pe-source-res", "Use source resolution", "pe-source-res")),
      h("div", { class: "set-row sub", id: "pe-dim", "data-setting": "pe-dim" },
        h("span", { class: "set-row-text" }, h("span", { class: "set-row-words" }, h("span", { class: "set-label" }, "Resolution"))),
        h("span", { class: "set-row-control" },
          textInput("pe-w", "1920", "Custom width", { mono: true, width: 88, attributes: { type: "number", min: "1" } }),
          h("span", { class: "set-times", "aria-hidden": "true" }, "×"),
          textInput("pe-h", "1080", "Custom height", { mono: true, width: 88, attributes: { type: "number", min: "1" } }))),
      h("div", { id: "pe-scaler-row" }, row({ setting: "pe-scaler", label: "Scaler", labelFor: "pe-scaler", sub: true, control: selectControl("pe-scaler", scalers, "Neighbor") })),
      editorSwitch("pe-source-fps", "Use source frame rate", "pe-source-fps"),
      h("div", { id: "pe-fps-row" }, row({
        setting: "pe-fps",
        label: "Frame rate",
        labelFor: "pe-fps",
        sub: true,
        control: textInput("pe-fps", "30", "Custom frame rate", { mono: true, width: 96, unit: "fps", attributes: { type: "number", step: "any", min: "0.1", max: "240", "data-settings-input": "profile-fps" } }),
      })),
    )), section("Transform", card(
      editorSwitch("pe-transform-enabled", "Apply transform settings from this profile", "pe-transform", "profile-visibility",
        "Saves the crop shape, not its exact position or size."),
      h("div", { id: "pe-transform-fields" },
        row({ setting: "pe-aspect", label: "Target aspect", labelFor: "pe-aspect", sub: true, control: selectControl("pe-aspect", [["free", "Free"], ["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"], ["4:3", "4:3"]], "free") }),
        row({ setting: "pe-sizing", label: "Sizing", labelFor: "pe-sizing", sub: true, control: selectControl("pe-sizing", [["fit", "Fit"], ["fill", "Fill"], ["stretch", "Stretch"]], "fit") }),
        row({ setting: "pe-rotation", label: "Rotation", labelFor: "pe-rotation", sub: true, control: selectControl("pe-rotation", [["0", "None"], ["90", "90° clockwise"], ["180", "180°"], ["270", "90° counterclockwise"]], "0") })),
    )), section("Audio", card(
      editorSwitch("pe-audio-source", "Keep source audio", "pe-audio-source"),
      row({
        setting: "pe-audio",
        label: "Audio bitrate",
        labelFor: "pe-audio",
        sub: true,
        control: textInput("pe-audio", "128", "Audio bitrate in kbps", { mono: true, width: 104, unit: "kbps", attributes: { type: "number", min: "0", max: "320" } }),
      }),
    )), section("Encoding", card(
      row({
        setting: "pe-enc",
        label: "Encoder",
        labelFor: "pe-enc",
        description: "Hardware is faster; software can make smaller files.",
        control: emptySelect("pe-enc", "profile-encoder"),
      }),
      row({
        setting: "pe-speed",
        label: "Encoding speed",
        labelFor: "pe-speed",
        control: selectControl("pe-speed", [["fast", "Fast"], ["balanced", "Balanced"], ["best", "Best compression"]], "balanced", { "data-settings-change": "profile-speed" }),
      }),
      h("div", { id: "pe-two-pass-row" }, switchRow({
        setting: "pe-two-pass",
        id: "pe-two-pass",
        label: "Two-pass encoding",
        description: "Two-pass is available only for software compression.",
        descriptionId: "pe-two-pass-note",
        checked: false,
      })),
      h("button", {
        type: "button",
        class: "set-row set-disclosure",
        id: "pe-advanced-button",
        "data-settings-click": "toggle-advanced",
        "aria-expanded": "false",
        "aria-controls": "pe-advanced",
      },
      h("span", { class: "set-row-text" }, h("span", { class: "set-row-words" },
        h("span", { class: "set-label" }, "Advanced encoding"),
        h("span", { class: "set-desc" }, "Preset, quality method, bitrate, and tune"))),
      h("span", { class: "set-row-control" }, icon("chevron"))),
      h("div", { id: "pe-advanced", class: "hid" },
        row({ setting: "pe-preset", label: "Native FFmpeg preset", labelFor: "pe-preset", sub: true, control: emptySelect("pe-preset", "profile-preset") }),
        h("div", { id: "pe-rc-row" }, row({ setting: "pe-rc", label: "Quality method", labelFor: "pe-rc", sub: true, control: emptySelect("pe-rc", "profile-visibility") })),
        h("div", { id: "pe-quality-row", class: "set-row sub", "data-setting": "pe-quality" },
          h("span", { class: "set-row-text" }, h("span", { class: "set-row-words" },
            h("label", { class: "set-label", id: "pe-quality-label", for: "pe-quality" }, "CQ"),
            h("span", { class: "set-desc" }, "Lower value means higher quality."))),
          h("span", { class: "set-row-control" },
            textInput("pe-quality", "23", "Quality value", { mono: true, width: 88, attributes: { type: "number", min: "0", max: "51" } }))),
        h("div", { id: "pe-bitrate-row" }, row({ setting: "pe-bitrate", label: "Bitrate", labelFor: "pe-bitrate", sub: true, control: textInput("pe-bitrate", "2000", "Bitrate in kbps", { mono: true, width: 112, unit: "kbps", attributes: { type: "number", min: "50", max: "50000" } }) })),
        h("div", { id: "pe-tune-row" }, row({ setting: "pe-tune", label: "Tune", labelFor: "pe-tune", sub: true, control: emptySelect("pe-tune") }))),
    ))];
  }

  let editorCapabilities: PlatformCapabilities | null = null;

  function peTask(): Workflow {
    return el("pe-u").classList.contains("on") ? "upscale" : "compression";
  }

  function peSetTask(task: Workflow): void {
    for (const [id, value] of [["pe-c", "compression"], ["pe-u", "upscale"]] as const) {
      el(id).classList.toggle("on", task === value);
      el(id).setAttribute("aria-pressed", String(task === value));
    }
    el("pe-size-sec").classList.toggle("hid", task === "upscale");
    el("pe-source-res-row").classList.toggle("hid", task === "upscale");
    if (task === "upscale") input("pe-source-res").checked = false;
    peRateControls();
    peVisibility();
  }

  function peSetSize(value: string | number, fromField = false): void {
    const n = Math.max(2, parseInt(String(value), 10) || 2);
    if (!fromField) input("pe-size").value = String(n);
    for (const preset of document.querySelectorAll<HTMLElement>('#settings-page [data-settings-click="profile-size"]')) {
      const on = Number(preset.dataset.settingsValue) === n;
      preset.classList.toggle("on", on);
      preset.setAttribute("aria-pressed", String(on));
    }
    updateEditorNote();
  }

  function peSetFps(value: string | number): void {
    const n = Math.max(0.1, Math.min(240, parseFloat(String(value)) || 30));
    input("pe-fps").value = String(n);
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
      input("pe-two-pass").checked = true;
      select("pe-preset").value = "veryslow";
    }
    peTunes();
    peRateControls();
    peVisibility();
  }

  function peSpeedChanged(): void {
    select("pe-preset").value = nativePresetForSpeed(select("pe-speed").value, select("pe-enc").value);
    deps.syncSelects();
  }

  function pePresetChanged(): void {
    select("pe-speed").value = speedForNativePreset(select("pe-preset").value);
    deps.syncSelects();
  }

  function peVisibility(): void {
    const up = peTask() === "upscale";
    const source = input("pe-source-res").checked;
    const sourceFps = input("pe-source-fps").checked;
    const keep = input("pe-audio-source").checked;
    const rc = select("pe-rc").value;
    const cpu = !["auto", "auto_compression", "auto_fast"].includes(select("pe-enc").value) && isCpuEncoder(select("pe-enc").value);
    const twoPass = twoPassEligible(peTask(), select("pe-enc").value);
    const quality = up && (rc === "CRF" || rc === "CQ");
    el("pe-dim").classList.toggle("hid", source);
    el("pe-scaler-row").classList.toggle("hid", source);
    el("pe-fps-row").classList.toggle("hid", sourceFps);
    input("pe-audio").disabled = keep;
    el("pe-audio").closest(".set-row")?.classList.toggle("hid", keep);
    el("pe-two-pass-row").classList.toggle("hid", up);
    el("pe-two-pass-note").classList.toggle("hid", !(!up && !twoPass));
    input("pe-two-pass").disabled = !twoPass;
    if (!twoPass) input("pe-two-pass").checked = false;
    el("pe-rc-row").classList.toggle("hid", !up);
    el("pe-quality-row").classList.toggle("hid", !quality);
    el("pe-bitrate-row").classList.toggle("hid", !(up && (rc === "CBR" || rc === "VBR")));
    el("pe-tune-row").classList.toggle("hid", !(up && cpu));
    el("pe-transform-fields").classList.toggle("hid", !input("pe-transform-enabled").checked);
    el("pe-quality-label").textContent = rc === "CRF" ? "CRF" : "CQ";
    deps.syncSelects();
    updateEditorNote();
  }

  function peToggleAdvanced(): void {
    const element = el("pe-advanced");
    const opening = element.classList.contains("hid");
    element.classList.toggle("hid", !opening);
    el("pe-advanced-button").setAttribute("aria-expanded", String(opening));
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
    const encoder = editorCapabilities ? encoderForPlatform(selectedEncoder, editorCapabilities) : selectedEncoder;
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
      two_pass: twoPassEligible(task, encoder) && input("pe-two-pass").checked,
      preset: select("pe-preset").value,
      scaler: select("pe-scaler").value.toLowerCase(),
      video_encoder: encoder,
      workflow: task,
      rate_control_method: rc,
      rate_control: task === "upscale" && (rc === "cbr" || rc === "vbr") ? "explicit_bitrate" : "target_size",
      crf: rc === "crf" ? quality : valueOr(original.crf as number, 23),
      cq: rc === "cq" ? quality : valueOr(original.cq as number, 23),
      qp: rc === "cqp" ? quality : valueOr(original.qp as number, 23),
      tune: task === "upscale" && isCpuEncoder(encoder) && select("pe-tune").value !== "none" ? select("pe-tune").value : "",
      transform_intent: input("pe-transform-enabled").checked
        ? {
          crop_aspect: select("pe-aspect").value,
          sizing_mode: select("pe-sizing").value,
          rotation: parseInt(select("pe-rotation").value, 10) || 0,
        }
        : null,
    };
    if (task === "upscale" && (rc === "cbr" || rc === "vbr")) data.explicit_bitrate_kbps = peInt("pe-bitrate", 2000);
    return data;
  }

  async function hydrateEditor(caps: PlatformCapabilities): Promise<void> {
    editorCapabilities = caps;
    editorSnapshot = "";
    populateEncoderSelect(select("pe-enc"), encodersForPlatform(session.availEncoders, caps), supportsHardwareEncoders(caps), caps.platform);
    let p: ProfileListEntry | undefined;
    if (settingsProfileId) {
      const profiles = (await legacyBackendResult(client().getProfilesJson())) as unknown as ProfileListEntry[] | { ok: false };
      if (Array.isArray(profiles)) p = profiles.find((x) => x.profile_id === settingsProfileId);
    }
    editorOriginal = (p as SettingsRecord | undefined) ?? {};
    const scaler = p ? String(p.scaler) : String(appSettings().default_scaler || "neighbor");
    const fps = p ? valueOr(num(p.custom_fps), valueOr(num(p.max_fps), 30)) : 30;
    input("pe-name").value = p ? p.name ?? "" : "";
    peSetSize(p ? Math.round(valueOr(num(p.target_size_bytes), 50 * 1024 * 1024) / (1024 * 1024)) : 50);
    input("pe-w").value = String(p ? valueOr(num(p.custom_width), valueOr(num(p.max_width), 1920)) : 1920);
    input("pe-h").value = String(p ? valueOr(num(p.custom_height), valueOr(num(p.max_height), 1080)) : 1080);
    const scalerName = (value: string): string | undefined => SCALERS.find((name) => name.toLowerCase() === value);
    select("pe-scaler").value = scalerName(scaler) ?? scalerName(String(appSettings().default_scaler || "neighbor")) ?? "Neighbor";
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
    select("pe-enc").value = encoderForPlatform(p ? String(valueOr(p.video_encoder as string, "libx264")) : "libx264", caps);
    if (!select("pe-enc").value) select("pe-enc").selectedIndex = 0;
    peEncoderChanged();
    select("pe-preset").value = p
      ? String(valueOr(p.preset as string, nativePresetForSpeed("balanced", select("pe-enc").value)))
      : nativePresetForSpeed("balanced", select("pe-enc").value);
    if (!select("pe-preset").value) select("pe-preset").value = nativePresetForSpeed("balanced", select("pe-enc").value);
    pePresetChanged();
    input("pe-two-pass").checked = !!(p && p.two_pass);
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
    const rcMap: Record<string, string> = { crf: "CRF", cq: "CQ", cqp: "CQ", cbr: "CBR", vbr: "VBR" };
    const rateControl = rcMap[String(p ? p.rate_control_method : "cbr")] ?? "CRF";
    if (Array.from(select("pe-rc").options).some((option) => option.value === rateControl)) select("pe-rc").value = rateControl;
    peVisibility();
    editorSnapshot = JSON.stringify(pePayload());
    updateEditorNote();
  }

  function editorDirty(): boolean {
    return view === "editor" && !!editorSnapshot && !!byId("pe-name") && JSON.stringify(pePayload()) !== editorSnapshot;
  }

  function updateEditorNote(): void {
    const note = byId("settings-editor-note");
    if (!note || !editorSnapshot) return;
    const dirty = editorDirty();
    note.textContent = dirty ? "Unsaved changes" : "";
    note.classList.toggle("on", dirty);
  }

  function backToProfiles(): void {
    const goBack = (): void => {
      view = "page";
      settingsProfileId = "";
      void open("profiles");
    };
    if (editorDirty()) confirmToast("Discard unsaved profile changes?", goBack, discardChangesIntent);
    else goBack();
  }

  async function saveProfileEditor(): Promise<void> {
    const result = settingsProfileId
      ? await legacyBackendResult(client().updateProfile(settingsProfileId, pePayload() as never))
      : await legacyBackendResult(client().createProfile(pePayload() as never));
    if (result.ok) {
      await deps.reloadEditorSettings();
      view = "page";
      settingsProfileId = "";
      await open("profiles");
      toast("Profile saved.", "ok");
    } else {
      toast(result.error ?? "Could not save profile.", "err");
    }
  }

  // each action can take new keys; they apply and are saved straight away
  let stopCapture: () => void = () => {};

  function keycaps(bindings: readonly string[]): HTMLElement {
    const keys = document.createElement("span");
    keys.className = "kbs-bindings kb-keys";
    if (!bindings.length) keys.appendChild(elementWithText("span", "No keys", "kb-none"));
    bindings.forEach((binding, index) => {
      if (index) keys.appendChild(elementWithText("span", "or", "kbs-or"));
      const chord = document.createElement("span");
      chord.className = "kbs-chord";
      bindingKeys(binding).forEach((key, keyIndex) => {
        if (keyIndex) chord.appendChild(elementWithText("span", "+", "kbs-plus"));
        chord.appendChild(elementWithText("kbd", key));
      });
      keys.appendChild(chord);
    });
    keys.setAttribute("aria-hidden", "true");
    const wrap = document.createElement("span");
    wrap.className = "kb-keys-wrap";
    wrap.append(keys, elementWithText("span", bindings.length ? displayShortcut(bindings) : "No keys", "sr-only"));
    return wrap;
  }

  function shortcutFilter(): string {
    return (byId<HTMLInputElement>("kb-search")?.value ?? "").trim().toLowerCase();
  }

  function renderKeyboardList(): void {
    stopCapture();
    const list = byId("kb-list");
    if (!list) return;
    list.replaceChildren();
    const filter = shortcutFilter();
    const byCategory = new Map<string, EditableCommand[]>();
    for (const command of editableCommands()) {
      if (filter && !`${command.label} ${command.category} ${displayShortcut(command.bindings)}`.toLowerCase().includes(filter)) continue;
      byCategory.set(command.category, [...(byCategory.get(command.category) ?? []), command]);
    }
    for (const [category, items] of byCategory) {
      const sectionNode = document.createElement("section");
      sectionNode.className = "set-section kb-section";
      const head = document.createElement("header");
      head.className = "set-section-head";
      head.appendChild(elementWithText("h3", category));
      sectionNode.appendChild(head);
      const group = document.createElement("div");
      group.className = "set-card";
      for (const command of items) {
        const rowNode = document.createElement("div");
        rowNode.className = "set-row kb-row";
        rowNode.dataset.command = command.id;
        rowNode.dataset.setting = `kb-${command.id}`;
        const text = document.createElement("span");
        text.className = "set-row-text";
        text.appendChild(elementWithText("span", command.label, "set-label kb-label"));
        rowNode.appendChild(text);
        const actions = document.createElement("span");
        actions.className = "set-row-control kb-actions";
        if (command.changed) {
          const reset = iconButton("reset", `Reset ${command.label} to its default keys`, () =>
            void saveShortcuts(withoutOverride(command.id), `${command.label} is back to its default keys.`, command.id));
          actions.appendChild(reset);
        }
        const change = document.createElement("button");
        change.type = "button";
        change.className = "kb-change";
        change.setAttribute("aria-label", `Change keys for ${command.label}`);
        change.title = "Change keys";
        change.appendChild(keycaps(command.bindings));
        change.addEventListener("click", () => captureShortcut(command, rowNode, change));
        actions.appendChild(change);
        rowNode.appendChild(actions);
        group.appendChild(rowNode);
      }
      sectionNode.appendChild(group);
      list.appendChild(sectionNode);
    }
    if (!byCategory.size) list.appendChild(elementWithText("p", "No shortcuts match.", "set-empty"));
    const resetAll = byId<HTMLButtonElement>("kb-reset-all");
    if (resetAll) resetAll.disabled = !Object.keys(shortcutOverrides()).length;
  }

  function withoutOverride(id: string): Record<string, string[]> {
    const next = shortcutOverrides();
    delete next[id];
    return next;
  }

  function announceShortcut(message: string): void {
    const status = byId("kb-status");
    if (status) status.textContent = message;
  }

  function captureShortcut(command: EditableCommand, rowNode: HTMLElement, change: HTMLButtonElement): void {
    stopCapture();
    rowNode.classList.add("capturing");
    change.replaceChildren(elementWithText("span", "Press keys…", "kb-capture-label"), elementWithText("span", "Esc cancels", "kb-capture-hint"));
    change.setAttribute("aria-pressed", "true");
    announceShortcut(`Press the new keys for ${command.label}. Esc cancels.`);
    const onKey = (event: KeyboardEvent): void => {
      // the page keeps these keys; nothing else in Tuck reacts while keys are being chosen
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        renderKeyboardList();
        announceShortcut("Keys unchanged.");
        document.querySelector<HTMLButtonElement>(`[data-command="${command.id}"] .kb-change`)?.focus();
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      if (!isAssignableBinding(binding)) {
        announceShortcut("Those keys cannot be used for shortcuts. Try other keys.");
        return;
      }
      stopCapture();
      offerShortcut(command, binding, rowNode, change);
    };
    window.addEventListener("keydown", onKey, true);
    stopCapture = () => {
      window.removeEventListener("keydown", onKey, true);
      stopCapture = () => {};
    };
  }

  function offerShortcut(command: EditableCommand, binding: string, rowNode: HTMLElement, change: HTMLButtonElement): void {
    const keys = displayShortcut([binding]);
    const next = shortcutOverrides();
    const taken = commandsUsing(binding, command.id);
    for (const other of taken) {
      next[other.id] = other.bindings.filter((existing) => !sameBinding(existing, binding));
    }
    next[command.id] = [binding];
    const done = `${command.label} now uses ${keys}.`;
    if (!taken.length) {
      void saveShortcuts(next, done, command.id);
      return;
    }
    // the keys already belong to something else; ask before moving them
    change.replaceChildren(keycaps([binding]));
    change.setAttribute("aria-pressed", "false");
    const note = document.createElement("div");
    note.className = "kb-conflict";
    note.setAttribute("role", "alert");
    note.appendChild(icon("warn"));
    note.appendChild(elementWithText("span", `${keys} is used by ${taken.map((item) => item.label).join(", ")}.`));
    const use = shortcutButton("Use here", () => void saveShortcuts(next, `${done} ${taken.map((item) => item.label).join(", ")} lost it.`, command.id));
    const cancel = shortcutButton("Cancel", () => {
      renderKeyboardList();
      announceShortcut("Keys unchanged.");
    }, "quiet");
    note.append(use, cancel);
    rowNode.after(note);
    use.focus();
  }

  async function saveShortcuts(next: Record<string, string[]>, message: string, focusId = ""): Promise<void> {
    const previous = shortcutOverrides();
    // a choice that matches the defaults is simply the default again
    for (const command of editableCommands()) {
      const chosen = next[command.id];
      if (chosen && chosen.length === command.defaults.length && chosen.every((binding, index) => sameBinding(binding, command.defaults[index] ?? ""))) {
        delete next[command.id];
      }
    }
    setShortcutOverrides(next);
    const result = await legacyBackendResult(client().saveSettings({ shortcut_overrides: next } as never));
    if (result.ok) {
      session.appSettings.shortcut_overrides = next;
      announceShortcut(message);
      showSaved();
    } else {
      setShortcutOverrides(previous);
      toast(result.error ?? "Could not save the keyboard shortcuts.", "err");
    }
    renderKeyboardList();
    if (focusId) document.querySelector<HTMLButtonElement>(`[data-command="${focusId}"] .kb-change`)?.focus();
  }

  function resetAllShortcuts(): void {
    confirmToast("Every action goes back to its default keys.", () => {
      void saveShortcuts({}, "Every shortcut is back to its default keys.");
    }, { title: "Reset keyboard shortcuts?", confirmLabel: "Reset all", cancelLabel: "Keep my keys", danger: true });
  }

  interface ShortcutRecord {
    readonly type?: string;
    readonly kind?: string;
    readonly name?: string;
    readonly profile_id?: string;
    readonly status?: string;
  }

  // each can be added on its own; one for a hidden task is only listed while installed
  const SEND_TO_SHORTCUTS: readonly {
    readonly kind: SendToKind;
    readonly name: string;
    readonly note: string;
    readonly task: TaskName | null;
  }[] = [
    { kind: "open", name: "Tuck", note: "Opens the videos in Tuck.", task: null },
    { kind: "compress", name: "Tuck Compress", note: "Compresses in the background with your default profile.", task: "compression" },
    { kind: "upscale", name: "Tuck Upscale", note: "Upscales in the background with your last Upscale profile.", task: "upscale" },
    { kind: "cut", name: "Tuck Lossless Cut", note: "Opens the videos in Tuck, ready to cut.", task: "cut" },
  ];

  function sendToIcon(kind: SendToKind): Node {
    return kind === "open" ? h("span", { class: "set-icon set-icon-logo" }, icon("logo")) : icon(kind);
  }

  function shortcutButton(label: string, run: () => void, kind?: "quiet" | "danger" | "primary"): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `set-btn${kind ? ` ${kind}` : ""}`;
    node.textContent = label;
    node.addEventListener("click", run);
    return node;
  }

  function iconButton(name: IconName, label: string, run: () => void): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "set-icon-btn";
    node.setAttribute("aria-label", label);
    node.title = label;
    node.appendChild(icon(name));
    node.addEventListener("click", run);
    return node;
  }

  function sendToRow(item: (typeof SEND_TO_SHORTCUTS)[number], installed: ShortcutRecord | undefined): HTMLElement {
    const broken = !!installed && installed.status !== "ok";
    const id = `st-${item.kind}`;
    if (broken) {
      return h("div", { class: "set-row has-icon", "data-setting": id },
        shortcutRowText(sendToIcon(item.kind), item.name, item.note),
        h("span", { class: "set-row-control" },
          h("span", { class: "set-state warn" }, icon("warn"), "Needs repair"),
          shortcutButton("Repair", () => void repairShortcut(installed)),
          shortcutButton("Remove", () => removeShortcut(installed, item.name), "quiet")));
    }
    const rowNode = switchRow({
      setting: id,
      id,
      label: item.name,
      description: item.note,
      checked: !!installed,
      attributes: { "data-sendto-kind": item.kind },
    });
    rowNode.classList.add("has-icon");
    rowNode.querySelector(".set-row-text")?.prepend(sendToIcon(item.kind));
    const toggle = rowNode.querySelector<HTMLInputElement>("input");
    toggle?.addEventListener("change", () => {
      if (toggle.checked) {
        void installGenericShortcut(item.kind, item.name);
      } else if (installed) {
        // it stays on until the removal is confirmed; the list redraws afterwards
        toggle.checked = true;
        removeShortcut(installed, item.name);
      }
    });
    return rowNode;
  }

  /** `focusId` names the Send to switch to keep focus on once the rows are rebuilt */
  async function refreshShortcutList(focusId = ""): Promise<void> {
    const fixed = byId("st-fixed");
    const list = byId("st-list");
    if (!fixed || !list) return;
    const active = document.activeElement;
    const keep = focusId || (active instanceof HTMLElement && fixed.contains(active) ? active.id : "");
    const result = await legacyBackendResult(client().listSendtoShortcuts());
    const shortcuts = (Array.isArray(result.shortcuts) ? result.shortcuts : []) as ShortcutRecord[];
    const hidden = hiddenParts(session.appSettings.hidden_ui);
    fixed.replaceChildren();
    for (const item of SEND_TO_SHORTCUTS) {
      const installed = shortcuts.find((shortcut) => shortcut.type === "generic" && shortcut.kind === item.kind);
      if (!installed && item.task && hidden.has(item.task)) continue;
      fixed.appendChild(sendToRow(item, installed));
    }
    list.replaceChildren();
    for (const shortcut of shortcuts.filter((item) => item.type === "profile")) {
      const name = profileShortcutName(shortcut.profile_id || shortcut.name || "");
      const status = shortcut.status === "ok" ? `Runs ${name} in the background.` : "This shortcut needs repair.";
      list.appendChild(h("div", { class: "set-row has-icon" },
        shortcutRowText(icon("compress"), shortcut.name || name, status),
        h("span", { class: "set-row-control" },
          shortcut.status !== "ok" && shortcutButton("Repair", () => void repairShortcut(shortcut)),
          shortcutButton("Remove", () => removeShortcut(shortcut, name), "quiet"))));
    }
    if (!list.children.length) list.appendChild(elementWithText("p", "No profile shortcuts yet.", "set-empty in-card"));
    if (keep && fixed.isConnected) {
      const target = byId(keep) ?? fixed.querySelector<HTMLElement>(`[data-setting="${CSS.escape(keep)}"] button`);
      target?.focus();
    }
  }

  async function addShortcutFlow(): Promise<void> {
    const caps = await fetchPlatformCapabilities();
    if (!shouldShowSendTo(caps)) return;
    view = "shortcut-choices";
    const profiles = (await legacyBackendResult(client().getProfilesJson())) as unknown as ProfileListEntry[] | { ok: false };
    renderShell([
      h("p", { class: "set-section-desc set-lead" }, "Choose a profile. It appears in Send to and runs in the background."),
      h("div", { id: "profile-shortcut-choices", class: "set-card" }),
    ], {
      title: "Add profile shortcut",
      back: { action: "open-explorer", label: "Back to File Explorer" },
      navPage: "explorer",
    });
    const choices = el("profile-shortcut-choices");
    renderShortcutChoices(document, choices, Array.isArray(profiles) ? profiles : [], { summarize: profileSummary });
    bindProfileActions(choices, (action, profileId, name) => {
      if (action === "install-profile-shortcut") void installProfileShortcut(profileId, name);
    });
  }

  async function installGenericShortcut(kind: SendToKind, name: string): Promise<void> {
    const result = await legacyBackendResult(client().installGenericSendto(kind));
    if (result.ok) toast(`Added "${name}" to Send to.`, "ok");
    else toast(result.error ?? `Could not add "${name}".`, "err");
    void refreshShortcutList(`st-${kind}`);
  }

  async function installProfileShortcut(pid: string, name: string): Promise<void> {
    const result = await legacyBackendResult(client().installProfileSendto(pid, "start"));
    if (result.ok) toast(`Added "${name}" to Explorer.`, "ok");
    else toast(result.error ?? "Could not add the profile shortcut.", "err");
    void open("explorer");
  }

  function genericKind(data: ShortcutRecord): SendToKind | null {
    return SEND_TO_SHORTCUTS.find((item) => item.kind === data.kind)?.kind ?? null;
  }

  function removeShortcut(data: ShortcutRecord, name: string): void {
    const kind = genericKind(data);
    confirmToast(`Remove "${name}" from Send to?`, () => {
      void legacyBackendResult(
        kind ? client().removeGenericSendto(kind) : client().removeProfileSendto(data.profile_id || data.name || ""),
      ).then((result) => {
        if (result.ok) toast("Shortcut removed.", "ok");
        else toast(result.error ?? "Could not remove the shortcut.", "err");
        void refreshShortcutList(kind ? `st-${kind}` : "");
      });
    }, { title: "Remove shortcut?", confirmLabel: "Remove", cancelLabel: "Keep shortcut", danger: true });
  }

  async function repairShortcut(data: ShortcutRecord): Promise<void> {
    const kind = genericKind(data);
    const result = kind
      ? await legacyBackendResult(client().repairGenericSendto(kind))
      : await legacyBackendResult(client().repairProfileSendto(data.profile_id || data.name || ""));
    if (result.ok) toast("Shortcut repaired.", "ok");
    else toast(result.error ?? "Could not repair the shortcut.", "err");
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
        "clear-search": () => {
          clearSearchField();
          leaveSearch();
          byId("settings-search")?.focus();
        },
        "search-result": (target) => void openSearchResult(target.dataset.settingsValue ?? ""),
        "back-profiles": () => backToProfiles(),
        "save-profile": () => void saveProfileEditor(),
        "import-profiles": () => void importProfiles(),
        "new-profile": () => void newProfile(),
        "add-shortcut": () => void addShortcutFlow(),
        "reset-shortcuts": () => resetAllShortcuts(),
        "show-shortcut-guide": () => deps.showShortcutGuide(),
        "open-explorer": () => void open("explorer"),
        "profile-task": (target) => {
          peSetTask((target.dataset.settingsValue as Workflow) ?? "compression");
          updateEditorNote();
        },
        "profile-size": (target) => peSetSize(target.dataset.settingsValue ?? "50"),
        "toggle-advanced": () => peToggleAdvanced(),
        "browse-output": () => void browseOutput(),
        "insert-token": (target) =>
          insertNamingToken(target.dataset.settingsTarget ?? "", target.dataset.settingsToken ?? "", target),
        "browse-ffmpeg": () => void browseTool("set-ffmpeg"),
        "browse-ffprobe": () => void browseTool("set-ffprobe"),
        "clear-ffmpeg": () => void clearTool("set-ffmpeg"),
        "clear-ffprobe": () => void clearTool("set-ffprobe"),
        "refresh-encoders": () => void refreshEncoders(),
        "check-updates": (target) => void checkForUpdatesNow(target),
        "copy-diagnostics": () => void deps.copyDiagnostics(),
        "open-support": (target) => void openSupportFolder(target.dataset.settingsValue ?? "logs"),
        "open-document": (target) => void openDocument(target),
        "export-settings": () => void exportSettings(),
        "import-settings": () => void importSettings(),
        "reset-settings": () => resetSettings(),
      },
      input: {
        search: (target) => onSearchInput(target as HTMLInputElement),
        "profile-size": (target) => peSetSize((target as HTMLInputElement).value, true),
        "profile-fps": () => updateEditorNote(),
        "editor-name": () => updateEditorNote(),
        "preview-output": (target) => updateExampleOutput(target as HTMLInputElement),
        "filter-shortcuts": () => renderKeyboardList(),
      },
      change: {
        "profile-visibility": () => peVisibility(),
        "profile-encoder": () => peEncoderChanged(),
        "profile-speed": () => peSpeedChanged(),
        "profile-preset": () => pePresetChanged(),
        save: () => void autosave(),
        location: (target) => void chooseLocation(target as HTMLInputElement),
        visibility: () => {
          syncVisibilityChoices();
          void autosave();
        },
        "filter-profiles": (target) => {
          profileFilter = (target as HTMLInputElement).value;
          void refreshProfileManagerList();
        },
      },
    },
    "settings",
  );

  // the editor tracks every field, including the ones without their own handler
  el("settings-page").addEventListener("input", () => updateEditorNote());
  el("settings-page").addEventListener("change", () => updateEditorNote());

  // Esc in the search field clears it first, then closes Settings
  byId("settings-search")?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !(event.target as HTMLInputElement).value) return;
    event.preventDefault();
    event.stopPropagation();
    clearSearchField();
    leaveSearch();
  });

  // Esc closes an open menu first and keeps Settings open
  el("settings-workspace").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = (event.target as HTMLElement).closest?.<HTMLDetailsElement>(".set-token-menu[open], .profile-actions-menu[open]")
      ?? document.querySelector<HTMLDetailsElement>("#settings-page .set-token-menu[open], #settings-page .profile-actions-menu[open]");
    if (!menu) return;
    event.preventDefault();
    event.stopPropagation();
    menu.removeAttribute("open");
    menu.querySelector<HTMLElement>("summary")?.focus();
  });

  // a token menu closes when focus or a click goes elsewhere
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(".set-token-menu[open], .profile-actions-menu[open]")) {
      if (!menu.contains(event.target as Node)) menu.removeAttribute("open");
    }
  });

  return {
    toggle,
    open,
    close,
    isOpen,
  };
}

// where a rejected save shows its message beside the field
function fieldError(id: string): HTMLElement {
  return h("span", { class: "set-row-error", id: `${id}-error`, role: "alert", hidden: true });
}

// keeps the chosen path for the page to save; the row shows it separately
function pathHolder(id: string, path: string): HTMLElement {
  return h("span", { id, "data-path": path, hidden: true });
}

function shortcutRowText(rowIcon: Node, label: string, description: string): HTMLElement {
  return h("span", { class: "set-row-text" },
    rowIcon,
    h("span", { class: "set-row-words" }, h("span", { class: "set-label" }, label), h("span", { class: "set-desc" }, description)));
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
