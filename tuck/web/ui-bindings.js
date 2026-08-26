(function (root) {
  "use strict";

  if (!root || !root.Tuck || !root.Tuck.uiEvents) return;

  var events = root.Tuck.uiEvents;
  function actionValue(target) {
    return target.dataset.actionValue;
  }
  function numericActionValue(target) {
    return Number(actionValue(target));
  }

  events.register("click", {
    "workspace-toggle": function (target) {
      root.toggleWorkspacePanel(actionValue(target));
    },
    "workspace-close-panels": function () {
      root.closeWorkspacePanels(true);
    },
    "history-undo": function () {
      root.History.undo();
    },
    "history-redo": function () {
      root.History.redo();
    },
    "shortcuts-open": function () {
      root.openKeyboardShortcuts();
    },
    "settings-toggle": function () {
      root.toggleSettings();
    },
    "settings-open-profiles": function () {
      root.openSettings("profiles");
    },
    "library-tab": function (target) {
      root.setLibraryTab(actionValue(target));
    },
    "inspector-tab": function (target) {
      root.setInspectorTab(actionValue(target));
    },
    "browse-videos": function () {
      root.browse();
    },
    "remove-all-clips": function () {
      root.removeAllClips();
    },
    "browse-audio": function () {
      root.AudioTimeline.browse();
    },
    "player-step-frame": function (target) {
      root.stepFrame(numericActionValue(target));
    },
    "player-toggle-play": function () {
      root.togglePlay();
    },
    "player-toggle-mute": function () {
      root.toggleMute();
    },
    "player-fullscreen": function () {
      root.toggleFullscreen();
    },
    "transform-crop-aspect": function (target) {
      root.setCropAspect(target.dataset.aspect);
    },
    "transform-rotation": function (target) {
      root.setVideoRotation(Number(target.dataset.rotation));
    },
    "transform-flip": function (target) {
      root.toggleVideoFlip(actionValue(target));
    },
    "transform-sizing": function (target) {
      root.setSizingMode(target.dataset.sizing);
    },
    "transform-reset-all": function () {
      root.resetVideoTransform();
    },
    "audio-toggle-master": function () {
      root.AudioTimeline.toggleMaster();
    },
    "audio-toggle-fragment-mute": function () {
      root.AudioTimeline.toggleFragmentMute();
    },
    "audio-toggle-source-mute": function () {
      root.AudioTimeline.toggleSourceMute();
    },
    "encoding-workflow": function (target) {
      root.setWf(numericActionValue(target));
    },
    "encoding-save-profile": function () {
      root.saveProfileChanges();
    },
    "encoding-save-profile-as": function () {
      root.saveProfileAs();
    },
    "encoding-reset-profile": function () {
      root.resetToProfile();
    },
    "encoding-toggle-advanced": function () {
      root.toggleAdv();
    },
    "encoding-run-selected": function () {
      root.compressOne();
    },
    "encoding-run-all": function () {
      root.compressAll();
    },
    "timeline-add-segment": function () {
      root.addSegment();
    },
    "timeline-split": function () {
      root.splitAtPlayhead();
    },
    "timeline-remove-segment": function () {
      root.removeActiveSegment();
    },
    "timeline-reset-segments": function () {
      root.resetSegments();
    },
    "timeline-toggle-snap": function () {
      root.toggleSnap();
    },
    "timeline-reset-height": function (_target, event) {
      root.resetTimelineHeight(event);
    },
    "timeline-fit": function () {
      root.fitTimeline();
    },
    "timeline-nudge-zoom": function (target) {
      root.nudgeTimelineZoom(numericActionValue(target));
    },
    "queue-stop-after-current": function () {
      root.stopAfterCurrent();
    },
    "queue-cancel-all": function () {
      root.cancelAll();
    },
    "queue-clear-completed": function () {
      root.clearDone();
    },
    "modal-close-overlay": function (target, event) {
      if (event.target === target) root.closeActiveModal();
    },
  });

  events.register("input", {
    "player-scrub": function (target) {
      root.onStageScrub(target.value);
    },
    "player-volume": function (target) {
      root.setVol(target.value);
    },
    "encoding-target-size": function (target) {
      root.onSize(target.value);
    },
    "encoding-frame-rate": function (target) {
      root.onFpsSlider(target.value);
    },
    "timeline-zoom": function (target) {
      root.setTimelineZoom(target.value);
    },
  });

  events.register("change", {
    "encoding-profile": function () {
      root.onProfileChange();
    },
    "encoding-badge-size": function (target) {
      root.onBadgeSize(target.value);
    },
    "encoding-source-resolution": function () {
      root.onUseSourceResolution();
    },
    "encoding-resolution": function () {
      root.onResolutionGeometryChanged();
    },
    "encoding-resolution-facade": function (target) {
      root.onExportResolutionChoice(target.value);
    },
    "encoding-preview-dirty": function () {
      root.reqPreview();
      root.updateDirty();
    },
    "encoding-source-fps": function () {
      root.onUseSourceFps();
    },
    "encoding-frame-rate-facade": function (target) {
      root.onExportFrameRateChoice(target.value);
    },
    "encoding-keep-audio": function () {
      root.onKeepAudio();
    },
    "encoding-encoder": function () {
      root.onEncChange();
    },
    "encoding-speed": function () {
      root.onSpeedChange();
    },
    "encoding-two-pass": function () {
      root.onTwoPassChange();
    },
    "encoding-native-preset": function () {
      root.onNativePresetChange();
    },
    "encoding-rate-control": function () {
      root.onRcChange();
    },
  });
})(typeof window !== "undefined" ? window : null);
