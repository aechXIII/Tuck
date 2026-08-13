function togglePlay() {
  var v = byId("vid");
  if (!v) return;
  if (v.paused) {
    var full = videoDuration();
    if (full > 0) {
      var b = clipTrimBounds(selPath ? clips[selPath] : null, full);
      var end = clipHasTrim(selPath ? clips[selPath] : null, full)
        ? b.end
        : full;
      var start = clipHasTrim(selPath ? clips[selPath] : null, full)
        ? b.start
        : 0;
      if (v.currentTime >= end - 0.05) v.currentTime = start;
    }
    v.play();
  } else {
    v.pause();
  }
}
function seekBy(seconds) {
  var v = byId("vid");
  if (v.duration)
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + seconds));
}
byId("vid").addEventListener("play", function () {
  byId("btn-play").textContent = "⏸";
});
byId("vid").addEventListener("pause", function () {
  byId("btn-play").textContent = "▶";
});
byId("vid").addEventListener("timeupdate", updateTime);
byId("vid").addEventListener("durationchange", function () {
  updateTime();
  syncTimelineUI();
});
byId("vid").addEventListener("loadedmetadata", function () {
  updateTime();
  syncTimelineUI();
});
byId("vid").addEventListener("ended", function () {
  loopPlayback();
});

var _tlDrag = null;
var _MIN_TRIM = 0.05;
var _looping = false;

function videoDuration() {
  var v = byId("vid");
  if (v && v.duration && isFinite(v.duration)) return v.duration;
  if (selPath && clips[selPath] && clips[selPath].probeData)
    return clips[selPath].probeData.duration || 0;
  return 0;
}

function clipTrimBounds(c, fullDur) {
  var start = c && c.trimStart != null ? c.trimStart : 0;
  var end = c && c.trimEnd != null ? c.trimEnd : fullDur;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end <= 0) end = fullDur;
  if (end > fullDur) end = fullDur;
  if (end - start < _MIN_TRIM) {
    if (start + _MIN_TRIM <= fullDur) end = start + _MIN_TRIM;
    else start = Math.max(0, fullDur - _MIN_TRIM);
  }
  return { start: start, end: end };
}

function clipHasTrim(c, fullDur) {
  if (!c || !fullDur) return false;
  return (
    (c.trimStart != null && c.trimStart > 0.001) ||
    (c.trimEnd != null && c.trimEnd < fullDur - 0.001)
  );
}

function loopPlayback() {
  if (_looping) return;
  var v = byId("vid");
  if (!v) return;
  var full = videoDuration();
  if (full <= 0) return;
  var c = selPath ? clips[selPath] : null;
  var b = clipTrimBounds(c, full);
  var start = clipHasTrim(c, full) ? b.start : 0;
  _looping = true;
  try {
    v.currentTime = start;
    var p = v.play();
    if (p && typeof p.catch === "function") p.catch(function () {});
  } finally {
    setTimeout(function () {
      _looping = false;
    }, 80);
  }
}

function paintTrimChrome() {
  var full = videoDuration();
  var c = selPath ? clips[selPath] : null;
  var bounds = clipTrimBounds(c, full || 1);
  var startPct = full > 0 ? (bounds.start / full) * 100 : 0;
  var endPct = full > 0 ? (bounds.end / full) * 100 : 100;
  byId("tl-range").style.left = startPct + "%";
  byId("tl-range").style.width = Math.max(0, endPct - startPct) + "%";
  byId("tl-dim-l").style.width = startPct + "%";
  byId("tl-dim-r").style.width = Math.max(0, 100 - endPct) + "%";
  byId("tl-in").style.left = startPct + "%";
  byId("tl-out").style.left = endPct + "%";
  var has = clipHasTrim(c, full);
  byId("btn-trim-reset").classList.toggle("show", has);
  var label = byId("trim-label");
  if (has) {
    label.textContent =
      fmtt(bounds.start) +
      "–" +
      fmtt(bounds.end) +
      " · " +
      fmtt(bounds.end - bounds.start);
  } else {
    label.textContent = "";
  }
  return { full: full, bounds: bounds, has: has };
}

function syncTimelineUI() {
  paintTrimChrome();
  updateTime();
}

function setPlayheadUI(sec, full) {
  full = full || videoDuration();
  sec = Number.isFinite(sec) ? sec : 0;
  if (full > 0) {
    byId("tl-playhead").style.left =
      Math.max(0, Math.min(100, (sec / full) * 100)) + "%";
    byId("timeline").setAttribute("aria-valuemax", String(Math.round(full)));
    byId("timeline").setAttribute("aria-valuenow", String(Math.round(sec)));
  }
  byId("ptime").textContent = fmtt(sec) + " / " + fmtt(full || 0);
  _previewSec = sec;
}

function updateTime() {
  if (_tlDrag && _previewSec != null) {
    setPlayheadUI(_previewSec, videoDuration());
    return;
  }
  var v = byId("vid");
  var full = videoDuration();
  var t = v && isFinite(v.currentTime) ? v.currentTime : 0;
  setPlayheadUI(t, full);
  if (v && !v.paused && !_looping && selPath && clips[selPath] && full > 0) {
    var b = clipTrimBounds(clips[selPath], full);
    if (clipHasTrim(clips[selPath], full) && t >= b.end - 0.04) {
      loopPlayback();
    }
  }
}

var _previewSec = null;
var _seekWanted = null;
var _seekBusy = false;
var _seekRaf = 0;
var _seekSafety = 0;
var _tlMoveRaf = 0;
var _tlMoveEvent = null;

function seekToRatio(ratio) {
  var full = videoDuration();
  if (!full || !isFinite(full)) return;
  ratio = Math.max(0, Math.min(1, ratio));
  seekPreview(ratio * full);
}

function seekPreview(sec) {
  var v = byId("vid");
  var full = videoDuration();
  if (!v || !full || !isFinite(full) || !Number.isFinite(sec)) return;
  sec = Math.max(0, Math.min(full, sec));
  setPlayheadUI(sec, full);
  if (!v.paused) {
    try {
      v.pause();
    } catch (err) {}
  }
  _seekWanted = sec;
  if (!_seekRaf) {
    _seekRaf = requestAnimationFrame(function () {
      _seekRaf = 0;
      flushVideoSeek();
    });
  }
}

function flushVideoSeek() {
  var v = byId("vid");
  if (!v || _seekWanted == null) return;
  if (_seekBusy) return;
  var sec = _seekWanted;
  _seekWanted = null;
  if (Math.abs((v.currentTime || 0) - sec) < 0.002) return;
  _seekBusy = true;
  var finished = false;
  var done = function () {
    if (finished) return;
    finished = true;
    v.removeEventListener("seeked", done);
    v.removeEventListener("error", done);
    if (_seekSafety) {
      clearTimeout(_seekSafety);
      _seekSafety = 0;
    }
    _seekBusy = false;
    if (_seekWanted != null) flushVideoSeek();
  };
  v.addEventListener("seeked", done);
  v.addEventListener("error", done);
  _seekSafety = setTimeout(done, 180);
  try {
    v.currentTime = sec;
  } catch (err) {
    done();
  }
}

function timelineRatioFromEvent(e) {
  var track = byId("tl-track");
  var rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  var x =
    (e.clientX != null
      ? e.clientX
      : e.touches && e.touches[0]
        ? e.touches[0].clientX
        : 0) - rect.left;
  return Math.max(0, Math.min(1, x / rect.width));
}

function applyTrimStart(sec) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var end = c.trimEnd != null ? c.trimEnd : full;
  sec = Math.max(0, Math.min(sec, end - _MIN_TRIM));
  c.trimStart = sec <= 0.001 ? null : sec;
  if (c.trimStart == null && c.trimEnd != null && c.trimEnd >= full - 0.001)
    c.trimEnd = null;
  return c.trimStart != null ? c.trimStart : 0;
}

function applyTrimEnd(sec) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var start = c.trimStart != null ? c.trimStart : 0;
  sec = Math.min(full, Math.max(sec, start + _MIN_TRIM));
  c.trimEnd = sec >= full - 0.001 ? null : sec;
  if (c.trimEnd == null && c.trimStart != null && c.trimStart <= 0.001)
    c.trimStart = null;
  return c.trimEnd != null ? c.trimEnd : full;
}

function clearTrim() {
  if (!selPath || !clips[selPath]) return;
  clips[selPath].trimStart = null;
  clips[selPath].trimEnd = null;
  paintTrimChrome();
  seekPreview(0);
  renderClips();
  reqPreview();
}

function setTrimDragCursor(active) {
  var tl = byId("timeline");
  if (tl) tl.classList.toggle("trim-dragging", !!active);
  document.body.classList.toggle("tl-trim-dragging", !!active);
}

function onTimelinePointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  var target = e.target;
  if (target && target.id === "tl-in") _tlDrag = "in";
  else if (target && target.id === "tl-out") _tlDrag = "out";
  else _tlDrag = "seek";
  if (target && target.classList && target.classList.contains("tl-handle")) {
    target.classList.add("dragging");
    setTrimDragCursor(true);
  }
  if (e.pointerId != null && e.currentTarget.setPointerCapture) {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
  }
  processTimelineMove(e);
  e.preventDefault();
}

function processTimelineMove(e) {
  if (!_tlDrag) return;
  var ratio = timelineRatioFromEvent(e);
  var full = videoDuration();
  if (full <= 0) return;
  var t = ratio * full;
  if (_tlDrag === "in") {
    var start = applyTrimStart(t);
    if (start == null) return;
    paintTrimChrome();
    seekPreview(start);
  } else if (_tlDrag === "out") {
    var end = applyTrimEnd(t);
    if (end == null) return;
    paintTrimChrome();
    seekPreview(end);
  } else {
    seekToRatio(ratio);
  }
}

function onTimelinePointerMove(e) {
  if (!_tlDrag) return;
  _tlMoveEvent = e;
  if (_tlMoveRaf) return;
  _tlMoveRaf = requestAnimationFrame(function () {
    _tlMoveRaf = 0;
    var ev = _tlMoveEvent;
    _tlMoveEvent = null;
    if (ev) processTimelineMove(ev);
  });
  e.preventDefault();
}

function onTimelinePointerUp(e) {
  if (!_tlDrag) return;
  var wasTrim = _tlDrag === "in" || _tlDrag === "out";
  if (_tlMoveRaf) {
    cancelAnimationFrame(_tlMoveRaf);
    _tlMoveRaf = 0;
  }
  if (_tlMoveEvent) {
    processTimelineMove(_tlMoveEvent);
    _tlMoveEvent = null;
  }
  byId("tl-in").classList.remove("dragging");
  byId("tl-out").classList.remove("dragging");
  setTrimDragCursor(false);
  _tlDrag = null;
  if (_previewSec != null) {
    _seekWanted = _previewSec;
    if (!_seekBusy) flushVideoSeek();
  }
  if (wasTrim) {
    renderClips();
    reqPreview();
  }
}
(function bindTimeline() {
  var tl = byId("timeline");
  if (!tl) return;
  tl.addEventListener("pointerdown", onTimelinePointerDown);
  tl.addEventListener("pointermove", onTimelinePointerMove);
  tl.addEventListener("pointerup", onTimelinePointerUp);
  tl.addEventListener("pointercancel", onTimelinePointerUp);
  tl.addEventListener("keydown", function (e) {
    var v = byId("vid");
    if (!v || !v.duration) return;
    var step = e.shiftKey ? 1 : 0.5;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekToRatio(Math.max(0, (v.currentTime - step) / v.duration));
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      seekToRatio(Math.min(1, (v.currentTime + step) / v.duration));
    }
  });
})();

var ICON_VOL = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M5 9v6h3.5L14 19V5l-5.5 4H5zm11 1.2v3.6c.9-.5 1.5-1.4 1.5-2.5S16.9 10.7 16 10.2z"/>
</svg>`;
var ICON_MUTE = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path
    d="M5 9v6h3.5L14 19V5l-5.5 4H5z
      m11.1 1.1-1.1 1.1 1.9 1.9-1.9 1.9 1.1 1.1 1.9-1.9
      1.9 1.9 1.1-1.1-1.9-1.9 1.9-1.9-1.1-1.1-1.9 1.9-1.9-1.9z"
  />
</svg>`;
function updateMuteIcon() {
  var btn = byId("btn-mute");
  if (!btn) return;
  var isMuted = muted || (byId("vid") && byId("vid").volume === 0);
  btn.innerHTML = isMuted ? ICON_MUTE : ICON_VOL;
  btn.title = isMuted ? "Unmute" : "Mute";
  btn.setAttribute("aria-label", isMuted ? "Unmute" : "Mute");
}
updateMuteIcon();
function toggleMute() {
  var v = byId("vid");
  if (muted || v.volume === 0) {
    v.volume = volBefore / 100;
    byId("vbar").value = volBefore;
    muted = false;
  } else {
    volBefore = Math.round(v.volume * 100) || 80;
    v.volume = 0;
    byId("vbar").value = 0;
    muted = true;
  }
  updateMuteIcon();
}
function setVol(vv) {
  var v = byId("vid");
  v.volume = vv / 100;
  muted = vv == 0;
  if (!muted) volBefore = parseInt(vv, 10) || volBefore;
  updateMuteIcon();
}
