var queueTimer = null;
var queueItemsById = {};
var queueActiveItemIds = {};
var retryInFlight = {};

function queueCompletionOutput(items, hadActive, active, activeItemIds) {
  if (!hadActive || active) return "";
  var latest = null,
    latestTime = "";
  for (var i = 0; i < items.length; i++) {
    var item = items[i],
      finishedAt = item.finished_at || "";
    if (
      item.state === "completed" &&
      item.result_path &&
      (!activeItemIds || activeItemIds[item.id]) &&
      (!latest || finishedAt >= latestTime)
    ) {
      latest = item;
      latestTime = finishedAt;
    }
  }
  return latest ? latest.result_path : "";
}

function mapQueueItems(items) {
  if (!items) return;
  var completed = false,
    map = {};
  queueItemsById = {};
  for (var i = 0; i < items.length; i++) {
    map[items[i].source_path] = items[i];
    queueItemsById[items[i].id] = items[i];
  }
  for (var pk in clips) {
    if (clips.hasOwnProperty(pk) && map[pk]) {
      var clip = clips[pk],
        previousState = clip._queueState,
        item = map[pk];
      clip._queueState = item.state;
      clip._queueItemId = item.id;
      clip._statusText = formatQueueStatus(item);
      clip._progress = item.progress || 0;
      if (item.error) clip._queueError = item.error;
      if (item.state === "completed" && previousState !== "completed") {
        completed = true;
      }
      if (item.state === "failed" && previousState !== "failed")
        toast(
          'Failed to process "' +
            clip.name +
            '": ' +
            errorSummary(item.error),
          "err",
        );
      if (item.result_size) clip._resultSize = item.result_size;
      if (item.result_path) clip._resultPath = item.result_path;
    } else if (
      clips.hasOwnProperty(pk) &&
      clips[pk]._queueState &&
      ["completed", "failed", "cancelled"].indexOf(clips[pk]._queueState) < 0
    ) {
      clips[pk]._queueState = null;
      clips[pk]._statusText = "";
    }
  }
  if (completed && appSettings.clear_completed_automatically)
    setTimeout(clearDone, 0);
}

function formatQueueStatus(item) {
  if (!item) return "";
  if (item.status_text) {
    var parts = [item.status_text];
    if (item.state === "running") {
      if (item.progress > 0) parts.push(Math.round(item.progress) + "%");
      var pi = item.progress_info || {};
      if (pi.speed) parts.push(pi.speed.toFixed(1) + "x");
      if (pi.eta_seconds != null)
        parts.push("ETA " + formatEta(pi.eta_seconds));
    }
    return parts.join(" · ");
  }
  if (item.state === "pending") return "Pending";
  if (item.state === "running")
    return "Encoding · " + Math.round(item.progress || 0) + "%";
  if (item.state === "completed") return "Completed";
  if (item.state === "failed") return "Failed";
  if (item.state === "cancelled") return "Cancelled";
  return item.state || "";
}

function formatEta(seconds) {
  if (seconds == null || !(seconds >= 0)) return "--";
  var total = Math.round(seconds),
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  if (h > 0)
    return (
      (h < 10 ? "0" : "") +
      h +
      ":" +
      (m < 10 ? "0" : "") +
      m +
      ":" +
      (s < 10 ? "0" : "") +
      s
    );
  return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

async function pollQueue() {
  if (!api) return;
  try {
    var state = await legacyBackendResult(api.getQueueState()),
      items = state.items || [],
      running = [],
      pending = [];
    mapQueueItems(items);
    if (!(clipReorder && clipReorder.active)) renderClips();
    for (var i = 0; i < items.length; i++) {
      if (items[i].state === "running") running.push(items[i]);
      else if (items[i].state === "pending") pending.push(items[i]);
    }
    var done = 0,
      completedCount = 0,
      failed = 0;
    for (var j = 0; j < items.length; j++) {
      if (["completed", "failed", "cancelled"].indexOf(items[j].state) >= 0)
        done++;
      if (items[j].state === "completed") completedCount++;
      if (items[j].state === "failed") failed++;
    }
    var active = running.length + pending.length;
    for (var k = 0; k < running.length; k++)
      queueActiveItemIds[running[k].id] = true;
    for (var m = 0; m < pending.length; m++)
      queueActiveItemIds[pending[m].id] = true;
    var outputToOpen = queueCompletionOutput(
        items,
        lastQueueHadActive,
        active,
        queueActiveItemIds,
      ),
      total = done + active,
      queueFinished = lastQueueHadActive && !active;
    if (lastQueueHadActive && !active)
      toast(
        failed
          ? "Processing finished with " +
              failed +
              " failure" +
              (failed === 1 ? "" : "s") +
              "."
          : "Processing completed.",
        failed ? "err" : "ok",
      );
    lastQueueHadActive = active > 0;
    if (queueFinished) queueActiveItemIds = {};
    if (outputToOpen && appSettings.open_output_folder_after_queue)
      await openResult(outputToOpen);
    byId("qbar").classList.toggle("hid", items.length === 0);
    byId("q-active").classList.toggle("hid", items.length === 0);
    byId("qidle").classList.toggle("hid", items.length > 0);
    byId("btn-stop-after").disabled = active === 0;
    byId("btn-cancel").disabled = active === 0;
    byId("btn-clear").disabled = completedCount === 0;
    if (!items.length) return;
    if (running.length) {
      var item = running[0],
        prog = item.progress || 0,
        pi = item.progress_info || {},
        status = formatQueueStatus(item);
      byId("qcnt").textContent = done + 1 + "/" + total;
      byId("qprog").value = Math.round(prog);
      byId("qeta").textContent =
        pi.eta_seconds != null
          ? "ETA " + formatEta(pi.eta_seconds)
          : prog > 0
            ? "ETA --"
            : "ETA --";
      var selection =
        (item.segment_count || 1) +
        ((item.segment_count || 1) === 1 ? " segment" : " segments") +
        (item.duration ? " · " + fmtt(item.duration) : "");
      byId("qfname").textContent =
        (item.source || "?") +
        " · " +
        selection +
        (status ? " · " + status : "");
    } else if (pending.length) {
      byId("qcnt").textContent = done + "/" + total;
      byId("qprog").value = 0;
      byId("qeta").textContent = "ETA --";
      byId("qfname").textContent = pending.length + " pending";
    } else {
      byId("qcnt").textContent = done + "/" + total;
      byId("qprog").value = 100;
      byId("qeta").textContent = "";
      byId("qfname").textContent = "Queue idle";
    }
  } catch (e) {}
}

async function cancelQueueItem(itemId) {
  if (!api || !itemId || typeof api.cancelItem !== "function") return;
  try {
    var r = await legacyBackendResult(api.cancelItem(itemId));
    if (!r || !r.ok) toast((r && r.error) || "Could not cancel item.", "err");
    await pollQueue();
  } catch (err) {
    toast("Could not cancel item.", "err");
  }
}

async function retryQueueItem(itemId) {
  if (!api || !itemId || retryInFlight[itemId]) return;
  retryInFlight[itemId] = true;
  try {
    var r = await legacyBackendResult(api.retryItem(itemId));
    if (!r.ok) toast(r.error || "Could not retry.", "err");
    pollQueue();
  } finally {
    delete retryInFlight[itemId];
  }
}

async function openResult(path) {
  if (!api || !path) return;
  try {
    var r = await legacyBackendResult(api.openOutputFolder(path));
    if (!r || !r.ok) toast((r && r.error) || "Could not open folder.", "err");
  } catch (e) {
    toast("Could not open folder.", "err");
  }
}

function buildDiagnosticsContext(itemId) {
  var ctx = {
    workflow: wf === 1 ? "upscale" : "compression",
    selected_encoder: byId("enc-sel") ? byId("enc-sel").value : "",
    profile_name:
      byId("prof-sel") && byId("prof-sel").selectedOptions[0]
        ? byId("prof-sel").selectedOptions[0].textContent
        : "",
    target_size_mb: byId("sz-slider")
      ? parseInt(byId("sz-slider").value, 10)
      : undefined,
    resolution:
      byId("res-mode") && byId("res-mode").value === "custom"
        ? (byId("res-w") ? byId("res-w").value : "") +
          "x" +
          (byId("res-h") ? byId("res-h").value : "")
        : "source",
    fps:
      byId("use-source-fps") && byId("use-source-fps").checked
        ? "source"
        : byId("fps-val")
          ? byId("fps-val").value
          : undefined,
    two_pass: byId("two-pass") ? byId("two-pass").value === "on" : undefined,
    preset: byId("preset-sel") ? byId("preset-sel").value : undefined,
    scaler: byId("scaler-sel") ? byId("scaler-sel").value : undefined,
    keep_audio: byId("keep-audio") ? !!byId("keep-audio").checked : undefined,
    audio_bitrate_kbps: byId("audio-br")
      ? parseInt(byId("audio-br").value, 10)
      : undefined,
    rate_control_method: byId("rc-sel") ? byId("rc-sel").value : undefined,
  };
  if (selPath && clips[selPath]) {
    var c = clips[selPath];
    ctx.source_name = c.name || selPath.split(/[\\/]/).pop();
    var full = (c.probeData && c.probeData.duration) || 0;
    if (full > 0) {
      ctx.segments = SegmentEditing.segmentsForClip(c, full);
      ctx.segment_count = ctx.segments.length;
      ctx.selected_duration = SegmentEditing.selectedDuration(ctx.segments);
    }
    if (c.planData) {
      if (c.planData.video_encoder)
        ctx.resolved_encoder = c.planData.video_encoder;
      if (c.planData.segments) {
        ctx.segments = c.planData.segments;
        ctx.segment_count = c.planData.segment_count;
        ctx.selected_duration = c.planData.selected_duration;
      }
    }
  }
  if (itemId) {
    ctx.item_id = itemId;
    var item = queueItemsById[itemId];
    if (item) {
      if (item.error) ctx.error = item.error;
      if (item.error_detail) ctx.stderr = item.error_detail;
    }
  } else {
    var failedId = null;
    for (var id in queueItemsById) {
      if (
        queueItemsById.hasOwnProperty(id) &&
        queueItemsById[id].state === "failed"
      )
        failedId = id;
    }
    if (failedId) {
      ctx.item_id = failedId;
      var fi = queueItemsById[failedId];
      if (fi.error) ctx.error = fi.error;
      if (fi.error_detail) ctx.stderr = fi.error_detail;
    }
  }
  return ctx;
}

async function copyDiagnostics(itemId) {
  if (!api) {
    toast("App API not ready.", "err");
    return;
  }
  var ctx = buildDiagnosticsContext(itemId);
  try {
    if (typeof api.getDiagnostics !== "function") {
      toast("Diagnostics is unavailable in this build.", "err");
      return;
    }
    var r = await legacyBackendResult(api.getDiagnostics(ctx));
    if (!r || !r.ok || !r.text) {
      toast((r && r.error) || "Could not build diagnostics.", "err");
      return;
    }
    var copied = false;
    if (typeof api.copyText === "function") {
      var cr = await legacyBackendResult(api.copyText(r.text));
      copied = !!(cr && cr.ok);
    }
    if (!copied) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(r.text);
          copied = true;
        }
      } catch (clipErr) {}
    }
    if (!copied) {
      var ta = document.createElement("textarea");
      ta.value = r.text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        copied = document.execCommand("copy");
      } catch (cmdErr) {
        copied = false;
      }
      document.body.removeChild(ta);
    }
    if (copied) toast("Diagnostics copied to clipboard.", "ok");
    else toast("Could not copy diagnostics.", "err");
  } catch (e) {
    toast("Could not copy diagnostics.", "err");
  }
}

async function stopAfterCurrent() {
  if (!api || typeof api.stopAfterCurrent !== "function") return;
  confirmToast(
    "Finish the current job and cancel the rest?",
    async function () {
      var r = await legacyBackendResult(api.stopAfterCurrent());
      if (!r || !r.ok) toast((r && r.error) || "Could not stop queue.", "err");
      else {
        toast("Queue will stop after the current job.", "ok");
        pollQueue();
      }
    },
  );
}

async function cancelAll() {
  if (!api) return;
  confirmToast("Cancel all processing?", async function () {
    await api.cancelAllItems();
    byId("q-active").classList.add("hid");
    byId("qidle").classList.remove("hid");
    toast("Processing cancelled.", "ok");
  });
}
async function clearDone() {
  if (!api) return;
  var r = await legacyBackendResult(api.clearCompleted());
  if (r && r.ok) {
    for (var p in clips) {
      if (clips.hasOwnProperty(p) && clips[p]._queueState === "completed")
        removeClip(p);
    }
    toast(
      r.count === 1
        ? "Cleared 1 completed video."
        : "Cleared " + (r.count || 0) + " completed videos.",
      "ok",
    );
    await pollQueue();
  } else toast((r && r.error) || "Could not clear completed videos.", "err");
}
async function pollIpc() {
  if (!api) return;
  try {
    var files = await legacyBackendResult(api.getIpcFiles());
    var metadata = await legacyBackendResult(api.getIpcMetadata());
    if (Array.isArray(files) && files.length) addFiles(files);
    if (metadata && Object.keys(metadata).length) {
      metadata.files = files;
      handleIpcMeta(metadata);
    }
  } catch (e) {}
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { queueCompletionOutput: queueCompletionOutput };
