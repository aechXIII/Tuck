(function (root) {
  "use strict";

  var bindings = new WeakMap();

  function createElement(document, tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function createActionButton(document, label, action, profile, className) {
    var button = createElement(document, "button", className || "", label);
    button.type = "button";
    button.dataset.profileAction = action;
    button.dataset.profileId = String(profile.profile_id || "");
    button.dataset.profileName = String(profile.name || "");
    return button;
  }

  function renderProfileList(document, list, profiles, options) {
    list.replaceChildren();
    profiles.forEach(function (profile) {
      var row = createElement(document, "div", "settings-list-row");
      var main = createElement(document, "div", "settings-list-main");
      main.appendChild(createElement(document, "strong", "", profile.name));
      main.appendChild(
        createElement(document, "span", "", options.summarize(profile)),
      );
      if (profile.profile_id === options.defaultProfileId) {
        main.appendChild(createElement(document, "span", "settings-badge", "Default"));
      }
      row.appendChild(main);
      row.appendChild(createActionButton(document, "Edit", "edit", profile, "btn2"));

      var details = createElement(document, "details", "profile-actions-menu");
      var summary = createElement(document, "summary", "mbtn", "•••");
      summary.setAttribute("aria-label", "More actions for " + String(profile.name || ""));
      details.appendChild(summary);
      var popover = createElement(document, "div", "profile-actions-popover");
      popover.appendChild(createActionButton(document, "Export", "export", profile));
      popover.appendChild(createActionButton(document, "Duplicate", "duplicate", profile));
      popover.appendChild(
        createActionButton(document, "Delete", "delete", profile, "danger"),
      );
      details.appendChild(popover);
      row.appendChild(details);
      list.appendChild(row);
    });
    if (!profiles.length) {
      list.appendChild(
        createElement(document, "div", "settings-empty", "No matching profiles."),
      );
    }
  }

  function createShortcutChoice(document, title, description, action, profile) {
    var button = createActionButton(document, "", action, profile, "mrow");
    var info = createElement(document, "div", "mi");
    info.appendChild(createElement(document, "div", "mti", title));
    info.appendChild(createElement(document, "div", "mme", description));
    button.appendChild(info);
    return button;
  }

  function renderShortcutChoices(document, list, profiles, options) {
    list.replaceChildren();
    list.appendChild(
      createShortcutChoice(
        document,
        "Tuck",
        "Default shortcut",
        "install-generic-shortcut",
        {},
      ),
    );
    profiles.forEach(function (profile) {
      list.appendChild(
        createShortcutChoice(
          document,
          profile.name,
          options.summarize(profile),
          "install-profile-shortcut",
          profile,
        ),
      );
    });
  }

  function actionFromTarget(target, container) {
    while (target && target !== container) {
      if (target.dataset && target.dataset.profileAction) {
        return {
          action: target.dataset.profileAction,
          profileId: target.dataset.profileId || "",
          profileName: target.dataset.profileName || "",
        };
      }
      target = target.parentElement;
    }
    return null;
  }

  function bindProfileActions(container, callback) {
    var binding = bindings.get(container);
    if (binding) {
      binding.callback = callback;
      return;
    }
    binding = { callback: callback };
    bindings.set(container, binding);
    container.addEventListener("click", function (event) {
      var selected = actionFromTarget(event.target, container);
      if (!selected) return;
      binding.callback(selected.action, selected.profileId, selected.profileName);
    });
  }

  var api = {
    bindProfileActions: bindProfileActions,
    renderProfileList: renderProfileList,
    renderShortcutChoices: renderShortcutChoices,
  };
  if (root) {
    root.Tuck = root.Tuck || {};
    root.Tuck.settingsProfiles = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
