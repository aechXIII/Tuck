export type ShortcutContext =
  | "editor"
  | "global"
  | "editor-no-entry"
  | "editor-no-text-entry"
  | string;

export interface CommandDefinition {
  id: string;
  category?: string;
  column?: number;
  label?: string;
  bindings: readonly string[];
  context?: ShortcutContext;
  configurable?: boolean;
  guideGroup?: string;
  guideHighlightAll?: boolean;
  guideIds?: readonly string[];
  local?: boolean;
  guide?: boolean;
  guideNote?: string;
  // the name in Settings when the guide pairs this command with another on one row
  editLabel?: string;
}

export interface GuideItem {
  label: string;
  keys: string[][];
  ids: string[];
  note?: string;
  highlightAll?: boolean;
}

export interface GuideSection {
  cat: string;
  column?: number;
  items: GuideItem[];
}

export interface CommandState {
  modalOpen?: boolean;
  settingsOpen?: boolean;
  formControlFocused?: boolean;
  textEntryFocused?: boolean;
}

export interface KeyboardEventLike {
  key?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
}

export type CommandExecute = (
  event: KeyboardEventLike,
  state: CommandState,
) => void;

export interface CommandAction {
  execute: CommandExecute;
  enabled?: (event: KeyboardEventLike, state: CommandState) => boolean;
}

export interface ShortcutRegistry {
  dispatch: (
    event: KeyboardEventLike | null | undefined,
    state?: CommandState | null,
  ) => string | null;
  registerAction: (
    id: string,
    action: CommandExecute | CommandAction,
  ) => void;
}

export interface SearchResult {
  query: string;
  total: number;
  matched: number;
  sections: GuideSection[];
  keyIds: string[];
}

export interface ClearButtonLike {
  classList: { toggle: (name: string, force?: boolean) => unknown };
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  disabled: boolean;
  tabIndex: number;
}

export interface TabbableControl {
  disabled: boolean;
  tabIndex: number;
  getAttribute: (name: string) => string | null;
  focus?: () => void;
}

export interface FocusableLike {
  focus: () => void;
}

export interface DialogBoxLike {
  removeEventListener: (
    type: string,
    listener: (event: KeyboardEvent) => void,
  ) => void;
  removeAttribute: (name: string) => void;
  querySelectorAll?: (selectors: string) => ArrayLike<TabbableControl>;
}

export interface ShortcutsApi {
  bindingMarkup: typeof bindingMarkup;
  bindingText: typeof bindingText;
  cleanupDialog: typeof cleanupDialog;
  commands: readonly CommandDefinition[];
  createRegistry: typeof createRegistry;
  dispatch: ShortcutRegistry["dispatch"];
  editorCommandsEnabled: typeof editorCommandsEnabled;
  escapeMarkup: typeof escapeMarkup;
  keyboardRowsMarkup: typeof keyboardRowsMarkup;
  matchesBinding: typeof matchesBinding;
  registerAction: ShortcutRegistry["registerAction"];
  sections: readonly GuideSection[];
  shouldUseSingleColumn: typeof shouldUseSingleColumn;
  tabbableControls: typeof tabbableControls;
  search: typeof search;
  shouldOpenGuide: typeof shouldOpenGuide;
  spokenBindingText: typeof spokenBindingText;
  resultLabel: typeof resultLabel;
  sectionColumns: typeof sectionColumns;
  updateClearButton: typeof updateClearButton;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ctrl: "control",
  del: "delete",
  esc: "escape",
  left: "left arrow",
  right: "right arrow",
  up: "up arrow",
  down: "down arrow",
  space: "spacebar",
  lbracket: "left bracket",
  rbracket: "right bracket",
};

const SPOKEN_KEYS: Readonly<Record<string, string>> = {
  Ctrl: "Control",
  Esc: "Escape",
  ",": "comma",
  "[": "left bracket",
  "]": "right bracket",
  "←": "Left arrow",
  "→": "Right arrow",
  "↑": "Up arrow",
  "↓": "Down arrow",
};

const KEY_IDS: Readonly<Record<string, string>> = {
  Ctrl: "ctrl",
  Shift: "shift",
  Esc: "esc",
  Delete: "del",
  ",": "comma",
  "[": "lbracket",
  "]": "rbracket",
  Space: "space",
  "←": "left",
  "→": "right",
  "↑": "up",
  "↓": "down",
};

const COMMANDS: CommandDefinition[] = [
  {
    id: "file.add-videos",
    category: "General",
    column: 0,
    label: "Add videos",
    bindings: ["Ctrl+O"],
    context: "editor",
  },
  {
    id: "settings.open",
    category: "General",
    column: 0,
    label: "Open settings",
    bindings: ["Ctrl+,"],
    context: "editor",
  },
  {
    id: "app.exit",
    category: "General",
    column: 0,
    label: "Exit Tuck",
    bindings: ["Ctrl+Q"],
    context: "editor",
  },
  {
    id: "ui.dismiss",
    category: "General",
    column: 0,
    label: "Close dialog",
    bindings: ["Escape"],
    context: "global",
    configurable: false,
  },
  {
    id: "edit.undo",
    category: "Edit",
    column: 1,
    label: "Undo",
    bindings: ["Ctrl+Z"],
    context: "editor-no-text-entry",
  },
  {
    id: "edit.redo",
    category: "Edit",
    column: 1,
    label: "Redo",
    bindings: ["Ctrl+Shift+Z", "Ctrl+Y"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.toggle",
    category: "Playback & navigation",
    column: 0,
    label: "Play / pause",
    bindings: ["Space"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.step-backward",
    editLabel: "Previous frame",
    category: "Playback & navigation",
    column: 0,
    label: "Previous / next frame",
    guideGroup: "playback.step",
    guideHighlightAll: true,
    bindings: ["ArrowLeft"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.step-forward",
    editLabel: "Next frame",
    category: "Playback & navigation",
    column: 0,
    label: "Previous / next frame",
    guideGroup: "playback.step",
    bindings: ["ArrowRight"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.seek-backward",
    editLabel: "Skip back 3 seconds",
    category: "Playback & navigation",
    column: 0,
    label: "Skip 3 seconds",
    guideGroup: "playback.seek",
    guideHighlightAll: true,
    bindings: ["Shift+ArrowLeft"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.seek-forward",
    editLabel: "Skip forward 3 seconds",
    category: "Playback & navigation",
    column: 0,
    label: "Skip 3 seconds",
    guideGroup: "playback.seek",
    bindings: ["Shift+ArrowRight"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.seek-start",
    editLabel: "Go to beginning",
    category: "Playback & navigation",
    column: 0,
    label: "Go to beginning / end",
    guideGroup: "playback.boundary",
    guideHighlightAll: true,
    bindings: ["Ctrl+ArrowLeft"],
    context: "editor-no-text-entry",
  },
  {
    id: "playback.seek-end",
    editLabel: "Go to end",
    category: "Playback & navigation",
    column: 0,
    label: "Go to beginning / end",
    guideGroup: "playback.boundary",
    bindings: ["Ctrl+ArrowRight"],
    context: "editor-no-text-entry",
  },
  {
    id: "media.select-previous",
    editLabel: "Previous Library video",
    category: "Playback & navigation",
    column: 0,
    label: "Previous / next Library video",
    guideGroup: "media.select",
    guideHighlightAll: true,
    bindings: ["ArrowUp"],
    context: "editor-no-text-entry",
  },
  {
    id: "media.select-next",
    editLabel: "Next Library video",
    category: "Playback & navigation",
    column: 0,
    label: "Previous / next Library video",
    guideGroup: "media.select",
    bindings: ["ArrowDown"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.add-segment",
    category: "Timeline & segments",
    column: 1,
    label: "Add segment",
    bindings: ["A"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.split",
    category: "Timeline & segments",
    column: 1,
    label: "Split at playhead",
    bindings: ["S"],
    context: "editor-no-text-entry",
  },
  {
    id: "audio.toggle-fragment-mute",
    category: "Timeline & segments",
    column: 1,
    label: "Mute / unmute fragment",
    bindings: ["M"],
    context: "editor-no-text-entry",
  },
  {
    id: "edit.delete-selection",
    category: "Timeline & segments",
    column: 1,
    label: "Delete selected item",
    bindings: ["Delete", "Backspace"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.set-selection-start",
    editLabel: "Set selected start",
    category: "Timeline & segments",
    column: 1,
    label: "Set selected start / end",
    guideGroup: "timeline.set-selection-boundary",
    guideHighlightAll: true,
    bindings: ["I"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.set-selection-end",
    editLabel: "Set selected end",
    category: "Timeline & segments",
    column: 1,
    label: "Set selected start / end",
    guideGroup: "timeline.set-selection-boundary",
    bindings: ["O"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.previous-keyframe",
    editLabel: "Previous keyframe",
    category: "Timeline & segments",
    column: 1,
    label: "Previous / next keyframe",
    guideGroup: "timeline.keyframe",
    guideHighlightAll: true,
    guideNote: "Lossless cut. Moves a focused segment handle.",
    bindings: ["["],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.next-keyframe",
    editLabel: "Next keyframe",
    category: "Timeline & segments",
    column: 1,
    label: "Previous / next keyframe",
    guideGroup: "timeline.keyframe",
    bindings: ["]"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.zoom-in",
    editLabel: "Zoom timeline in",
    category: "Timeline & segments",
    column: 1,
    label: "Zoom timeline in / out",
    guideGroup: "timeline.zoom",
    guideHighlightAll: true,
    bindings: ["Ctrl+="],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.zoom-out",
    editLabel: "Zoom timeline out",
    category: "Timeline & segments",
    column: 1,
    label: "Zoom timeline in / out",
    guideGroup: "timeline.zoom",
    bindings: ["Ctrl+-"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.fit",
    category: "Timeline & segments",
    column: 1,
    label: "Fit timeline",
    bindings: ["Ctrl+0"],
    context: "editor-no-text-entry",
  },
  {
    id: "timeline.adjust-trim-backward",
    category: "Timeline & segments",
    column: 1,
    label: "Nudge focused trim handle",
    guideGroup: "timeline.adjust-trim",
    guideHighlightAll: true,
    guideIds: ["shift"],
    bindings: ["ArrowLeft"],
    local: true,
    configurable: false,
    guide: false,
  },
  {
    id: "timeline.adjust-trim-forward",
    category: "Timeline & segments",
    column: 1,
    label: "Nudge focused trim handle",
    guideGroup: "timeline.adjust-trim",
    bindings: ["ArrowRight"],
    local: true,
    configurable: false,
    guide: false,
  },
  {
    id: "help.shortcuts",
    category: "General",
    column: 0,
    label: "Open keyboard shortcuts",
    bindings: ["?", "Ctrl+/"],
    context: "editor-no-text-entry",
    guide: false,
  },
];

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

interface BindingParts {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  key: string;
}

function bindingParts(binding: string): BindingParts {
  const tokens = String(binding || "").split("+");
  const key = tokens.pop() || "";
  const parts: BindingParts = {
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
    key,
  };
  tokens.forEach((token) => {
    const modifier = token.toLowerCase();
    if (modifier === "alt") parts.alt = true;
    else if (modifier === "ctrl" || modifier === "control") parts.ctrl = true;
    else if (modifier === "meta" || modifier === "cmd") parts.meta = true;
    else if (modifier === "shift") parts.shift = true;
    else throw new Error("Unknown shortcut modifier: " + token);
  });
  return parts;
}

function displayBinding(binding: string): string[] {
  const parts = bindingParts(binding);
  const keys: string[] = [];
  if (parts.ctrl) keys.push("Ctrl");
  if (parts.meta) keys.push("Meta");
  if (parts.alt) keys.push("Alt");
  if (parts.shift) keys.push("Shift");
  keys.push(DISPLAY_KEYS[parts.key] || parts.key);
  return keys;
}

function commandSections(
  commands: readonly CommandDefinition[],
  bindingsOf: (command: CommandDefinition) => readonly string[] = (command) => command.bindings,
): GuideSection[] {
  const sections: GuideSection[] = [];
  const sectionByCategory: Record<string, GuideSection> = {};
  const itemByGroup: Record<string, GuideItem> = {};

  (commands || []).forEach((command) => {
    if (command.guide === false) return;
    const category = command.category;
    if (!category) return;
    let section = sectionByCategory[category];
    if (!section) {
      section = {
        cat: category,
        column: command.column === 1 ? 1 : 0,
        items: [],
      };
      sectionByCategory[category] = section;
      sections.push(section);
    }

    const group = command.guideGroup || command.id;
    let item = itemByGroup[group];
    if (!item) {
      item = {
        label: command.label || "",
        keys: [],
        ids: (command.guideIds || []).slice(),
      };
      if (command.guideNote) item.note = command.guideNote;
      if (command.guideHighlightAll) item.highlightAll = true;
      itemByGroup[group] = item;
      section.items.push(item);
    }

    (bindingsOf(command) || []).forEach((binding) => {
      const keys = displayBinding(binding);
      item.keys.push(keys);
      keys.forEach((key) => {
        const id = keyId(key);
        if (id && item.ids.indexOf(id) < 0) item.ids.push(id);
      });
    });
  });

  return sections;
}

function freezeTree<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.keys(value).forEach((key) => {
    freezeTree((value as Record<string, unknown>)[key]);
  });
  return Object.freeze(value);
}

const SECTIONS = commandSections(COMMANDS);
freezeTree(COMMANDS);
freezeTree(SECTIONS);

function normalizedKey(key: string | undefined): string {
  const aliases: Readonly<Record<string, string>> = {
    " ": "space",
    Spacebar: "space",
    Esc: "escape",
    Del: "delete",
    Left: "arrowleft",
    Right: "arrowright",
    Up: "arrowup",
    Down: "arrowdown",
  };
  return String(aliases[key || ""] || key || "").toLowerCase();
}

export function matchesBinding(
  event: KeyboardEventLike | null | undefined,
  binding: string,
): boolean {
  if (!event) return false;
  const parts = bindingParts(binding);
  let eventShift = !!event.shiftKey;
  if (
    !parts.shift &&
    eventShift &&
    String(event.key || "").length === 1 &&
    !/[a-z0-9]/i.test(event.key || "")
  )
    eventShift = false;
  return (
    !!event.altKey === parts.alt &&
    !!event.ctrlKey === parts.ctrl &&
    !!event.metaKey === parts.meta &&
    eventShift === parts.shift &&
    normalizedKey(event.key) === normalizedKey(parts.key)
  );
}

function commandAvailable(
  command: CommandDefinition,
  state: CommandState | null | undefined,
): boolean {
  const context = command.context || "editor";
  const current = state || {};
  if (context !== "global" && (current.modalOpen || current.settingsOpen))
    return false;
  if (context === "editor-no-entry" && current.formControlFocused) return false;
  if (context === "editor-no-text-entry" && current.textEntryFocused)
    return false;
  return true;
}

export function createRegistry(
  commands?: readonly CommandDefinition[] | null,
  bindingsOf: (command: CommandDefinition) => readonly string[] = (command) => command.bindings,
): ShortcutRegistry {
  const definitions = commands || [];
  const commandById: Record<string, CommandDefinition> = {};
  const actions: Record<string, CommandAction> = {};
  definitions.forEach((command) => {
    if (!command.id || commandById[command.id])
      throw new Error("Duplicate or missing command id: " + command.id);
    commandById[command.id] = command;
  });

  function registerAction(
    id: string,
    action: CommandExecute | CommandAction,
  ): void {
    if (!commandById[id]) throw new Error("Unknown command: " + id);
    if (actions[id]) throw new Error("Action already registered: " + id);
    const registration: CommandAction =
      typeof action === "function" ? { execute: action } : action;
    if (!registration || typeof registration.execute !== "function")
      throw new Error("Command action must provide execute(): " + id);
    actions[id] = registration;
  }

  function dispatch(
    event: KeyboardEventLike | null | undefined,
    state?: CommandState | null,
  ): string | null {
    if (event && event.defaultPrevented) return null;
    for (let i = 0; i < definitions.length; i++) {
      const command = definitions[i];
      if (!command || command.local || !commandAvailable(command, state))
        continue;
      if (
        !(bindingsOf(command) || []).some((binding) =>
          matchesBinding(event, binding),
        )
      )
        continue;
      const action = actions[command.id];
      if (!action) continue;
      if (
        typeof action.enabled === "function" &&
        !action.enabled(event || {}, state || {})
      )
        continue;
      if (event && typeof event.preventDefault === "function")
        event.preventDefault();
      action.execute(event || {}, state || {});
      return command.id;
    }
    return null;
  }

  return { dispatch, registerAction };
}

type KeyboardKeySpec = readonly [number, string, string?] | [number, string, string?];

const KEYBOARD_LAYOUT: readonly (readonly KeyboardKeySpec[])[] = [
  [
    [34, "Esc", "esc"],
    [34, "1"],
    [34, "2"],
    [34, "3"],
    [34, "4"],
    [34, "5"],
    [34, "6"],
    [34, "7"],
    [34, "8"],
    [34, "9"],
    [34, "0", "0"],
    [34, "-"],
    [34, "="],
    [72, "Backspace"],
    [34, "Del", "del"],
  ],
  [
    [53, "Tab"],
    [34, "Q", "q"],
    [34, "W"],
    [34, "E"],
    [34, "R"],
    [34, "T"],
    [34, "Y", "y"],
    [34, "U"],
    [34, "I", "i"],
    [34, "O", "o"],
    [34, "P"],
    [34, "[", "lbracket"],
    [34, "]", "rbracket"],
    [53, "\\"],
    [34, "PgUp"],
  ],
  [
    [63, "Caps"],
    [34, "A", "a"],
    [34, "S", "s"],
    [34, "D"],
    [34, "F"],
    [34, "G"],
    [34, "H"],
    [34, "J"],
    [34, "K"],
    [34, "L"],
    [34, ";"],
    [34, "'"],
    [81, "Enter"],
    [34, "PgDn"],
  ],
  [
    [81, "Shift", "shift"],
    [34, "Z", "z"],
    [34, "X"],
    [34, "C"],
    [34, "V"],
    [34, "B"],
    [34, "N"],
    [34, "M", "m"],
    [34, ",", "comma"],
    [34, "."],
    [34, "/"],
    [63, "Shift", "shift"],
    [34, "↑", "up"],
    [34, "End"],
  ],
  [
    [43, "Ctrl", "ctrl"],
    [43, "Win"],
    [43, "Alt"],
    [255, "Space", "space"],
    [43, "Alt"],
    [43, "Fn"],
    [34, "←", "left"],
    [34, "↓", "down"],
    [34, "→", "right"],
  ],
];

function bindingGroups(
  keys: string | readonly string[] | readonly (readonly string[])[] | null | undefined,
): string[][] {
  if (!Array.isArray(keys)) return keys ? [[String(keys)]] : [];
  if (!keys.length) return [];
  return Array.isArray(keys[0])
    ? (keys as string[][]).map((chord) => chord.slice())
    : [Array.from(keys as readonly string[])];
}

export function bindingText(
  keys: string | readonly string[] | readonly (readonly string[])[] | null | undefined,
): string {
  return bindingGroups(keys)
    .map((chord) => chord.join(" + "))
    .join(" or ");
}

export function spokenBindingText(
  keys: string | readonly string[] | readonly (readonly string[])[] | null | undefined,
): string {
  return bindingGroups(keys)
    .map((chord) =>
      chord.map((key) => SPOKEN_KEYS[key] || key).join(" plus "),
    )
    .join(" or ");
}

export function escapeMarkup(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function bindingMarkup(
  keys: string | readonly string[] | readonly (readonly string[])[] | null | undefined,
): string {
  return bindingGroups(keys)
    .map((chord) => {
      const keycaps = chord
        .map((key) => "<kbd>" + escapeMarkup(key) + "</kbd>")
        .join('<span class="kbs-plus">+</span>');
      return '<span class="kbs-chord">' + keycaps + "</span>";
    })
    .join('<span class="kbs-or">or</span>');
}

function normalize(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/←/g, " left arrow ")
    .replace(/→/g, " right arrow ")
    .replace(/↑/g, " up arrow ")
    .replace(/↓/g, " down arrow ")
    .replace(/,/g, " comma ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bplus\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function searchableText(section: GuideSection, item: GuideItem): string {
  const terms: Array<string | undefined> = [
    section.cat,
    item.label,
    bindingText(item.keys),
    spokenBindingText(item.keys),
    item.note,
  ];
  (item.ids || []).forEach((id) => {
    terms.push(id);
    if (KEY_ALIASES[id]) terms.push(KEY_ALIASES[id]);
  });
  return normalize(terms.join(" "));
}

function keyId(key: string): string | null {
  if (KEY_IDS[key]) return KEY_IDS[key] ?? null;
  return /^[a-z0-9]$/i.test(key) ? key.toLowerCase() : null;
}

function highlightedKeyIds(item: GuideItem, query: string): string[] {
  const groups = bindingGroups(item.keys);
  let selected = groups;
  if (query) {
    const matches = groups.filter(
      (chord) =>
        normalize(bindingText([chord])).indexOf(query) >= 0 ||
        normalize(spokenBindingText([chord])).indexOf(query) >= 0,
    );
    selected = matches.length
      ? matches
      : item.highlightAll
        ? groups
        : groups.slice(0, 1);
  }

  const ids: string[] = [];
  selected.forEach((chord) => {
    chord.forEach((key) => {
      const id = keyId(key);
      if (id && ids.indexOf(id) < 0) ids.push(id);
    });
  });
  return ids.length ? ids : item.ids || [];
}

export function search(
  sections: readonly GuideSection[] | null | undefined,
  value: unknown,
): SearchResult {
  const query = normalize(value);
  let total = 0;
  let matched = 0;
  const keyIds: string[] = [];
  const seenKeyIds: Record<string, boolean> = {};
  const filteredSections: GuideSection[] = [];

  (sections || []).forEach((section) => {
    const items = (section.items || []).filter((item) => {
      total++;
      const matches =
        !query || searchableText(section, item).indexOf(query) >= 0;
      if (!matches) return false;

      matched++;
      highlightedKeyIds(item, query).forEach((id) => {
        if (seenKeyIds[id]) return;
        seenKeyIds[id] = true;
        keyIds.push(id);
      });
      return true;
    });

    if (items.length) {
      const filteredSection: GuideSection = { cat: section.cat, items };
      if (section.column != null) filteredSection.column = section.column;
      filteredSections.push(filteredSection);
    }
  });

  return {
    query,
    total,
    matched,
    sections: filteredSections,
    keyIds,
  };
}

export function resultLabel(
  query: string,
  matched: number,
  total: number,
): string {
  if (!query) return total + " shortcuts";
  return matched + (matched === 1 ? " result" : " results");
}

export function shouldUseSingleColumn(
  query: string,
  matched: number,
  populatedColumns: number,
): boolean {
  return !!query && matched > 0 && (matched <= 2 || populatedColumns === 1);
}

export function sectionColumns(
  sections: readonly GuideSection[] | null | undefined,
  singleColumn: boolean,
): GuideSection[][] {
  const list = sections || [];
  if (singleColumn) return [Array.from(list)];
  const columns: [GuideSection[], GuideSection[]] = [[], []];
  list.forEach((section) => {
    columns[section.column === 1 ? 1 : 0].push(section);
  });
  return columns.filter((column) => column.length);
}

export function updateClearButton(
  button: ClearButtonLike | null | undefined,
  visible: boolean,
): void {
  if (!button) return;
  button.classList.toggle("is-hidden", !visible);
  if (visible) button.removeAttribute("aria-hidden");
  else button.setAttribute("aria-hidden", "true");
  button.disabled = !visible;
  button.tabIndex = visible ? 0 : -1;
}

export function tabbableControls(
  box: { querySelectorAll: (selectors: string) => ArrayLike<TabbableControl> } | null | undefined,
): TabbableControl[] {
  if (!box) return [];
  return Array.prototype.filter.call(
    box.querySelectorAll("button, input"),
    (control: TabbableControl) =>
      !control.disabled &&
      control.tabIndex !== -1 &&
      control.getAttribute("aria-hidden") !== "true",
  ) as TabbableControl[];
}

export function cleanupDialog(
  box: DialogBoxLike | null | undefined,
  focusTrap: ((event: KeyboardEvent) => void) | null | undefined,
  returnFocus: FocusableLike | null | undefined,
  restoreFocus: boolean,
): null {
  if (box) {
    if (focusTrap) box.removeEventListener("keydown", focusTrap);
    box.removeAttribute("role");
    box.removeAttribute("aria-modal");
    box.removeAttribute("aria-labelledby");
  }
  if (restoreFocus && returnFocus && typeof returnFocus.focus === "function") {
    returnFocus.focus();
  }
  return null;
}

export function editorCommandsEnabled(
  doc:
    | {
        body?: { classList?: { contains: (name: string) => boolean } } | null;
        getElementById?: (id: string) => {
          classList?: { contains: (name: string) => boolean };
        } | null;
      }
    | null
    | undefined,
): boolean {
  if (!doc) return true;
  const overlay = doc.getElementById && doc.getElementById("mod-overlay");
  const modalOpen = !!(
    overlay &&
    overlay.classList &&
    overlay.classList.contains("open")
  );
  const settingsOpen = !!(
    doc.body &&
    doc.body.classList &&
    doc.body.classList.contains("settings-open")
  );
  return !modalOpen && !settingsOpen;
}

export function keyboardRowsMarkup(): string {
  return KEYBOARD_LAYOUT.map((row) => {
    const keys = row
      .map((key) => {
        const id = key[2];
        const attr = id ? ' data-k="' + id + '"' : "";
        return (
          '<div class="kbs-key" style="--kw:' +
          key[0] +
          '"' +
          attr +
          ">" +
          escapeMarkup(key[1]) +
          "</div>"
        );
      })
      .join("");
    return '<div class="kbs-krow">' + keys + "</div>";
  }).join("");
}

export function shouldOpenGuide(
  event: KeyboardEventLike | null | undefined,
  state: CommandState | null | undefined,
): boolean {
  return !!(
    event &&
    (matchesBinding(event, "?") || matchesBinding(event, "Ctrl+/")) &&
    state &&
    !state.modalOpen &&
    !state.settingsOpen &&
    !state.textEntryFocused
  );
}

// keys the user chose in Settings, by command id; commands without an entry keep their defaults
let overrides: Readonly<Record<string, readonly string[]>> = {};
let effectiveSections: readonly GuideSection[] = SECTIONS;
const changeListeners = new Set<() => void>();

// Esc closes dialogs, Tab moves focus and Enter presses buttons, so none of them can be taken
const RESERVED_KEYS = new Set(["escape", "tab", "enter"]);
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph", "capslock"]);
// the named keys settings can store; any single printable character works too
const NAMED_KEYS = new Set([
  "arrowleft", "arrowright", "arrowup", "arrowdown", "space", "delete", "backspace",
  "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
]);

export function isAssignableBinding(binding: unknown): binding is string {
  if (typeof binding !== "string" || !binding || binding.length > 40) return false;
  try {
    const parts = bindingParts(binding);
    const key = normalizedKey(parts.key);
    if (!key || RESERVED_KEYS.has(key)) return false;
    return parts.key.length === 1 ? parts.key.trim() !== "" : NAMED_KEYS.has(key);
  } catch {
    return false;
  }
}

function configurable(command: CommandDefinition): boolean {
  return command.configurable !== false && !command.local;
}

export function effectiveBindings(command: CommandDefinition): readonly string[] {
  return configurable(command) && overrides[command.id] ? overrides[command.id]! : command.bindings;
}

// saved values come from a settings file, so anything unknown or unusable is left out
export function setShortcutOverrides(value: unknown): void {
  const clean: Record<string, readonly string[]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const command of COMMANDS) {
      const saved = (value as Record<string, unknown>)[command.id];
      if (!configurable(command) || !Array.isArray(saved) || saved.length > 3) continue;
      if (!saved.every(isAssignableBinding)) continue;
      clean[command.id] = Object.freeze([...new Set(saved)]);
    }
  }
  overrides = Object.freeze(clean);
  effectiveSections = freezeTree(commandSections(COMMANDS, effectiveBindings));
  changeListeners.forEach((listener) => listener());
}

export function shortcutOverrides(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(overrides).map(([id, keys]) => [id, [...keys]]));
}

export function currentSections(): readonly GuideSection[] {
  return effectiveSections;
}

export function onShortcutsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export interface EditableCommand {
  id: string;
  label: string;
  category: string;
  bindings: readonly string[];
  defaults: readonly string[];
  changed: boolean;
}

export function editableCommands(): EditableCommand[] {
  return COMMANDS.filter(configurable).map((command) => ({
    id: command.id,
    label: command.editLabel || command.label || command.id,
    category: command.category || "General",
    bindings: effectiveBindings(command),
    defaults: command.bindings,
    changed: !!overrides[command.id],
  }));
}

// the shortcut a key press makes, written the way bindings are stored; null for a lone modifier
export function bindingFromEvent(event: KeyboardEventLike): string | null {
  const raw = String(event.key || "");
  if (!raw || MODIFIER_KEYS.has(raw.toLowerCase())) return null;
  const key = raw === " " || raw === "Spacebar" ? "Space" : raw.length === 1 ? raw.toUpperCase() : raw;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  // Shift is part of the character itself for punctuation such as ? and +
  if (event.shiftKey && (raw.length > 1 || /[a-z0-9]/i.test(raw))) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

export function sameBinding(a: string, b: string): boolean {
  try {
    const x = bindingParts(a);
    const y = bindingParts(b);
    return x.ctrl === y.ctrl && x.alt === y.alt && x.shift === y.shift && x.meta === y.meta
      && normalizedKey(x.key) === normalizedKey(y.key);
  } catch {
    return false;
  }
}

// commands that already answer to `binding`; local handlers such as the trim nudge are left out
export function commandsUsing(binding: string, exceptId = ""): EditableCommand[] {
  return editableCommands().filter((command) =>
    command.id !== exceptId && command.bindings.some((existing) => sameBinding(existing, binding)));
}

// the keycaps shown for one binding, for example ["Ctrl", "Shift", "Z"]
export function bindingKeys(binding: string): string[] {
  return displayBinding(binding);
}

export function displayShortcut(bindings: readonly string[]): string {
  return bindings.map((binding) => displayBinding(binding).join("+")).join(" or ");
}

// the aria-keyshortcuts form, for example "Control+Shift+Z"
export function ariaShortcuts(bindings: readonly string[]): string {
  return bindings
    .map((binding) => {
      const parts = bindingParts(binding);
      const keys: string[] = [];
      if (parts.ctrl) keys.push("Control");
      if (parts.alt) keys.push("Alt");
      if (parts.shift) keys.push("Shift");
      if (parts.meta) keys.push("Meta");
      keys.push(parts.key);
      return keys.join("+");
    })
    .join(" ");
}

export function commandBindings(id: string): readonly string[] {
  const command = COMMANDS.find((item) => item.id === id);
  return command ? effectiveBindings(command) : [];
}

// "Add segment (A)", or just the label when the user removed every key
export function withShortcut(label: string, id: string): string {
  const keys = displayShortcut(commandBindings(id));
  return keys ? `${label} (${keys})` : label;
}

// buttons name the commands they run, so their tooltip and announced keys follow the user's keys
export function syncShortcutHints(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-shortcut-commands]")) {
    const ids = (element.dataset.shortcutCommands || "").split(/\s+/).filter(Boolean);
    const bindings = ids.flatMap((id) => commandBindings(id));
    if (bindings.length) element.setAttribute("aria-keyshortcuts", ariaShortcuts(bindings));
    else element.removeAttribute("aria-keyshortcuts");
    const label = element.dataset.shortcutLabel;
    if (label) element.dataset.tip = ids[0] ? withShortcut(label, ids[0]) : label;
  }
}

const registry = createRegistry(COMMANDS, effectiveBindings);

export const commands: readonly CommandDefinition[] = COMMANDS;
export const sections: readonly GuideSection[] = SECTIONS;
export const dispatch = registry.dispatch;
export const registerAction = registry.registerAction;

export function getShortcutsApi(): ShortcutsApi {
  return {
    bindingMarkup,
    bindingText,
    cleanupDialog,
    commands,
    createRegistry,
    dispatch,
    editorCommandsEnabled,
    escapeMarkup,
    keyboardRowsMarkup,
    matchesBinding,
    registerAction,
    sections,
    shouldUseSingleColumn,
    tabbableControls,
    search,
    shouldOpenGuide,
    spokenBindingText,
    resultLabel,
    sectionColumns,
    updateClearButton,
  };
}

export function installShortcuts(target: {
  TuckShortcuts?: ShortcutsApi;
}): ShortcutsApi {
  const api = getShortcutsApi();
  target.TuckShortcuts = api;
  return api;
}
