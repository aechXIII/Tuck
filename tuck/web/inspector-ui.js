(function (root, factory) {
  "use strict";

  var api = factory();
  if (root) {
    root.Tuck = root.Tuck || {};
    root.Tuck.inspectorUi = api;
  }
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function videoCodec(encoder) {
    var id = String(encoder || "").toLowerCase();
    if (id.indexOf("265") >= 0 || id.indexOf("hevc") >= 0) return "H.265";
    if (id.indexOf("av1") >= 0) return "AV1";
    if (id.indexOf("vp9") >= 0) return "VP9";
    return "H.264";
  }

  function audioSummary(state) {
    if (state.audioEnabled === false) return "No audio";
    if (state.keepAudio) return "Copy when possible";
    var audio = Math.max(0, Math.round(Number(state.audioBitrateKbps) || 0));
    return audio ? "AAC " + audio + "k" : "No audio";
  }

  function encoderSummary(state) {
    var speeds = {
      fast: "Fast",
      balanced: "Balanced",
      best: "Best compression",
    };
    return videoCodec(state.videoEncoder) + " · " + (speeds[state.speed] || "Balanced");
  }

  function encoderPanelSummary(state) {
    var id = String(state.videoEncoder || "").toLowerCase();
    var family = videoCodec(id);
    if (id.indexOf("nvenc") >= 0) family = "NVENC";
    else if (id.indexOf("qsv") >= 0) family = "Quick Sync";
    else if (id.indexOf("amf") >= 0) family = "AMF";
    else if (id.indexOf("videotoolbox") >= 0) family = "VideoToolbox";
    var speeds = { fast: "Fast", balanced: "Balanced", best: "Best compression" };
    return family + " · " + (speeds[state.speed] || "Balanced");
  }

  function exportSummary(state) {
    var width = Math.max(0, Math.round(Number(state.width) || 0));
    var height = Math.max(0, Math.round(Number(state.height) || 0));
    var fps = Math.max(0, Math.round(Number(state.fps) || 0));
    return {
      title:
        state.workflow === "upscale"
          ? "Upscale output"
          : Math.max(0, Math.round(Number(state.targetSizeMb) || 0)) + " MB",
      detail:
        width +
        "×" +
        height +
        " · " +
        fps +
        " fps · " +
        videoCodec(state.videoEncoder) +
        " · " +
        audioSummary(state),
      modified: !!state.modified,
    };
  }

  function sizePresets() {
    return [10, 50, 500];
  }

  function resolutionChoices(sourceWidth, sourceHeight) {
    var width = Math.max(0, Math.round(Number(sourceWidth) || 0));
    var height = Math.max(0, Math.round(Number(sourceHeight) || 0));
    return [
      { value: "source", label: "Source · " + width + "×" + height },
      { value: "1920x1080", label: "1080p" },
      { value: "2560x1440", label: "1440p" },
      { value: "custom", label: "Custom…" },
    ];
  }

  function resolutionDecision(value) {
    if (value === "source") return { mode: "source" };
    var match = /^(\d+)x(\d+)$/.exec(String(value || ""));
    if (!match) return { mode: "custom" };
    return {
      mode: "custom",
      width: Number(match[1]),
      height: Number(match[2]),
    };
  }

  function frameRateChoices(sourceFps) {
    var fps = Math.max(1, Math.round(Number(sourceFps) || 30));
    return [
      { value: "source", label: "Source · " + fps + " fps" },
      { value: "30", label: "30 fps" },
      { value: "24", label: "24 fps" },
      { value: "custom", label: "Custom…" },
    ];
  }

  return {
    audioSummary: audioSummary,
    encoderPanelSummary: encoderPanelSummary,
    encoderSummary: encoderSummary,
    exportSummary: exportSummary,
    frameRateChoices: frameRateChoices,
    resolutionChoices: resolutionChoices,
    resolutionDecision: resolutionDecision,
    sizePresets: sizePresets,
  };
});
