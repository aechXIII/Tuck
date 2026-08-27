(function (root) {
  "use strict";

  function createElement(document, tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function render(document, host, view, retry) {
    host.replaceChildren();
    if (!view || view.state === "empty") return;
    if (view.state === "loading") {
      var loading = createElement(
        document,
        "div",
        "cd-empty",
        "Reading clip details…",
      );
      loading.setAttribute("role", "status");
      host.appendChild(loading);
      return;
    }
    if (view.state === "error") {
      var error = createElement(document, "div", "cd-probe-error");
      error.setAttribute("role", "alert");
      error.appendChild(
        createElement(document, "strong", "", "Couldn’t read clip details"),
      );
      error.appendChild(
        createElement(
          document,
          "span",
          "",
          "You may still be able to play this video, but Tuck needs its details to edit or export it.",
        ),
      );
      error.appendChild(
        createElement(document, "span", "cd-probe-message", view.error),
      );
      var button = createElement(document, "button", "btn2 cd-probe-retry", "Retry");
      button.type = "button";
      button.addEventListener("click", function () {
        retry(view.path);
      });
      error.appendChild(button);
      host.appendChild(error);
      return;
    }
    view.rows.forEach(function (row) {
      var line = createElement(document, "div", "cd-row");
      line.appendChild(createElement(document, "span", "cd-k", row[0]));
      line.appendChild(createElement(document, "span", "cd-v", row[1]));
      host.appendChild(line);
    });
  }

  function sourceFileRows(values) {
    return [
      ["Duration", values.duration],
      ["Resolution", values.resolution],
      ["Frame rate", values.frameRate],
      ["Format", values.format],
      ["Size", values.size],
    ];
  }

  var api = { render: render, sourceFileRows: sourceFileRows };
  if (root) {
    root.Tuck = root.Tuck || {};
    root.Tuck.clipDetails = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
