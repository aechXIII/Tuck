(function (root, factory) {
  "use strict";

  var core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  if (root) {
    root.TimelineCore = core;
  }
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var ZOOM_MIN = 1;
  var ZOOM_MAX = 8;
  var RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

  function trackActions(kind) {
    if (kind === "source") return ["mute"];
    if (kind === "imported") return ["mute", "remove"];
    return [];
  }

  function clampZoom(level) {
    var numeric = Number(level);
    if (!Number.isFinite(numeric)) return ZOOM_MIN;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, numeric));
  }

  function anchorScrollLeft(viewportWidth, contentWidth, anchorRatio) {
    var viewport = Math.max(0, Number(viewportWidth) || 0);
    var content = Math.max(0, Number(contentWidth) || 0);
    var ratio = Math.min(1, Math.max(0, Number(anchorRatio) || 0));
    var maximum = Math.max(0, content - viewport);
    return Math.min(maximum, Math.max(0, content * ratio - viewport / 2));
  }

  function rulerStep(duration, pixelsPerSecond) {
    var pps = Number(pixelsPerSecond);
    if (Number.isFinite(pps) && pps > 0) {
      var desiredSeconds = 32 / pps;
      for (var index = 0; index < RULER_STEPS.length; index += 1) {
        if (RULER_STEPS[index] >= desiredSeconds) return RULER_STEPS[index];
      }
      return RULER_STEPS[RULER_STEPS.length - 1];
    }

    var full = Math.max(0, Number(duration) || 0);
    if (full <= 30) return 2;
    if (full <= 90) return 5;
    if (full <= 180) return 10;
    if (full <= 420) return 15;
    return 30;
  }

  function rulerMajorEvery(step, pixelsPerSecond) {
    var minor = Number(step);
    var pps = Number(pixelsPerSecond);
    if (!Number.isFinite(minor) || minor <= 0) return 1;
    if (!Number.isFinite(pps) || pps <= 0) return 5;
    return Math.max(1, Math.ceil(170 / (minor * pps)));
  }

  function editKeyIntent(target, key, largeStep) {
    var direction = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (!direction || !target) return null;
    var delta = (largeStep ? 0.1 : 0.01) * direction;
    if (
      target.classList &&
      typeof target.classList.contains === "function" &&
      target.classList.contains("tl-segment")
    ) {
      return {
        type: "segment",
        index: parseInt(target.dataset.segmentIndex, 10),
        delta: delta,
        snap: false,
      };
    }
    if (target.id === "tl-in" || target.id === "tl-out") {
      return {
        type: "trim",
        endpoint: target.id === "tl-in" ? "start" : "end",
        delta: delta,
        snap: false,
      };
    }
    return null;
  }

  function segmentPresentationState(index, activeIndex) {
    return {
      className: "tl-segment" + (index === activeIndex ? " active" : ""),
    };
  }

  function clipFill(kind, selected, muted, segmentColor) {
    if (muted) return "#22222B";
    if (kind === "source") return "#4C3A86";
    if (kind === "imported") return segmentColor || "#115E56";
    return selected ? "#6D28D9" : segmentColor || "#6D28D9";
  }

  function videoSegmentSelected(index, activeIndex, sourceGroupSelected) {
    return index === activeIndex && !!sourceGroupSelected;
  }

  return {
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    trackActions: trackActions,
    clampZoom: clampZoom,
    anchorScrollLeft: anchorScrollLeft,
    rulerStep: rulerStep,
    rulerMajorEvery: rulerMajorEvery,
    editKeyIntent: editKeyIntent,
    segmentPresentationState: segmentPresentationState,
    clipFill: clipFill,
    videoSegmentSelected: videoSegmentSelected,
  };
});

(function (root) {
  "use strict";

  if (!root || !root.document) return;

  var snapOn = true;
  var timelineZoom = 1;
  var TL_ZOOM_MIN = root.TimelineCore.ZOOM_MIN;
  var TL_SNAP_PX = 8;

var _tlDrag = null;
var _MIN_TRIM = SegmentEditing.MIN_DURATION;

var _segmentDragOffset = 0;
var _segmentPointerX = 0;
var _segmentClickTime = 0;
var _SEGMENT_DRAG_THRESHOLD = 5;
var _SEGMENT_COLORS = [
  "#6D28D9",
  "#A855F7",
  "#8B5CF6",
  "#C084FC",
  "#7E22CE",
  "#9333EA",
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

function clipHasTrim(c, fullDur) {
  var segments = clipSegments(c, fullDur);
  return !SegmentEditing.isFullSource(segments, fullDur);
}

function setClipSegments(c, segments, active) {
  c.segments = segments.map(function (segment) {
    var item = { start: segment.start, end: segment.end };
    if (segment.muted) item.muted = true;
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


function formatSegmentTime(seconds) {
  var centiseconds = Math.round(Math.max(0, seconds) * 100);
  var wholeSeconds = Math.floor(centiseconds / 100);
  var fraction = centiseconds % 100;
  return fmtt(wholeSeconds) +
    (fraction ? "." + String(fraction).padStart(2, "0").replace(/0$/, "") : "");
}

function paintTrimChrome() {
  var c = selPath ? clips[selPath] : null;
  var probeStatus = c ? TuckProbeState.status(c) : "empty";
  var full = probeStatus === "ready" ? videoDuration() : 0;
  var view = SegmentEditing.timelineViewState(c, full);
  if (probeStatus === "error") view = { status: "error", items: [] };
  var ready = view.status === "ready";
  var editor = byId("audio-editor");
  var emptyState = byId("timeline-empty");
  if (editor) {
    editor.classList.toggle("is-empty", view.status === "empty");
    editor.classList.toggle("is-loading", view.status === "loading");
    editor.classList.toggle("is-error", view.status === "error");
  }
  if (emptyState) {
    emptyState.hidden = ready;
    var emptyTitle = emptyState.querySelector(".timeline-empty-title");
    var emptyCopy = emptyState.querySelector(".timeline-empty-copy");
    if (emptyTitle)
      emptyTitle.textContent =
        view.status === "loading"
          ? "Preparing timeline"
          : view.status === "error"
            ? "Clip details unavailable"
            : "Timeline is empty";
    if (emptyCopy)
      emptyCopy.textContent =
        view.status === "loading"
          ? "Reading clip duration and audio tracks"
          : view.status === "error"
            ? "Retry from the Video inspector to enable editing."
          : "Video and audio tracks will appear here.";
  }
  var ruler = byId("sequence-ruler");
  if (ruler) {
    ruler.classList.toggle("hid", !ready);
    if (ready) paintSequenceRuler(full);
  }
  var segmentsLayer = byId("tl-segments");
  segmentsLayer.replaceChildren();
  var timeline = byId("timeline");
  timeline.setAttribute("aria-disabled", ready ? "false" : "true");
  timeline.setAttribute("tabindex", ready ? "0" : "-1");
  byId("tl-in").classList.toggle("hid", !ready);
  byId("tl-out").classList.toggle("hid", !ready);
  byId("seq-playhead-layer").classList.toggle("hid", !ready);
  byId("btn-seq-split").disabled = !ready;
  byId("btn-snap-toggle").disabled = !ready;
  byId("audio-add").disabled = !ready;
  byId("tl-zoom-slider").disabled = !ready;
  var zoomButtons = document.querySelectorAll(".dock-zoom-btn, .dock-fit-btn");
  for (var z = 0; z < zoomButtons.length; z++) zoomButtons[z].disabled = !ready;

  var resetButton = byId("btn-segments-reset");
  var removeButton = byId("btn-segment-remove");
  var addButton = byId("btn-segment-add");
  if (!ready) {
    resetButton.disabled = true;
    resetButton.classList.add("hid");
    removeButton.disabled = true;
    addButton.disabled = true;
    addButton.setAttribute("aria-disabled", "true");
    addButton.dataset.tip =
      view.status === "loading"
        ? "Preparing timeline"
        : view.status === "error"
          ? "Retry clip details first"
          : "Add a video first";
    return {
      full: 0,
      bounds: { start: 0, end: 0 },
      has: false,
      segments: [],
      active: 0,
      status: view.status,
    };
  }

  var segments = view.items;
  var active = activeSegmentIndex(c, segments);
  var sourceGroupSelected =
    window.AudioTimeline && typeof AudioTimeline.isSourceGroupSelected === "function"
      ? AudioTimeline.isSourceGroupSelected()
      : true;
  var bounds = segments[active];
  var startPct = full > 0 ? (bounds.start / full) * 100 : 0;
  var endPct = full > 0 ? (bounds.end / full) * 100 : 100;
  for (var i = 0; i < segments.length; i++) {
    var segmentAudioMuted = !!segments[i].muted;
    var presentation = TimelineCore.segmentPresentationState(i, active);
    var range = document.createElement("button");
    range.type = "button";
    range.className = presentation.className;
    range.dataset.segmentIndex = String(i);
    range.style.setProperty("--segment-color", segmentColor(i));
    range.style.setProperty(
      "--clip-fill",
      root.TimelineCore.clipFill(
        "video",
        root.TimelineCore.videoSegmentSelected(i, active, sourceGroupSelected),
        false,
        segmentColor(i),
      ),
    );
    range.style.left = (segments[i].start / (full || 1)) * 100 + "%";
    range.style.width =
      ((segments[i].end - segments[i].start) / (full || 1)) * 100 + "%";
    range.setAttribute(
      "aria-label",
      "Segment " +
        (i + 1) +
        ", " +
        formatSegmentTime(segments[i].start) +
        " to " +
        formatSegmentTime(segments[i].end) +
        (segmentAudioMuted ? ", source audio muted" : "") +
        ". Click to seek; drag to move",
    );
    range.setAttribute(
      "aria-pressed",
      i === active && sourceGroupSelected ? "true" : "false",
    );
    range.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
    var surface = document.createElement("span");
    surface.className = "tl-segment-surface";
    var touchesPrevious =
      i > 0 && Math.abs(segments[i - 1].end - segments[i].start) < 0.001;
    var touchesNext =
      i + 1 < segments.length &&
      Math.abs(segments[i].end - segments[i + 1].start) < 0.001;
    range.classList.toggle("joins-previous", touchesPrevious);
    range.classList.toggle("joins-next", touchesNext);
    var badgeLabel = document.createElement("span");
    badgeLabel.className = "tl-segment-badge";
    badgeLabel.setAttribute("aria-hidden", "true");
    badgeLabel.textContent = segments[i].badge;
    var copy = document.createElement("span");
    copy.className = "tl-segment-copy";
    var nameLabel = document.createElement("span");
    nameLabel.className = "tl-segment-label";
    nameLabel.textContent = c ? c.name : "";
    var rangeLabel = document.createElement("span");
    rangeLabel.className = "tl-segment-range";
    rangeLabel.setAttribute("aria-hidden", "true");
    var timeText =
      formatSegmentTime(segments[i].start) +
      "–" +
      formatSegmentTime(segments[i].end) +
      " · " +
      formatSelectedDuration(segments[i].end - segments[i].start);
    rangeLabel.textContent = timeText;
    copy.append(nameLabel, rangeLabel);
    surface.append(badgeLabel, copy);
    range.appendChild(surface);
    var timeLabel = document.createElement("span");
    timeLabel.className = "tl-segment-time";
    timeLabel.setAttribute("aria-hidden", "true");
    timeLabel.textContent = timeText;
    range.appendChild(timeLabel);
    var edgeIn = document.createElement("span");
    edgeIn.className = "clip-edge start";
    edgeIn.dataset.edge = "start";
    var edgeOut = document.createElement("span");
    edgeOut.className = "clip-edge end";
    edgeOut.dataset.edge = "end";
    range.append(edgeIn, edgeOut);
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
  resetButton.disabled = !has;
  resetButton.classList.toggle("hid", !has);
  removeButton.disabled = segments.length <= 1;
  var canAdd = SegmentEditing.canAddSegment(segments, full || 1);
  addButton.disabled = !canAdd;
  addButton.setAttribute("aria-disabled", canAdd ? "false" : "true");
  addButton.dataset.tip = canAdd ? "New segment" : "Shorten a segment first";
  if (window.AudioTimeline && AudioTimeline.paintSource)
    AudioTimeline.paintSource();
  if (window.AudioTimeline && AudioTimeline.paintMixer)
    AudioTimeline.paintMixer();
  return {
    full: full,
    bounds: bounds,
    has: has,
    segments: segments,
    active: active,
    status: view.status,
  };
}

function paintSelectionFrame(startPct, endPct, color) {
  var frame = byId("seq-selection");
  if (frame) frame.hidden = true;
  var tlIn = byId("tl-in");
  if (tlIn) {
    tlIn.classList.remove("hid");
    tlIn.classList.add("sr-handle");
    tlIn.style.left = startPct + "%";
    tlIn.style.setProperty("--segment-color", color);
  }
  var tlOut = byId("tl-out");
  if (tlOut) {
    tlOut.classList.remove("hid");
    tlOut.classList.add("sr-handle");
    tlOut.style.left = endPct + "%";
    tlOut.style.setProperty("--segment-color", color);
  }
}

function paintSequenceRuler(full) {
  var ruler = byId("sequence-ruler");
  if (!ruler) return;
  ruler.replaceChildren();
  if (full <= 0) return;
  var pixelsPerSecond = timelinePxPerSecond();
  var step = root.TimelineCore.rulerStep(full, pixelsPerSecond);
  var majorEvery = root.TimelineCore.rulerMajorEvery(step, pixelsPerSecond);
  var index = 0;
  for (var t = 0; t <= full + 0.0001; t += step, index += 1) {
    var tick = document.createElement("span");
    var isEndpoint = Math.abs(t - full) < 0.001;
    var isMajor = index % majorEvery === 0 || isEndpoint;
    tick.className = "seq-tick" + (isMajor ? " major" : "");
    tick.style.left = (t / full) * 100 + "%";
    if (isMajor) {
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
  if (typeof applyTimelineZoom === "function") applyTimelineZoom();
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
  var tlTime = byId("tl-time");
  if (tlTime)
    tlTime.textContent =
      formatTimelineTime(sec) + " / " + formatTimelineTime(full || 0);
  var playheadTime = byId("seq-playhead-time");
  if (playheadTime) playheadTime.textContent = formatTimelineTime(sec);
  paintStageScrub(pct);
  _previewSec = sec;
}

function formatTimelineTime(seconds) {
  var centiseconds = Math.round(Math.max(0, seconds) * 100);
  var whole = Math.floor(centiseconds / 100);
  var fraction = centiseconds % 100;
  return fmtt(whole) + "." + String(fraction).padStart(2, "0");
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
  paintTrimChrome();
  seekPreview(time);
  renderClips();
  reqPreview();
  if (window.AudioTimeline) AudioTimeline.render();
}


var _tlMoveRaf = 0;
var _tlMoveEvent = null;


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

function segmentSnapCandidates(segments, active, full) {
  var points = [0, full];
  var v = byId("vid");
  if (v) points.push(v.currentTime);
  for (var i = 0; i < segments.length; i++) {
    if (i === active) continue;
    points.push(segments[i].start, segments[i].end);
  }
  return points;
}

function applyTrimStart(sec, snap) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  if (snap !== false && typeof snapCandidateTime === "function")
    sec = snapCandidateTime(
      sec,
      segmentSnapCandidates(segments, active, full),
      timelinePxPerSecond(),
    );
  segments = SegmentEditing.editEndpoint(segments, active, "start", sec, full);
  setClipSegments(c, segments, active);
  return segments[active].start;
}

function applyTrimEnd(sec, snap) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  if (snap !== false && typeof snapCandidateTime === "function")
    sec = snapCandidateTime(
      sec,
      segmentSnapCandidates(segments, active, full),
      timelinePxPerSecond(),
    );
  segments = SegmentEditing.editEndpoint(segments, active, "end", sec, full);
  setClipSegments(c, segments, active);
  return segments[active].end;
}

function canTrimActiveSegmentToPlayhead() {
  if (!selPath || !clips[selPath]) return false;
  var full =
    videoDuration() ||
    (clips[selPath].probeData && clips[selPath].probeData.duration) ||
    0;
  var video = byId("vid");
  return full > 0 && !!video && Number.isFinite(video.currentTime);
}

function trimActiveSegmentToPlayhead(endpoint) {
  if (!canTrimActiveSegmentToPlayhead()) return null;
  var time = byId("vid").currentTime;
  var value =
    endpoint === "start"
      ? applyTrimStart(time, false)
      : applyTrimEnd(time, false);
  paintTrimChrome();
  renderClips();
  reqPreview();
  if (window.AudioTimeline) AudioTimeline.render();
  return value;
}

function moveActiveSegment(start, snap) {
  if (!selPath || !clips[selPath]) return null;
  var c = clips[selPath];
  var full = videoDuration() || (c.probeData && c.probeData.duration) || 0;
  if (full <= 0) return null;
  var segments = clipSegments(c, full);
  var active = activeSegmentIndex(c, segments);
  if (snap !== false && typeof snapCandidateTime === "function") {
    var duration = segments[active].end - segments[active].start;
    var candidates = segmentSnapCandidates(segments, active, full).reduce(function (acc, p) {
      acc.push(p, p - duration);
      return acc;
    }, []);
    start = snapCandidateTime(start, candidates, timelinePxPerSecond());
  }
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
  paintTrimChrome();
  seekPreview(0);
  renderClips();
  reqPreview();
  if (window.AudioTimeline) AudioTimeline.render();
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
    var pixelsPerSecond = timelinePxPerSecond();
    var preferredDuration = pixelsPerSecond > 0 ? Math.max(1, 64 / pixelsPerSecond) : 1;
    var result = SegmentEditing.addSegment(
      clipSegments(c, full),
      full,
      byId("vid").currentTime,
      preferredDuration,
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

function canRemoveActiveSegment() {
  if (!selPath || !clips[selPath]) return false;
  var clip = clips[selPath];
  var full = videoDuration() || (clip.probeData && clip.probeData.duration) || 0;
  return clipSegments(clip, full).length > 1;
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

function setRulerScrubCursor(active) {
  var ruler = byId("sequence-ruler");
  if (ruler) ruler.classList.toggle("scrubbing", !!active);
  document.body.classList.toggle("timeline-scrubbing", !!active);
}

function onTimelinePointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  if (window.AudioTimeline && typeof AudioTimeline.selectVideoTrack === "function")
    AudioTimeline.selectVideoTrack();
  var target = e.target;
  var edge = target && target.closest ? target.closest(".clip-edge") : null;
  var isSegment =
    target && target.classList && target.classList.contains("tl-segment");
  if (edge && edge.dataset.edge) {
    var edgeName = edge.dataset.edge;
    var edgeSegment = edge.closest(".tl-segment");
    if (edgeSegment) {
      var edgeIndex = parseInt(edgeSegment.dataset.segmentIndex, 10);
      selectSegment(edgeIndex, false);
      edge = byId("tl-segments").querySelector(
        '.tl-segment[data-segment-index="' +
          edgeIndex +
          '"] .clip-edge.' +
          (edgeName === "start" ? "start" : "end"),
      );
    }
    _tlDrag = edgeName === "start" ? "in" : "out";
    if (edge) edge.classList.add("dragging");
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
  if (window.History && (_tlDrag === "in" || _tlDrag === "out" || _tlDrag === "segment-pending"))
    History.begin(selPath);
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
  if (window.History) {
    if (wasEdit) History.commit();
    else History.cancel();
  }
  if (wasSegmentClick) seekPreview(_segmentClickTime);
  byId("tl-in").classList.remove("dragging");
  byId("tl-out").classList.remove("dragging");
  var edgeHandles = document.querySelectorAll(".clip-edge.dragging");
  for (var i = 0; i < edgeHandles.length; i++) edgeHandles[i].classList.remove("dragging");
  setTrimDragCursor(false);
  setSegmentDragCursor(false);
  if (_tlDrag === "ruler") setRulerScrubCursor(false);
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

function handleTimelineEditKey(e) {
  var v = byId("vid");
  if (!v || !v.duration) return;
  var intent = root.TimelineCore.editKeyIntent(e.target, e.key, e.shiftKey);
  if (!intent) return;
  e.preventDefault();
  var full = videoDuration();
  var c = selPath ? clips[selPath] : null;
  var segments = clipSegments(c, full);
  if (!c) return;
  if (intent.type === "segment") {
    if (!segments[intent.index]) return;
    c.activeSegment = intent.index;
    var moved = moveActiveSegment(
      segments[intent.index].start + intent.delta,
      intent.snap,
    );
    paintTrimChrome();
    if (moved) seekPreview(moved.start);
  } else {
    var state = paintTrimChrome();
    var current = state.bounds[intent.endpoint];
    var value =
      intent.endpoint === "start"
        ? applyTrimStart(current + intent.delta, intent.snap)
        : applyTrimEnd(current + intent.delta, intent.snap);
    paintTrimChrome();
    seekPreview(value);
  }
  renderClips();
  reqPreview();
}

(function bindTimeline() {
  var timeline = byId("timeline");
  if (!timeline) return;
  var ruler = byId("sequence-ruler");
  if (ruler) {
    ruler.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      _tlDrag = "ruler";
      setRulerScrubCursor(true);
      if (e.pointerId != null && ruler.setPointerCapture) {
        try {
          ruler.setPointerCapture(e.pointerId);
        } catch (err) {}
      }
      processTimelineMove(e);
      e.preventDefault();
    });
    ruler.addEventListener("pointermove", onTimelinePointerMove);
    ruler.addEventListener("pointerup", onTimelinePointerUp);
    ruler.addEventListener("pointercancel", onTimelinePointerUp);
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
    selectionLayer.addEventListener("keydown", handleTimelineEditKey);
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
  timeline.addEventListener("keydown", handleTimelineEditKey);
})();


function toggleSnap() {
  snapOn = !snapOn;
  var btn = byId("btn-snap-toggle");
  if (btn) {
    btn.classList.toggle("on", snapOn);
    btn.setAttribute("aria-pressed", String(snapOn));
  }
}

function snapCandidateTime(time, candidates, pxPerSecond) {
  if (!snapOn || !pxPerSecond) return time;
  var thresholdSec = TL_SNAP_PX / pxPerSecond;
  var best = time;
  var bestDist = thresholdSec;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c == null) continue;
    var dist = Math.abs(c - time);
    if (dist <= bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

function timelinePxPerSecond() {
  var track = byId("tl-track");
  var full = typeof videoDuration === "function" ? videoDuration() : 0;
  if (!track || !full) return 0;
  return track.getBoundingClientRect().width / full;
}

function timelineAnchorRatio() {
  var full = videoDuration();
  var video = byId("vid");
  if (!full || !video || !Number.isFinite(video.currentTime)) return 0;
  return Math.min(1, Math.max(0, video.currentTime / full));
}

function applyTimelineZoom(anchorRatio) {
  var frame = byId("sequence-frame");
  if (!frame) return;
  var anchor = Number.isFinite(anchorRatio) ? anchorRatio : timelineAnchorRatio();
  var zoomed = timelineZoom > TL_ZOOM_MIN;
  frame.classList.toggle("is-zoomed", zoomed);
  if (zoomed) {
    var base = Math.max(0, frame.clientWidth - 1);
    if (base > 0) {
      var contentWidth = base * timelineZoom;
      frame.style.setProperty("--tl-width", contentWidth + "px");
      frame.scrollLeft = root.TimelineCore.anchorScrollLeft(
        frame.clientWidth,
        contentWidth,
        anchor,
      );
    }
  } else {
    frame.style.removeProperty("--tl-width");
    frame.scrollLeft = 0;
  }
  var slider = byId("tl-zoom-slider");
  if (slider && document.activeElement !== slider) slider.value = String(timelineZoom);
  var full = videoDuration();
  if (full > 0) paintSequenceRuler(full);
}

function setTimelineZoom(level) {
  var anchor = timelineAnchorRatio();
  timelineZoom = root.TimelineCore.clampZoom(level);
  applyTimelineZoom(anchor);
}

function nudgeTimelineZoom(delta) {
  setTimelineZoom(timelineZoom + delta);
}

function fitTimeline() {
  timelineZoom = TL_ZOOM_MIN;
  applyTimelineZoom(0);
}

var timelineResizeState = null;
var timelineHeightSetting = 0;
var timelineTrackCount = 2;

function updateTimelineResizeA11y(height) {
  var separator = byId("timeline-resizer");
  if (!separator || !window.TuckLayout) return;
  var bounds = TuckLayout.timelineHeightBounds(window.innerHeight);
  separator.setAttribute("aria-valuemin", String(bounds.min));
  separator.setAttribute("aria-valuemax", String(bounds.max));
  separator.setAttribute("aria-valuenow", String(height));
  separator.setAttribute("aria-valuetext", height + " pixels");
}

function refreshAfterTimelineResize() {
  applyTimelineZoom();
  if (typeof paintCropOverlay === "function") paintCropOverlay();
}

function applyTimelineHeight(value) {
  var editor = byId("audio-editor");
  if (!editor || !window.TuckLayout) return 0;
  var height = TuckLayout.clampTimelineHeight(
    value,
    window.innerHeight,
    timelineTrackCount,
  );
  editor.style.height = height + "px";
  updateTimelineResizeA11y(height);
  refreshAfterTimelineResize();
  return height;
}

function syncTimelineTrackCount(importedCount) {
  var count = Math.max(0, Math.round(Number(importedCount) || 0));
  timelineTrackCount = 2 + count;
  if (!window.TuckLayout) return;
  var height = TuckLayout.timelineHeightForTrackCount(
    timelineHeightSetting,
    timelineTrackCount,
    window.innerHeight,
  );
  if (height != null) applyTimelineHeight(height);
}

function saveTimelineHeight(value) {
  timelineHeightSetting = value > 0 ? Math.round(value) : 0;
  if (window.appSettings) appSettings.timeline_height = timelineHeightSetting;
  if (!api || typeof api.saveSettings !== "function") return;
  api
    .saveSettings({ timeline_height: timelineHeightSetting })
    .then(function (response) {
      if (!response.ok) toast(response.error || "Could not save timeline height.", "err");
    })
    .catch(function () {
      toast("Could not save timeline height.", "err");
    });
}

function restoreTimelineHeight(value) {
  timelineHeightSetting = TuckLayout.normalizeTimelineHeightSetting(
    value,
    window.innerHeight,
  );
  return applyTimelineHeight(timelineHeightSetting);
}

function beginTimelineResize(event) {
  if (event.button !== 0 || !window.TuckLayout) return;
  var editor = byId("audio-editor");
  var separator = byId("timeline-resizer");
  if (!editor || !separator) return;
  event.preventDefault();
  timelineResizeState = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: editor.getBoundingClientRect().height,
  };
  document.body.classList.add("timeline-resizing");
  if (separator.setPointerCapture && event.pointerId != null) {
    try {
      separator.setPointerCapture(event.pointerId);
    } catch (error) {}
  }
}

function moveTimelineResize(event) {
  if (!timelineResizeState || event.pointerId !== timelineResizeState.pointerId) return;
  event.preventDefault();
  applyTimelineHeight(
    timelineResizeState.startHeight + timelineResizeState.startY - event.clientY,
  );
}

function endTimelineResize(event) {
  if (!timelineResizeState || event.pointerId !== timelineResizeState.pointerId) return;
  var separator = byId("timeline-resizer");
  var editor = byId("audio-editor");
  timelineResizeState = null;
  document.body.classList.remove("timeline-resizing");
  if (
    separator &&
    event.pointerId != null &&
    separator.releasePointerCapture &&
    separator.hasPointerCapture(event.pointerId)
  ) {
    separator.releasePointerCapture(event.pointerId);
  }
  if (editor) saveTimelineHeight(editor.getBoundingClientRect().height);
}

function handleTimelineResizeKey(event) {
  if (!window.TuckLayout) return;
  var editor = byId("audio-editor");
  if (!editor) return;
  var next = TuckLayout.timelineHeightForKey(
    editor.getBoundingClientRect().height,
    event.key,
    event.shiftKey,
    window.innerHeight,
  );
  if (next == null) return;
  event.preventDefault();
  saveTimelineHeight(applyTimelineHeight(next));
}

function resetTimelineHeight(event) {
  if (event) event.preventDefault();
  saveTimelineHeight(0);
  applyTimelineHeight(0);
}

function initTimelineResizer() {
  var separator = byId("timeline-resizer");
  if (!separator) return;
  window.addEventListener("resize", function () {
    applyTimelineHeight(timelineHeightSetting);
  });
  separator.addEventListener("pointerdown", beginTimelineResize);
  window.addEventListener("pointermove", moveTimelineResize);
  window.addEventListener("pointerup", endTimelineResize);
  window.addEventListener("pointercancel", endTimelineResize);
  separator.addEventListener("keydown", handleTimelineResizeKey);
  separator.addEventListener("dblclick", resetTimelineHeight);
  restoreTimelineHeight(TuckLayout.initialTimelineHeightSetting(root.appSettings));
}



  root.TuckShortcuts.registerAction("timeline.zoom-in", {
    enabled: function () {
      return !!selPath;
    },
    execute: function () {
      nudgeTimelineZoom(1);
    },
  });
  root.TuckShortcuts.registerAction("timeline.zoom-out", {
    enabled: function () {
      return !!selPath;
    },
    execute: function () {
      nudgeTimelineZoom(-1);
    },
  });
  root.TuckShortcuts.registerAction("timeline.fit", {
    enabled: function () {
      return !!selPath;
    },
    execute: fitTimeline,
  });

  var api = {
    isDragging: function () { return !!_tlDrag; },
    addSegment: addSegment,
    applyTimelineZoom: applyTimelineZoom,
    canTrimActiveSegmentToPlayhead: canTrimActiveSegmentToPlayhead,
    canRemoveActiveSegment: canRemoveActiveSegment,
    clipSegments: clipSegments,
    fitTimeline: fitTimeline,
    nudgeTimelineZoom: nudgeTimelineZoom,
    paintTrimChrome: paintTrimChrome,
    playbackSegments: playbackSegments,
    removeActiveSegment: removeActiveSegment,
    resetTimelineHeight: resetTimelineHeight,
    resetSegments: resetSegments,
    restoreTimelineHeight: restoreTimelineHeight,
    segmentColor: segmentColor,
    setClipSegments: setClipSegments,
    setPlayheadUI: setPlayheadUI,
    setTimelineZoom: setTimelineZoom,
    snapCandidateTime: snapCandidateTime,
    splitAtPlayhead: splitAtPlayhead,
    syncTimelineTrackCount: syncTimelineTrackCount,
    syncTimelineUI: syncTimelineUI,
    timelinePxPerSecond: timelinePxPerSecond,
    toggleSnap: toggleSnap,
    trimActiveSegmentToPlayhead: trimActiveSegmentToPlayhead,
    videoDuration: videoDuration,
  };
  root.Timeline = api;
  Object.keys(api).forEach(function (name) { root[name] = api[name]; });
  initTimelineResizer();
})(typeof window !== "undefined" ? window : null);
