(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TuckLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TIMELINE_MIN_HEIGHT = 170;
  var TIMELINE_MAX_RATIO = 0.55;
  var WORKSPACE_CHROME_HEIGHT = 330;

  function timelineHeightBounds(viewportHeight) {
    var height = Number(viewportHeight);
    if (!Number.isFinite(height)) height = 640;
    height = Math.max(640, Math.round(height));
    var max = Math.max(
      TIMELINE_MIN_HEIGHT,
      Math.min(Math.round(height * TIMELINE_MAX_RATIO), height - WORKSPACE_CHROME_HEIGHT),
    );
    return {
      min: TIMELINE_MIN_HEIGHT,
      max: max,
      defaultHeight: Math.max(
        TIMELINE_MIN_HEIGHT,
        Math.min(max, Math.round(height * 0.3)),
      ),
    };
  }

  function clampTimelineHeight(value, viewportHeight) {
    var bounds = timelineHeightBounds(viewportHeight);
    var height = Number(value);
    if (!Number.isFinite(height) || height <= 0) return bounds.defaultHeight;
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(height)));
  }

  function timelineHeightForKey(current, key, largeStep, viewportHeight) {
    var bounds = timelineHeightBounds(viewportHeight);
    if (key === "Home") return bounds.min;
    if (key === "End") return bounds.max;
    var direction = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
    if (!direction) return null;
    var step = largeStep ? 32 : 10;
    return clampTimelineHeight(Number(current) + direction * step, viewportHeight);
  }

  return {
    timelineHeightBounds: timelineHeightBounds,
    clampTimelineHeight: clampTimelineHeight,
    timelineHeightForKey: timelineHeightForKey,
  };
});
