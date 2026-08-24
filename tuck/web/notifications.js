(function (root) {
  "use strict";

  function presentation(kind) {
    if (kind === "err") {
      return {
        kind: "err",
        role: "alert",
        live: "assertive",
        duration: 6000,
      };
    }
    if (kind === "ok") {
      return {
        kind: "ok",
        role: "status",
        live: "polite",
        duration: 3500,
      };
    }
    return {
      kind: "info",
      role: "status",
      live: "polite",
      duration: 3500,
    };
  }

  function createMessageElement(document, message) {
    var span = document.createElement("span");
    span.className = "tmsg";
    span.textContent = String(message);
    return span;
  }

  var notifications = {
    presentation: presentation,
    createMessageElement: createMessageElement,
  };
  root.TuckNotifications = notifications;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = notifications;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
