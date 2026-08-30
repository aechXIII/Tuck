const test = require("node:test");
const assert = require("node:assert/strict");

const shortcuts = require("../../frontend/public/legacy/shortcuts.js");

const ITEMS = [
  {
    cat: "General",
    items: [
      { label: "Add videos", keys: "Ctrl O", ids: ["ctrl", "o"] },
      { label: "Close dialog", keys: "Esc", ids: ["esc"] },
    ],
  },
  {
    cat: "Edit",
    items: [{ label: "Undo", keys: "Ctrl Z", ids: ["ctrl", "z"] }],
  },
];

function keyEvent(key, modifiers = {}) {
  return {
    key,
    ctrlKey: !!modifiers.ctrlKey,
    shiftKey: !!modifiers.shiftKey,
    altKey: !!modifiers.altKey,
    metaKey: !!modifiers.metaKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

test("production commands are the source of the existing shortcut guide", () => {
  const commandIds = shortcuts.commands.map((command) => command.id);
  const defaultBindings = Object.fromEntries(
    shortcuts.commands.map((command) => [command.id, command.bindings]),
  );

  assert.equal(new Set(commandIds).size, commandIds.length);
  assert.deepEqual(defaultBindings, {
    "file.add-videos": ["Ctrl+O"],
    "settings.open": ["Ctrl+,"],
    "app.exit": ["Ctrl+Q"],
    "ui.dismiss": ["Escape"],
    "edit.undo": ["Ctrl+Z"],
    "edit.redo": ["Ctrl+Shift+Z", "Ctrl+Y"],
    "playback.toggle": ["Space"],
    "playback.step-backward": ["ArrowLeft"],
    "playback.step-forward": ["ArrowRight"],
    "playback.seek-backward": ["Shift+ArrowLeft"],
    "playback.seek-forward": ["Shift+ArrowRight"],
    "playback.seek-start": ["Ctrl+ArrowLeft"],
    "playback.seek-end": ["Ctrl+ArrowRight"],
    "media.select-previous": ["ArrowUp"],
    "media.select-next": ["ArrowDown"],
    "timeline.add-segment": ["A"],
    "timeline.split": ["S"],
    "audio.toggle-fragment-mute": ["M"],
    "edit.delete-selection": ["Delete", "Backspace"],
    "timeline.set-selection-start": ["I"],
    "timeline.set-selection-end": ["O"],
    "timeline.zoom-in": ["Ctrl+="],
    "timeline.zoom-out": ["Ctrl+-"],
    "timeline.fit": ["Ctrl+0"],
    "timeline.adjust-trim-backward": ["ArrowLeft"],
    "timeline.adjust-trim-forward": ["ArrowRight"],
    "help.shortcuts": ["?", "Ctrl+/"],
  });
  assert.deepEqual(
    shortcuts.sections.map((section) => ({
      category: section.cat,
      column: section.column,
      items: section.items.map((item) => ({
        label: item.label,
        bindings: shortcuts.bindingText(item.keys),
      })),
    })),
    [
      {
        category: "General",
        column: 0,
        items: [
          { label: "Add videos", bindings: "Ctrl + O" },
          { label: "Open settings", bindings: "Ctrl + ," },
          { label: "Exit Tuck", bindings: "Ctrl + Q" },
          { label: "Close dialog", bindings: "Esc" },
        ],
      },
      {
        category: "Edit",
        column: 1,
        items: [
          { label: "Undo", bindings: "Ctrl + Z" },
          {
            label: "Redo",
            bindings: "Ctrl + Shift + Z or Ctrl + Y",
          },
        ],
      },
      {
        category: "Playback & navigation",
        column: 0,
        items: [
          { label: "Play / pause", bindings: "Space" },
          {
            label: "Previous / next frame",
            bindings: "← or →",
          },
          {
            label: "Skip 3 seconds",
            bindings: "Shift + ← or Shift + →",
          },
          {
            label: "Go to beginning / end",
            bindings: "Ctrl + ← or Ctrl + →",
          },
          {
            label: "Previous / next Library video",
            bindings: "↑ or ↓",
          },
        ],
      },
      {
        category: "Timeline & segments",
        column: 1,
        items: [
          { label: "Add segment", bindings: "A" },
          { label: "Split at playhead", bindings: "S" },
          { label: "Mute / unmute fragment", bindings: "M" },
          { label: "Delete selected item", bindings: "Delete or Backspace" },
          { label: "Set selected start / end", bindings: "I or O" },
          {
            label: "Zoom timeline in / out",
            bindings: "Ctrl + = or Ctrl + -",
          },
          { label: "Fit timeline", bindings: "Ctrl + 0" },
        ],
      },
    ],
  );
});

test("dispatchable default bindings do not conflict", () => {
  const seen = new Map();

  shortcuts.commands
    .filter((command) => !command.local)
    .forEach((command) =>
      command.bindings.forEach((binding) => {
        assert.equal(
          seen.has(binding),
          false,
          `${binding} is assigned to ${seen.get(binding)} and ${command.id}`,
        );
        seen.set(binding, command.id);
      }),
    );
});

test("grouped shortcut commands share one guide label", () => {
  const labelsByGroup = new Map();
  shortcuts.commands.forEach((command) => {
    if (!command.guideGroup) return;
    if (!labelsByGroup.has(command.guideGroup))
      labelsByGroup.set(command.guideGroup, new Set());
    labelsByGroup.get(command.guideGroup).add(command.label);
  });

  labelsByGroup.forEach((labels, group) => {
    assert.equal(labels.size, 1, `${group} has inconsistent labels`);
  });
});

test("production command metadata and derived guide sections are immutable", () => {
  assert.equal(Object.isFrozen(shortcuts.commands), true);
  assert.equal(Object.isFrozen(shortcuts.commands[0]), true);
  assert.equal(Object.isFrozen(shortcuts.commands[0].bindings), true);
  assert.equal(Object.isFrozen(shortcuts.sections), true);
  assert.equal(Object.isFrozen(shortcuts.sections[0].items), true);
  assert.throws(() => shortcuts.commands[0].bindings.push("Alt+O"), TypeError);
});

test("binding matching requires exact modifiers", () => {
  assert.equal(shortcuts.matchesBinding(keyEvent("o", { ctrlKey: true }), "Ctrl+O"), true);
  assert.equal(
    shortcuts.matchesBinding(
      keyEvent("o", { ctrlKey: true, shiftKey: true }),
      "Ctrl+O",
    ),
    false,
  );
  assert.equal(shortcuts.matchesBinding(keyEvent("S"), "S"), true);
  assert.equal(shortcuts.matchesBinding(keyEvent("S", { altKey: true }), "S"), false);
  assert.equal(shortcuts.matchesBinding(keyEvent("?", { shiftKey: true }), "?"), true);
});

test("a registry validates action registration", () => {
  const registry = shortcuts.createRegistry([
    { id: "test.run", bindings: ["R"], context: "editor" },
  ]);

  assert.throws(() => registry.registerAction("missing", () => {}), /Unknown command/);
  registry.registerAction("test.run", () => {});
  assert.throws(
    () => registry.registerAction("test.run", () => {}),
    /already registered/,
  );
});

test("dispatch executes one enabled matching command and prevents the browser default", () => {
  const registry = shortcuts.createRegistry([
    { id: "first", bindings: ["R"], context: "editor" },
    { id: "second", bindings: ["R"], context: "editor" },
  ]);
  const calls = [];
  registry.registerAction("first", {
    enabled: () => true,
    execute: () => calls.push("first"),
  });
  registry.registerAction("second", () => calls.push("second"));
  const event = keyEvent("r");

  assert.equal(
    registry.dispatch(event, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
    }),
    "first",
  );
  assert.deepEqual(calls, ["first"]);
  assert.equal(event.defaultPrevented, true);
});

test("dispatch leaves unavailable and unregistered commands to the focused control", () => {
  const registry = shortcuts.createRegistry([
    { id: "disabled", bindings: ["D"], context: "editor-no-entry" },
    { id: "unregistered", bindings: ["U"], context: "editor" },
  ]);
  registry.registerAction("disabled", {
    enabled: () => false,
    execute: () => assert.fail("disabled command executed"),
  });
  const disabledEvent = keyEvent("d");
  const unregisteredEvent = keyEvent("u");

  assert.equal(
    registry.dispatch(disabledEvent, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
    }),
    null,
  );
  assert.equal(
    registry.dispatch(unregisteredEvent, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
    }),
    null,
  );
  assert.equal(disabledEvent.defaultPrevented, false);
  assert.equal(unregisteredEvent.defaultPrevented, false);
});

test("dispatch ignores keyboard events already handled by a local control", () => {
  const registry = shortcuts.createRegistry([
    { id: "seek.backward", bindings: ["ArrowLeft"], context: "editor" },
  ]);
  let calls = 0;
  registry.registerAction("seek.backward", () => calls++);
  const event = keyEvent("ArrowLeft");
  event.preventDefault();

  assert.equal(
    registry.dispatch(event, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
    }),
    null,
  );
  assert.equal(calls, 0);
});

test("editor commands are unavailable while a modal or Settings is open", () => {
  const registry = shortcuts.createRegistry([
    { id: "editor.run", bindings: ["R"], context: "editor" },
  ]);
  let calls = 0;
  registry.registerAction("editor.run", () => calls++);

  assert.equal(
    registry.dispatch(keyEvent("r"), {
      modalOpen: true,
      settingsOpen: false,
      formControlFocused: false,
    }),
    null,
  );
  assert.equal(
    registry.dispatch(keyEvent("r"), {
      modalOpen: false,
      settingsOpen: true,
      formControlFocused: false,
    }),
    null,
  );
  assert.equal(calls, 0);
});

test("global commands can dismiss an open surface", () => {
  const registry = shortcuts.createRegistry([
    { id: "ui.dismiss", bindings: ["Escape"], context: "global" },
  ]);
  let calls = 0;
  registry.registerAction("ui.dismiss", () => calls++);

  assert.equal(
    registry.dispatch(keyEvent("Escape"), {
      modalOpen: true,
      settingsOpen: false,
      formControlFocused: false,
    }),
    "ui.dismiss",
  );
  assert.equal(calls, 1);
});

test("editor-no-entry commands do not fire from form controls", () => {
  const registry = shortcuts.createRegistry([
    { id: "timeline.split", bindings: ["S"], context: "editor-no-entry" },
  ]);
  let calls = 0;
  registry.registerAction("timeline.split", () => calls++);
  const event = keyEvent("s");

  assert.equal(
    registry.dispatch(event, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: true,
    }),
    null,
  );
  assert.equal(calls, 0);
  assert.equal(event.defaultPrevented, false);
});

test("text-entry suppression still allows the shortcut guide from buttons", () => {
  const registry = shortcuts.createRegistry([
    {
      id: "help.shortcuts",
      bindings: ["?"],
      context: "editor-no-text-entry",
    },
  ]);
  let calls = 0;
  registry.registerAction("help.shortcuts", () => calls++);

  assert.equal(
    registry.dispatch(keyEvent("?", { shiftKey: true }), {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: true,
      textEntryFocused: false,
    }),
    "help.shortcuts",
  );
  assert.equal(
    registry.dispatch(keyEvent("?", { shiftKey: true }), {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: true,
      textEntryFocused: true,
    }),
    null,
  );
  assert.equal(calls, 1);
});

test("production editor shortcuts override button focus but preserve text entry", () => {
  const command = shortcuts.commands.find(
    (candidate) => candidate.id === "playback.toggle",
  );
  const registry = shortcuts.createRegistry([command]);
  let calls = 0;
  registry.registerAction("playback.toggle", () => calls++);

  const buttonEvent = keyEvent(" ");
  assert.equal(
    registry.dispatch(buttonEvent, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: true,
      textEntryFocused: false,
    }),
    "playback.toggle",
  );
  assert.equal(buttonEvent.defaultPrevented, true);

  const inputEvent = keyEvent(" ");
  assert.equal(
    registry.dispatch(inputEvent, {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: true,
      textEntryFocused: true,
    }),
    null,
  );
  assert.equal(inputEvent.defaultPrevented, false);
  assert.equal(calls, 1);
});

test("shortcut search returns only matching sections and keyboard keys", () => {
  assert.deepEqual(shortcuts.search(ITEMS, "undo"), {
    query: "undo",
    total: 3,
    matched: 1,
    sections: [
      {
        cat: "Edit",
        items: [{ label: "Undo", keys: "Ctrl Z", ids: ["ctrl", "z"] }],
      },
    ],
    keyIds: ["ctrl", "z"],
  });
});

test("blank shortcut search returns the complete guide", () => {
  const result = shortcuts.search(ITEMS, "   ");

  assert.equal(result.query, "");
  assert.equal(result.total, 3);
  assert.equal(result.matched, 3);
  assert.deepEqual(result.sections, ITEMS);
  assert.deepEqual(result.keyIds, ["ctrl", "o", "esc", "z"]);
});

test("shortcut result labels use natural singular and plural wording", () => {
  assert.equal(shortcuts.resultLabel("", 3, 3), "3 shortcuts");
  assert.equal(shortcuts.resultLabel("undo", 1, 3), "1 result");
  assert.equal(shortcuts.resultLabel("missing", 0, 3), "0 results");
  assert.equal(shortcuts.resultLabel("audio", 2, 3), "2 results");
});

test("structured key bindings produce clear visual and spoken labels", () => {
  const bindings = [
    ["Ctrl", "Shift", "Z"],
    ["Ctrl", "Y"],
  ];

  assert.equal(
    shortcuts.bindingText(bindings),
    "Ctrl + Shift + Z or Ctrl + Y",
  );
  assert.equal(
    shortcuts.spokenBindingText(bindings),
    "Control plus Shift plus Z or Control plus Y",
  );
  assert.equal(
    shortcuts.spokenBindingText([["Shift", "←"], ["Shift", "→"]]),
    "Shift plus Left arrow or Shift plus Right arrow",
  );
  assert.equal(
    shortcuts.spokenBindingText([["Ctrl", ","]]),
    "Control plus comma",
  );
  assert.equal(
    shortcuts.bindingMarkup([["Ctrl", "Q"]]),
    '<span class="kbs-chord"><kbd>Ctrl</kbd><span class="kbs-plus">+</span><kbd>Q</kbd></span>',
  );
  assert.equal(
    shortcuts.bindingMarkup([["←"], ["→"]]),
    '<span class="kbs-chord"><kbd>←</kbd></span><span class="kbs-or">or</span><span class="kbs-chord"><kbd>→</kbd></span>',
  );
});

test("shortcut search includes structured alternatives and usage notes", () => {
  const structuredItems = [
    {
      cat: "Edit",
      items: [
        {
          label: "Redo",
          keys: [
            ["Ctrl", "Shift", "Z"],
            ["Ctrl", "Y"],
          ],
          ids: ["ctrl", "shift", "z", "y"],
        },
        {
          label: "Adjust trim point",
          keys: [["←"], ["→"]],
          note: "Hold Shift for larger steps.",
          ids: ["left", "right", "shift"],
        },
      ],
    },
  ];
  const labelsFor = (query) =>
    shortcuts
      .search(structuredItems, query)
      .sections.flatMap((section) => section.items.map((item) => item.label));

  assert.deepEqual(labelsFor("ctrl+y"), ["Redo"]);
  assert.deepEqual(labelsFor("control+y"), ["Redo"]);
  assert.deepEqual(labelsFor("larger steps"), ["Adjust trim point"]);
});

test("focused searches highlight a real chord instead of merging alternatives", () => {
  const redo = [
    {
      cat: "Edit",
      items: [
        {
          label: "Redo",
          keys: [
            ["Ctrl", "Shift", "Z"],
            ["Ctrl", "Y"],
          ],
          ids: ["ctrl", "shift", "z", "y"],
        },
      ],
    },
  ];

  assert.deepEqual(shortcuts.search(redo, "redo").keyIds, [
    "ctrl",
    "shift",
    "z",
  ]);
  assert.deepEqual(shortcuts.search(redo, "ctrl+y").keyIds, ["ctrl", "y"]);
  assert.deepEqual(shortcuts.search(redo, "control+y").keyIds, ["ctrl", "y"]);
});

test("only focused shortcut searches use a single result column", () => {
  assert.equal(shortcuts.shouldUseSingleColumn("", 12, 2), false);
  assert.equal(shortcuts.shouldUseSingleColumn("undo", 1, 1), true);
  assert.equal(shortcuts.shouldUseSingleColumn("edit", 2, 1), true);
  assert.equal(shortcuts.shouldUseSingleColumn("general", 4, 1), true);
  assert.equal(shortcuts.shouldUseSingleColumn("a", 10, 2), false);
  assert.equal(shortcuts.shouldUseSingleColumn("missing", 0, 0), false);
});

test("shortcut sections stack independently within their assigned columns", () => {
  const sections = [
    { cat: "General", column: 0 },
    { cat: "Edit", column: 1 },
    { cat: "Playback & navigation", column: 0 },
    { cat: "Timeline & segments", column: 1 },
  ];

  assert.deepEqual(shortcuts.sectionColumns(sections, false), [
    [sections[0], sections[2]],
    [sections[1], sections[3]],
  ]);
  assert.deepEqual(shortcuts.sectionColumns(sections, true), [sections]);
});

test("shortcut search recognizes common key names and chord punctuation", () => {
  const keyItems = [
    {
      cat: "Keys",
      items: [
        { label: "Add videos", keys: "Ctrl O", ids: ["ctrl", "o"] },
        { label: "Open settings", keys: "Ctrl ,", ids: ["ctrl", "comma"] },
        { label: "Close dialog", keys: "Esc", ids: ["esc"] },
        { label: "Seek", keys: "← →", ids: ["left", "right"] },
      ],
    },
  ];
  const labelsFor = (query) =>
    shortcuts
      .search(keyItems, query)
      .sections.flatMap((section) => section.items.map((item) => item.label));

  assert.deepEqual(labelsFor("ctrl+o"), ["Add videos"]);
  assert.deepEqual(labelsFor("comma"), ["Open settings"]);
  assert.deepEqual(labelsFor("escape"), ["Close dialog"]);
  assert.deepEqual(labelsFor("right arrow"), ["Seek"]);
});

class DialogShell extends EventTarget {
  constructor() {
    super();
    this.attributes = new Set();
  }

  setAttribute(name) {
    this.attributes.add(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

class ButtonShell {
  constructor() {
    this.attributes = new Set();
    this.classes = new Set(["kbs-clear", "is-hidden"]);
    this.classList = {
      toggle: (name, enabled) =>
        enabled ? this.classes.add(name) : this.classes.delete(name),
    };
    this.disabled = true;
    this.tabIndex = -1;
  }

  setAttribute(name) {
    this.attributes.add(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

test("clear control keeps its reserved slot while becoming interactive", () => {
  const button = new ButtonShell();

  shortcuts.updateClearButton(button, true);
  assert.equal(button.classes.has("is-hidden"), false);
  assert.equal(button.attributes.has("aria-hidden"), false);
  assert.equal(button.disabled, false);
  assert.equal(button.tabIndex, 0);

  shortcuts.updateClearButton(button, false);
  assert.equal(button.classes.has("is-hidden"), true);
  assert.equal(button.attributes.has("aria-hidden"), true);
  assert.equal(button.disabled, true);
  assert.equal(button.tabIndex, -1);
});

test("dialog tab order ignores its reserved hidden clear control", () => {
  const close = { disabled: false, tabIndex: 0, getAttribute: () => null };
  const search = { disabled: false, tabIndex: 0, getAttribute: () => null };
  const clear = {
    disabled: true,
    tabIndex: -1,
    getAttribute: (name) => (name === "aria-hidden" ? "true" : null),
  };
  const box = { querySelectorAll: () => [close, search, clear] };

  assert.deepEqual(shortcuts.tabbableControls(box), [close, search]);
});

test("replacing the shortcuts dialog clears its state without restoring stale focus", () => {
  const box = new DialogShell();
  let trapCalls = 0;
  let focusCalls = 0;
  const trap = () => trapCalls++;
  const returnFocus = { focus: () => focusCalls++ };
  box.addEventListener("keydown", trap);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "kbs-dialog-title");

  assert.equal(typeof shortcuts.cleanupDialog, "function");
  const nextReturnFocus = shortcuts.cleanupDialog(box, trap, returnFocus, false);
  box.dispatchEvent(new Event("keydown"));

  assert.equal(trapCalls, 0);
  assert.equal(box.hasAttribute("role"), false);
  assert.equal(box.hasAttribute("aria-modal"), false);
  assert.equal(box.hasAttribute("aria-labelledby"), false);
  assert.equal(focusCalls, 0);
  assert.equal(nextReturnFocus, null);
});

test("closing the shortcuts dialog restores focus", () => {
  const box = new DialogShell();
  let focusCalls = 0;

  assert.equal(typeof shortcuts.cleanupDialog, "function");
  shortcuts.cleanupDialog(box, () => {}, { focus: () => focusCalls++ }, true);

  assert.equal(focusCalls, 1);
});

test("question-mark shortcut opens from controls but not while typing", () => {
  assert.equal(typeof shortcuts.shouldOpenGuide, "function");
  assert.equal(
    shortcuts.shouldOpenGuide(
      { key: "?", ctrlKey: false, metaKey: false, altKey: false },
      { modalOpen: false, settingsOpen: false, textEntryFocused: false },
    ),
    true,
  );
  assert.equal(
    shortcuts.shouldOpenGuide(
      { key: "/", ctrlKey: true, metaKey: false, altKey: false },
      { modalOpen: false, settingsOpen: false, textEntryFocused: false },
    ),
    true,
  );
  assert.equal(
    shortcuts.shouldOpenGuide(
      { key: "?", ctrlKey: false, metaKey: false, altKey: false },
      { modalOpen: false, settingsOpen: false, textEntryFocused: true },
    ),
    false,
  );
});

test("editor shortcuts are disabled while a modal or settings page is open", () => {
  function documentWithState(modalOpen, settingsOpen) {
    return {
      body: {
        classList: { contains: (name) => name === "settings-open" && settingsOpen },
      },
      getElementById: (id) =>
        id === "mod-overlay"
          ? { classList: { contains: (name) => name === "open" && modalOpen } }
          : null,
    };
  }

  assert.equal(shortcuts.editorCommandsEnabled(documentWithState(false, false)), true);
  assert.equal(shortcuts.editorCommandsEnabled(documentWithState(true, false)), false);
  assert.equal(shortcuts.editorCommandsEnabled(documentWithState(false, true)), false);
});

test("the production guide renders every physical key with one base keycap style", () => {
  const markup = shortcuts.keyboardRowsMarkup();
  const renderedIds = new Set(
    Array.from(markup.matchAll(/data-k="([^"]+)"/g), (match) => match[1]),
  );
  const shortcutIds = new Set(
    shortcuts.sections.flatMap((section) =>
      section.items.flatMap((item) => item.ids),
    ),
  );

  assert.equal(shortcuts.search(shortcuts.sections, "").total, 18);
  assert.deepEqual(
    Array.from(shortcutIds).filter((id) => !renderedIds.has(id)),
    [],
  );
  assert.match(markup, /class="kbs-key"[^>]*data-k="del"[^>]*>Del<\/div>/);
  assert.match(markup, /class="kbs-key"[^>]*>PgUp<\/div>/);
  assert.doesNotMatch(markup, /kbs-key-(?:util|live)/);
});
