var api = null;
var clips = {};
var selPath = null;
var allProfiles = [];
var availEncoders = [];
var appSettings = {};
var wf = 0;
var lastComp = "";
var lastUpscale = "";
var lastQueueHadActive = false;
var muted = false;
var volBefore = 80;
var profSnapshot = "";
var settingsDirty = false;
var _trackDirty = true;
var previewRequestId = 0;

function byId(id) {
  return document.getElementById(id);
}
function showThumbnail(source) {
  if (!source) return removeThumbnail();
  var thumb = byId("thumb");
  if (!thumb) {
    thumb = document.createElement("img");
    thumb.id = "thumb";
    thumb.alt = "";
    byId("media-viewport").appendChild(thumb);
  }
  thumb.src = source;
  thumb.style.display = "block";
  byId("vid").style.display = "none";
  return thumb;
}
function removeThumbnail() {
  var thumb = byId("thumb");
  if (thumb) thumb.remove();
}
function esc(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function escJS(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}
function fmtt(s) {
  var m = Math.floor(s / 60),
    sec = Math.floor(s % 60),
    h = Math.floor(m / 60);
  if (h)
    return h + ":" + ("0" + (m % 60)).slice(-2) + ":" + ("0" + sec).slice(-2);
  return m + ":" + ("0" + sec).slice(-2);
}
var toastId = 0;
var pendingConfirm = null;
function toast(msg, kind) {
  kind = kind || "";
  var id = "t" + ++toastId,
    ct = byId("toast-ct");
  var div = document.createElement("div");
  div.className = "toast " + kind;
  div.id = id;
  div.innerHTML =
    '<span class="tmsg">' +
    msg +
    '</span><button class="tcls" onclick="dismissToast(\'' +
    id +
    '\')" aria-label="Dismiss notification">✕</button>';
  ct.appendChild(div);
  setTimeout(
    function () {
      dismissToast(id);
    },
    kind === "err" ? 6000 : 3500,
  );
}
function dismissToast(id) {
  var el = byId(id);
  if (el) {
    el.style.opacity = "0";
    el.style.transition = "opacity .2s";
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }
}
function confirmToast(msg, cb) {
  var lower = msg.toLowerCase(),
    discard = lower.indexOf("discard") >= 0,
    remove =
      lower.indexOf("remove") >= 0 ||
      lower.indexOf("delete") >= 0 ||
      lower.indexOf("cancel") >= 0,
    install = lower.indexOf("install") >= 0,
    title = discard
      ? "Unsaved changes"
      : install
        ? "Install update"
        : remove
          ? "Confirm removal"
          : "Confirm action",
    confirmLabel = discard
      ? "Discard changes"
      : install
        ? "Install update"
        : lower.indexOf("delete") >= 0
          ? "Delete"
          : lower.indexOf("remove") >= 0
            ? "Remove"
            : lower.indexOf("cancel") >= 0
              ? "Cancel processing"
              : "Continue",
    cancelLabel = discard ? "Keep editing" : "Go back";
  pendingConfirm = cb;
  var box = prepareModalBox("mod-box confirm-dialog");
  box.innerHTML = `<h2 id="confirm-title"></h2>
    <p class="confirm-copy" id="confirm-copy"></p>
    <div class="confirm-actions">
      <button class="btn2" onclick="closeMod()">${cancelLabel}</button>
      <button
        class="btn1 ${discard || remove ? "danger" : ""}"
        onclick="acceptConfirm()"
      >
        ${confirmLabel}
      </button>
    </div>`;
  byId("confirm-title").textContent = title;
  byId("confirm-copy").textContent = msg;
  byId("mod-overlay").classList.add("open");
}
function acceptConfirm() {
  var cb = pendingConfirm;
  closeMod();
  if (cb) cb();
}

function profileControlState() {
  var clip = selPath && clips[selPath];
  return {
    pid: byId("prof-sel").value,
    size: byId("sz-slider").value,
    rm: byId("res-mode").value,
    rw: byId("res-w").value,
    rh: byId("res-h").value,
    fps: byId("fps-val").value,
    ka: byId("keep-audio").checked,
    abr: byId("audio-br").value,
    tp: byId("two-pass").value,
    pre: byId("preset-sel").value,
    sc: byId("scaler-sel").value,
    enc: byId("enc-sel").value,
    rc: byId("rc-sel").value,
    q: byId("quality-val").value,
    br: byId("br-val").value,
    tu: byId("tune-sel").value,
    aspect: clip ? clip.cropAspect || "off" : "off",
    rotation: clip ? clip.rotation || 0 : 0,
    sizing: clip ? clip.sizingMode || "fit" : "fit",
  };
}
function snapProf() {
  if (!_trackDirty) return;
  profSnapshot = JSON.stringify(profileControlState());
  updateDirty();
}
function updateDirty() {
  if (!_trackDirty || !profSnapshot) {
    byId("mod-badge").classList.remove("show");
    byId("prof-reset-row").classList.add("hid");
    return;
  }
  var cur = JSON.stringify(profileControlState());
  var dirty = profSnapshot !== cur;
  byId("mod-badge").classList.toggle("show", dirty);
  byId("prof-reset-row").classList.toggle("hid", !dirty);
}
function resetToProfile() {
  _trackDirty = false;
  applyProfile(true);
  snapProf();
  _trackDirty = true;
  toast("Settings reset to profile.", "ok");
}

function showMod(html) {
  var box = prepareModalBox("mod-box");
  box.innerHTML = html;
  byId("mod-overlay").classList.add("open");
}
function closeMod() {
  byId("mod-overlay").classList.remove("open");
  resetKeyboardShortcutsDialog(true);
  pendingConfirm = null;
}
function cleanUpdateNoteText(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
function updateNoteBlocks(notes) {
  var blocks = [];
  var lines = String(notes || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      var headingText = cleanUpdateNoteText(heading[1]);
      if (/^\[?v?\d+\.\d+\.\d+\]?\s+-\s+\d{4}-\d{2}-\d{2}$/i.test(headingText))
        continue;
      blocks.push({ type: "heading", text: headingText });
      continue;
    }
    var bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: cleanUpdateNoteText(bullet[1]) });
      continue;
    }
    blocks.push({ type: "text", text: cleanUpdateNoteText(line) });
  }
  return blocks;
}
function renderUpdateNotes(notes) {
  var root = byId("update-notes");
  root.replaceChildren();
  var blocks = updateNoteBlocks(notes);
  if (!blocks.length)
    blocks.push({ type: "text", text: "No release notes provided." });
  var list = null;
  blocks.forEach(function (block) {
    if (block.type === "bullet") {
      if (!list) {
        list = document.createElement("ul");
        root.appendChild(list);
      }
      var item = document.createElement("li");
      item.textContent = block.text;
      list.appendChild(item);
      return;
    }
    list = null;
    var element = document.createElement(block.type === "heading" ? "h4" : "p");
    element.textContent = block.text;
    root.appendChild(element);
  });
}
function showUpdateModal(update) {
  showMod(
    `<h2>Update available</h2>
    <div>
      Version <strong id="update-version"></strong> ·
      <span id="update-size"></span>
    </div>
    <h3>What's new</h3>
    <div class="update-notes" id="update-notes"></div>
    <div class="brow">
      <button class="btn2" id="update-later" onclick="closeMod()">Later</button>
      <button class="btn1" id="update-install" onclick="downloadAndInstallUpdate()">Download &amp; install</button>
    </div>`,
  );
  byId("update-version").textContent = "v" + update.version;
  byId("update-size").textContent = (update.size_mb || 0).toFixed(1) + " MB";
  renderUpdateNotes(update.notes);
}
async function downloadAndInstallUpdate() {
  var button = byId("update-install");
  var later = byId("update-later");
  button.disabled = true;
  later.disabled = true;
  try {
    var started = await api.downloadUpdate();
    if (!started.ok) {
      throw new Error(started.error || "Could not start the download");
    }
    while (true) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 500);
      });
      var progress = await api.getDownloadProgress();
      if (progress.downloading) {
        button.textContent = "Downloading " + (progress.progress || 0) + "%";
        continue;
      }
      if (progress.error) throw new Error(progress.error);
      if (progress.done) break;
      throw new Error("Download stopped unexpectedly");
    }
    button.textContent = "Starting installer...";
    var installed = await api.installUpdate();
    if (!installed.ok)
      throw new Error(installed.error || "Could not start the installer");
    await api.closeWindow();
  } catch (error) {
    button.disabled = false;
    later.disabled = false;
    button.textContent = "Download & install";
    toast("Update failed: " + error.message, "err");
  }
}
function closeActiveModal() {
  closeMod();
}

function prepareModalBox(className) {
  resetKeyboardShortcutsDialog(false);
  var box = byId("mod-box");
  box.className = className;
  return box;
}
var startupData = null;
var clipOrder = [];
async function startApp() {
  if (!api || !startupData) return;
  var data = startupData;
  startupData = null;
  updateSizePresets(10);
  try {
    await loadSettings();
  } catch (e) {
    toast("Could not load settings.", "err");
  }
  if (appSettings.check_updates !== false) checkUpdates(true);
  if (queueTimer === null)
    queueTimer = setInterval(function () {
      pollQueue();
      pollIpc();
    }, 500);
  if (data.files && data.files.length) addFiles(data.files);
  if (data.sendto) handleSendto(data.sendto);
}
window.initApp = function (data) {
  startupData = data || { files: [], sendto: null };
  if (window.pywebview && window.pywebview.api) {
    api = window.pywebview.api;
    startApp();
  }
};
window.addEventListener("pywebviewready", function () {
  api = window.pywebview.api;
  startApp();
});

var dragDepth = 0;
function isFileDrag(e) {
  var types =
    e.dataTransfer && e.dataTransfer.types
      ? Array.prototype.slice.call(e.dataTransfer.types)
      : [];
  return types.indexOf("Files") >= 0;
}
document.body.addEventListener("dragenter", function (e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dragDepth++;
  byId("drag-overlay").classList.add("show");
});
document.body.addEventListener("dragover", function (e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  byId("drag-overlay").classList.add("show");
});
document.body.addEventListener("dragleave", function (e) {
  if (!isFileDrag(e) && dragDepth === 0) return;
  e.preventDefault();
  e.stopPropagation();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) byId("drag-overlay").classList.remove("show");
});
document.body.addEventListener("drop", function (e) {
  dragDepth = 0;
  byId("drag-overlay").classList.remove("show");
  byId("drop-z").classList.remove("over");
  if (isFileDrag(e)) e.preventDefault();
});
var dz = byId("drop-z");
dz.addEventListener("dragover", function (e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dz.classList.add("over");
});
dz.addEventListener("dragleave", function (e) {
  e.stopPropagation();
  dz.classList.remove("over");
});
dz.addEventListener("drop", function (e) {
  e.preventDefault();
  e.stopPropagation();
  dz.classList.remove("over");
});

async function browse() {
  if (!api) return;
  try {
    var r = await api.pickFiles();
    if (r.ok && Array.isArray(r.files) && r.files.length) addFiles(r.files);
    else if (!r.ok)
      toast("Could not add files: " + (r.error || "Unknown error"), "err");
  } catch (e) {
    toast("Could not add files.", "err");
  }
}

window.addFiles = function (paths, rejected) {
  if (!Array.isArray(paths)) return;
  var added = 0,
    skipped = 0,
    firstAdded = null;
  for (var i = 0; i < paths.length; i++) {
    if (typeof paths[i] !== "string") continue;
    var p = paths[i];
    if (clips[p]) {
      skipped++;
      continue;
    }
    clips[p] = {
      path: p,
      name: p.split(/[\\/]/).pop(),
      probed: false,
      probing: false,
      probeData: null,
      planData: null,
      mediaToken: null,
      error: "",
      segments: null,
      activeSegment: 0,
      crop: null,
      cropAspect: "off",
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
      sizingMode: "fit",
      transformOverride: false,
      transformIntentTouched: false,
    };
    if (typeof applySelectedProfileTransform === "function")
      applySelectedProfileTransform(clips[p], true);
    if (clipOrder.indexOf(p) < 0) clipOrder.push(p);
    if (!firstAdded) firstAdded = p;
    added++;
  }
  renderClips();
  for (var k in clips) {
    if (clips.hasOwnProperty(k) && !clips[k].probed && !clips[k].probing)
      probeClip(k);
  }
  if (added && !selPath)
    selectClip(firstAdded || clipOrder[0] || Object.keys(clips)[0]);
  var rej = Array.isArray(rejected) ? rejected.length : 0;
  if (rej && added)
    toast(
      "Added " +
        added +
        " file" +
        (added === 1 ? "" : "s") +
        "; skipped " +
        rej +
        " unsupported.",
      "err",
    );
  else if (rej && !added)
    toast("No supported video files in drop (" + rej + " skipped).", "err");
  else if (added > 1) toast("Added " + added + " files.", "ok");
};

function orderedClipKeys() {
  clipOrder = clipOrder.filter(function (p) {
    return !!clips[p];
  });
  var keys = Object.keys(clips);
  for (var j = 0; j < keys.length; j++) {
    if (clipOrder.indexOf(keys[j]) < 0) clipOrder.push(keys[j]);
  }
  return clipOrder.slice();
}

function renderClips() {
  if (clipReorder && clipReorder.active) return;
  var keys = orderedClipKeys(),
    cdiv = byId("clips"),
    el = byId("drop-z");
  cdiv.replaceChildren(el);
  byId("btn-rmall").style.display = keys.length ? "block" : "none";
  if (!keys.length) {
    el.classList.add("show");
    updateActionButtons();
    return;
  }
  el.classList.remove("show");
  for (var i = 0; i < keys.length; i++) {
    (function (p, c) {
      var div = document.createElement("div");
      div.className = "clip clip-drag" + (selPath === p ? " sel" : "");
      div.setAttribute("tabindex", "0");
      div.setAttribute("role", "option");
      div.setAttribute("aria-selected", selPath === p ? "true" : "false");
      div.setAttribute("aria-keyshortcuts", "Enter Space Delete ArrowUp ArrowDown");
      div.setAttribute("title", c.name + " - drag handle to reorder");
      div.dataset.clipPath = p;
      if (c._queueItemId) div.dataset.queueItemId = c._queueItemId;
      div.onclick = function () {
        if (clipReorder && clipReorder.moved) {
          clipReorder.moved = false;
          return;
        }
        selectClip(p);
      };
      div.ondblclick = function () {
        selectClip(p);
        togglePlay();
      };
      div.onkeydown = function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectClip(p);
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          removeClip(p);
        }
      };

      var statusLabel = c._statusText || "";
      if (!statusLabel && c._queueState === "completed")
        statusLabel = "Completed";
      if (!statusLabel && c._queueState === "pending") statusLabel = "Pending";
      if (!statusLabel && c._queueState === "running") statusLabel = "Encoding";
      if (!statusLabel && c._queueState === "failed") statusLabel = "Failed";
      if (!statusLabel && c._queueState === "cancelled")
        statusLabel = "Cancelled";

      var trailingActs = "";
      if (c._queueState === "completed" && c._resultPath) {
        trailingActs += `<button
          type="button"
          class="c-act link"
          data-no-reorder="1"
          onclick="event.stopPropagation();openResult('${escJS(c._resultPath)}')"
          title="Open folder"
          aria-label="Open folder"
        >Open folder</button>`;
      }
      if (
        (c._queueState === "pending" ||
          c._queueState === "running" ||
          c._queueState === "processing") &&
        c._queueItemId
      ) {
        trailingActs += `<button
          type="button"
          class="c-act danger"
          data-no-reorder="1"
          onclick="event.stopPropagation();cancelQueueItem('${escJS(c._queueItemId)}')"
          title="Cancel"
          aria-label="Cancel"
        >Cancel</button>`;
      }
      if (
        (c._queueState === "failed" || c._queueState === "cancelled") &&
        c._queueItemId
      ) {
        trailingActs +=
          '<button type="button" class="c-act" data-no-reorder="1" onclick="event.stopPropagation();retryQueueItem(\'' +
          escJS(c._queueItemId) +
          '\')" title="Retry" aria-label="Retry">Retry</button>';
      }

      var statusRow = "";
      if (statusLabel || trailingActs) {
        statusRow =
          '<div class="c-status-row">' +
          (statusLabel
            ? '<span class="c-status">' + esc(statusLabel) + "</span>"
            : '<span class="c-status"></span>') +
          trailingActs +
          "</div>";
      }

      div.innerHTML =
        '<span class="c-drag" data-drag-handle="1" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>' +
        '<div class="c1"><div class="c2">' +
        esc(c.name) +
        "</div>" +
        '<div class="c3"><span class="c-meta">' +
        metaStr(c) +
        "</span></div>" +
        statusRow +
        "</div>" +
        clipStateBadge(p) +
        '<button class="c4" data-no-reorder="1" onclick="event.stopPropagation();removeClip(\'' +
        escJS(p) +
        '\')" aria-label="Remove ' +
        esc(c.name) +
        '" tabindex="0">✕</button>';

      var handle = div.querySelector("[data-drag-handle]");
      if (handle) {
        handle.addEventListener("pointerdown", function (ev) {
          beginClipReorder(ev, p, div);
        });
      }
      cdiv.appendChild(div);
    })(keys[i], clips[keys[i]]);
  }
  updateActionButtons();
}

var clipReorder = {
  active: false,
  moved: false,
  fromPath: null,
  overPath: null,
  startX: 0,
  startY: 0,
  el: null,
  pointerId: null,
};

function clearDropTargets() {
  var nodes = byId("clips").querySelectorAll(".drop-target");
  for (var i = 0; i < nodes.length; i++)
    nodes[i].classList.remove("drop-target");
}

function beginClipReorder(e, path, el) {
  if (!path || e.button !== 0) return;
  if (orderedClipKeys().length < 2) return;
  e.stopPropagation();
  clipReorder.active = true;
  clipReorder.moved = false;
  clipReorder.fromPath = path;
  clipReorder.overPath = null;
  clipReorder.startX = e.clientX;
  clipReorder.startY = e.clientY;
  clipReorder.el = el;
  clipReorder.pointerId = e.pointerId;
  try {
    el.setPointerCapture(e.pointerId);
  } catch (err) {}
  window.addEventListener("pointermove", onClipReorderMove, true);
  window.addEventListener("pointerup", onClipReorderEnd, true);
  window.addEventListener("pointercancel", onClipReorderEnd, true);
}

function onClipReorderMove(e) {
  if (!clipReorder.active) return;
  var dx = e.clientX - clipReorder.startX,
    dy = e.clientY - clipReorder.startY;
  if (!clipReorder.moved && dx * dx + dy * dy < 16) return;
  if (!clipReorder.moved) {
    clipReorder.moved = true;
    if (clipReorder.el) clipReorder.el.classList.add("dragging");
  }
  e.preventDefault();
  var under = document.elementFromPoint(e.clientX, e.clientY);
  var card =
    under && under.closest ? under.closest(".clip[data-clip-path]") : null;
  clearDropTargets();
  if (
    card &&
    card.dataset.clipPath &&
    card.dataset.clipPath !== clipReorder.fromPath
  ) {
    card.classList.add("drop-target");
    clipReorder.overPath = card.dataset.clipPath;
  } else {
    clipReorder.overPath = null;
  }
}

async function onClipReorderEnd() {
  if (!clipReorder.active) return;
  window.removeEventListener("pointermove", onClipReorderMove, true);
  window.removeEventListener("pointerup", onClipReorderEnd, true);
  window.removeEventListener("pointercancel", onClipReorderEnd, true);
  var fromPath = clipReorder.fromPath;
  var overPath = clipReorder.overPath;
  var el = clipReorder.el;
  var moved = clipReorder.moved;
  if (el) {
    try {
      if (clipReorder.pointerId != null)
        el.releasePointerCapture(clipReorder.pointerId);
    } catch (err) {}
    el.classList.remove("dragging");
  }
  clearDropTargets();
  clipReorder.active = false;
  clipReorder.fromPath = null;
  clipReorder.overPath = null;
  clipReorder.el = null;
  clipReorder.pointerId = null;
  if (!moved || !fromPath || !overPath || fromPath === overPath) {
    clipReorder.moved = false;
    renderClips();
    return;
  }
  var order = orderedClipKeys();
  var fromIdx = order.indexOf(fromPath);
  var toIdx = order.indexOf(overPath);
  if (fromIdx < 0 || toIdx < 0) {
    clipReorder.moved = false;
    renderClips();
    return;
  }
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, fromPath);
  clipOrder = order;
  clipReorder.moved = false;
  renderClips();
  await syncPendingQueueToClipOrder();
}

async function syncPendingQueueToClipOrder() {
  if (!api || typeof api.moveItem !== "function") return;
  var desired = [];
  for (var i = 0; i < clipOrder.length; i++) {
    var c = clips[clipOrder[i]];
    if (c && c._queueState === "pending" && c._queueItemId)
      desired.push(c._queueItemId);
  }
  if (desired.length < 2) return;
  try {
    for (var j = 0; j < desired.length; j++) {
      await api.moveItem(desired[j], j);
    }
  } catch (err) {}
  await pollQueue();
}

function errorSummary(error, limit) {
  var text = String(error || "Unknown error")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > (limit || 140)
    ? text.substring(0, limit || 140) + "…"
    : text;
}
function clipStateBadge(p) {
  var c = clips[p],
    st = c._queueState || "";
  if (!st && !c.error && !c._statusText) return "";
  var states = {
    pending: ["Pending", "●", "cst-queued"],
    running: ["Encoding", "↻", "cst-processing"],
    processing: ["Encoding", "↻", "cst-processing"],
    completed: ["Completed", "✓", "cst-completed"],
    failed: ["Failed", "!", "cst-failed"],
    cancelled: ["Cancelled", "!", "cst-cancelled"],
  };
  var label =
    c._statusText ||
    (states[st] ? states[st][0] : "") ||
    (c.error ? "Error" : "Ready");
  if (st === "failed" && c._queueError) label = "Failed: " + c._queueError;
  var state =
    states[st] ||
    (c.error ? ["Error", "!", "cst-failed"] : ["Ready", "·", "cst-ready"]);
  return (
    '<span class="c-st ' +
    state[2] +
    '" role="img" title="' +
    esc(label) +
    '" aria-label="' +
    esc(label) +
    '">' +
    state[1] +
    "</span>"
  );
}

function clipDuration(c) {
  if (!c.probed || !c.probeData || !c.probeData.duration) return "";
  var full = c.probeData.duration;
  var segments = SegmentEditing.segmentsForClip(c, full);
  var selected = SegmentEditing.selectedDuration(segments);
  if (segments.length > 1)
    return fmtt(selected) + " · " + segments.length + " segments";
  if (!SegmentEditing.isFullSource(segments, full))
    return fmtt(segments[0].start) + "–" + fmtt(segments[0].end);
  return fmtt(selected);
}
function metaStr(c) {
  if (c._queueState === "failed" && c._queueError)
    return (
      '<span class="c-error">' +
      esc(errorSummary(c._queueError, 100)) +
      "</span>"
    );
  if (c.error) return esc(errorSummary(c.error, 100));
  if (!c.probed) return "…";
  var d = c.probeData,
    first = [];
  var duration = clipDuration(c);
  if (duration) first.push(duration);
  if (d.width && d.height) first.push(d.width + "×" + d.height);
  if (c.crop) first.push("crop " + c.crop.width + "×" + c.crop.height);
  if (c.rotation) first.push(c.rotation + "°");
  if (c.flipHorizontal || c.flipVertical)
    first.push(
      c.flipHorizontal && c.flipVertical
        ? "flip H+V"
        : c.flipHorizontal
          ? "flip H"
          : "flip V",
    );
  var second = c._fileSize ? formatBytes(c._fileSize) : "";
  if (c._resultSize && c._queueState === "completed")
    second += " → " + formatBytes(c._resultSize);
  if (second) first.push(second);
  return (
    first.join(" · ")
  );
}

function formatBytes(b) {
  if (!b) return "";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function selectClip(p) {
  if (selPath && selPath !== p && clips[selPath] && clips[selPath].mediaToken) {
    api.releaseMediaToken(clips[selPath].mediaToken);
    clips[selPath].mediaToken = null;
  }
  selPath = p;
  renderClips();
  byId("empty").style.display = "none";
  byId("stage").style.display = "block";
  byId("player-bar").classList.add("on");
  removeThumbnail();
  byId("vid").style.display = "block";
  byId("btn-play").textContent = "▶";
  loadMedia(p);
  var c = clips[p];
  if (window.AudioTimeline) AudioTimeline.selectVideo(c);
  syncTimelineUI();
  if (typeof syncTransformControls === "function") syncTransformControls();
  if (typeof paintCropOverlay === "function") paintCropOverlay();
  if (typeof renderClipDetails === "function") renderClipDetails();
  if (typeof renderAudioLibraryPanel === "function" && libraryTab === "audio")
    renderAudioLibraryPanel();
  if (!c.probed && !c.error) probeClip(p);
  else if (c.probed) {
    syncFpsToClip();
    syncResolutionToClip();
    reqPreview();
  }
}

function removeClip(p) {
  if (clips[p] && window.AudioTimeline) AudioTimeline.disposeClip(clips[p]);
  if (clips[p] && clips[p].mediaToken)
    api.releaseMediaToken(clips[p].mediaToken);
  if (window.History) History.forgetClip(p);
  delete clips[p];
  clipOrder = clipOrder.filter(function (x) {
    return x !== p;
  });
  if (selPath === p) {
    selPath = null;
    byId("empty").style.display = "flex";
    byId("stage").style.display = "none";
    byId("player-bar").classList.remove("on");
    var v = byId("vid");
    v.pause();
    v.src = "";
    removeThumbnail();
    if (clipOrder.length) selectClip(clipOrder[0]);
    else {
      if (window.AudioTimeline) AudioTimeline.selectVideo(null);
      syncTimelineUI();
      if (typeof syncTransformControls === "function") syncTransformControls();
      if (typeof renderClipDetails === "function") renderClipDetails();
    }
  }
  renderClips();
}

function removeAllClips() {
  var keys = Object.keys(clips);
  if (!keys.length) return;
  var hasActive = false;
  for (var i = 0; i < keys.length; i++) {
    var st = clips[keys[i]]._queueState || "";
    if (st === "running" || st === "processing" || st === "pending") {
      hasActive = true;
      break;
    }
  }
  if (hasActive) {
    confirmToast(
      "Some files are still processing. Remove all anyway?",
      doRemoveAllClips,
    );
  } else {
    doRemoveAllClips();
  }
}
function doRemoveAllClips() {
  var keys = Object.keys(clips);
  for (var i = 0; i < keys.length; i++) {
    if (clips[keys[i]] && window.AudioTimeline) AudioTimeline.disposeClip(clips[keys[i]]);
    if (clips[keys[i]] && clips[keys[i]].mediaToken)
      api.releaseMediaToken(clips[keys[i]].mediaToken);
    if (window.History) History.forgetClip(keys[i]);
  }
  clips = {};
  clipOrder = [];
  selPath = null;
  byId("empty").style.display = "flex";
  byId("stage").style.display = "none";
  byId("player-bar").classList.remove("on");
  var v = byId("vid");
  v.pause();
  v.src = "";
  removeThumbnail();
  if (window.AudioTimeline) AudioTimeline.selectVideo(null);
  syncTimelineUI();
  if (typeof syncTransformControls === "function") syncTransformControls();
  if (typeof renderClipDetails === "function") renderClipDetails();
  renderClips();
}

async function probeClip(p) {
  if (!api) return;
  var c = clips[p];
  if (!TuckProbeState.begin(c)) return;
  renderClips();
  if (selPath === p && typeof renderClipDetails === "function")
    renderClipDetails();
  try {
    var r = await api.probeFile(p);
    var result = TuckProbeState.complete(c, r);
    if (result.ok) {
      if (!Array.isArray(c.segments) || !c.segments.length)
        c.segments = SegmentEditing.fullSegment(result.data.duration);
      c.activeSegment = Math.max(
        0,
        Math.min(c.segments.length - 1, c.activeSegment || 0),
      );
      c._fileSize = result.data.file_size;
      if (window.AudioTimeline) AudioTimeline.onProbe(c);
      if (typeof applySelectedProfileTransform === "function")
        applySelectedProfileTransform(c, false);
    }
  } catch (e) {
    TuckProbeState.fail(c, e);
  }
  renderClips();
  if (selPath === p) {
    syncFpsToClip();
    syncResolutionToClip();
    syncTimelineUI();
    if (typeof syncTransformControls === "function") syncTransformControls();
    if (typeof paintCropOverlay === "function") paintCropOverlay();
    if (typeof renderClipDetails === "function") renderClipDetails();
    reqPreview();
  }
}

function retryProbeClip(p) {
  probeClip(p);
}

async function loadMedia(p) {
  if (!api) return;
  try {
    var r = await api.getMediaUrl(p);
    if (r.ok && r.url) {
      var v = byId("vid");
      v.src = r.url;
      v.load();
      if (clips[p]) clips[p].mediaToken = r.token;
      v.onerror = function () {
        loadThumb(p);
      };
    } else if (r.thumbnail) {
      showThumbnail(r.thumbnail);
    }
  } catch (e) {}
}

async function loadThumb(p) {
  if (!api) return;
  try {
    var r = await api.getThumbnail(p);
    if (r.ok && r.thumbnail) {
      showThumbnail(r.thumbnail);
    }
  } catch (e) {}
}

async function checkUpdates(silent) {
  if (!api) return;
  var r = await api.checkForUpdates();
  if (r.error) {
    if (!silent) toast("Update check failed: " + r.error, "err");
    return;
  }
  if (!r.available) {
    if (!silent) toast("Running latest version.", "ok");
    return;
  }
  showUpdateModal(r);
}
async function checkUpdatesFromSettings() {
  await checkUpdates(false);
}

function handleLaunch(data) {
  if (data.profile_id) {
    var sel = byId("prof-sel");
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === data.profile_id) {
        sel.selectedIndex = i;
        onProfileChange();
        break;
      }
    }
  }
  if (
    data.action === "start" &&
    data.files &&
    data.files.length &&
    data.profile_id
  ) {
    setTimeout(function () {
      var reqs = data.files.map(function (f) {
        var r = buildReq(f);
        r.profile_id = data.profile_id;
        return r;
      });
      api.enqueueBatch(JSON.stringify(reqs));
      pollQueue();
    }, 500);
  }
}
window.handleIpcMeta = handleLaunch;
window.handleSendto = handleLaunch;

function libraryClipTarget(event) {
  var target = event && event.target;
  if (!target || typeof target.closest !== "function") return null;
  return target.closest("#clips .clip[data-clip-path]");
}

function moveSelection(delta, event) {
  var keys = orderedClipKeys();
  if (!keys.length) return;
  var focusedClip = libraryClipTarget(event);
  var currentPath = focusedClip ? focusedClip.dataset.clipPath : selPath;
  var index = currentPath ? keys.indexOf(currentPath) : 0;
  index = Math.max(0, Math.min(keys.length - 1, index + delta));
  var nextPath = keys[index];
  selectClip(nextPath);
  Array.from(byId("clips").querySelectorAll(".clip[data-clip-path]")).some(
    function (clip) {
      if (clip.dataset.clipPath !== nextPath) return false;
      clip.focus();
      return true;
    },
  );
}
TuckShortcuts.registerAction("file.add-videos", browse);
TuckShortcuts.registerAction("settings.open", function () {
  toggleSettings();
});
TuckShortcuts.registerAction("app.exit", {
  enabled: function () {
    return !!api;
  },
  execute: function () {
    api.closeWindow();
  },
});
TuckShortcuts.registerAction("ui.dismiss", {
  enabled: function () {
    return (
      byId("mod-overlay").classList.contains("open") ||
      document.body.classList.contains("settings-open") ||
      (window.AudioTimeline && AudioTimeline.hasSelection())
    );
  },
  execute: function () {
    if (byId("mod-overlay").classList.contains("open")) closeActiveModal();
    else if (document.body.classList.contains("settings-open")) closeSettings();
    else AudioTimeline.selectVideoTrack();
  },
});
TuckShortcuts.registerAction("playback.toggle", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    togglePlay();
  },
});
TuckShortcuts.registerAction("playback.step-backward", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    stepFrame(-1);
  },
});
TuckShortcuts.registerAction("playback.step-forward", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    stepFrame(1);
  },
});
TuckShortcuts.registerAction("playback.seek-backward", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    seekBy(-3);
  },
});
TuckShortcuts.registerAction("playback.seek-forward", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    seekBy(3);
  },
});
TuckShortcuts.registerAction("playback.seek-start", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    seekPreview(0);
  },
});
TuckShortcuts.registerAction("playback.seek-end", {
  enabled: function () {
    return !!selPath;
  },
  execute: function () {
    seekPreview(videoDuration());
  },
});
TuckShortcuts.registerAction("media.select-previous", {
  enabled: function (event) {
    return !!libraryClipTarget(event);
  },
  execute: function (event) {
    moveSelection(-1, event);
  },
});
TuckShortcuts.registerAction("media.select-next", {
  enabled: function (event) {
    return !!libraryClipTarget(event);
  },
  execute: function (event) {
    moveSelection(1, event);
  },
});
