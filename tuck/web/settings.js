var settingsPage = "general",
  settingsView = "page",
  settingsProfileId = "",
  settingsFilter = "all",
  editorOriginal = null,
  editorSnapshot = "";
function valueOr(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}
function settingsShell(page, content, actions) {
  var actionBar = byId("settings-actions");
  document.body.classList.add("settings-open");
  byId("settings-page").innerHTML =
    '<div class="settings-page-inner">' + content + "</div>";
  actionBar.className = "settings-actions " + (actions.split ? "split" : "");
  actionBar.innerHTML = actions.html
    ? actions.plain
      ? actions.html
      : `<span class="settings-unsaved" id="settings-unsaved">
          Unsaved changes
        </span>
        <span class="settings-action-spacer"></span>
        ${actions.html}`
    : "";
  ["general", "output", "profiles", "explorer", "system"].forEach(
    function (name) {
      var button = byId("settings-nav-" + name),
        active = name === page;
      button.classList.toggle("on", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    },
  );
}
function toggleSettings() {
  if (document.body.classList.contains("settings-open")) closeSettings();
  else openSettings();
}
function settingButton(label, action, primary) {
  return (
    '<button class="' +
    (primary ? "btn1" : "btn2") +
    '" onclick="' +
    action +
    '">' +
    label +
    "</button>"
  );
}
function profileSummary(p) {
  var up = (p.workflow || "compression") === "upscale",
    res =
      p.resolution_mode === "custom"
        ? (p.custom_width || p.max_width) +
          " × " +
          (p.custom_height || p.max_height)
        : "Source resolution",
    fps =
      p.fps_mode === "custom"
        ? Math.round(p.custom_fps || p.max_fps || 30) + " FPS"
        : "Source FPS",
    audio = p.keep_audio
      ? "Keep audio"
      : (p.audio_bitrate_kbps || 128) + " kbps audio";
  var transform = p.transform_intent,
    transformSummary = transform
      ? " · " +
        (transform.crop_aspect === "free" ? "Free aspect" : transform.crop_aspect) +
        " · " +
        (transform.sizing_mode || "fit").replace(/^./, function (value) {
          return value.toUpperCase();
        }) +
        (transform.rotation ? " · " + transform.rotation + "°" : "")
      : "";
  return (
    (up ? "Upscale" : "Compress") +
    " · " +
    (up
      ? ""
      : Math.round((p.target_size_bytes || 0) / (1024 * 1024)) + " MB · ") +
    res +
    " · " +
    fps +
    " · " +
    audio +
    transformSummary
  );
}
async function refreshPMList(filter) {
  settingsFilter = filter || settingsFilter;
  var list = byId("pm-list");
  if (!list) return;
  var profiles = await api.getProfilesJson();
  list.innerHTML = "";
  ["all", "compression", "upscale"].forEach(function (k) {
    var b = byId("pm-" + k);
    if (b) b.classList.toggle("on", k === settingsFilter);
  });
  profiles.forEach(function (p) {
    if (
      settingsFilter !== "all" &&
      (p.workflow || "compression") !== settingsFilter
    )
      return;
    var row = document.createElement("div"),
      badge =
        p.profile_id === appSettings.default_profile_id
          ? '<span class="settings-badge">Default</span>'
          : "";
    row.className = "settings-list-row";
    row.innerHTML =
      '<div class="settings-list-main"><strong>' +
      esc(p.name) +
      "</strong><span>" +
      esc(profileSummary(p)) +
      "</span>" +
      badge +
      '</div><button class="btn2" onclick="editProf(\'' +
      escJS(p.profile_id) +
      '\')">Edit</button><details class="profile-actions-menu"><summary class="mbtn" aria-label="More actions for ' +
      esc(p.name) +
      '">•••</summary><div class="profile-actions-popover"><button onclick="exportProf(\'' +
      escJS(p.profile_id) +
      '\')">Export</button><button onclick="dupProf(\'' +
      escJS(p.profile_id) +
      '\')">Duplicate</button><button class="danger" onclick="delProf(\'' +
      escJS(p.profile_id) +
      "','" +
      escJS(p.name) +
      "')\">Delete</button></div></details>";
    list.appendChild(row);
  });
  if (!list.children.length)
    list.innerHTML = '<div class="settings-empty">No matching profiles.</div>';
}
async function editProf(pid) {
  openSettings("profiles", "editor", pid);
}
async function newProf() {
  openSettings("profiles", "editor", "");
}
async function dupProf(pid) {
  var r = await api.duplicateProfile(pid);
  if (r.ok) {
    await loadSettings();
    refreshPMList();
    toast("Profile duplicated.", "ok");
  } else toast(r.error, "err");
}
async function delProf(pid, name) {
  confirmToast('Delete "' + name + '"?', function () {
    api.deleteProfile(pid).then(async function (r) {
      if (r.ok) {
        await loadSettings();
        refreshPMList();
        toast("Profile deleted.", "ok");
      } else toast(r.error, "err");
    });
  });
}
async function importProfs() {
  var r = await api.pickImportFile();
  if (!r.ok || !r.path) return;
  var result = await api.importProfilesFromFile(r.path);
  if (result.ok) {
    await loadSettings();
    refreshPMList();
    toast("Profiles imported.", "ok");
  } else toast(result.error, "err");
}
async function exportProf(pid) {
  var r = await api.pickSaveFile(pid + ".json");
  if (!r.ok || !r.path) return;
  var result = await api.exportProfileToFile(r.path, pid);
  if (result.ok) toast("Profile exported.", "ok");
  else toast(result.error, "err");
}
function settingsTitle(title, action) {
  var backButton = action
    ? `<button class="settings-title-back" aria-label="Back" onclick="${action}">
        ←
      </button>`
    : "";
  return `<div class="settings-title-row">
    ${backButton}
    <h3 class="settings-title">${title}</h3>
  </div>`;
}
function profileEditorTaskHTML() {
  return `<div class="settings-field full">
    <label for="pe-name">Profile name</label>
    <input id="pe-name" type="text">
  </div>
  <div class="settings-field full">
    <label>Task</label>
    <div class="profile-editor-task">
      <button id="pe-c" onclick="peSetTask('compression')">Compress</button>
      <button id="pe-u" onclick="peSetTask('upscale')">Upscale</button>
    </div>
  </div>`;
}
function profileEditorVideoHTML() {
  return `<div class="settings-sec full" id="pe-size-sec">
    <h3>Target Size</h3>
    <div class="sl-row">
      <input id="pe-size-range" type="range" min="2" max="500" value="50" oninput="peSetSize(this.value)">
      <input
        id="pe-size"
        type="number"
        min="2"
        value="50"
        aria-label="Target size in MB"
        oninput="peSetSize(this.value)"
      >
      <span>MB</span>
    </div>
    <div class="pset">
      <button onclick="peSetSize(20)">20 MB</button>
      <button onclick="peSetSize(50)">50 MB</button>
      <button onclick="peSetSize(100)">100 MB</button>
      <button onclick="peSetSize(500)">500 MB</button>
    </div>
  </div>
  <div class="settings-sec full">
    <h3>Resolution</h3>
    <div class="info-row" id="pe-source-res-row">
      <span>Use source resolution</span>
      <label class="chk">
        <input id="pe-source-res" type="checkbox" onchange="peVisibility()">
        <span class="chk-box"></span>
        <span>Source</span>
      </label>
    </div>
    <div class="row" id="pe-dim">
      <input id="pe-w" type="number" min="1" aria-label="Custom width">
      <span>×</span>
      <input id="pe-h" type="number" min="1" aria-label="Custom height">
    </div>
    <div id="pe-scaler-row" class="settings-field">
      <label for="pe-scaler">Scaler</label>
      <select id="pe-scaler">
        <option>Bilinear</option>
        <option>Bicubic</option>
        <option>Lanczos</option>
        <option>Point</option>
        <option>Neighbor</option>
      </select>
    </div>
  </div>
  <div class="settings-sec full">
    <h3>Frame Rate</h3>
    <div class="info-row">
      <span>Use source frame rate</span>
      <label class="chk">
        <input id="pe-source-fps" type="checkbox" onchange="peVisibility()">
        <span class="chk-box"></span>
        <span>Source</span>
      </label>
    </div>
    <div id="pe-fps-row" class="sl-row">
      <input id="pe-fps-range" type="range" min="1" max="240" value="30" oninput="peSetFps(this.value)">
      <input
        id="pe-fps"
        type="number"
        min="1"
        max="240"
        value="30"
        aria-label="Custom frame rate"
        oninput="peSetFps(this.value)"
      >
      <span>fps</span>
    </div>
  </div>`;
}
function profileEditorTransformHTML() {
  return `<div class="settings-sec full">
    <h3>Transform defaults</h3>
    <div class="info-row">
      <span>Apply reusable transform intent</span>
      <label class="chk">
        <input id="pe-transform-enabled" type="checkbox" onchange="peVisibility()">
        <span class="chk-box"></span>
        <span>Enabled</span>
      </label>
    </div>
    <div id="pe-transform-fields">
      <div class="settings-field">
        <label for="pe-aspect">Target aspect</label>
        <select id="pe-aspect">
          <option value="free">Free</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="4:3">4:3</option>
        </select>
      </div>
      <div class="settings-field">
        <label for="pe-sizing">Sizing</label>
        <select id="pe-sizing">
          <option value="fit">Fit</option>
          <option value="fill">Fill</option>
          <option value="stretch">Stretch</option>
        </select>
      </div>
      <div class="settings-field">
        <label for="pe-rotation">Rotation</label>
        <select id="pe-rotation">
          <option value="0">None</option>
          <option value="90">90° clockwise</option>
          <option value="180">180°</option>
          <option value="270">90° counterclockwise</option>
        </select>
      </div>
      <span class="setting-note">Manual crop position and dimensions are never saved.</span>
    </div>
  </div>`;
}
function profileEditorAudioHTML() {
  return `<div class="settings-sec full">
    <h3>Audio</h3>
    <div class="info-row">
      <span>Keep source audio</span>
      <label class="chk">
        <input id="pe-audio-source" type="checkbox" onchange="peVisibility()">
        <span class="chk-box"></span>
        <span>Source</span>
      </label>
    </div>
    <div class="settings-field">
      <label for="pe-audio">Audio bitrate (kbps)</label>
      <input id="pe-audio" type="number" min="0" max="320">
    </div>
  </div>`;
}
function profileEditorEncodingHTML() {
  return `<div class="settings-sec full">
    <h3>Encoding</h3>
    <div class="settings-field">
      <label for="pe-enc">Encoder</label>
      <select id="pe-enc" onchange="peEncoderChanged()"></select>
    </div>
    <span class="setting-note">Hardware is faster; software can produce smaller files.</span>
    <div class="settings-field">
      <label for="pe-speed">Encoding speed</label>
      <select id="pe-speed" onchange="peSpeedChanged()">
        <option value="fast">Fast</option>
        <option value="balanced">Balanced</option>
        <option value="best">Best compression</option>
      </select>
    </div>
    <div id="pe-two-pass-row" class="settings-field">
      <label for="pe-two-pass">Two-pass encoding</label>
      <select id="pe-two-pass">
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
      <span id="pe-two-pass-note" class="help-tip">Two-pass is available only for software compression.</span>
    </div>
    <button class="advanced-toggle" id="pe-advanced-button" onclick="peToggleAdvanced()" aria-expanded="false">
      <span>Advanced encoding</span>
      <span class="advanced-arrow">⌄</span>
    </button>
    <div id="pe-advanced" class="hid">
      <div class="settings-field">
        <label for="pe-preset">Native FFmpeg preset</label>
        <select id="pe-preset" onchange="pePresetChanged()"></select>
      </div>
      <div class="settings-field" id="pe-rc-row">
        <label for="pe-rc">Quality method</label>
        <select id="pe-rc" onchange="peVisibility()"></select>
      </div>
      <div class="settings-field" id="pe-quality-row">
        <label id="pe-quality-label" for="pe-quality">CQ</label>
        <input id="pe-quality" type="number" min="0" max="51">
        <span class="help-tip">Lower value = higher quality.</span>
      </div>
      <div class="settings-field" id="pe-bitrate-row">
        <label for="pe-bitrate">Bitrate (kbps)</label>
        <input id="pe-bitrate" type="number" min="50" max="50000">
      </div>
      <div class="settings-field" id="pe-tune-row">
        <label for="pe-tune">Tune</label>
        <select id="pe-tune"></select>
      </div>
    </div>
  </div>`;
}
function profileEditorHTML() {
  var title = settingsProfileId ? "Edit profile" : "New profile";
  return `${settingsTitle(title, "backToProfiles()")}
    <div class="settings-grid">
      ${profileEditorTaskHTML()}
      ${profileEditorVideoHTML()}
      ${profileEditorTransformHTML()}
      ${profileEditorAudioHTML()}
      ${profileEditorEncodingHTML()}
    </div>`;
}
function peTask() {
  return byId("pe-u").classList.contains("on") ? "upscale" : "compression";
}
function peSetTask(task) {
  byId("pe-c").classList.toggle("on", task === "compression");
  byId("pe-u").classList.toggle("on", task === "upscale");
  byId("pe-size-sec").classList.toggle("hid", task === "upscale");
  byId("pe-source-res-row").classList.toggle("hid", task === "upscale");
  if (task === "upscale") byId("pe-source-res").checked = false;
  peRateControls();
  peVisibility();
}
function peSetSize(value) {
  var n = Math.max(2, parseInt(value) || 2);
  byId("pe-size").value = n;
  byId("pe-size-range").max = Math.max(500, n);
  byId("pe-size-range").value = n;
}
function peSetFps(value) {
  var n = Math.max(1, Math.min(240, parseFloat(value) || 30));
  byId("pe-fps").value = n;
  byId("pe-fps-range").value = n;
}
function populateEditorEncoders() {
  populateEncoders("pe-enc");
}
function pePresets() {
  populatePresets("pe-preset", byId("pe-enc").value, "pe-speed");
}
function peTunes() {
  populateTunes("pe-tune", byId("pe-enc").value);
}
function peRateControls() {
  populateRateControls("pe-rc", peTask(), byId("pe-enc").value);
}
function peEncoderChanged() {
  pePresets();
  if (byId("pe-enc").value === "auto_compression") {
    byId("pe-two-pass").value = "on";
    byId("pe-preset").value = "veryslow";
  }
  peTunes();
  peRateControls();
  peVisibility();
}
function peSpeedChanged() {
  byId("pe-preset").value = nativePresetForSpeed(
    byId("pe-speed").value,
    byId("pe-enc").value,
  );
}
function pePresetChanged() {
  byId("pe-speed").value = speedForNativePreset(byId("pe-preset").value);
}
function peVisibility() {
  var up = peTask() === "upscale",
    source = byId("pe-source-res").checked,
    sourceFps = byId("pe-source-fps").checked,
    keep = byId("pe-audio-source").checked,
    rc = byId("pe-rc").value,
    cpu =
      !isAutoEncoder(byId("pe-enc").value) &&
      isCpuEncoder(byId("pe-enc").value),
    twoPass = twoPassEligible(peTask(), byId("pe-enc").value),
    quality = up && (rc === "CRF" || rc === "CQ");
  byId("pe-dim").classList.toggle("hid", source);
  byId("pe-scaler-row").classList.toggle("hid", source);
  byId("pe-fps-row").classList.toggle("hid", sourceFps);
  byId("pe-audio").disabled = keep;
  byId("pe-two-pass-row").classList.toggle("hid", up);
  byId("pe-two-pass-note").classList.toggle("hid", !(!up && !twoPass));
  byId("pe-two-pass").disabled = !twoPass;
  if (!twoPass) byId("pe-two-pass").value = "off";
  byId("pe-rc-row").classList.toggle("hid", !up);
  byId("pe-quality-row").classList.toggle("hid", !quality);
  byId("pe-bitrate-row").classList.toggle(
    "hid",
    !(up && (rc === "CBR" || rc === "VBR")),
  );
  byId("pe-tune-row").classList.toggle("hid", !(up && cpu));
  byId("pe-transform-fields").classList.toggle(
    "hid",
    !byId("pe-transform-enabled").checked,
  );
  byId("pe-quality-label").textContent = rc === "CRF" ? "CRF" : "CQ";
}
function peToggleAdvanced() {
  var el = byId("pe-advanced"),
    open = el.classList.contains("hid");
  el.classList.toggle("hid", !open);
  byId("pe-advanced-button").setAttribute("aria-expanded", String(open));
  byId("pe-advanced-button").querySelector(".advanced-arrow").textContent = open
    ? "⌃"
    : "⌄";
}
function pePayload() {
  var original = editorOriginal || {},
    task = peTask(),
    rcDisplay = byId("pe-rc").value,
    rcMap = { CRF: "crf", CQ: "cq", CBR: "cbr", VBR: "vbr" },
    rc = rcMap[rcDisplay],
    quality = parseInt(byId("pe-quality").value);
  if (!Number.isFinite(quality)) quality = 23;
  if (original.rate_control_method === "cqp" && rcDisplay === "CQ") rc = "cqp";
  var data = {
    name: byId("pe-name").value.trim() || "Profile",
    target_size_mb: parseInt(byId("pe-size").value) || 50,
    resolution_mode: byId("pe-source-res").checked ? "source" : "custom",
    custom_width: parseInt(byId("pe-w").value) || 1920,
    custom_height: parseInt(byId("pe-h").value) || 1080,
    max_width: parseInt(byId("pe-w").value) || 1920,
    max_height: parseInt(byId("pe-h").value) || 1080,
    fps_mode: byId("pe-source-fps").checked ? "source" : "custom",
    custom_fps: parseFloat(byId("pe-fps").value) || 30,
    max_fps: parseFloat(byId("pe-fps").value) || 30,
    audio_bitrate_kbps: parseInt(byId("pe-audio").value) || 0,
    keep_audio: byId("pe-audio-source").checked,
    two_pass:
      twoPassEligible(task, byId("pe-enc").value) &&
      byId("pe-two-pass").value === "on",
    preset: byId("pe-preset").value,
    scaler: byId("pe-scaler").value.toLowerCase(),
    video_encoder: byId("pe-enc").value,
    workflow: task,
    rate_control_method: rc,
    rate_control:
      task === "upscale" && (rc === "cbr" || rc === "vbr")
        ? "explicit_bitrate"
        : "target_size",
    crf: rc === "crf" ? quality : valueOr(original.crf, 23),
    cq: rc === "cq" ? quality : valueOr(original.cq, 23),
    qp: rc === "cqp" ? quality : valueOr(original.qp, 23),
    tune:
      task === "upscale" &&
      isCpuEncoder(byId("pe-enc").value) &&
      byId("pe-tune").value !== "none"
        ? byId("pe-tune").value
        : "",
    transform_intent: byId("pe-transform-enabled").checked
      ? {
          crop_aspect: byId("pe-aspect").value,
          sizing_mode: byId("pe-sizing").value,
          rotation: parseInt(byId("pe-rotation").value) || 0,
        }
      : null,
  };
  if (task === "upscale" && (rc === "cbr" || rc === "vbr"))
    data.explicit_bitrate_kbps = parseInt(byId("pe-bitrate").value) || 2000;
  return data;
}
async function hydrateEditor() {
  populateEditorEncoders();
  var p = null;
  if (settingsProfileId) {
    var profiles = await api.getProfilesJson();
    p = profiles.find(function (x) {
      return x.profile_id === settingsProfileId;
    });
  }
  editorOriginal = p || {};
  var scaler = p ? p.scaler : appSettings.default_scaler || "neighbor",
    fps = p ? Math.round(valueOr(p.custom_fps, valueOr(p.max_fps, 30))) : 30;
  byId("pe-name").value = p ? p.name : "";
  peSetSize(
    p
      ? Math.round(
          valueOr(p.target_size_bytes, 50 * 1024 * 1024) / (1024 * 1024),
        )
      : 50,
  );
  byId("pe-w").value = p
    ? valueOr(p.custom_width, valueOr(p.max_width, 1920))
    : 1920;
  byId("pe-h").value = p
    ? valueOr(p.custom_height, valueOr(p.max_height, 1080))
    : 1080;
  byId("pe-scaler").value =
    scaler === "neighbor"
      ? "Neighbor"
      : scaler[0].toUpperCase() + scaler.slice(1);
  byId("pe-source-res").checked = p ? p.resolution_mode !== "custom" : true;
  byId("pe-source-fps").checked = p ? p.fps_mode !== "custom" : true;
  peSetFps(fps);
  byId("pe-audio-source").checked = !!(p && p.keep_audio);
  byId("pe-audio").value = p ? valueOr(p.audio_bitrate_kbps, 128) : 128;
  var intent = p && p.transform_intent;
  byId("pe-transform-enabled").checked = !!intent;
  byId("pe-aspect").value = intent ? intent.crop_aspect || "free" : "free";
  byId("pe-sizing").value = intent ? intent.sizing_mode || "fit" : "fit";
  byId("pe-rotation").value = String(intent ? intent.rotation || 0 : 0);
  byId("pe-enc").value = p ? valueOr(p.video_encoder, "libx264") : "libx264";
  peEncoderChanged();
  byId("pe-preset").value = p
    ? valueOr(p.preset, nativePresetForSpeed("balanced", byId("pe-enc").value))
    : nativePresetForSpeed("balanced", byId("pe-enc").value);
  pePresetChanged();
  byId("pe-two-pass").value = p && p.two_pass ? "on" : "off";
  byId("pe-quality").value = p
    ? p.rate_control_method === "crf"
      ? valueOr(p.crf, 23)
      : p.rate_control_method === "cqp"
        ? valueOr(p.qp, 23)
        : valueOr(p.cq, 23)
    : 23;
  byId("pe-bitrate").value = p ? valueOr(p.explicit_bitrate_kbps, 2000) : 2000;
  peSetTask(p && p.workflow === "upscale" ? "upscale" : "compression");
  byId("pe-rc").value =
    { crf: "CRF", cq: "CQ", cqp: "CQ", cbr: "CBR", vbr: "VBR" }[
      p ? p.rate_control_method : "cbr"
    ] || "CRF";
  peVisibility();
  editorSnapshot = JSON.stringify(pePayload());
}
function editorDirty() {
  return editorSnapshot && JSON.stringify(pePayload()) !== editorSnapshot;
}
function backToProfiles() {
  if (editorDirty())
    confirmToast("Discard unsaved profile changes?", function () {
      settingsView = "page";
      settingsProfileId = "";
      openSettings("profiles");
    });
  else {
    settingsView = "page";
    settingsProfileId = "";
    openSettings("profiles");
  }
}
async function saveProfEdit() {
  var r = settingsProfileId
    ? await api.updateProfile(settingsProfileId, JSON.stringify(pePayload()))
    : await api.createProfile(JSON.stringify(pePayload()));
  if (r.ok) {
    await loadSettings();
    settingsView = "page";
    settingsProfileId = "";
    openSettings("profiles");
    toast("Profile saved.", "ok");
  } else toast(r.error, "err");
}

function markSettingsDirty() {
  settingsDirty = true;
  var indicator = byId("settings-unsaved");
  if (indicator) {
    indicator.textContent = "Unsaved changes";
    indicator.classList.add("on");
  }
}
function generalSettingsHTML(s, profiles) {
  var options = profiles
    .map(function (p) {
      return `<option value="${esc(p.profile_id)}">${esc(p.name)}</option>`;
    })
    .join("");
  var scalers = ["Bilinear", "Bicubic", "Lanczos", "Point", "Neighbor"]
    .map(function (x) {
      var selected =
        x.toLowerCase() === (s.default_scaler || "neighbor") ? "selected" : "";
      return `<option ${selected}>${x}</option>`;
    })
    .join("");
  var autoClear = s.clear_completed_automatically ? "checked" : "";
  return `<div class="settings-card">
    <div class="settings-card-title">Task defaults</div>
    <div class="settings-card-copy">Applied when a profile does not provide its own value.</div>
    <div class="settings-grid">
      <div class="settings-field">
        <label for="set-dp">Default profile</label>
        <select id="set-dp" onchange="markSettingsDirty()">${options}</select>
      </div>
      <div class="settings-field">
        <label for="set-ds">Default scaler</label>
        <select id="set-ds" onchange="markSettingsDirty()">${scalers}</select>
      </div>
    </div>
  </div>
  <div class="settings-card">
    <div class="settings-card-title">Queue cleanup</div>
    <div class="settings-card-copy">Choose what happens to successful jobs after processing.</div>
    <label class="chk">
      <input id="set-auto-clear" type="checkbox" ${autoClear} onchange="markSettingsDirty()">
      <span class="chk-box"></span>
      <span>Clear completed jobs automatically</span>
    </label>
    <span class="help-tip">Failed and cancelled jobs remain available for inspection or retry.</span>
  </div>`;
}
function outputSettingsHTML(s) {
  var outputDir = esc(s.output_dir || "");
  var outputLabel = esc(s.output_dir || "Next to each source file");
  var compressionSuffix = esc(s.compression_suffix || "_tucked_{size}");
  var upscaleSuffix = esc(s.upscale_suffix || "_upscaled_{width}x{height}");
  return `<div class="settings-card">
    <div class="settings-card-title">Output location</div>
    <div class="settings-card-copy">Save beside each source file, or choose one folder for every completed export.</div>
    <div class="row">
      <div id="set-od" class="settings-readonly" style="flex:1" data-path="${outputDir}">${outputLabel}</div>
      <button class="btn2" onclick="browseOut()">Browse…</button>
      <button class="btn2" onclick="clearOut()">Use source folder</button>
    </div>
  </div>
  <section class="file-naming">
    <h3>File names</h3>
    <div class="settings-grid">
      <div class="settings-field">
        <label for="set-cs">Compress suffix</label>
        <input id="set-cs" value="${compressionSuffix}" oninput="markSettingsDirty();updateExampleOutput()">
        <div class="settings-token-row">
          <button class="settings-token" onclick="insertNamingToken('set-cs','{size}')">{size}</button>
        </div>
      </div>
      <div class="settings-field">
        <label for="set-us">Upscale suffix</label>
        <input id="set-us" value="${upscaleSuffix}" oninput="markSettingsDirty();updateExampleOutput()">
        <div class="settings-token-row">
          <button class="settings-token" onclick="insertNamingToken('set-us','{width}')">{width}</button>
          <button class="settings-token" onclick="insertNamingToken('set-us','{height}')">{height}</button>
        </div>
      </div>
      <div class="file-naming-example full">
        <span>Compress preview</span>
        <div class="example-out" id="ex-out"></div>
      </div>
      <div class="file-naming-example full">
        <span>Upscale preview</span>
        <div class="example-out" id="ex-up-out"></div>
      </div>
    </div>
  </section>`;
}
function profilesSettingsHTML() {
  return `<div class="settings-profile-filterbar">
    <div class="ft profile-filters" role="group" aria-label="Filter profiles">
      <button id="pm-all" class="on" onclick="refreshPMList('all')">All</button>
      <button id="pm-compression" onclick="refreshPMList('compression')">Compress</button>
      <button id="pm-upscale" onclick="refreshPMList('upscale')">Upscale</button>
    </div>
  </div>
  <div id="pm-list" class="settings-list"></div>`;
}
function explorerSettingsHTML() {
  return `<div class="settings-card">
    <div class="settings-card-title">Windows Send to shortcuts</div>
    <div class="settings-card-copy">
      Send videos into Tuck directly from File Explorer.
      Broken shortcuts can be repaired in place.
    </div>
    <div id="st-list" class="settings-list"></div>
  </div>`;
}
function encoderDisplaySummary(encoders) {
  var labels = [];
  if (
    encoders.some(function (x) {
      return x.indexOf("nvenc") >= 0;
    })
  )
    labels.push("NVIDIA");
  if (
    encoders.some(function (x) {
      return x.indexOf("amf") >= 0;
    })
  )
    labels.push("AMD");
  if (
    encoders.some(function (x) {
      return x.indexOf("qsv") >= 0;
    })
  )
    labels.push("Intel");
  if (
    encoders.some(function (x) {
      return x.indexOf("libx") === 0;
    })
  )
    labels.push("CPU");
  return labels.join(" · ") || "None detected";
}
function systemStatusHTML(s) {
  var ffmpegReady = !!s.ffmpeg_available;
  var ffprobeReady = !!s.ffprobe_available;
  var ffmpegPath = esc(
    s.ffmpeg_path || s.detected_ffmpeg_path || "Automatic detection",
  );
  var ffprobePath = esc(
    s.ffprobe_path || s.detected_ffprobe_path || "Automatic detection",
  );
  var encoders = esc(encoderDisplaySummary(s.available_encoders || []));
  return `<div class="settings-card">
    <div class="settings-card-title">System status</div>
    <div class="settings-status-table" aria-label="System readiness">
      <div class="settings-status-row">
        <div>FFmpeg</div>
        <div class="settings-status-value">
          <span class="${ffmpegReady ? "status-good" : "status-warn"}">
            ${ffmpegReady ? "Ready" : "Missing"}
          </span>
          · ${ffmpegPath}
        </div>
        <div class="settings-status-actions">
          <button class="btn2" onclick="browseFfmpeg()">Change</button>
        </div>
      </div>
      <div class="settings-status-row">
        <div>FFprobe</div>
        <div class="settings-status-value">
          <span class="${ffprobeReady ? "status-good" : "status-warn"}">
            ${ffprobeReady ? "Ready" : "Missing"}
          </span>
          · ${ffprobePath}
        </div>
        <div class="settings-status-actions">
          <button class="btn2" onclick="browseFfprobe()">Change</button>
        </div>
      </div>
      <div class="settings-status-row">
        <div>Encoders</div>
        <div class="settings-status-value">${encoders}</div>
        <div class="settings-status-actions">
          <button class="btn2" onclick="refreshEncoders()">Rescan</button>
        </div>
      </div>
      <div class="settings-status-row">
        <div>WebView2</div>
        <div class="settings-status-value">
          <span class="status-good">Ready</span> · Edge runtime
        </div>
        <div class="settings-status-actions"></div>
      </div>
    </div>
  </div>`;
}
function systemUpdatesHTML(s) {
  var updateStatus = s.last_update_check
    ? "Last checked: " + esc(s.last_update_check)
    : "Current update status: ready to check.";
  var checkUpdates = s.check_updates ? "checked" : "";
  return `<div class="settings-card">
    <div class="settings-card-title">Updates</div>
    <div class="settings-list-row">
      <div class="settings-list-main">
        <strong>Tuck ${esc(s.version || "")}</strong>
        <span>${updateStatus}</span>
      </div>
      <button class="btn2" onclick="checkUpdatesFromSettings()">Check now</button>
    </div>
    <label class="chk" style="margin-top:12px">
      <input id="set-check-updates" type="checkbox" ${checkUpdates} onchange="markSettingsDirty()">
      <span class="chk-box"></span>
      <span>Check automatically at startup</span>
    </label>
  </div>`;
}
function systemSupportHTML() {
  return `<div class="settings-card">
    <div class="settings-card-title">Support</div>
    <div class="settings-card-copy">
      Copy a sanitized report containing versions, encoder status, and recent errors.
    </div>
    <div class="settings-support-actions">
      <button class="btn1" onclick="copyDiagnostics()">Copy diagnostics</button>
      <button class="btn2" onclick="openSupportFolder('logs')">Open logs folder</button>
      <button class="btn2" onclick="openSupportFolder('config')">Open configuration folder</button>
    </div>
  </div>`;
}
function systemAdvancedHTML(s) {
  var ffmpegPath = esc(s.ffmpeg_path || "");
  var ffprobePath = esc(s.ffprobe_path || "");
  var ffmpegLabel = esc(s.ffmpeg_path || "Use PATH or automatic detection");
  var ffprobeLabel = esc(s.ffprobe_path || "Use PATH or automatic detection");
  return `<details class="settings-advanced">
    <summary>Advanced system settings</summary>
    <div class="settings-advanced-body settings-grid">
      <div class="settings-field full">
        <label for="set-ffmpeg">Custom FFmpeg path</label>
        <div class="row">
          <div id="set-ffmpeg" class="settings-readonly" style="flex:1" data-path="${ffmpegPath}">
            ${ffmpegLabel}
          </div>
          <button class="btn2" onclick="clearFfmpeg()">Use automatic</button>
        </div>
      </div>
      <div class="settings-field full">
        <label for="set-ffprobe">Custom FFprobe path</label>
        <div class="row">
          <div id="set-ffprobe" class="settings-readonly" style="flex:1" data-path="${ffprobePath}">
            ${ffprobeLabel}
          </div>
          <button class="btn2" onclick="clearFfprobe()">Use automatic</button>
        </div>
      </div>
      <div class="settings-field full">
        <label for="set-encoder-cache-days">Encoder detection cache</label>
        <select id="set-encoder-cache-days" onchange="markSettingsDirty()">
          <option value="0">Disabled</option>
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
        <span class="help-tip">Caching hardware probes makes startup faster.</span>
      </div>
    </div>
  </details>`;
}
function systemSettingsHTML(s) {
  return (
    systemStatusHTML(s) +
    systemUpdatesHTML(s) +
    systemSupportHTML() +
    systemAdvancedHTML(s)
  );
}
async function openSettings(page, view, profileId) {
  if (!api) return;
  settingsPage = page || settingsPage;
  settingsView = view || "page";
  if (profileId !== undefined) settingsProfileId = profileId;
  var s = await api.getSettings(),
    profiles = s.profiles || [],
    content = "",
    actions = { html: "" };
  if (settingsPage === "profiles" && settingsView === "editor") {
    settingsShell("profiles", profileEditorHTML(), {
      html:
        settingButton("Cancel", "backToProfiles()") +
        settingButton("Save profile", "saveProfEdit()", true),
    });
    await hydrateEditor();
    return;
  }
  if (settingsPage === "general") {
    content = generalSettingsHTML(s, profiles);
    actions = { html: settingButton("Save changes", "saveSettings()", true) };
  } else if (settingsPage === "output") {
    content = outputSettingsHTML(s);
    actions = {
      html: settingButton("Save changes", "saveOutputSettings()", true),
    };
  } else if (settingsPage === "profiles") {
    content = profilesSettingsHTML();
    actions = {
      plain: true,
      html:
        settingButton("Import", "importProfs()") +
        '<span class="settings-action-spacer"></span>' +
        settingButton("+ New profile", "newProf()", true),
    };
  } else if (settingsPage === "explorer") {
    content = explorerSettingsHTML();
    actions = { html: settingButton("+ Add shortcut", "instProfSt()", true) };
  } else {
    content = systemSettingsHTML(s);
    actions = {
      html: settingButton("Save changes", "saveSystemSettings()", true),
    };
  }
  settingsShell(settingsPage, content, actions);
  settingsDirty = false;
  if (settingsPage === "general")
    byId("set-dp").value = s.default_profile_id || "";
  if (settingsPage === "output") updateExampleOutput();
  if (settingsPage === "profiles") await refreshPMList(settingsFilter);
  if (settingsPage === "explorer") await refreshSTList();
  if (settingsPage === "system")
    byId("set-encoder-cache-days").value = String(s.encoder_cache_days || 0);
}
function navigateSettings(page) {
  if (settingsView === "editor") return backToProfiles();
  if (settingsDirty)
    confirmToast("Discard unsaved settings?", function () {
      settingsDirty = false;
      openSettings(page);
    });
  else openSettings(page);
}
function closeSettings() {
  if (settingsView === "editor")
    return confirmToast("Discard unsaved profile changes?", function () {
      settingsView = "page";
      settingsProfileId = "";
      closeSettingsWorkspace();
    });
  if (settingsDirty)
    return confirmToast("Discard unsaved settings?", function () {
      settingsDirty = false;
      closeSettingsWorkspace();
    });
  closeSettingsWorkspace();
}
function closeSettingsWorkspace() {
  document.body.classList.remove("settings-open");
}
function clearPath(id, placeholder) {
  byId(id).dataset.path = "";
  byId(id).textContent = placeholder;
}
async function browseOut() {
  var r = await api.pickFolder();
  if (r.ok && r.path) {
    byId("set-od").dataset.path = r.path;
    byId("set-od").textContent = r.path;
    markSettingsDirty();
  }
}
function clearOut() {
  clearPath("set-od", "Next to each source file");
  markSettingsDirty();
}
async function browseFfmpeg() {
  var r = await api.pickFfmpegFile();
  if (r.ok && r.path) {
    byId("set-ffmpeg").dataset.path = r.path;
    byId("set-ffmpeg").textContent = r.path;
    markSettingsDirty();
  }
}
async function browseFfprobe() {
  var r = await api.pickFfprobeFile();
  if (r.ok && r.path) {
    byId("set-ffprobe").dataset.path = r.path;
    byId("set-ffprobe").textContent = r.path;
    markSettingsDirty();
  }
}
function clearFfmpeg() {
  clearPath("set-ffmpeg", "Use PATH or automatic detection");
  markSettingsDirty();
}
function clearFfprobe() {
  clearPath("set-ffprobe", "Use PATH or automatic detection");
  markSettingsDirty();
}
async function persistSettings(data) {
  var r = await api.saveSettings(JSON.stringify(data));
  if (r.ok) {
    appSettings = Object.assign(appSettings, data);
    settingsDirty = false;
    var indicator = byId("settings-unsaved");
    if (indicator) {
      indicator.textContent = "Saved";
      indicator.classList.add("on");
      setTimeout(function () {
        if (indicator) indicator.classList.remove("on");
      }, 1200);
    }
    await loadSettings();
    toast("Settings saved.", "ok");
    return true;
  }
  toast(r.error, "err");
  return false;
}
async function saveSettings() {
  await persistSettings({
    default_profile_id: byId("set-dp").value,
    default_scaler: byId("set-ds").value.toLowerCase(),
    clear_completed_automatically: byId("set-auto-clear").checked,
  });
}
async function saveOutputSettings() {
  await persistSettings({
    output_dir: byId("set-od").dataset.path || "",
    compression_suffix: byId("set-cs").value.trim() || "_tucked_{size}",
    upscale_suffix: byId("set-us").value.trim() || "_upscaled_{width}x{height}",
  });
}
async function saveSystemSettings() {
  await persistSettings({
    ffmpeg_path: byId("set-ffmpeg").dataset.path || "",
    ffprobe_path: byId("set-ffprobe").dataset.path || "",
    encoder_cache_days: parseInt(byId("set-encoder-cache-days").value),
    check_updates: byId("set-check-updates").checked,
  });
}
async function refreshEncoders() {
  if (settingsDirty) {
    confirmToast("Refresh encoders and discard unsaved settings?", function () {
      settingsDirty = false;
      refreshEncoders();
    });
    return;
  }
  var r = await api.refreshEncoders();
  if (r.ok) {
    availEncoders = r.available_encoders || [];
    updateEncOpts();
    toast("Encoder detection refreshed.", "ok");
    openSettings("system");
  } else toast(r.error || "Could not refresh encoders.", "err");
}
function insertNamingToken(id, token) {
  var input = byId(id);
  if (!input.value.includes(token)) input.value += token;
  markSettingsDirty();
  updateExampleOutput();
  input.focus();
}
async function openSupportFolder(kind) {
  var r =
    kind === "logs" ? await api.openLogsFolder() : await api.openConfigFolder();
  if (!r.ok) toast(r.error || "Could not open folder.", "err");
}
function updateExampleOutput() {
  var compress = byId("set-cs"),
    upscale = byId("set-us");
  if (compress && byId("ex-out"))
    byId("ex-out").textContent =
      "video" +
      (compress.value.trim() || "_tucked_{size}").replace("{size}", "20MB") +
      ".mp4";
  if (upscale && byId("ex-up-out"))
    byId("ex-up-out").textContent =
      "video" +
      (upscale.value.trim() || "_upscaled_{width}x{height}")
        .replace("{width}", "1920")
        .replace("{height}", "1080") +
      ".mp4";
}
function profileShortcutName(id) {
  var p = allProfiles.find(function (x) {
    return x.profile_id === id;
  });
  return p ? p.name : "Profile shortcut";
}
async function refreshSTList() {
  var list = byId("st-list");
  if (!list) return;
  var r = await api.listSendtoShortcuts();
  list.innerHTML = "";
  (r.shortcuts || []).forEach(function (s) {
    var row = document.createElement("div"),
      profile =
        s.type === "profile"
          ? profileShortcutName(s.profile_id || s.name || "")
          : "Default shortcut",
      status =
        s.status === "ok"
          ? "Installed"
          : s.status === "broken"
            ? "Needs repair"
            : s.status === "missing"
              ? "Missing"
              : s.status || "Unknown";
    row.className = "settings-list-row";
    row.innerHTML =
      '<div class="settings-list-main"><strong>' +
      esc(s.name || profile) +
      "</strong><span>" +
      esc(profile) +
      '</span><span class="' +
      (s.status === "ok" ? "settings-badge" : "status-warn") +
      '">' +
      esc(status) +
      "</span></div>";
    var repair = document.createElement("button");
    repair.className = "btn2";
    repair.textContent = "Repair";
    repair.onclick = function () {
      repairSt(s);
    };
    var remove = document.createElement("button");
    remove.className = "btn2";
    remove.style.color = "var(--danger)";
    remove.textContent = "Remove";
    remove.onclick = function () {
      removeSt(s);
    };
    row.appendChild(repair);
    row.appendChild(remove);
    list.appendChild(row);
  });
  if (!list.children.length)
    list.innerHTML =
      '<div class="settings-empty">No Explorer shortcuts installed.</div>';
}
async function instProfSt() {
  var profiles = await api.getProfilesJson();
  var content = `${settingsTitle("Add shortcut", "openSettings('explorer')")}
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="mrow" onclick="instGenSt()">
        <div class="mi">
          <div class="mti">Tuck</div>
          <div class="mme">Default shortcut</div>
        </div>
      </button>`;
  profiles.forEach(function (p) {
    content += `<button
      class="mrow"
      onclick="installProfileSt('${escJS(p.profile_id)}','${escJS(p.name)}')"
    >
      <div class="mi">
        <div class="mti">${esc(p.name)}</div>
        <div class="mme">${esc(profileSummary(p))}</div>
      </div>
    </button>`;
  });
  content += "</div>";
  settingsShell("explorer", content, { html: "" });
}
async function instGenSt() {
  var r = await api.installGenericSendto();
  if (r.ok) toast("Default Explorer shortcut installed.", "ok");
  else toast(r.error || "Failed", "err");
  openSettings("explorer");
}
async function installProfileSt(pid, name) {
  var r = await api.installProfileSendto(pid, "start");
  if (r.ok) toast('Added "' + name + '" to Explorer.', "ok");
  else toast(r.error || "Failed", "err");
  openSettings("explorer");
}
async function removeSt(data) {
  confirmToast("Remove shortcut?", function () {
    (data.type === "generic"
      ? api.removeGenericSendto()
      : api.removeProfileSendto(data.profile_id || data.name || "")
    ).then(function (r) {
      if (r.ok) toast("Shortcut removed.", "ok");
      else toast(r.error || "Failed", "err");
      refreshSTList();
    });
  });
}
async function repairSt(data) {
  var r =
    data.type === "generic"
      ? await api.installGenericSendto()
      : await api.repairProfileSendto(data.profile_id || data.name || "");
  if (r.ok) toast("Shortcut repaired.", "ok");
  else toast(r.error || "Failed", "err");
  refreshSTList();
}
