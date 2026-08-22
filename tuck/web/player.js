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

function stepFrame(direction) {
  var v = byId("vid");
  if (!v || !isFinite(v.duration)) return;
  var fps =
    (selPath && clips[selPath] && clips[selPath].probeData && clips[selPath].probeData.fps) ||
    30;
  if (!v.paused) v.pause();
  seekPreview(v.currentTime + direction * (1 / fps));
}

function toggleFullscreen() {
  var center = byId("center");
  if (!center) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (center.requestFullscreen) center.requestFullscreen();
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

var _looping = false;
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

function paintStageScrub(pct) {
  var scrub = byId("stage-scrub");
  if (!scrub) return;
  if (document.activeElement !== scrub) scrub.value = String(Math.round(pct * 10));
  scrub.style.background =
    "linear-gradient(to right, var(--accent-light) " +
    pct +
    "%, rgba(255,255,255,0.22) " +
    pct +
    "%)";
}

function onStageScrub(value) {
  seekToRatio(Number(value) / 1000);
}

function updateTime() {
  if (window.Timeline && Timeline.isDragging() && _previewSec != null) {
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
