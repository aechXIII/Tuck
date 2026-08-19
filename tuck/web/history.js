var History = (function () {
  var undoStack = [];
  var redoStack = [];
  var pending = null;
  var MAX_ENTRIES = 100;

  function cloneSegments(segments) {
    return Array.isArray(segments)
      ? segments.map(function (s) {
          return Object.assign({}, s);
        })
      : segments;
  }

  function snapshot(clip) {
    if (!clip) return null;
    return {
      crop: clip.crop ? Object.assign({}, clip.crop) : null,
      cropAspect: clip.cropAspect,
      rotation: clip.rotation,
      flipHorizontal: clip.flipHorizontal,
      flipVertical: clip.flipVertical,
      sizingMode: clip.sizingMode,
      transformOverride: clip.transformOverride,
      transformIntentTouched: clip.transformIntentTouched,
      segments: cloneSegments(clip.segments),
      activeSegment: clip.activeSegment,
      audioTimeline: clip.audioTimeline ? JSON.parse(JSON.stringify(clip.audioTimeline)) : null,
    };
  }

  function apply(clip, snap) {
    if (!clip || !snap) return;
    clip.crop = snap.crop ? Object.assign({}, snap.crop) : null;
    clip.cropAspect = snap.cropAspect;
    clip.rotation = snap.rotation;
    clip.flipHorizontal = snap.flipHorizontal;
    clip.flipVertical = snap.flipVertical;
    clip.sizingMode = snap.sizingMode;
    clip.transformOverride = snap.transformOverride;
    clip.transformIntentTouched = snap.transformIntentTouched;
    clip.segments = cloneSegments(snap.segments);
    clip.activeSegment = snap.activeSegment;
    clip.audioTimeline = snap.audioTimeline ? JSON.parse(JSON.stringify(snap.audioTimeline)) : null;
    clip.planData = null;
  }

  function begin(path) {
    var clip = path && window.clips ? window.clips[path] : null;
    if (!clip) {
      pending = null;
      return;
    }
    pending = { path: path, before: snapshot(clip) };
  }

  function commit() {
    if (!pending) return;
    var clip = window.clips ? window.clips[pending.path] : null;
    if (!clip) {
      pending = null;
      return;
    }
    var after = snapshot(clip);
    if (JSON.stringify(after) === JSON.stringify(pending.before)) {
      pending = null;
      return;
    }
    undoStack.push({ path: pending.path, before: pending.before, after: after });
    if (undoStack.length > MAX_ENTRIES) undoStack.shift();
    redoStack.length = 0;
    pending = null;
    updateButtons();
  }

  function cancel() {
    pending = null;
  }

  function action(path, fn) {
    begin(path);
    var result = fn();
    commit();
    return result;
  }

  function wrap(owner, name) {
    var original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function () {
      var self = this;
      var args = arguments;
      return action(window.selPath, function () {
        return original.apply(self, args);
      });
    };
  }

  function refreshUiForClip(path) {
    if (window.selPath !== path) return;
    if (typeof syncTransformControls === "function") syncTransformControls();
    if (typeof paintCropOverlay === "function") paintCropOverlay();
    if (typeof paintTrimChrome === "function") paintTrimChrome();
    if (typeof renderClipDetails === "function") renderClipDetails();
    if (window.AudioTimeline) window.AudioTimeline.render();
    if (typeof renderClips === "function") renderClips();
    if (typeof reqPreview === "function") reqPreview();
  }

  function undo() {
    var entry = undoStack.pop();
    if (!entry) return;
    var clip = window.clips ? window.clips[entry.path] : null;
    if (clip) {
      apply(clip, entry.before);
      refreshUiForClip(entry.path);
    }
    redoStack.push(entry);
    updateButtons();
  }

  function redo() {
    var entry = redoStack.pop();
    if (!entry) return;
    var clip = window.clips ? window.clips[entry.path] : null;
    if (clip) {
      apply(clip, entry.after);
      refreshUiForClip(entry.path);
    }
    undoStack.push(entry);
    updateButtons();
  }

  function updateButtons() {
    var undoBtn = document.getElementById("btn-undo");
    var redoBtn = document.getElementById("btn-redo");
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function forgetClip(path) {
    undoStack = undoStack.filter(function (entry) {
      return entry.path !== path;
    });
    redoStack = redoStack.filter(function (entry) {
      return entry.path !== path;
    });
    updateButtons();
  }

  return {
    begin: begin,
    commit: commit,
    cancel: cancel,
    action: action,
    wrap: wrap,
    undo: undo,
    redo: redo,
    updateButtons: updateButtons,
    forgetClip: forgetClip,
  };
})();
window.History = History;

document.addEventListener("keydown", function (event) {
  var ctrlOrCmd = event.ctrlKey || event.metaKey;
  if (!ctrlOrCmd) return;
  var target = event.target;
  if (target && (target.matches("input, select, textarea") || target.isContentEditable)) return;
  if (event.key.toLowerCase() === "z" && !event.shiftKey) {
    event.preventDefault();
    History.undo();
  } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
    event.preventDefault();
    History.redo();
  }
});

window.addEventListener("load", function () {
  [
    "setCropAspect",
    "setVideoRotation",
    "toggleVideoFlip",
    "setSizingMode",
    "clearCrop",
  ].forEach(function (name) {
    History.wrap(window, name);
  });
  ["addSegment", "removeActiveSegment", "resetSegments", "splitAtPlayhead"].forEach(function (name) {
    History.wrap(window, name);
  });
  if (window.AudioTimeline) {
    ["toggleMaster", "toggleSourceMute", "toggleFragmentMute", "toggleTrackMute", "splitSelected", "deleteSelected"].forEach(
      function (name) {
        History.wrap(window.AudioTimeline, name);
      },
    );
  }
  History.updateButtons();
});
