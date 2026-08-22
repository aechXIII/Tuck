const test = require("node:test");
const assert = require("node:assert/strict");

const shortcuts = require("../../tuck/web/shortcuts.js");

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

  assert.equal(shortcuts.search(shortcuts.sections, "").total, 12);
  assert.match(markup, /class="kbs-key"[^>]*data-k="del"[^>]*>Del<\/div>/);
  assert.match(markup, /class="kbs-key"[^>]*>PgUp<\/div>/);
  assert.doesNotMatch(markup, /kbs-key-(?:util|live)/);
});
