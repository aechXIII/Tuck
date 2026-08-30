(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TuckSettingsState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function snapshot(value) {
    return JSON.stringify(value || {});
  }

  function isDirty(openingSnapshot, currentValue) {
    return !!openingSnapshot && snapshot(currentValue) !== openingSnapshot;
  }

  return { snapshot: snapshot, isDirty: isDirty };
});
