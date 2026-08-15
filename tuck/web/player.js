function togglePlay() {
  var v = byId("vid");
  if (!v) return;
  if (v.paused) {
    var target = SegmentEditing.playbackTarget(playbackSegments(), v.currentTime, 0.04);
    if (target != null) v.currentTime = target;
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
  byId("btn-play").textContent = "\u23f8";
});
byId("vid").addEventListener("pause", function () {
  byId("btn-play").textContent = "\u25b6";
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
byId("vid").addEventListener("ended", loopPlayback);

var _tlDrag = null;
var _MIN_TRIM = SegmentEditing.MIN_DURATION;
var _looping = false;
var _segmentDragOffset = 0;
var _segmentPointerX = 0;
var _segmentClickTime = 0;
var _SEGMENT_DRAG_THRESHOLD = 5;
var _SEGMENT_COLORS = [
  "#6d28d9",
  "#a855f7",
  "#8b5cf6",
  "#c084fc",
  "#7e22ce",
  "#9333ea",
];

function segmentColor(index) {
  return _SEGMENT_COLORS[index % _SEGMENT_COLORS.length];
}

function formatSelectedDuration(seconds) {
  if (seconds < 60)
    return seconds.toFixed(2).replace(/\.?0+$/, "") + "s";
  return fmtt(seconds);
}

function videoDuration() {
  if (selPath && clips[selPath] && clips[selPath].probeData)
    if (Number.isFinite(clips[selPath].probeData.duration))
      return clips[selPath].probeData.duration;
  var v = byId("vid");
  if (v && v.duration && isFinite(v.duration)) return v.duration;
  return 0;
}

function clipSegments(c, fullDur) {
  if (!fullDur || fullDur <= 0) return [];
  return SegmentEditing.segmentsForClip(c, fullDur);
}

function activeSegmentIndex(c, segments) {
  var index = c && Number.isInteger(c.activeSegment) ? c.activeSegment : 0;
  return Math.max(0, Math.min(segments.length - 1, index));
}

function clipTrimBounds(c, fullDur) {
  var segments = clipSegments(c, fullDur);
  return segments[activeSegmentIndex(c, segments)] || { start: 0, end: fullDur };
}

function clipHasTrim(c, fullDur) {
  var segments = clipSegments(c, fullDur);
  return !SegmentEditing.isFullSource(segments, fullDur);
}

function setClipSegments(c, segments, active) {
  c.segments = segments.map(function (segment) {
    var item = { start: segment.start, end: segment.end };
    if (segment.grouped === false || segment.audio === false) item.grouped = false;
    if (segment.muted) item.muted = true;
    if (segment.audioLink) item.audioLink = segment.audioLink;
    return item;
  });
  c.activeSegment = Math.max(0, Math.min(c.segments.length - 1, active || 0));
  c.trimStart = null;
  c.trimEnd = null;
  c.planData = null;
}

function playbackSegments() {
  return clipSegments(selPath ? clips[selPath] : null, videoDuration());
}

function continuePlaybackAt(target) {
  if (_looping || target == null) return;
  var v = byId("vid");
  if (!v) return;
  _looping = true;
  try {
    v.currentTime = target;
    var p = v.play();
    if (p && typeof p.catch === "function") p.catch(function () {});
  } finally {
    setTimeout(function () {
      _looping = false;
    }, 80);
  }
}

function loopPlayback() {
  var segments = playbackSegments();
  if (segments.length) continuePlaybackAt(segments[0].start);
}

function formatSegmentTime(seconds) {
  var centiseconds = Math.round(Math.max(0, seconds) * 100);
  var wholeSeconds = Math.floor(centiseconds / 100);
  var fraction = centiseconds % 100;
  return fmtt(wholeSeconds) +
    (fraction ? "." + String(fraction).padStart(2, "0").replace(/0$/, "") : "");
}

function paintTrimChrome() {
  var full = videoDuration();
  var c = selPath ? clips[selPath] : null;
  var ruler = byId("sequence-ruler");
  if (ruler) {
    ruler.classList.toggle("hid", !(c && full > 0));
    if (c && full > 0) paintSequenceRuler(full);
  }
  var segments = clipSegments(c, full || 1);
  var active = activeSegmentIndex(c, segments);
  var bounds = segments[active] || { start: 0, end: full || 1 };
  var startPct = full > 0 ? (bounds.start / full) * 100 : 0;
  var endPct = full > 0 ? (bounds.end / full) * 100 : 100;
  var segmentsLayer = byId("tl-segments");
  segmentsLayer.replaceChildren();
  for (var i = 0; i < segments.length; i++) {
    var range = document.createElement("button");
    range.type = "button";
    range.className = "tl-segment" + (i === active ? " active" : "");
    range.dataset.segmentIndex = String(i);
    range.style.setProperty("--segment-color", segmentColor(i));
    range.style.left = (segments[i].start / (full || 1)) * 100 + "%";
    range.style.width =
      ((segments[i].end - segments[i].start) / (full || 1)) * 100 + "%";
    range.setAttribute(
      "aria-label",
      "Segment " + (i + 1) + ". Click to seek; drag to move",
    );
    range.setAttribute("aria-pressed", i === active ? "true" : "false");
    range.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
    var timeLabel = document.createElement("span");
    timeLabel.className = "tl-segment-time";
    timeLabel.setAttribute("aria-hidden", "true");
    timeLabel.textContent =
      formatSegmentTime(segments[i].start) +
      "–" +
      formatSegmentTime(segments[i].end) +
      " · " +
      formatSelectedDuration(segments[i].end - segments[i].start);
    range.appendChild(timeLabel);
    if (i === active) {
      var edgeIn = document.createElement("span");
      edgeIn.className = "clip-edge start";
      edgeIn.dataset.edge = "start";
      var edgeOut = document.createElement("span");
      edgeOut.className = "clip-edge end";
      edgeOut.dataset.edge = "end";
      range.append(edgeIn, edgeOut);
    }
    range.title =
      "Segment " +
      (i + 1) +
      ": " +
      fmtt(segments[i].start) +
      "-" +
      fmtt(segments[i].end) +
      " · Click to seek · drag to move";
    segmentsLayer.appendChild(range);
  }
  paintSelectionFrame(startPct, endPct, segmentColor(active));
  byId("tl-in").setAttribute(
    "aria-valuemin",
    String(active > 0 ? segments[active - 1].end : 0),
  );
  byId("tl-in").setAttribute("aria-valuemax", String(bounds.end - _MIN_TRIM));
  byId("tl-in").setAttribute("aria-valuenow", String(bounds.start));
  byId("tl-out").setAttribute("aria-valuemin", String(bounds.start + _MIN_TRIM));
  byId("tl-out").setAttribute(
    "aria-valuemax",
    String(active + 1 < segments.length ? segments[active + 1].start : full),
  );
  byId("tl-out").setAttribute("aria-valuenow", String(bounds.end));

  var has = clipHasTrim(c, full);
  byId("btn-segments-reset").disabled = !has;
  byId("btn-segment-remove").disabled = segments.length <= 1;
  var canAdd = SegmentEditing.canAddSegment(segments, full || 1);
  var addButton = byId("btn-segment-add");
  addButton.setAttribute("aria-disabled", canAdd ? "false" : "true");
  addButton.title = canAdd
    ? "Add a kept range in a gap near the playhead"
    : "Shorten a segment to create a gap first";
  var groupButton = byId("btn-seq-link");
  if (groupButton) {
    var grouped = SegmentEditing.hasAudio(segments[active]);
    groupButton.classList.toggle("on", grouped);
    groupButton.setAttribute("aria-pressed", grouped ? "true" : "false");
    groupButton.title = grouped
      ? "Ungroup audio from this segment"
      : "Group audio with this segment";
    groupButton.setAttribute(
      "aria-label",
      grouped ? "Ungroup this segment" : "Group this segment",
    );
  }
  if (window.AudioTimeline && AudioTimeline.paintSource)
    AudioTimeline.paintSource();
  return { full: full, bounds: bounds, has: has, segments: segments, active: active };
}

function paintSelectionFrame(startPct, endPct, color) {
  var frame = byId("seq-selection");
  if (frame) frame.hidden = true;
  var tlIn = byId("tl-in");
  if (tlIn) {
    tlIn.classList.add("sr-handle");
    tlIn.style.left = startPct + "%";
    tlIn.style.setProperty("--segment-color", color);
  }
  var tlOut = byId("tl-out");
  if (tlOut) {
    tlOut.classList.add("sr-handle");
    tlOut.style.left = endPct + "%";
    tlOut.style.setProperty("--segment-color", color);
  }
}

function rulerStep(full) {
  if (full <= 10) return 1;
  if (full <= 30) return 2;
  if (full <= 90) return 5;
  if (full <= 180) return 10;
  if (full <= 600) return 30;
  return 60;
}

function paintSequenceRuler(full) {
  var ruler = byId("sequence-ruler");
  if (!ruler) return;
  ruler.replaceChildren();
  if (full <= 0) return;
  var step = rulerStep(full);
  var major = step * (full <= 30 ? 2 : full <= 180 ? 3 : 2);
  for (var t = 0; t <= full + 0.0001; t += step) {
    var tick = document.createElement("span");
    tick.className = "seq-tick" + (t % major < 0.001 || t < 0.001 ? " major" : "");
    tick.style.left = (t / full) * 100 + "%";
    if (t % major < 0.001 || t < 0.001) {
      var label = document.createElement("span");
      label.textContent = fmtt(t);
      tick.appendChild(label);
    }
    ruler.appendChild(tick);
  }
}

function syncTimelineUI() {
  paintTrimChrome();
  updateTime();
  if (window.AudioTimeline) AudioTimeline.render();
}

function setPlayheadUI(sec, full) {
  full = full || videoDuration();
  sec = Number.isFinite(sec) ? sec : 0;
  var pct = full > 0 ? Math.max(0, Math.min(100, (sec / full) * 100)) : 0;
  var layer = byId("seq-playhead-layer");
  if (layer) layer.style.setProperty("--playhead", pct + "%");
  if (full > 0) {
    byId("timeline").setAttribute("aria-valuemax", String(Math.round(full)));
    byId("timeline").setAttribute("aria-valuenow", String(Math.round(sec)));
  }
  byId("ptime").textContent = fmtt(sec) + " / " + fmtt(full || 0);
  var clock = byId("audio-output-time");
  if (clock) clock.textContent = fmtt(sec) + " / " + fmtt(full || 0);
  _previewSec = sec;
}

function splitAtPlayhead() {
  if (window.AudioTimeline && AudioTimeline.splitSelected && AudioTimeline.hasSelection()) {
    AudioTimeline.splitSelected();
    return;
  }
  if (!selPath || !clips[selPath]) return;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  var video = byId("vid");
  var time = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  var result = SegmentEditing.splitAt(clipSegments(c, full), time, full);
  if (!result) {
    toast("Move the playhead inside a video clip to split it.", "err");
    return;
  }
  setClipSegments(c, result.segments, result.index);
  if (window.AudioTimeline) AudioTimeline.onVideoSplit(time);
  paintTrimChrome();
  seekPreview(time);
  renderClips();
  reqPreview();
  if (window.AudioTimeline) AudioTimeline.render();
}

function updateTime() {
  if (_tlDrag && _previewSec != null) {
    setPlayheadUI(_previewSec, videoDuration());
    return;
  }
  var v = byId("vid");
  var full = videoDuration();
  var time = v && isFinite(v.currentTime) ? v.currentTime : 0;
  setPlayheadUI(time, full);
  if (v && !v.paused && !_looping && selPath && clips[selPath] && full > 0) {
    var target = SegmentEditing.playbackTarget(
      clipSegments(clips[selPath], full),
      time,
      0.04,
    );
    if (target != null) continuePlaybackAt(target);
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
  if (!v || _seekWanted == null || _seekBusy) return;
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
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  segments = SegmentEditing.editEndpoint(segments, active, "start", sec, full);
  setClipSegments(c, segments, active);
  return segments[active].start;
}

function applyTrimEnd(sec) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  segments = SegmentEditing.editEndpoint(segments, active, "end", sec, full);
  setClipSegments(c, segments, active);
  return segments[active].end;
}

function moveActiveSegment(start) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  segments = SegmentEditing.moveSegment(segments, active, start, full);
  setClipSegments(c, segments, active);
  return segments[active];
}

function resetSegments() {
  if (!selPath || !clips[selPath]) return;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return;
  setClipSegments(c, SegmentEditing.fullSegment(full), 0);
  if (window.AudioTimeline) AudioTimeline.resetAudio(c);
  paintTrimChrome();
  seekPreview(0);
  renderClips();
  reqPreview();
  if (window.AudioTimeline) AudioTimeline.render();
}

function clearTrim() {
  resetSegments();
}

function selectSegment(index, shouldSeek) {
  if (!selPath || !clips[selPath]) return;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  var segments = clipSegments(c, full);
  index = Math.max(0, Math.min(segments.length - 1, Number(index)));
  c.activeSegment = index;
  paintTrimChrome();
  if (shouldSeek !== false) seekPreview(segments[index].start);
}

function addSegment() {
  if (!selPath || !clips[selPath]) return;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return;
  try {
    var result = SegmentEditing.addSegment(
      clipSegments(c, full),
      full,
      byId("vid").currentTime,
    );
    setClipSegments(c, result.segments, result.index);
    paintTrimChrome();
    seekPreview(result.segments[result.index].start);
    renderClips();
    reqPreview();
    if (window.AudioTimeline) AudioTimeline.render();
  } catch (err) {
    toast(err.message || "No room for another segment.", "err");
  }
}

function removeActiveSegment() {
  if (!selPath || !clips[selPath]) return;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  if (segments.length <= 1) return;
  segments = SegmentEditing.removeSegment(segments, active, full);
  active = Math.min(active, segments.length - 1);
  setClipSegments(c, segments, active);
  paintTrimChrome();
  seekPreview(segments[active].start);
  renderClips();
  reqPreview();
  if (window.AudioTimeline) AudioTimeline.render();
}

function setTrimDragCursor(active) {
  var timeline = byId("timeline");
  if (timeline) timeline.classList.toggle("trim-dragging", !!active);
  document.body.classList.toggle("tl-trim-dragging", !!active);
}

function setSegmentDragCursor(active) {
  var timeline = byId("timeline");
  if (timeline) timeline.classList.toggle("segment-dragging", !!active);
  document.body.classList.toggle("tl-segment-dragging", !!active);
}

function onTimelinePointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  var target = e.target;
  var edge = target && target.closest ? target.closest(".clip-edge") : null;
  var isSegment =
    target && target.classList && target.classList.contains("tl-segment");
  if (edge && edge.dataset.edge) {
    _tlDrag = edge.dataset.edge === "start" ? "in" : "out";
    setTrimDragCursor(true);
  } else if (isSegment) {
    var index = parseInt(target.dataset.segmentIndex, 10);
    var full = videoDuration();
    var segments = playbackSegments();
    if (!full || !segments[index]) return;
    var pointerTime = timelineRatioFromEvent(e) * full;
    _segmentDragOffset = pointerTime - segments[index].start;
    _segmentPointerX = e.clientX;
    _segmentClickTime = pointerTime;
    selectSegment(index, false);
    _tlDrag = "segment-pending";
  } else if (target && target.id === "tl-in") _tlDrag = "in";
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
  if (_tlDrag !== "segment-pending") processTimelineMove(e);
  e.preventDefault();
}

function processTimelineMove(e) {
  if (!_tlDrag) return;
  if (_tlDrag === "segment-pending") {
    if (Math.abs(e.clientX - _segmentPointerX) < _SEGMENT_DRAG_THRESHOLD) return;
    _tlDrag = "segment";
    setSegmentDragCursor(true);
  }
  var ratio = timelineRatioFromEvent(e);
  var full = videoDuration();
  if (full <= 0) return;
  var time = ratio * full;
  if (_tlDrag === "in") {
    var start = applyTrimStart(time);
    if (start == null) return;
    paintTrimChrome();
    seekPreview(start);
  } else if (_tlDrag === "out") {
    var end = applyTrimEnd(time);
    if (end == null) return;
    paintTrimChrome();
    seekPreview(end);
  } else if (_tlDrag === "segment") {
    var moved = moveActiveSegment(time - _segmentDragOffset);
    if (!moved) return;
    paintTrimChrome();
    seekPreview(moved.start);
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
    var event = _tlMoveEvent;
    _tlMoveEvent = null;
    if (event) processTimelineMove(event);
  });
  e.preventDefault();
}

function onTimelinePointerUp(e) {
  if (!_tlDrag) return;
  if (_tlMoveRaf) {
    cancelAnimationFrame(_tlMoveRaf);
    _tlMoveRaf = 0;
  }
  if (_tlMoveEvent) {
    processTimelineMove(_tlMoveEvent);
    _tlMoveEvent = null;
  }
  var wasSegmentClick =
    _tlDrag === "segment-pending" && (!e || e.type !== "pointercancel");
  var wasEdit = _tlDrag === "in" || _tlDrag === "out" || _tlDrag === "segment";
  if (wasSegmentClick) seekPreview(_segmentClickTime);
  byId("tl-in").classList.remove("dragging");
  byId("tl-out").classList.remove("dragging");
  setTrimDragCursor(false);
  setSegmentDragCursor(false);
  _tlDrag = null;
  if (_previewSec != null) {
    _seekWanted = _previewSec;
    if (!_seekBusy) flushVideoSeek();
  }
  if (wasEdit) {
    if (window.AudioTimeline) AudioTimeline.render();
    renderClips();
    reqPreview();
  }
}

(function bindTimeline() {
  var timeline = byId("timeline");
  if (!timeline) return;
  var ruler = byId("sequence-ruler");
  if (ruler) {
    ruler.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      seekToRatio(timelineRatioFromEvent(e));
      e.preventDefault();
    });
  }
  timeline.addEventListener("pointerdown", onTimelinePointerDown);
  timeline.addEventListener("pointermove", onTimelinePointerMove);
  timeline.addEventListener("pointerup", onTimelinePointerUp);
  timeline.addEventListener("pointercancel", onTimelinePointerUp);
  var selectionLayer = byId("seq-selection-layer");
  if (selectionLayer) {
    selectionLayer.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      if (!e.target || (e.target.id !== "tl-in" && e.target.id !== "tl-out")) return;
      _tlDrag = e.target.id === "tl-in" ? "in" : "out";
      e.target.classList.add("dragging");
      setTrimDragCursor(true);
      if (e.pointerId != null && selectionLayer.setPointerCapture) {
        try {
          selectionLayer.setPointerCapture(e.pointerId);
        } catch (err) {}
      }
      processTimelineMove(e);
      e.preventDefault();
    });
    selectionLayer.addEventListener("pointermove", onTimelinePointerMove);
    selectionLayer.addEventListener("pointerup", onTimelinePointerUp);
    selectionLayer.addEventListener("pointercancel", onTimelinePointerUp);
  }
  timeline.addEventListener("click", function (e) {
    if (
      e.target &&
      e.target.classList &&
      e.target.classList.contains("tl-segment") &&
      e.detail === 0
    )
      selectSegment(parseInt(e.target.dataset.segmentIndex, 10), true);
  });
  timeline.addEventListener("keydown", function (e) {
    var v = byId("vid");
    if (!v || !v.duration) return;
    if (
      e.target &&
      e.target.classList &&
      e.target.classList.contains("tl-segment")
    ) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var index = parseInt(e.target.dataset.segmentIndex, 10);
      var full = videoDuration();
      var c = selPath ? clips[selPath] : null;
      var segments = clipSegments(c, full);
      if (!c || !segments[index]) return;
      c.activeSegment = index;
      var moveDelta =
        (e.shiftKey ? 0.1 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1);
      var moved = moveActiveSegment(segments[index].start + moveDelta);
      paintTrimChrome();
      if (moved) seekPreview(moved.start);
      renderClips();
      reqPreview();
      return;
    }
    if (e.target && (e.target.id === "tl-in" || e.target.id === "tl-out")) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var state = paintTrimChrome();
      var endpoint = e.target.id === "tl-in" ? "start" : "end";
      var current = state.bounds[endpoint];
      var delta = (e.shiftKey ? 0.1 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1);
      var value =
        endpoint === "start"
          ? applyTrimStart(current + delta)
          : applyTrimEnd(current + delta);
      paintTrimChrome();
      seekPreview(value);
      renderClips();
      reqPreview();
      return;
    }
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
  var isMuted = muted || (byId("vbar") && Number(byId("vbar").value) === 0);
  btn.innerHTML = isMuted ? ICON_MUTE : ICON_VOL;
  btn.title = isMuted ? "Unmute preview" : "Mute preview";
  btn.setAttribute("aria-label", isMuted ? "Unmute preview" : "Mute preview");
}

updateMuteIcon();

function toggleMute() {
  if (muted || Number(byId("vbar").value) === 0) {
    byId("vbar").value = volBefore;
    muted = false;
  } else {
    volBefore = parseInt(byId("vbar").value, 10) || 80;
    byId("vbar").value = 0;
    muted = true;
  }
  if (window.AudioTimeline) AudioTimeline.applyPreviewVolume();
  else byId("vid").volume = muted ? 0 : volBefore / 100;
  updateMuteIcon();
}

function setVol(value) {
  muted = value == 0;
  if (!muted) volBefore = parseInt(value, 10) || volBefore;
  if (window.AudioTimeline) AudioTimeline.applyPreviewVolume();
  else byId("vid").volume = value / 100;
  updateMuteIcon();
}
