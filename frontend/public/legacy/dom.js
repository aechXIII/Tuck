(function (root) {
  "use strict";

  function escapeHtml(value) {
    if (value == null) return "";
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[character];
    });
  }

  var api = Object.freeze({ escapeHtml: escapeHtml });
  root.Tuck = root.Tuck || {};
  root.Tuck.dom = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
