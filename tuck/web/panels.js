var libraryTab = "media";
var inspectorTab = "edit";
var snapOn = true;
var timelineZoom = 1;
var TL_ZOOM_MIN = 1;
var TL_ZOOM_MAX = 8;
var TL_SNAP_PX = 8;
var workspaceViewportMode = "";
var workspacePanels = { libraryOpen: true, inspectorOpen: true };
var workspaceReturnFocus = null;

function applyWorkspacePanels(restoreFocus) {
  var overlay = workspaceViewportMode === "overlay";
  var drawerOpen = overlay && (workspacePanels.libraryOpen || workspacePanels.inspectorOpen);
  document.body.classList.add("workspace-ready");
  document.body.classList.toggle("workspace-overlay", overlay);
  document.body.classList.toggle("library-panel-open", workspacePanels.libraryOpen);
  document.body.classList.toggle("inspector-panel-open", workspacePanels.inspectorOpen);
  document.body.classList.toggle(
    "workspace-drawer-open",
    drawerOpen,
  );
  byId("center").inert = drawerOpen;
  byId("audio-editor").inert = drawerOpen;
  byId("qbar").inert = drawerOpen;
  [
    ["library", "left", "panel-toggle-library", "library-panel-close"],
    ["inspector", "right", "panel-toggle-inspector", "inspector-panel-close"],
  ].forEach(function (entry) {
    var open = workspacePanels[entry[0] + "Open"];
    var panel = byId(entry[1]);
    var toggle = byId(entry[2]);
    var close = byId(entry[3]);
    panel.setAttribute("aria-hidden", String(!open));
    panel.inert = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("on", open);
    close.setAttribute("aria-label", (overlay ? "Close " : "Hide ") + entry[0]);
    if (overlay && open) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", entry[0] === "library" ? "Library" : "Inspector");
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
      panel.removeAttribute("aria-label");
    }
  });
  if (restoreFocus && workspaceReturnFocus && workspaceReturnFocus.isConnected)
    workspaceReturnFocus.focus();
  if (!workspacePanels.libraryOpen && !workspacePanels.inspectorOpen)
    workspaceReturnFocus = null;
}

function toggleWorkspacePanel(panel) {
  if (panel !== "library" && panel !== "inspector") return;
  var wasOpen = panel === "library" ? workspacePanels.libraryOpen : workspacePanels.inspectorOpen;
  if (workspaceViewportMode === "overlay" && !wasOpen) {
    workspaceReturnFocus = document.activeElement;
  } else if (workspaceViewportMode === "docked" && wasOpen) {
    workspaceReturnFocus = byId(
      panel === "library" ? "panel-toggle-library" : "panel-toggle-inspector",
    );
  }
  workspacePanels = TuckLayout.toggleWorkspacePanelState(
    workspacePanels,
    panel,
    window.innerWidth,
  );
  applyWorkspacePanels(wasOpen);
  if (workspaceViewportMode === "overlay" && !wasOpen) {
    var close = byId(panel === "library" ? "library-panel-close" : "inspector-panel-close");
    if (close) close.focus();
  }
}

function closeWorkspacePanels(restoreFocus) {
  if (workspaceViewportMode !== "overlay") return;
  workspacePanels = { libraryOpen: false, inspectorOpen: false };
  applyWorkspacePanels(!!restoreFocus);
}

function trapWorkspaceDrawerFocus(event) {
  if (event.key !== "Tab" || workspaceViewportMode !== "overlay") return false;
  var panel = workspacePanels.libraryOpen
    ? byId("left")
    : workspacePanels.inspectorOpen
      ? byId("right")
      : null;
  if (!panel) return false;
  var focusable = Array.prototype.filter.call(
    panel.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
    function (element) {
      return element.offsetParent !== null && !element.inert;
    },
  );
  if (!focusable.length) return false;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (!panel.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

function syncWorkspaceForViewport() {
  var nextMode = TuckLayout.workspaceMode(window.innerWidth);
  if (nextMode !== workspaceViewportMode) {
    workspaceViewportMode = nextMode;
    workspacePanels = TuckLayout.initialWorkspacePanels(window.innerWidth);
  }
  applyWorkspacePanels(false);
}

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

function applyTimelineZoom() {
  var frame = byId("sequence-frame");
  if (!frame) return;
  var zoomed = timelineZoom > TL_ZOOM_MIN;
  frame.classList.toggle("is-zoomed", zoomed);
  if (zoomed) {
    var base = Math.max(0, frame.clientWidth - 1);
    if (base > 0) frame.style.setProperty("--tl-width", base * timelineZoom + "px");
  } else {
    frame.style.removeProperty("--tl-width");
    frame.scrollLeft = 0;
  }
  var slider = byId("tl-zoom-slider");
  if (slider && document.activeElement !== slider) slider.value = String(timelineZoom);
}

function setTimelineZoom(level) {
  timelineZoom = Math.max(TL_ZOOM_MIN, Math.min(TL_ZOOM_MAX, Number(level) || 1));
  applyTimelineZoom();
}

function nudgeTimelineZoom(delta) {
  setTimelineZoom(timelineZoom + delta);
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
  var nextTrackCount = 2 + count;
  var addedTrack = nextTrackCount > timelineTrackCount;
  timelineTrackCount = nextTrackCount;
  if (!window.TuckLayout) return;
  if (timelineHeightSetting === 0) {
    applyTimelineHeight(0);
    return;
  }
  if (!addedTrack) return;
  var editor = byId("audio-editor");
  if (!editor) return;
  var required = TuckLayout.timelineAutoHeight(timelineTrackCount, window.innerHeight);
  if (editor.getBoundingClientRect().height + 0.5 < required) {
    saveTimelineHeight(applyTimelineHeight(required));
  }
}

function saveTimelineHeight(value) {
  timelineHeightSetting = value > 0 ? Math.round(value) : 0;
  if (window.appSettings) appSettings.timeline_height = timelineHeightSetting;
  if (!api || typeof api.saveSettings !== "function") return;
  api
    .saveSettings(JSON.stringify({ timeline_height: timelineHeightSetting }))
    .then(function (response) {
      if (!response.ok) toast(response.error || "Could not save timeline height.", "err");
    })
    .catch(function () {
      toast("Could not save timeline height.", "err");
    });
}

function restoreTimelineHeight(value) {
  var numeric = Number(value);
  timelineHeightSetting = Number.isFinite(numeric) && numeric >= 170 ? Math.round(numeric) : 0;
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
  separator.addEventListener("pointerdown", beginTimelineResize);
  window.addEventListener("pointermove", moveTimelineResize);
  window.addEventListener("pointerup", endTimelineResize);
  window.addEventListener("pointercancel", endTimelineResize);
  separator.addEventListener("keydown", handleTimelineResizeKey);
  separator.addEventListener("dblclick", resetTimelineHeight);
  restoreTimelineHeight(0);
}

window.addEventListener("resize", function () {
  applyTimelineHeight(timelineHeightSetting);
  syncWorkspaceForViewport();
});

document.addEventListener(
  "keydown",
  function (event) {
    if (trapWorkspaceDrawerFocus(event)) return;
    if (event.key !== "Escape" || workspaceViewportMode !== "overlay") return;
    if (!workspacePanels.libraryOpen && !workspacePanels.inspectorOpen) return;
    if (document.body.classList.contains("settings-open")) return;
    if (byId("mod-overlay").classList.contains("open")) return;
    event.preventDefault();
    closeWorkspacePanels(true);
  },
  true,
);

function setLibraryTab(tab) {
  libraryTab = tab === "audio" ? "audio" : "media";
  byId("lib-tab-media").classList.toggle("on", libraryTab === "media");
  byId("lib-tab-media").setAttribute("aria-pressed", String(libraryTab === "media"));
  byId("lib-tab-audio").classList.toggle("on", libraryTab === "audio");
  byId("lib-tab-audio").setAttribute("aria-pressed", String(libraryTab === "audio"));
  byId("lib-add-row-media").classList.toggle("hid", libraryTab !== "media");
  byId("lib-add-row-audio").classList.toggle("hid", libraryTab !== "audio");
  byId("lib-panel-media").classList.toggle("hid", libraryTab !== "media");
  byId("lib-panel-audio").classList.toggle("hid", libraryTab !== "audio");
  if (libraryTab === "audio") renderAudioLibraryPanel();
}

function renderAudioLibraryPanel() {
  var list = byId("audio-lib-list");
  var empty = byId("audio-lib-empty");
  if (!list || !empty) return;
  var clip = selPath ? clips[selPath] : null;
  if (!clip) {
    list.replaceChildren();
    empty.textContent = "Select a video to manage audio.";
    empty.classList.remove("hid");
    return;
  }
  var tracks = (clip.audioTimeline && clip.audioTimeline.tracks) || [];
  if (!tracks.length) {
    list.replaceChildren();
    empty.textContent = "No audio yet.";
    empty.classList.remove("hid");
    return;
  }
  empty.classList.add("hid");
  list.replaceChildren();
  tracks.forEach(function (track) {
    var div = document.createElement("div");
    div.className = "clip audio-lib-item";
    div.tabIndex = 0;
    div.innerHTML =
      '<div class="c1"><div class="c2">' +
      esc(track.name) +
      '</div><div class="c3"><span class="c-meta">' +
      esc((track.codec || "audio").toUpperCase()) +
      '</span><span class="c-time">' +
      fmtt(track.sourceDuration || 0) +
      "</span></div></div>";
    div.onclick = function () {
      AudioTimeline.selectTrack(track.id);
      setInspectorTab("audio");
    };
    list.appendChild(div);
  });
}

function setInspectorTab(tab) {
  inspectorTab = tab === "audio" || tab === "export" ? tab : "edit";
  ["edit", "audio", "export"].forEach(function (t) {
    var active = t === inspectorTab;
    byId("insp-tab-" + t).classList.toggle("on", active);
    byId("insp-tab-" + t).setAttribute("aria-pressed", String(active));
    byId("insp-" + t).classList.toggle("hid", !active);
  });
  byId("right-foot").classList.toggle("hid", inspectorTab !== "export");
  if (inspectorTab === "audio") renderAudioMixerList();
}

var CODEC_LABELS = {
  h264: "H.264",
  hevc: "H.265",
  vp9: "VP9",
  av1: "AV1",
  mpeg4: "MPEG-4",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  flac: "FLAC",
  ac3: "AC3",
  eac3: "E-AC3",
  pcm_s16le: "PCM",
};
function formatCodec(name) {
  if (!name) return "";
  return CODEC_LABELS[name.toLowerCase()] || name.toUpperCase();
}

function renderClipDetails() {
  var host = byId("clip-details-body");
  if (!host) return;
  var clip = selPath ? clips[selPath] : null;
  var empty = byId("video-inspector-empty");
  var content = byId("video-inspector-content");
  var selection = byId("video-selection-name");
  if (empty) empty.classList.toggle("hid", Boolean(clip));
  if (content) content.classList.toggle("hid", !clip);
  if (!clip) {
    host.replaceChildren();
    return;
  }
  if (selection) selection.textContent = clip.name || "Selected video";
  if (!clip.probed || !clip.probeData) {
    host.innerHTML = '<div class="cd-empty">Reading clip details…</div>';
    return;
  }
  var d = clip.probeData;
  var format = [
    formatCodec(d.video_codec),
    d.has_audio ? formatCodec(d.audio_codec) : null,
  ]
    .filter(Boolean)
    .join(" / ");
  var rows = [
    ["File", clip.name],
    ["Duration", fmtt(d.duration || 0)],
    ["Resolution", d.width && d.height ? d.width + "×" + d.height : "—"],
    ["Frame rate", d.fps ? Math.round(d.fps * 100) / 100 + " fps" : "—"],
    ["Format", format || "—"],
  ];
  host.innerHTML = rows
    .map(function (row) {
      return (
        '<div class="cd-row"><span class="cd-k">' +
        esc(row[0]) +
        '</span><span class="cd-v">' +
        esc(String(row[1])) +
        "</span></div>"
      );
    })
    .join("");
}

function renderAudioMixerList() {
  var host = byId("audio-track-mixer");
  var count = byId("audio-track-count");
  if (!host) return;
  var clip = selPath ? clips[selPath] : null;
  if (!clip || !clip.audioTimeline) {
    if (count) count.textContent = "0";
    host.innerHTML = '<div class="cd-empty">Select a video clip to mix its audio.</div>';
    renderAudioClipRange();
    return;
  }
  var state = clip.audioTimeline;
  var rows = [];
  var trackNumber = 1;
  if (clip.probeData && clip.probeData.has_audio) {
    rows.push(
      mixerRowHtml({
        id: "source",
        code: "A1",
        name: "Source audio",
        role: "Original",
        muted: state.sourceMuted,
        gain: state.sourceGainDb,
        removable: false,
        color: "#a78bfa",
      }),
    );
    trackNumber = 2;
  }
  state.tracks.forEach(function (track, index) {
    rows.push(
      mixerRowHtml({
        id: track.id,
        code: "A" + (trackNumber + index),
        name: track.name,
        role: "Imported",
        muted: track.muted,
        gain: track.gainDb,
        removable: true,
        color: AudioTimeline.trackColor(index),
      }),
    );
  });
  if (count) count.textContent = String(rows.length);
  if (!rows.length) {
    host.innerHTML = '<div class="cd-empty">No audio on this clip yet. Use “Add audio” on the timeline.</div>';
    renderAudioClipRange();
    return;
  }
  host.innerHTML = rows.join("");
  state.tracks.concat(clip.probeData && clip.probeData.has_audio ? [{ id: "source" }] : []).forEach(
    function (track) {
      var row = host.querySelector('[data-mixer-id="' + track.id + '"]');
      if (!row) return;
      var muteButton = row.querySelector(".mixer-mute");
      var slider = row.querySelector(".mixer-gain");
      var removeBtn = row.querySelector(".mixer-remove");
      if (muteButton)
        muteButton.onclick = function () {
          if (track.id === "source") AudioTimeline.toggleSourceMute();
          else AudioTimeline.toggleTrackMute(track.id);
        };
      if (slider) {
        slider.onpointerdown = function () {
          if (window.History) History.begin(selPath);
        };
        slider.oninput = function () {
          var output = row.querySelector(".mixer-db");
          if (output) output.textContent = formatGainDb(this.value);
          if (track.id === "source") AudioTimeline.setSourceGain(this.value);
          else AudioTimeline.setTrackGain(track.id, this.value);
        };
        slider.onchange = function () {
          if (window.History) History.commit();
        };
        slider.ondblclick = function (event) {
          event.preventDefault();
          if (window.History) History.begin(selPath);
          this.value = "0";
          var output = row.querySelector(".mixer-db");
          if (output) output.textContent = formatGainDb(0);
          if (track.id === "source") AudioTimeline.setSourceGain(0);
          else AudioTimeline.setTrackGain(track.id, 0);
          if (window.History) History.commit();
        };
      }
      if (removeBtn)
        removeBtn.onclick = function () {
          AudioTimeline.removeTrack(track.id);
        };
    },
  );
  renderAudioClipRange();
}

function renderAudioClipRange() {
  var host = byId("audio-clip-range");
  if (!host) return;
  var info =
    window.AudioTimeline && typeof AudioTimeline.getSelectedClipRange === "function"
      ? AudioTimeline.getSelectedClipRange()
      : null;
  if (!info) {
    host.classList.add("hid");
    host.replaceChildren();
    return;
  }
  host.classList.remove("hid");
  var formatTime =
    window.AudioEditing && typeof AudioEditing.formatSourceTime === "function"
      ? AudioEditing.formatSourceTime
      : fmtt;
  host.innerHTML =
    '<div class="audio-clip-range-head"><div><span class="audio-range-title">Selected clip</span>' +
    '<span class="audio-range-name" title="' +
    esc(info.name) +
    '">' +
    esc(info.name) +
    '</span></div><span class="mixer-track-code" style="--track-color:' +
    info.color +
    '" aria-hidden="true">' +
    esc(info.code) +
    "</span></div>" +
    '<div class="audio-range-meta"><span>Source</span><output class="audio-range-value"></output></div>' +
    '<div class="audio-source-picker"><div class="audio-source-label">Overview</div>' +
    '<div class="audio-source-overview" role="slider" aria-label="Audio source overview" aria-describedby="audio-range-hint" aria-valuemin="0" aria-valuemax="' +
    info.maxSourceIn +
    '" aria-valuenow="' +
    info.sourceIn +
    '" tabindex="' +
    (info.canSlip ? "0" : "-1") +
    '" aria-disabled="' +
    (info.canSlip ? "false" : "true") +
    '"><div class="audio-source-overview-window" aria-hidden="true"></div></div>' +
    '<div class="audio-source-label">Detail</div>' +
    '<div class="audio-source-detail" role="slider" aria-label="Audio source detail" aria-describedby="audio-range-hint" aria-valuemin="0" aria-valuemax="' +
    info.maxSourceIn +
    '" aria-valuenow="' +
    info.sourceIn +
    '" tabindex="' +
    (info.canSlip ? "0" : "-1") +
    '" aria-disabled="' +
    (info.canSlip ? "false" : "true") +
    '">' +
    '<span class="audio-source-detail-scrim before" aria-hidden="true"></span>' +
    '<span class="audio-source-detail-scrim after" aria-hidden="true"></span>' +
    '<div class="audio-source-detail-window" aria-hidden="true"><span class="audio-source-grip"></span></div></div></div>' +
    '<div class="audio-range-foot"><span class="audio-range-hint" id="audio-range-hint">' +
    (info.canSlip
      ? "Click overview to jump · Drag waveform to fine-tune"
      : "Entire source is in use") +
    '</span><button type="button" class="audio-range-reset"' +
    (info.canSlip ? "" : " disabled") +
    ">Reset</button></div>";

  var overview = host.querySelector(".audio-source-overview");
  var overviewWindow = host.querySelector(".audio-source-overview-window");
  var detail = host.querySelector(".audio-source-detail");
  var detailBefore = host.querySelector(".audio-source-detail-scrim.before");
  var detailAfter = host.querySelector(".audio-source-detail-scrim.after");
  var detailWindow = host.querySelector(".audio-source-detail-window");
  var output = host.querySelector(".audio-range-value");
  var reset = host.querySelector(".audio-range-reset");
  overview.style.setProperty("--track-color", info.color);
  detail.style.setProperty("--track-color", info.color);
  if (info.waveformUrl) {
    var waveformImage = "url('" + info.waveformUrl.replace(/'/g, "%27") + "')";
    overview.style.backgroundImage = waveformImage;
    detail.style.backgroundImage = waveformImage;
  }

  var detailState = null;

  function paintRange(next) {
    info = next || info;
    detailState = AudioEditing.sourceRangeDetailState(
      info.sourceIn,
      info.sourceSpan,
      info.sourceDuration,
    );
    overviewWindow.style.left = info.startPct + "%";
    overviewWindow.style.width = info.widthPct + "%";
    detail.style.backgroundSize = detailState.waveformWidthPct + "% 100%";
    detail.style.backgroundPosition = detailState.waveformPositionPct + "% center";
    detailWindow.style.left = detailState.selectionStartPct + "%";
    detailWindow.style.width = detailState.selectionWidthPct + "%";
    detailBefore.style.width = detailState.selectionStartPct + "%";
    detailAfter.style.left =
      detailState.selectionStartPct + detailState.selectionWidthPct + "%";
    var valueText = formatTime(info.sourceIn) + " to " + formatTime(info.sourceOut);
    [overview, detail].forEach(function (control) {
      control.setAttribute("aria-valuenow", String(info.sourceIn));
      control.setAttribute("aria-valuetext", valueText);
    });
    output.textContent =
      formatTime(info.sourceIn) +
      "–" +
      formatTime(info.sourceOut) +
      " / " +
      formatTime(info.sourceDuration);
  }

  paintRange(info);
  if (!info.canSlip) return;

  var pointer = null;

  function updateFromPointer(clientX) {
    if (!pointer) return;
    var nextSourceIn =
      pointer.mode === "detail"
        ? AudioEditing.sourceRangeDetailDragValue(
            pointer.sourceIn,
            clientX - pointer.startX,
            pointer.visibleSpan,
            pointer.rect.width,
            info.maxSourceIn,
          )
        : AudioEditing.sourceRangePointerValue(
            clientX,
            pointer.rect.left,
            pointer.rect.width,
            pointer.grabOffset,
            info.sourceDuration,
            info.maxSourceIn,
          );
    var next = AudioTimeline.setSelectedSourceIn(nextSourceIn, false);
    if (next) paintRange(next);
  }

  function startPointer(mode, element, event) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    var rect = element.getBoundingClientRect();
    var windowRect = overviewWindow.getBoundingClientRect();
    var onOverviewWindow = mode === "overview" && overviewWindow.contains(event.target);
    pointer = {
      pointerId: event.pointerId,
      mode: mode,
      element: element,
      startX: event.clientX,
      sourceIn: info.sourceIn,
      visibleSpan: detailState.visibleSpan,
      rect: {
        left: rect.left + element.clientLeft,
        width: element.clientWidth,
      },
      grabOffset: onOverviewWindow ? event.clientX - windowRect.left : windowRect.width / 2,
      cursorClass:
        mode === "detail" ? "audio-range-detail-dragging" : "audio-range-overview-dragging",
    };
    if (window.History) History.begin(selPath);
    element.classList.add("dragging");
    document.body.classList.add(pointer.cursorClass);
    if (element.setPointerCapture) {
      try {
        element.setPointerCapture(event.pointerId);
      } catch (err) {}
    }
    if (mode === "overview") updateFromPointer(event.clientX);
  }

  function movePointer(event) {
    if (!pointer || event.pointerId !== pointer.pointerId) return;
    event.preventDefault();
    updateFromPointer(event.clientX);
  }

  function finishPointer(event) {
    if (!pointer || event.pointerId !== pointer.pointerId) return;
    if (event.type !== "pointercancel") updateFromPointer(event.clientX);
    if (
      pointer.element.releasePointerCapture &&
      pointer.element.hasPointerCapture &&
      pointer.element.hasPointerCapture(event.pointerId)
    )
      pointer.element.releasePointerCapture(event.pointerId);
    pointer.element.classList.remove("dragging");
    pointer = null;
    document.body.classList.remove(
      "audio-range-overview-dragging",
      "audio-range-detail-dragging",
    );
    AudioTimeline.setSelectedSourceIn(info.sourceIn, true);
    if (window.History) History.commit();
  }

  overview.onpointerdown = function (event) {
    startPointer("overview", overview, event);
  };
  detail.onpointerdown = function (event) {
    startPointer("detail", detail, event);
  };
  [overview, detail].forEach(function (control) {
    control.onpointermove = movePointer;
    control.onpointerup = finishPointer;
    control.onpointercancel = finishPointer;
  });

  function moveFromKeyboard(event) {
    var next = AudioEditing.sourceRangeKeyboardValue(
      info.sourceIn,
      info.maxSourceIn,
      event.key,
      event.shiftKey,
    );
    if (next == null) return;
    event.preventDefault();
    if (window.History) History.begin(selPath);
    AudioTimeline.setSelectedSourceIn(next, true);
    if (window.History) History.commit();
  }
  overview.onkeydown = moveFromKeyboard;
  detail.onkeydown = moveFromKeyboard;

  function resetRange(event) {
    event.preventDefault();
    if (window.History) History.begin(selPath);
    AudioTimeline.resetSelectedSource();
    if (window.History) History.commit();
  }
  overview.ondblclick = resetRange;
  detail.ondblclick = resetRange;
  reset.onclick = resetRange;
}

function formatGainDb(value) {
  var gain = Math.max(-60, Math.min(12, Number(value) || 0));
  return (gain > 0 ? "+" : "") + gain + " dB";
}

function mixerRowHtml(row) {
  var gain = Math.max(-24, Math.min(12, Number(row.gain) || 0));
  var gainDisplay = formatGainDb(gain);
  return (
    '<div class="mixer-row" data-mixer-id="' +
    esc(row.id) +
    '" style="--track-color:' +
    row.color +
    '">' +
    '<div class="mixer-row-top">' +
    '<span class="mixer-track-code" aria-hidden="true">' +
    esc(row.code) +
    '</span><span class="mixer-identity"><span class="mixer-name" title="' +
    esc(row.name) +
    '">' +
    esc(row.name) +
    '</span><span class="mixer-role">' +
    esc(row.role) +
    "</span></span>" +
    '<button type="button" class="mixer-mute" aria-pressed="' +
    (row.muted ? "true" : "false") +
    '" aria-label="' +
    (row.muted ? "Unmute " : "Mute ") +
    esc(row.name) +
    '">' +
    (row.muted ? "Muted" : "Mute") +
    "</button>" +
    "</div>" +
    '<div class="mixer-row-bottom">' +
    '<input type="range" class="mixer-gain" min="-24" max="12" step="1" value="' +
    gain +
    '" aria-label="' +
    esc(row.name) +
    ' gain in decibels"/>' +
    '<span class="mixer-db">' +
    gainDisplay +
    "</span>" +
    "</div>" +
    (row.removable
      ? '<div class="mixer-row-actions"><button type="button" class="mixer-remove" aria-label="Remove ' +
        esc(row.name) +
        '" data-tip="Remove imported audio track">Remove track</button></div>'
      : "") +
    "</div>"
  );
}

initTimelineResizer();
syncWorkspaceForViewport();
