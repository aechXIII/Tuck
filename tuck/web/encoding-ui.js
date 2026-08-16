function setWf(idx) {
  if (wf === idx) return;
  var curPid = byId("prof-sel").value;
  if (curPid) {
    if (wf === 0) lastComp = curPid;
    else lastUpscale = curPid;
  }
  wf = idx;
  var c = byId("wf-c"),
    u = byId("wf-u"),
    up = idx === 1;
  c.classList.toggle("on", !up);
  c.setAttribute("aria-pressed", String(!up));
  u.classList.toggle("on", up);
  u.setAttribute("aria-pressed", String(up));
  byId("sz-grp").classList.toggle("hid", up);
  byId("two-pass").disabled = up;
  byId("two-pass-wrap").classList.toggle("hid", up);
  byId("res-source-wrap").classList.toggle("hid", up);
  if (up) {
    byId("two-pass").value = "off";
    byId("use-source-res").checked = false;
    byId("res-mode").value = "custom";
  } else {
    byId("res-mode").value = byId("use-source-res").checked
      ? "source"
      : "custom";
  }
  onResMode();
  updateRcOpts();
  updateRcVis();
  refilter();
  updateActionButtons();
  persistSession();
}

function persistSession() {
  if (!api || !appSettings || !Object.keys(appSettings).length) return;
  var data = {
    default_profile_id: appSettings.default_profile_id,
    default_scaler: appSettings.default_scaler,
    output_dir: appSettings.output_dir,
    check_updates: appSettings.check_updates,
    clear_completed_automatically: !!appSettings.clear_completed_automatically,
    open_output_folder_after_queue: !!appSettings.open_output_folder_after_queue,
    compression_suffix: appSettings.compression_suffix,
    upscale_suffix: appSettings.upscale_suffix,
    last_task: wf === 1 ? "upscale" : "compression",
    last_compress_profile_id: lastComp,
    last_upscale_profile_id: lastUpscale,
    left_sidebar_width: parseInt(byId("left").style.width) || 240,
  };
  api.saveSettings(JSON.stringify(data)).then(function (r) {
    if (r.ok) appSettings = Object.assign(appSettings, data);
  });
}

function updateActionButtons() {
  var up = wf === 1,
    nObj = Object.keys(clips).length,
    sel = !!selPath;
  byId("btn-one").textContent = up ? "Upscale selected" : "Compress selected";
  byId("btn-one").disabled = !sel;
  byId("btn-all").textContent =
    (up ? "Upscale all" : "Compress all") + (nObj ? " (" + nObj + ")" : "");
  byId("btn-all").disabled = !nObj;
  byId("btn-all").style.background = up ? "#2a2a3e" : "";
}

async function loadSettings() {
  if (!api) return;
  var s = await api.getSettings();
  appSettings = s;
  availEncoders = s.available_encoders || [];
  allProfiles = s.profiles || [];
  var def = s.default_profile_id || "";
  if (!lastComp) lastComp = s.last_compress_profile_id || def;
  if (!lastUpscale) lastUpscale = s.last_upscale_profile_id || "";
  if (s.last_task === "upscale" && !lastUpscale) lastUpscale = def;
  if (s.left_sidebar_width)
    byId("left").style.width = s.left_sidebar_width + "px";
  updateEncOpts();
  var task = s.last_task === "upscale" ? 1 : 0;
  if (task !== wf) setWf(task);
  else refilter();
}

function refilter() {
  var up = wf === 1,
    targetWf = up ? "upscale" : "compression";
  var matching = allProfiles.filter(function (p) {
    return (p.workflow || "compression") === targetWf;
  });
  var lastId = up ? lastUpscale : lastComp,
    sel = byId("prof-sel");
  sel.innerHTML = "";
  var sIdx = 0;
  if (!matching.length) {
    updateActionButtons();
    return;
  }
  for (var i = 0; i < matching.length; i++) {
    var o = document.createElement("option");
    o.value = matching[i].profile_id;
    o.textContent = matching[i].name;
    sel.appendChild(o);
    if (lastId && matching[i].profile_id === lastId) sIdx = i;
  }
  sel.selectedIndex = Math.max(sIdx, 0);
  applyProfile();
  reqPreview();
}

function onProfileChange() {
  var pid = byId("prof-sel").value;
  if (pid) {
    if (wf === 0) lastComp = pid;
    else lastUpscale = pid;
  }
  applyProfile();
  reqPreview();
  persistSession();
}

function selectedProfile() {
  var pid = byId("prof-sel").value;
  return (
    allProfiles.find(function (profile) {
      return profile.profile_id === pid;
    }) || null
  );
}

function applyProfileTransformToClip(profile, clip, force) {
  if (!clip || (!force && clip.transformOverride)) return;
  var intent = profile && profile.transform_intent;
  clip.cropAspect = intent ? intent.crop_aspect || "off" : "off";
  clip.rotation = intent ? intent.rotation || 0 : 0;
  clip.sizingMode = intent ? intent.sizing_mode || "fit" : "fit";
  clip.flipHorizontal = false;
  clip.flipVertical = false;
  clip.crop = null;
  if (
    clip.cropAspect !== "free" &&
    clip.cropAspect !== "off" &&
    clip.probed &&
    clip.probeData &&
    typeof TuckCropGeometry !== "undefined"
  ) {
    clip.crop = TuckCropGeometry.cropForAspect(
      null,
      clip.cropAspect,
      clip.probeData.width,
      clip.probeData.height,
      clip.rotation,
    );
    if (
      TuckCropGeometry.isFullCrop(
        clip.crop,
        clip.probeData.width,
        clip.probeData.height,
      )
    )
      clip.crop = null;
  }
  clip.transformOverride = false;
  clip.transformIntentTouched = false;
  clip.planData = null;
}

function applySelectedProfileTransform(clip, force) {
  applyProfileTransformToClip(selectedProfile(), clip, !!force);
}

function applyProfile(forceTransform) {
  var pid = byId("prof-sel").value;
  if (!pid) return;
  var p = null;
  for (var i = 0; i < allProfiles.length; i++) {
    if (allProfiles[i].profile_id === pid) {
      p = allProfiles[i];
      break;
    }
  }
  if (!p) return;
  Object.keys(clips).forEach(function (path) {
    applyProfileTransformToClip(p, clips[path], !!forceTransform);
  });
  var sizeMb = Math.round((p.target_size_bytes || 0) / (1024 * 1024));
  byId("sz-slider").value = sizeMb;
  byId("sz-badge").value = sizeMb;
  updateSizePresets(sizeMb);
  byId("res-mode").value = p.resolution_mode === "custom" ? "custom" : "source";
  byId("use-source-res").checked = wf === 0 && p.resolution_mode !== "custom";
  byId("res-w").value = p.custom_width || p.max_width || 1920;
  byId("res-h").value = p.custom_height || p.max_height || 1080;
  onResMode();
  var useSourceFps = p.fps_mode !== "custom";
  byId("use-source-fps").checked = useSourceFps;
  var fpsVal = Math.round(p.custom_fps || p.max_fps || 30);
  var clipMax =
    clips[selPath] && clips[selPath].probed
      ? Math.round(clips[selPath].probeData.fps || fpsVal)
      : fpsVal;
  byId("fps-slider").max = clipMax;
  if (fpsVal > clipMax) fpsVal = clipMax;
  byId("fps-slider").value = fpsVal;
  byId("fps-val").value = fpsVal;
  byId("fps-badge").textContent = fpsVal + " fps";
  onUseSourceFps();
  byId("keep-audio").checked = !!p.keep_audio;
  byId("audio-br").value = Math.round((p.audio_bitrate || 128000) / 1000);
  byId("audio-br").disabled = !!p.keep_audio;
  byId("two-pass").value = p.two_pass ? "on" : "off";
  byId("preset-sel").value = p.preset || "medium";
  var sc = p.scaler || "neighbor";
  byId("scaler-sel").value =
    sc === "neighbor" ? "Neighbor" : sc.charAt(0).toUpperCase() + sc.slice(1);
  byId("enc-sel").value = p.video_encoder || "libx264";
  updateTuneOpts();
  var tune = p.tune || "none",
    ts = byId("tune-sel");
  for (var i = 0; i < ts.options.length; i++) {
    if (ts.options[i].value === tune) {
      ts.selectedIndex = i;
      break;
    }
  }
  byId("quality-val").value =
    p.rate_control_method === "crf" ? p.crf || 23 : p.cq || p.qp || 23;
  byId("br-val").value =
    p.explicit_bitrate_kbps ||
    Math.round((p.explicit_bitrate || 0) / 1000) ||
    2000;
  updatePresetOptions();
  byId("preset-sel").value = p.preset || nativePresetForSpeed("balanced");
  syncSpeedFromPreset();
  updateRcOpts();
  var rcMap = { crf: "CRF", cq: "CQ", cqp: "CQ", cbr: "CBR", vbr: "VBR" },
    rcDisp = rcMap[p.rate_control_method] || "CRF",
    rs = byId("rc-sel");
  for (var i = 0; i < rs.options.length; i++) {
    if (rs.options[i].value === rcDisp) {
      rs.selectedIndex = i;
      break;
    }
  }
  updateRcVis();
  if (typeof syncTransformControls === "function") syncTransformControls();
  if (typeof paintCropOverlay === "function") paintCropOverlay();
  snapProf();
}

function onSize(v) {
  var size = parseInt(v);
  if (!size || size < 2) return;
  byId("sz-badge").value = size;
  byId("sz-slider").max = Math.max(500, size);
  byId("sz-slider").setAttribute("aria-valuenow", size);
  updateSizePresets(size);
  reqPreview();
  updateDirty();
}
function onBadgeSize(v) {
  var size = parseInt(v);
  if (!size || size < 2) {
    byId("sz-badge").value = byId("sz-slider").value;
    return;
  }
  byId("sz-slider").value = size;
  onSize(size);
}
function updateSizePresets(v) {
  var c = byId("sz-presets");
  c.innerHTML = "";
  [10, 50, 100, 500].forEach(function (mb) {
    var b = document.createElement("button");
    b.textContent = mb + " MB";
    if (mb === v) b.classList.add("on");
    b.onclick = function () {
      byId("sz-slider").value = mb;
      onSize(mb);
    };
    c.appendChild(b);
  });
}
function onUseSourceResolution() {
  byId("res-mode").value = byId("use-source-res").checked ? "source" : "custom";
  if (byId("use-source-res").checked) syncResolutionToClip(true);
  onResMode();
}
function onResMode() {
  var source = byId("res-mode").value === "source";
  byId("res-w").disabled = source;
  byId("res-h").disabled = source;
  byId("scaler-row").classList.toggle("hid", source);
  if (typeof paintCropOverlay === "function") paintCropOverlay();
  reqPreview();
  updateDirty();
}
function onResolutionGeometryChanged() {
  if (typeof paintCropOverlay === "function") paintCropOverlay();
  reqPreview();
  updateDirty();
}
function syncResolutionToClip(forceSourceValue) {
  if (!selPath || !clips[selPath] || !clips[selPath].probed) return;
  if (forceSourceValue || byId("use-source-res").checked) {
    var d = clips[selPath].probeData;
    byId("res-w").value = d.width || 1920;
    byId("res-h").value = d.height || 1080;
  }
}
function onUseSourceFps() {
  if (byId("use-source-fps").checked) syncFpsToClip(true);
  reqPreview();
  updateDirty();
}
function onFpsSlider(v) {
  byId("fps-val").value = v;
  byId("fps-badge").textContent = v + " fps";
  byId("fps-slider").setAttribute("aria-valuenow", v);
  reqPreview();
  updateDirty();
}
function syncFpsToClip(forceSourceValue) {
  if (!selPath || !clips[selPath] || !clips[selPath].probed) return;
  var native = Math.round(clips[selPath].probeData.fps) || 30;
  byId("fps-slider").max = native;
  var cur =
    forceSourceValue || byId("use-source-fps").checked
      ? native
      : parseInt(byId("fps-val").value) || native;
  if (cur > native) cur = native;
  byId("fps-slider").value = cur;
  byId("fps-val").value = cur;
  byId("fps-badge").textContent = cur + " fps";
}
function onKeepAudio() {
  byId("audio-br").disabled = byId("keep-audio").checked;
  reqPreview();
  updateDirty();
}
function onTwoPassChange() {
  reqPreview();
  updateDirty();
}
function toggleAdv() {
  var sec = byId("adv-sec"),
    open = sec.classList.contains("hid");
  sec.classList.toggle("hid", !open);
  byId("adv-toggle").setAttribute("aria-expanded", String(open));
  byId("adv-toggle").querySelector(".advanced-arrow").textContent = open
    ? "⌃"
    : "⌄";
}
function onEncChange() {
  updatePresetOptions();
  if (byId("enc-sel").value === "auto_compression") {
    byId("two-pass").value = "on";
    byId("preset-sel").value = "veryslow";
  }
  updateTuneOpts();
  updateRcOpts();
  gateTwoPass();
  reqPreview();
  updateDirty();
}
function onRcChange() {
  updateRcVis();
  reqPreview();
  updateDirty();
}

function encoderLabel(id) {
  return (
    {
      auto_compression: "Auto (best compression)",
      auto_fast: "Auto (fastest available)",
      auto: "Auto (fastest available)",
      libx264: "H.264 · Software",
      libx265: "H.265 · Software",
      h264_nvenc: "NVIDIA H.264 · Hardware",
      hevc_nvenc: "NVIDIA H.265 · Hardware",
      h264_amf: "AMD H.264 · Hardware",
      hevc_amf: "AMD H.265 · Hardware",
    }[id] || id
  );
}
function encoderIds(current) {
  var all = [
      "auto_compression",
      "auto_fast",
      "libx264",
      "libx265",
      "h264_nvenc",
      "hevc_nvenc",
      "h264_amf",
      "hevc_amf",
    ],
    avail = availEncoders.length ? availEncoders : all.slice(2);
  return all.filter(function (id) {
    return (
      id === "auto_compression" ||
      id === "auto_fast" ||
      avail.indexOf(id) >= 0 ||
      id === current
    );
  });
}
function isAutoEncoder(enc) {
  return enc === "auto" || enc === "auto_compression" || enc === "auto_fast";
}
function isCpuEncoder(enc) {
  return enc === "libx264" || enc === "libx265" || isAutoEncoder(enc);
}
function encoderOption(id) {
  var o = document.createElement("option");
  o.value = id;
  o.textContent = encoderLabel(id);
  if (
    !isAutoEncoder(id) &&
    availEncoders.length &&
    availEncoders.indexOf(id) < 0
  ) {
    o.disabled = true;
    o.textContent += " (unavailable)";
  }
  return o;
}
function populateEncoders(id) {
  var sel = byId(id),
    cur = sel.value || "auto_compression",
    ids = encoderIds(cur);
  sel.innerHTML = "";
  ids.forEach(function (enc) {
    sel.appendChild(encoderOption(enc));
  });
  if (!sel.options.length) sel.appendChild(encoderOption("libx264"));
  if (ids.indexOf(cur) < 0) cur = ids[0] || "libx264";
  sel.value = cur;
}
function updateEncOpts() {
  populateEncoders("enc-sel");
}
function tunesForEncoder(enc) {
  return enc === "libx265"
    ? [
        "none",
        "psnr",
        "ssim",
        "grain",
        "zerolatency",
        "fastdecode",
        "animation",
      ]
    : [
        "none",
        "film",
        "animation",
        "grain",
        "stillimage",
        "fastdecode",
        "zerolatency",
      ];
}
function populateTunes(id, enc) {
  var sel = byId(id),
    cur = sel.value,
    tunes = tunesForEncoder(enc);
  sel.innerHTML = "";
  tunes.forEach(function (t) {
    var o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  });
  sel.value = tunes.indexOf(cur) >= 0 ? cur : "none";
}
function updateTuneOpts() {
  populateTunes("tune-sel", byId("enc-sel").value);
}
function nativePresets(enc) {
  if (isCpuEncoder(enc))
    return [
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "fast",
      "medium",
      "slow",
      "slower",
      "veryslow",
    ];
  if (enc.indexOf("nvenc") >= 0)
    return ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  return ["speed", "balanced", "quality"];
}
function nativePresetForSpeed(speed, enc) {
  enc = enc || byId("enc-sel").value;
  if (isCpuEncoder(enc))
    return { fast: "veryfast", balanced: "medium", best: "slow" }[speed];
  if (enc.indexOf("nvenc") >= 0)
    return { fast: "p2", balanced: "p5", best: "p7" }[speed];
  return { fast: "speed", balanced: "balanced", best: "quality" }[speed];
}
function speedForNativePreset(preset) {
  if (
    [
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "p1",
      "p2",
      "p3",
      "speed",
    ].indexOf(preset) >= 0
  )
    return "fast";
  if (
    ["slow", "slower", "veryslow", "p6", "p7", "quality"].indexOf(preset) >= 0
  )
    return "best";
  return "balanced";
}
function populatePresets(id, enc, speedId) {
  var sel = byId(id),
    cur = sel.value,
    presets = nativePresets(enc);
  sel.innerHTML = "";
  presets.forEach(function (p) {
    var o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  });
  sel.value =
    presets.indexOf(cur) >= 0
      ? cur
      : nativePresetForSpeed(byId(speedId).value || "balanced", enc);
}
function updatePresetOptions() {
  populatePresets("preset-sel", byId("enc-sel").value, "speed-sel");
}
function rateControlOptions(workflow, enc) {
  return workflow === "upscale"
    ? isCpuEncoder(enc)
      ? ["CRF", "CBR"]
      : ["CQ", "CBR", "VBR"]
    : isCpuEncoder(enc)
      ? ["CBR"]
      : ["CBR", "VBR"];
}
function defaultRateControl(workflow, enc) {
  return workflow === "upscale"
    ? isCpuEncoder(enc)
      ? "CRF"
      : "CQ"
    : isCpuEncoder(enc)
      ? "CBR"
      : "VBR";
}
function twoPassEligible(workflow, enc) {
  return (
    workflow === "compression" &&
    (enc === "libx264" || enc === "libx265" || enc === "auto_compression")
  );
}
function populateRateControls(id, workflow, enc) {
  var sel = byId(id),
    cur = sel.value,
    opts = rateControlOptions(workflow, enc);
  sel.innerHTML = "";
  opts.forEach(function (v) {
    var o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  });
  sel.value = opts.indexOf(cur) >= 0 ? cur : defaultRateControl(workflow, enc);
}
function onSpeedChange() {
  byId("preset-sel").value = nativePresetForSpeed(byId("speed-sel").value);
  reqPreview();
  updateDirty();
}
function onNativePresetChange() {
  syncSpeedFromPreset();
  reqPreview();
  updateDirty();
}
function syncSpeedFromPreset() {
  byId("speed-sel").value = speedForNativePreset(byId("preset-sel").value);
}
function updateRcOpts() {
  populateRateControls(
    "rc-sel",
    wf === 1 ? "upscale" : "compression",
    byId("enc-sel").value,
  );
  updateRcVis();
}
function updateRcVis() {
  var rc = byId("rc-sel").value,
    up = wf === 1,
    quality = up && (rc === "CRF" || rc === "CQ");
  byId("rate-control-row").classList.toggle("hid", !up);
  byId("quality-row").classList.toggle("hid", !quality);
  byId("quality-label").textContent = rc === "CRF" ? "CRF value" : "CQ value";
  byId("br-row").classList.toggle(
    "hid",
    !(up && (rc === "CBR" || rc === "VBR")),
  );
  byId("tune-row").classList.toggle(
    "hid",
    !(up && isCpuEncoder(byId("enc-sel").value)),
  );
}
function gateTwoPass() {
  var can = twoPassEligible(
    wf === 1 ? "upscale" : "compression",
    byId("enc-sel").value,
  );
  byId("two-pass").disabled = !can;
  byId("two-pass-note").classList.toggle("hid", can || wf === 1);
  if (!can) byId("two-pass").value = "off";
}

async function reqPreview() {
  var path = selPath;
  var clip = path && clips[path];
  if (!api || !clip || !clip.probed) return;
  var requestId = ++previewRequestId;
  clip._previewRequestId = requestId;
  clip.planData = null;
  if (typeof paintCropOverlay === "function") paintCropOverlay();
  var req = buildReq(path);
  req._request_id = requestId;
  try {
    var r = await api.createPlan(JSON.stringify(req));
    if (
      r.ok &&
      r.data &&
      clips[path] === clip &&
      clip._previewRequestId === requestId &&
      r._request_id === requestId
    ) {
      clip.planData = r.data;
      if (selPath !== path) return;
      byId("calc-br").textContent =
        wf === 0
          ? "Calculated bitrate: " +
            r.data.video_bitrate_kbps +
            " kbps · " +
            r.data.segment_count +
            (r.data.segment_count === 1 ? " segment · " : " segments · ") +
            fmtt(r.data.selected_duration) +
            " selected"
          : "";
      if (typeof paintCropOverlay === "function") paintCropOverlay();
    }
  } catch (e) {}
}

function buildReq(src) {
  var up = wf === 1,
    rc = byId("rc-sel").value,
    rcMap = { CRF: "crf", CQ: "cq", CBR: "cbr", VBR: "vbr" };
  var req = {
    source: src,
    profile_id: byId("prof-sel").value,
    workflow: up ? "upscale" : "compression",
    rate_control: "target_size",
    video_encoder: byId("enc-sel").value,
    preset: byId("preset-sel").value,
    rate_control_method: rcMap[rc] || "cbr",
  };
  if (!up)
    req.target_size_bytes = parseInt(byId("sz-slider").value) * 1024 * 1024;
  if (byId("res-mode").value === "custom") {
    req.resolution_mode = "custom";
    req.custom_width = parseInt(byId("res-w").value);
    req.custom_height = parseInt(byId("res-h").value);
    req.scaler = byId("scaler-sel").value.toLowerCase();
  } else req.resolution_mode = "source";
  if (byId("use-source-fps").checked) req.fps_mode = "source";
  else {
    req.fps_mode = "custom";
    req.custom_fps = parseInt(byId("fps-val").value);
  }
  var keep = byId("keep-audio").checked;
  req.keep_audio = keep;
  if (!keep) req.audio_bitrate = parseInt(byId("audio-br").value) * 1000;
  req.two_pass = !up && byId("two-pass").value === "on";
  if (rc === "CRF") req.crf = parseInt(byId("quality-val").value);
  if (rc === "CQ") req.cq = parseInt(byId("quality-val").value);
  if (up && (rc === "CBR" || rc === "VBR")) {
    req.rate_control = "explicit_bitrate";
    req.explicit_bitrate = parseInt(byId("br-val").value) * 1000;
  }
  if (
    up &&
    (byId("enc-sel").value === "libx264" || byId("enc-sel").value === "libx265")
  ) {
    var tune = byId("tune-sel").value;
    if (tune !== "none") req.tune = tune;
  }
  var c = clips[src];
  if (c) {
    var full = (c.probeData && c.probeData.duration) || 0;
    var edited = (c.segments && c.segments.length) || c.trimStart != null || c.trimEnd != null;
    if (full > 0 && edited) {
      req.segments = SegmentEditing.segmentsForClip(c, full).map(function (segment) {
        return {
          start: segment.start,
          end: segment.end,
        };
      });
    }
    var profile = selectedProfile();
    if (
      typeof cropTransformForRequest === "function" &&
      (c.transformOverride || !profile || !profile.transform_intent)
    ) {
      var transform = cropTransformForRequest(c);
      if (transform) req.transform = transform;
    }
    if (window.AudioTimeline) Object.assign(req, AudioTimeline.requestPayload(c));
  }
  return req;
}

async function compressOne() {
  if (!api || !selPath) {
    toast("Select a clip first.", "err");
    return;
  }
  var r = await api.enqueueWithOptions(
    JSON.stringify(buildReq(clips[selPath].path)),
  );
  if (!r.ok) toast("Error: " + r.error, "err");
  pollQueue();
}

async function compressAll() {
  if (!api) return;
  var keys = orderedClipKeys();
  if (!keys.length) {
    toast("Add clips first.", "err");
    return;
  }
  var reqs = [];
  for (var i = 0; i < keys.length; i++)
    reqs.push(buildReq(clips[keys[i]].path));
  var r = await api.enqueueBatch(JSON.stringify(reqs));
  if (!r.ok) toast("Error: " + (r.error || "Failed"), "err");
  if (r.errors && r.errors.length) toast("Some errors occurred.", "err");
  pollQueue();
}

async function saveProfileChanges() {
  if (!api) return;
  var pid = byId("prof-sel").value;
  if (!pid) {
    toast("Select a profile.", "err");
    return;
  }
  var name = byId("prof-sel")
    .selectedOptions[0].textContent.split(" (")[0]
    .trim();
  var data = savePayload(name);
  var r = await api.updateProfile(pid, JSON.stringify(data));
  if (r.ok) {
    if (selPath && clips[selPath]) {
      clips[selPath].transformOverride = false;
      clips[selPath].transformIntentTouched = false;
    }
    await loadSettings();
    snapProf();
    toast('Changes saved to "' + name + '".', "ok");
  } else toast(r.error, "err");
}

async function saveProfileAs() {
  if (!api) return;
  showMod(
    `<h2>Save Profile As</h2>
    <div>
      <span>Profile name</span>
      <input type="text" id="sp-name" placeholder="My profile">
    </div>
    <div class="mod-btns">
      <button class="btn2" onclick="closeMod()">Cancel</button>
      <button class="btn1" style="width:auto" onclick="doSaveAs()">Save</button>
    </div>`,
  );
  setTimeout(function () {
    var inp = byId("sp-name");
    if (inp) {
      inp.focus();
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") doSaveAs();
      });
    }
  }, 100);
}
async function doSaveAs() {
  var name = (byId("sp-name").value || "").trim();
  if (!name) {
    toast("Enter a name.", "err");
    return;
  }
  closeMod();
  var data = savePayload(name);
  var r = await api.createProfile(JSON.stringify(data));
  if (r.ok) {
    await loadSettings();
    snapProf();
    toast('Profile saved as "' + name + '".', "ok");
  } else toast(r.error, "err");
}

function savePayload(name) {
  var sizeMb = parseInt(byId("sz-slider").value),
    up = wf === 1,
    rcMap = { CRF: "crf", CQ: "cq", CBR: "cbr", VBR: "vbr" },
    rc = up
      ? rcMap[byId("rc-sel").value] || "crf"
      : isCpuEncoder(byId("enc-sel").value)
        ? "cbr"
        : "vbr",
    isBr = rc === "cbr" || rc === "vbr",
    current =
      allProfiles.find(function (p) {
        return p.profile_id === byId("prof-sel").value;
      }) || {};
  if (current.rate_control_method === "cqp" && rc === "cq") rc = "cqp";
  var data = {
    name: name,
    target_size_mb: sizeMb,
    resolution_mode: byId("res-mode").value,
    custom_width: parseInt(byId("res-w").value),
    custom_height: parseInt(byId("res-h").value),
    max_width: parseInt(byId("res-w").value),
    max_height: parseInt(byId("res-h").value),
    fps_mode: byId("use-source-fps").checked ? "source" : "custom",
    custom_fps: parseInt(byId("fps-val").value),
    max_fps: parseInt(byId("fps-val").value),
    rate_control: up && isBr ? "explicit_bitrate" : "target_size",
    audio_bitrate_kbps: parseInt(byId("audio-br").value),
    keep_audio: byId("keep-audio").checked,
    two_pass: !up && byId("two-pass").value === "on",
    preset: byId("preset-sel").value,
    scaler: byId("scaler-sel").value.toLowerCase(),
    video_encoder: byId("enc-sel").value,
    workflow: up ? "upscale" : "compression",
    rate_control_method: rc,
    cq: rc === "cq" ? parseInt(byId("quality-val").value) : current.cq || 23,
    qp: rc === "cqp" ? parseInt(byId("quality-val").value) : current.qp || 23,
    crf: rc === "crf" ? parseInt(byId("quality-val").value) : current.crf || 23,
  };
  var clip = selPath && clips[selPath];
  if (current.transform_intent || (clip && clip.transformIntentTouched)) {
    data.transform_intent = {
      crop_aspect: clip && clip.cropAspect !== "off" ? clip.cropAspect || "free" : "free",
      rotation: clip ? clip.rotation || 0 : 0,
      sizing_mode: clip ? clip.sizingMode || "fit" : "fit",
    };
  }
  if (up && isBr) data.explicit_bitrate_kbps = parseInt(byId("br-val").value);
  if (up && isCpuEncoder(byId("enc-sel").value))
    data.tune = byId("tune-sel").value === "none" ? "" : byId("tune-sel").value;
  return data;
}
