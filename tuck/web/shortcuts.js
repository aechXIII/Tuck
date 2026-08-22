(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TuckShortcuts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var KEY_ALIASES = {
    ctrl: "control",
    del: "delete",
    esc: "escape",
    left: "left arrow",
    right: "right arrow",
    up: "up arrow",
    down: "down arrow",
    space: "spacebar",
  };
  var SPOKEN_KEYS = {
    Ctrl: "Control",
    Esc: "Escape",
    ",": "comma",
    "←": "Left arrow",
    "→": "Right arrow",
    "↑": "Up arrow",
    "↓": "Down arrow",
  };
  var KEY_IDS = {
    Ctrl: "ctrl",
    Shift: "shift",
    Esc: "esc",
    Delete: "del",
    ",": "comma",
    Space: "space",
    "←": "left",
    "→": "right",
    "↑": "up",
    "↓": "down",
  };
  var COMMANDS = [
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
      context: "editor-no-entry",
    },
    {
      id: "edit.redo",
      category: "Edit",
      column: 1,
      label: "Redo",
      bindings: ["Ctrl+Shift+Z", "Ctrl+Y"],
      context: "editor-no-entry",
    },
    {
      id: "playback.toggle",
      category: "Playback & navigation",
      column: 0,
      label: "Play / pause",
      bindings: ["Space"],
      context: "editor-no-entry",
    },
    {
      id: "playback.seek-backward",
      category: "Playback & navigation",
      column: 0,
      label: "Skip back / forward 3 seconds",
      guideGroup: "playback.seek",
      guideHighlightAll: true,
      bindings: ["ArrowLeft"],
      context: "editor-no-entry",
    },
    {
      id: "playback.seek-forward",
      category: "Playback & navigation",
      column: 0,
      label: "Skip back / forward 3 seconds",
      guideGroup: "playback.seek",
      bindings: ["ArrowRight"],
      context: "editor-no-entry",
    },
    {
      id: "media.select-previous",
      category: "Playback & navigation",
      column: 0,
      label: "Select previous / next video",
      guideGroup: "media.select",
      guideHighlightAll: true,
      bindings: ["ArrowUp"],
      context: "editor-no-entry",
    },
    {
      id: "media.select-next",
      category: "Playback & navigation",
      column: 0,
      label: "Select previous / next video",
      guideGroup: "media.select",
      bindings: ["ArrowDown"],
      context: "editor-no-entry",
    },
    {
      id: "timeline.split",
      category: "Timeline & segments",
      column: 1,
      label: "Split at playhead",
      bindings: ["S"],
      context: "editor-no-entry",
    },
    {
      id: "audio.delete-selected",
      category: "Timeline & segments",
      column: 1,
      label: "Delete selected audio",
      bindings: ["Delete"],
      context: "editor-no-entry",
    },
    {
      id: "timeline.adjust-trim-backward",
      category: "Timeline & segments",
      column: 1,
      label: "Adjust trim point",
      guideGroup: "timeline.adjust-trim",
      guideNote: "Hold Shift for larger steps.",
      guideHighlightAll: true,
      guideIds: ["shift"],
      bindings: ["ArrowLeft"],
      local: true,
      configurable: false,
    },
    {
      id: "timeline.adjust-trim-forward",
      category: "Timeline & segments",
      column: 1,
      label: "Adjust trim point",
      guideGroup: "timeline.adjust-trim",
      bindings: ["ArrowRight"],
      local: true,
      configurable: false,
    },
    {
      id: "help.shortcuts",
      category: "General",
      column: 0,
      label: "Open keyboard shortcuts",
      bindings: ["?"],
      context: "editor-no-text-entry",
      guide: false,
    },
  ];

  var DISPLAY_KEYS = {
    Escape: "Esc",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };

  function bindingParts(binding) {
    var tokens = String(binding || "").split("+");
    var key = tokens.pop() || "";
    var parts = {
      alt: false,
      ctrl: false,
      meta: false,
      shift: false,
      key: key,
    };
    tokens.forEach(function (token) {
      var modifier = token.toLowerCase();
      if (modifier === "alt") parts.alt = true;
      else if (modifier === "ctrl" || modifier === "control") parts.ctrl = true;
      else if (modifier === "meta" || modifier === "cmd") parts.meta = true;
      else if (modifier === "shift") parts.shift = true;
      else throw new Error("Unknown shortcut modifier: " + token);
    });
    return parts;
  }

  function displayBinding(binding) {
    var parts = bindingParts(binding);
    var keys = [];
    if (parts.ctrl) keys.push("Ctrl");
    if (parts.meta) keys.push("Meta");
    if (parts.alt) keys.push("Alt");
    if (parts.shift) keys.push("Shift");
    keys.push(DISPLAY_KEYS[parts.key] || parts.key);
    return keys;
  }

  function commandSections(commands) {
    var sections = [];
    var sectionByCategory = {};
    var itemByGroup = {};

    (commands || []).forEach(function (command) {
      if (command.guide === false) return;
      var category = command.category;
      if (!category) return;
      var section = sectionByCategory[category];
      if (!section) {
        section = {
          cat: category,
          column: command.column === 1 ? 1 : 0,
          items: [],
        };
        sectionByCategory[category] = section;
        sections.push(section);
      }

      var group = command.guideGroup || command.id;
      var item = itemByGroup[group];
      if (!item) {
        item = {
          label: command.label,
          keys: [],
          ids: (command.guideIds || []).slice(),
        };
        if (command.guideNote) item.note = command.guideNote;
        if (command.guideHighlightAll) item.highlightAll = true;
        itemByGroup[group] = item;
        section.items.push(item);
      }

      (command.bindings || []).forEach(function (binding) {
        var keys = displayBinding(binding);
        item.keys.push(keys);
        keys.forEach(function (key) {
          var id = keyId(key);
          if (id && item.ids.indexOf(id) < 0) item.ids.push(id);
        });
      });
    });

    return sections;
  }

  function freezeTree(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value))
      return value;
    Object.keys(value).forEach(function (key) {
      freezeTree(value[key]);
    });
    return Object.freeze(value);
  }

  var SECTIONS = commandSections(COMMANDS);
  freezeTree(COMMANDS);
  freezeTree(SECTIONS);

  function normalizedKey(key) {
    var aliases = {
      " ": "space",
      Spacebar: "space",
      Esc: "escape",
      Del: "delete",
      Left: "arrowleft",
      Right: "arrowright",
      Up: "arrowup",
      Down: "arrowdown",
    };
    return String(aliases[key] || key || "").toLowerCase();
  }

  function matchesBinding(event, binding) {
    if (!event) return false;
    var parts = bindingParts(binding);
    var eventShift = !!event.shiftKey;
    if (
      !parts.shift &&
      eventShift &&
      String(event.key || "").length === 1 &&
      !/[a-z0-9]/i.test(event.key)
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

  function commandAvailable(command, state) {
    var context = command.context || "editor";
    var current = state || {};
    if (
      context !== "global" &&
      (current.modalOpen || current.settingsOpen)
    )
      return false;
    if (context === "editor-no-entry" && current.formControlFocused)
      return false;
    if (context === "editor-no-text-entry" && current.textEntryFocused)
      return false;
    return true;
  }

  function createRegistry(commands) {
    var definitions = commands || [];
    var commandById = {};
    var actions = {};
    definitions.forEach(function (command) {
      if (!command.id || commandById[command.id])
        throw new Error("Duplicate or missing command id: " + command.id);
      commandById[command.id] = command;
    });

    function registerAction(id, action) {
      if (!commandById[id]) throw new Error("Unknown command: " + id);
      if (actions[id]) throw new Error("Action already registered: " + id);
      var registration =
        typeof action === "function" ? { execute: action } : action;
      if (!registration || typeof registration.execute !== "function")
        throw new Error("Command action must provide execute(): " + id);
      actions[id] = registration;
    }

    function dispatch(event, state) {
      if (event && event.defaultPrevented) return null;
      for (var i = 0; i < definitions.length; i++) {
        var command = definitions[i];
        if (command.local || !commandAvailable(command, state)) continue;
        if (
          !(command.bindings || []).some(function (binding) {
            return matchesBinding(event, binding);
          })
        )
          continue;
        var action = actions[command.id];
        if (!action) continue;
        if (
          typeof action.enabled === "function" &&
          !action.enabled(event, state || {})
        )
          continue;
        if (event && typeof event.preventDefault === "function")
          event.preventDefault();
        action.execute(event, state || {});
        return command.id;
      }
      return null;
    }

    return { dispatch: dispatch, registerAction: registerAction };
  }
  var KEYBOARD_LAYOUT = [
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
      [34, "0"],
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
      [34, "I"],
      [34, "O", "o"],
      [34, "P"],
      [34, "["],
      [34, "]"],
      [53, "\\"],
      [34, "PgUp"],
    ],
    [
      [63, "Caps"],
      [34, "A"],
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
      [34, "M"],
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

  function bindingGroups(keys) {
    if (!Array.isArray(keys)) return keys ? [[String(keys)]] : [];
    if (!keys.length) return [];
    return Array.isArray(keys[0]) ? keys : [keys];
  }

  function bindingText(keys) {
    return bindingGroups(keys)
      .map(function (chord) {
        return chord.join(" + ");
      })
      .join(" or ");
  }

  function spokenBindingText(keys) {
    return bindingGroups(keys)
      .map(function (chord) {
        return chord
          .map(function (key) {
            return SPOKEN_KEYS[key] || key;
          })
          .join(" plus ");
      })
      .join(" or ");
  }

  function escapeMarkup(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function bindingMarkup(keys) {
    return bindingGroups(keys)
      .map(function (chord) {
        var keycaps = chord
          .map(function (key) {
            return "<kbd>" + escapeMarkup(key) + "</kbd>";
          })
          .join('<span class="kbs-plus">+</span>');
        return '<span class="kbs-chord">' + keycaps + "</span>";
      })
      .join('<span class="kbs-or">or</span>');
  }

  function normalize(value) {
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

  function searchableText(section, item) {
    var terms = [
      section.cat,
      item.label,
      bindingText(item.keys),
      spokenBindingText(item.keys),
      item.note,
    ];
    (item.ids || []).forEach(function (id) {
      terms.push(id);
      if (KEY_ALIASES[id]) terms.push(KEY_ALIASES[id]);
    });
    return normalize(terms.join(" "));
  }

  function keyId(key) {
    if (KEY_IDS[key]) return KEY_IDS[key];
    return /^[a-z0-9]$/i.test(key) ? key.toLowerCase() : null;
  }

  function highlightedKeyIds(item, query) {
    var groups = bindingGroups(item.keys);
    var selected = groups;
    if (query) {
      var matches = groups.filter(function (chord) {
        return (
          normalize(bindingText([chord])).indexOf(query) >= 0 ||
          normalize(spokenBindingText([chord])).indexOf(query) >= 0
        );
      });
      selected = matches.length
        ? matches
        : item.highlightAll
          ? groups
          : groups.slice(0, 1);
    }

    var ids = [];
    selected.forEach(function (chord) {
      chord.forEach(function (key) {
        var id = keyId(key);
        if (id && ids.indexOf(id) < 0) ids.push(id);
      });
    });
    return ids.length ? ids : item.ids || [];
  }

  function search(sections, value) {
    var query = normalize(value);
    var total = 0;
    var matched = 0;
    var keyIds = [];
    var seenKeyIds = {};
    var filteredSections = [];

    (sections || []).forEach(function (section) {
      var items = (section.items || []).filter(function (item) {
        total++;
        var matches =
          !query || searchableText(section, item).indexOf(query) >= 0;
        if (!matches) return false;

        matched++;
        highlightedKeyIds(item, query).forEach(function (id) {
          if (seenKeyIds[id]) return;
          seenKeyIds[id] = true;
          keyIds.push(id);
        });
        return true;
      });

      if (items.length) {
        var filteredSection = { cat: section.cat, items: items };
        if (section.column != null) filteredSection.column = section.column;
        filteredSections.push(filteredSection);
      }
    });

    return {
      query: query,
      total: total,
      matched: matched,
      sections: filteredSections,
      keyIds: keyIds,
    };
  }

  function resultLabel(query, matched, total) {
    if (!query) return total + " shortcuts";
    return matched + (matched === 1 ? " result" : " results");
  }

  function shouldUseSingleColumn(query, matched, populatedColumns) {
    return (
      !!query &&
      matched > 0 &&
      (matched <= 2 || populatedColumns === 1)
    );
  }

  function sectionColumns(sections, singleColumn) {
    var list = sections || [];
    if (singleColumn) return [list];
    var columns = [[], []];
    list.forEach(function (section) {
      columns[section.column === 1 ? 1 : 0].push(section);
    });
    return columns.filter(function (column) {
      return column.length;
    });
  }

  function updateClearButton(button, visible) {
    if (!button) return;
    button.classList.toggle("is-hidden", !visible);
    if (visible) button.removeAttribute("aria-hidden");
    else button.setAttribute("aria-hidden", "true");
    button.disabled = !visible;
    button.tabIndex = visible ? 0 : -1;
  }

  function tabbableControls(box) {
    if (!box) return [];
    return Array.prototype.filter.call(
      box.querySelectorAll("button, input"),
      function (control) {
        return (
          !control.disabled &&
          control.tabIndex !== -1 &&
          control.getAttribute("aria-hidden") !== "true"
        );
      },
    );
  }

  function cleanupDialog(box, focusTrap, returnFocus, restoreFocus) {
    if (box) {
      box.removeEventListener("keydown", focusTrap);
      box.removeAttribute("role");
      box.removeAttribute("aria-modal");
      box.removeAttribute("aria-labelledby");
    }
    if (restoreFocus && returnFocus && typeof returnFocus.focus === "function") {
      returnFocus.focus();
    }
    return null;
  }

  function editorCommandsEnabled(doc) {
    if (!doc) return true;
    var overlay = doc.getElementById && doc.getElementById("mod-overlay");
    var modalOpen = !!(
      overlay &&
      overlay.classList &&
      overlay.classList.contains("open")
    );
    var settingsOpen = !!(
      doc.body &&
      doc.body.classList &&
      doc.body.classList.contains("settings-open")
    );
    return !modalOpen && !settingsOpen;
  }

  function keyboardRowsMarkup() {
    return KEYBOARD_LAYOUT.map(function (row) {
      var keys = row
        .map(function (key) {
          var id = key[2];
          var attr = id ? ' data-k="' + id + '"' : "";
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

  function shouldOpenGuide(event, state) {
    return !!(
      event &&
      event.key === "?" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      state &&
      !state.modalOpen &&
      !state.settingsOpen &&
      !state.textEntryFocused
    );
  }

  var registry = createRegistry(COMMANDS);

  return {
    bindingMarkup: bindingMarkup,
    bindingText: bindingText,
    cleanupDialog: cleanupDialog,
    commands: COMMANDS,
    createRegistry: createRegistry,
    dispatch: registry.dispatch,
    editorCommandsEnabled: editorCommandsEnabled,
    escapeMarkup: escapeMarkup,
    keyboardRowsMarkup: keyboardRowsMarkup,
    matchesBinding: matchesBinding,
    registerAction: registry.registerAction,
    sections: SECTIONS,
    shouldUseSingleColumn: shouldUseSingleColumn,
    tabbableControls: tabbableControls,
    search: search,
    shouldOpenGuide: shouldOpenGuide,
    spokenBindingText: spokenBindingText,
    resultLabel: resultLabel,
    sectionColumns: sectionColumns,
    updateClearButton: updateClearButton,
  };
});

(function (root) {
  "use strict";

  if (!root || !root.document || !root.TuckShortcuts) return;

  var shortcuts = root.TuckShortcuts;
  var returnFocus = null;

  function byId(id) {
    return root.document.getElementById(id);
  }

  function commandState(event) {
    var target = (event && event.target) || root.document.activeElement;
    var textEntryFocused = !!(
      target &&
      ((typeof target.matches === "function" &&
        target.matches("input, select, textarea")) ||
        target.isContentEditable)
    );
    var formControlFocused = !!(
      target &&
      ((typeof target.matches === "function" &&
        target.matches("input, select, textarea, button")) ||
        target.isContentEditable)
    );
    var overlay = byId("mod-overlay");
    return {
      modalOpen: !!(
        overlay &&
        overlay.classList &&
        overlay.classList.contains("open")
      ),
      settingsOpen: !!(
        root.document.body &&
        root.document.body.classList.contains("settings-open")
      ),
      formControlFocused: formControlFocused,
      textEntryFocused: textEntryFocused,
    };
  }

  function dispatchCommand(event) {
    shortcuts.dispatch(event, commandState(event));
  }

  function dialogMarkup() {
    return `<div class="kbs-dialog-header">
      <div>
        <h2 id="kbs-dialog-title">Keyboard shortcuts</h2>
        <p>Browse the keyboard or search by action and key.</p>
      </div>
      <button type="button" class="kbs-close" onclick="closeMod()" aria-label="Close keyboard shortcuts">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"></path></svg>
      </button>
    </div>
    <div class="kbs-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5"></circle><line x1="10" y1="10" x2="14" y2="14"></line></svg>
      <input type="search" id="kbs-search-input" aria-label="Search keyboard shortcuts" placeholder="Search actions or keys…" autocomplete="off" spellcheck="false" oninput="filterShortcuts(this.value)" />
      <button type="button" class="kbs-clear is-hidden" id="kbs-search-clear" onclick="clearShortcutSearch()" aria-label="Clear search" aria-hidden="true" disabled tabindex="-1">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>
      </button>
      <span id="kbs-match-count" aria-live="polite"></span>
    </div>
    <div class="kbs-keyboard" aria-hidden="true">${shortcuts.keyboardRowsMarkup()}</div>
    <div class="kbs-grid" id="kbs-grid"></div>`;
  }

  function renderResults(query) {
    var grid = byId("kbs-grid");
    if (!grid) return;

    var result = shortcuts.search(shortcuts.sections, query);
    var sourceColumns = shortcuts.sectionColumns(result.sections, false);
    var singleColumn = shortcuts.shouldUseSingleColumn(
      result.query,
      result.matched,
      sourceColumns.length,
    );
    var html = "";
    var lit = {};

    result.keyIds.forEach(function (id) {
      lit[id] = true;
    });
    shortcuts.sectionColumns(result.sections, singleColumn).forEach(function (
      column,
    ) {
      html += '<div class="kbs-column">';
      column.forEach(function (section) {
        html +=
          '<section class="kbs-section"><h3 class="kbs-cat">' +
          shortcuts.escapeMarkup(section.cat) +
          "</h3>";
        section.items.forEach(function (item) {
          var note = item.note
            ? '<span class="kbs-note">' +
              shortcuts.escapeMarkup(item.note) +
              "</span>"
            : "";
          html +=
            '<div class="kbs-row"><span class="kbs-action"><span>' +
            shortcuts.escapeMarkup(item.label) +
            "</span>" +
            note +
            '</span><span class="kbs-keys"><span class="kbs-sr-label">' +
            shortcuts.escapeMarkup(shortcuts.spokenBindingText(item.keys)) +
            '</span><span class="kbs-bindings" aria-hidden="true">' +
            shortcuts.bindingMarkup(item.keys) +
            "</span></span></div>";
        });
        html += "</section>";
      });
      html += "</div>";
    });

    grid.innerHTML =
      html ||
      '<div class="kbs-empty"><strong>No shortcuts found</strong><span>Try another action or key.</span></div>';
    var count = byId("kbs-match-count");
    if (count)
      count.textContent = shortcuts.resultLabel(
        result.query,
        result.matched,
        result.total,
      );
    shortcuts.updateClearButton(byId("kbs-search-clear"), !!result.query);
    var box = byId("mod-box");
    if (box) box.classList.toggle("is-single-column", singleColumn);
    var keys = root.document.querySelectorAll(".kbs-key[data-k]");
    for (var i = 0; i < keys.length; i++) {
      keys[i].classList.toggle("lit", !!lit[keys[i].dataset.k]);
    }
  }

  function clearSearch() {
    var input = byId("kbs-search-input");
    if (!input) return;
    input.value = "";
    renderResults("");
    input.focus();
  }

  function trapFocus(event) {
    if (event.key !== "Tab") return;
    var focusable = shortcuts.tabbableControls(byId("mod-box"));
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && root.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && root.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function resetDialog(restoreFocus) {
    returnFocus = shortcuts.cleanupDialog(
      byId("mod-box"),
      trapFocus,
      returnFocus,
      restoreFocus,
    );
  }

  function openDialog() {
    var box = root.prepareModalBox("mod-box shortcuts-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "kbs-dialog-title");
    box.innerHTML = dialogMarkup();
    box.removeEventListener("keydown", trapFocus);
    box.addEventListener("keydown", trapFocus);
    returnFocus =
      root.document.activeElement &&
      root.document.activeElement !== root.document.body
        ? root.document.activeElement
        : byId("shortcuts-toggle");
    byId("mod-overlay").classList.add("open");
    renderResults("");
    var input = byId("kbs-search-input");
    if (input) input.focus();
  }

  shortcuts.registerAction("help.shortcuts", openDialog);
  root.addEventListener("keydown", dispatchCommand);

  root.clearShortcutSearch = clearSearch;
  root.filterShortcuts = renderResults;
  root.openKeyboardShortcuts = openDialog;
  root.resetKeyboardShortcutsDialog = resetDialog;
})(typeof window !== "undefined" ? window : null);
