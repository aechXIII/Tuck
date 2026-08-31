(function (root) {
  "use strict";

  function createElement(document, tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function createActionButton(document, action, label, className) {
    var button = createElement(document, "button", className, label);
    button.type = "button";
    button.dataset.clipAction = action;
    button.dataset.noReorder = "1";
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    return button;
  }

  function actionFromTarget(target, card) {
    while (target && target !== card) {
      if (target.dataset && target.dataset.clipAction) {
        return target.dataset.clipAction;
      }
      target = target.parentElement;
    }
    return "";
  }

  function appendStatus(document, cardMain, model) {
    var state = model.queueState || "";
    if (state === "pending") return;
    var hasOpen = state === "completed" && model.resultPath;
    var hasCancel =
      (state === "running" || state === "processing") &&
      model.queueItemId;
    var hasRetry =
      (state === "failed" || state === "cancelled") && model.queueItemId;
    var hasProbeRetry = !!model.probeError;
    if (
      !model.statusLabel &&
      !hasOpen &&
      !hasCancel &&
      !hasRetry &&
      !hasProbeRetry
    )
      return;

    var row = createElement(document, "div", "c-status-row");
    row.appendChild(createElement(document, "span", "c-status", model.statusLabel || ""));
    if (hasOpen) {
      row.appendChild(
        createActionButton(document, "open-result", "Open folder", "c-act link"),
      );
    }
    if (hasCancel) {
      row.appendChild(createActionButton(document, "cancel", "Cancel", "c-act danger"));
    }
    if (hasRetry) {
      row.appendChild(createActionButton(document, "retry", "Retry", "c-act"));
    }
    if (hasProbeRetry) {
      row.appendChild(
        createActionButton(
          document,
          "retry-probe",
          "Retry reading " + model.name,
          "c-act",
        ),
      );
    }
    cardMain.appendChild(row);
  }

  function appendBadge(document, card, badge) {
    if (!badge) return;
    var element = createElement(
      document,
      "span",
      "c-st " + badge.className,
      badge.icon,
    );
    element.setAttribute("role", "img");
    element.setAttribute("title", badge.label);
    element.setAttribute("aria-label", badge.label);
    card.appendChild(element);
  }

  function libraryGroup(model) {
    var state = model.queueState || "";
    if (state === "running" || state === "processing") return "encoding";
    if (state === "pending") return "queued";
    return "ready";
  }

  function groupClipModels(models) {
    var definitions = [
      { key: "encoding", label: "Encoding" },
      { key: "queued", label: "Queued" },
      { key: "ready", label: "Ready" },
    ];
    return definitions
      .map(function (definition) {
        return {
          key: definition.key,
          label: definition.label,
          items: models.filter(function (model) {
            return libraryGroup(model) === definition.key;
          }),
        };
      })
      .filter(function (group) {
        return group.items.length > 0;
      });
  }

  function groupHeading(group) {
    if (!group || group.key === "encoding") return group ? group.label : "";
    return group.label + " · " + group.items.length;
  }

  function groupedClipPaths(models) {
    return groupClipModels(models).reduce(function (paths, group) {
      return paths.concat(
        group.items.map(function (model) {
          return model.path;
        }),
      );
    }, []);
  }

  function formatLibrarySize(bytes) {
    if (!bytes) return "0 B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  function librarySummary(models) {
    var bytes = models.reduce(function (total, model) {
      return total + (Number(model.fileSize) || 0);
    }, 0);
    return {
      countLabel: models.length + (models.length === 1 ? " video" : " videos"),
      sizeLabel: formatLibrarySize(bytes),
    };
  }

  function createClipCard(document, model, callbacks) {
    var card = createElement(
      document,
      "div",
      "clip clip-drag" + (model.selected ? " sel" : ""),
    );
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", model.selected ? "true" : "false");
    card.setAttribute("aria-keyshortcuts", "Enter Space Delete ArrowUp ArrowDown");
    card.setAttribute("title", model.name + " - drag handle to reorder");
    card.dataset.clipPath = model.path;
    card.dataset.queueState = model.queueState || "ready";
    if (model.queueItemId) card.dataset.queueItemId = model.queueItemId;

    var drag = createElement(document, "span", "c-drag", "⋮⋮");
    drag.dataset.dragHandle = "1";
    drag.setAttribute("title", "Drag to reorder");
    drag.setAttribute("aria-label", "Drag to reorder");
    card.appendChild(drag);

    var main = createElement(document, "div", "c1");
    main.appendChild(createElement(document, "div", "c2", model.name));
    var metadata = createElement(document, "div", "c3");
    var metadataText = createElement(document, "span", "c-meta");
    if (model.meta && model.meta.error) {
      metadataText.appendChild(
        createElement(document, "span", "c-error", model.meta.text),
      );
    } else {
      metadataText.textContent = model.meta ? String(model.meta.text) : "";
    }
    metadata.appendChild(metadataText);
    main.appendChild(metadata);
    if (
      model.queueState === "running" ||
      model.queueState === "processing"
    ) {
      var progress = Math.max(0, Math.min(100, Number(model.progress) || 0));
      var progressTrack = createElement(document, "div", "c-progress");
      var progressFill = createElement(document, "span", "c-progress-fill");
      progressFill.setAttribute("style", "width:" + progress + "%");
      progressTrack.setAttribute("role", "progressbar");
      progressTrack.setAttribute("aria-label", "Encoding progress");
      progressTrack.setAttribute("aria-valuemin", "0");
      progressTrack.setAttribute("aria-valuemax", "100");
      progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
      progressTrack.appendChild(progressFill);
      main.appendChild(progressTrack);
    }
    appendStatus(document, main, model);
    card.appendChild(main);
    if (model.queueState === "pending") {
      var queued = createActionButton(
        document,
        "cancel",
        "Cancel queued export",
        "c-queue-badge",
      );
      queued.textContent = "QUEUED";
      card.appendChild(queued);
    } else if (
      model.queueState !== "running" &&
      model.queueState !== "processing"
    ) {
      appendBadge(document, card, model.badge);
    }

    var remove = createActionButton(document, "remove", "Remove " + model.name, "c4");
    remove.textContent = "✕";
    remove.setAttribute("tabindex", "0");
    card.appendChild(remove);

    card.addEventListener("click", function (event) {
      var action = actionFromTarget(event.target, card);
      if (!action) {
        callbacks.select(model.path);
        return;
      }
      event.stopPropagation();
      if (action === "open-result") callbacks.openResult(model.resultPath);
      else if (action === "cancel") callbacks.cancel(model.queueItemId);
      else if (action === "retry") callbacks.retry(model.queueItemId);
      else if (action === "retry-probe") callbacks.retryProbe(model.path);
      else if (action === "remove") callbacks.remove(model.path);
    });
    card.addEventListener("dblclick", function () {
      callbacks.select(model.path);
      callbacks.togglePlay(model.path);
    });
    card.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        callbacks.select(model.path);
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        callbacks.remove(model.path);
      }
    });
    card.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.dataset && event.target.dataset.dragHandle) {
        callbacks.beginReorder(event, model.path, card);
      }
    });
    return card;
  }

  var api = {
    createClipCard: createClipCard,
    groupClipModels: groupClipModels,
    groupHeading: groupHeading,
    groupedClipPaths: groupedClipPaths,
    librarySummary: librarySummary,
  };
  if (root) {
    root.Tuck = root.Tuck || {};
    root.Tuck.clipCards = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
