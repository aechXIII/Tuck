(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TuckLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TIMELINE_MIN_HEIGHT = 170;
  var TIMELINE_MAX_RATIO = 0.55;
  var WORKSPACE_CHROME_HEIGHT = 330;
  var DEFAULT_TRACK_COUNT = 2;
  var TIMELINE_AUTO_BASE_HEIGHT = 190;
  var IMPORTED_TRACK_HEIGHT = 42;
  var WORKSPACE_DOCKED_MIN_WIDTH = 1180;

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
      defaultHeight: Math.min(max, TIMELINE_AUTO_BASE_HEIGHT),
    };
  }

  function timelineAutoHeight(trackCount, viewportHeight) {
    var bounds = timelineHeightBounds(viewportHeight);
    var count = Math.round(Number(trackCount));
    if (!Number.isFinite(count)) count = DEFAULT_TRACK_COUNT;
    count = Math.max(DEFAULT_TRACK_COUNT, count);
    return Math.min(
      bounds.max,
      bounds.defaultHeight + (count - DEFAULT_TRACK_COUNT) * IMPORTED_TRACK_HEIGHT,
    );
  }

  function clampTimelineHeight(value, viewportHeight, trackCount) {
    var bounds = timelineHeightBounds(viewportHeight);
    var height = Number(value);
    if (!Number.isFinite(height) || height <= 0)
      return timelineAutoHeight(trackCount, viewportHeight);
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(height)));
  }

  function normalizeTimelineHeightSetting(value, viewportHeight) {
    var bounds = timelineHeightBounds(viewportHeight);
    var height = Number(value);
    if (!Number.isFinite(height) || height < bounds.min) return 0;
    return Math.round(height);
  }

  function initialTimelineHeightSetting(settings) {
    return settings && settings.timeline_height != null ? settings.timeline_height : 0;
  }

  function timelineHeightForTrackCount(setting, trackCount, viewportHeight) {
    if (normalizeTimelineHeightSetting(setting, viewportHeight) !== 0) return null;
    return timelineAutoHeight(trackCount, viewportHeight);
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

  function workspaceMode(viewportWidth) {
    var width = Number(viewportWidth);
    if (!Number.isFinite(width)) width = WORKSPACE_DOCKED_MIN_WIDTH;
    return width >= WORKSPACE_DOCKED_MIN_WIDTH ? "docked" : "overlay";
  }

  function initialWorkspacePanels(viewportWidth) {
    var open = workspaceMode(viewportWidth) === "docked";
    return { libraryOpen: open, inspectorOpen: open };
  }

  function toggleWorkspacePanelState(state, panel, viewportWidth) {
    var current = {
      libraryOpen: !!(state && state.libraryOpen),
      inspectorOpen: !!(state && state.inspectorOpen),
    };
    if (panel !== "library" && panel !== "inspector") return current;
    var key = panel === "library" ? "libraryOpen" : "inspectorOpen";
    if (workspaceMode(viewportWidth) === "docked") {
      current[key] = !current[key];
      return current;
    }
    var opening = !current[key];
    return {
      libraryOpen: panel === "library" && opening,
      inspectorOpen: panel === "inspector" && opening,
    };
  }

  return {
    timelineHeightBounds: timelineHeightBounds,
    timelineAutoHeight: timelineAutoHeight,
    clampTimelineHeight: clampTimelineHeight,
    normalizeTimelineHeightSetting: normalizeTimelineHeightSetting,
    initialTimelineHeightSetting: initialTimelineHeightSetting,
    timelineHeightForTrackCount: timelineHeightForTrackCount,
    timelineHeightForKey: timelineHeightForKey,
    workspaceMode: workspaceMode,
    initialWorkspacePanels: initialWorkspacePanels,
    toggleWorkspacePanelState: toggleWorkspacePanelState,
  };
});
