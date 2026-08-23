(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TuckProbeState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function errorMessage(response, thrown) {
    var value =
      (response && response.error) ||
      (response && response.data && response.data.error) ||
      (thrown && thrown.message) ||
      "";
    value = String(value).trim();
    return value || "Couldn’t read clip details.";
  }

  function begin(clip) {
    if (!clip || clip.probed || clip.probing) return false;
    clip.probing = true;
    clip.error = "";
    return true;
  }

  function complete(clip, response) {
    if (response && response.ok && response.data) {
      clip.probing = false;
      clip.probed = true;
      clip.probeData = response.data;
      clip.error = "";
      return { ok: true, data: response.data };
    }
    var error = errorMessage(response);
    clip.probing = false;
    clip.probed = false;
    clip.probeData = null;
    clip.error = error;
    return { ok: false, error: error };
  }

  function fail(clip, thrown) {
    return complete(clip, { ok: false, error: errorMessage(null, thrown) });
  }

  function status(clip) {
    if (clip && clip.probed && clip.probeData) return "ready";
    if (clip && clip.error) return "error";
    return "loading";
  }

  function isReady(clip) {
    return status(clip) === "ready";
  }

  function allReady(clips) {
    var values = Object.keys(clips || {}).map(function (key) {
      return clips[key];
    });
    return values.length > 0 && values.every(isReady);
  }

  return {
    begin: begin,
    complete: complete,
    fail: fail,
    status: status,
    isReady: isReady,
    allReady: allReady,
  };
});
