(function (root, factory) {
  var core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  if (!root || !root.document) return;

  var selectedClipId = null;
  var selectedSourceIndex = null;
  var selectedTrackId = "source";
  var idCounter = 0;
  var dragState = null;
  var previewElements = {};
  var _MIN_TRIM = root.SegmentEditing.MIN_DURATION;

  // Imported tracks use colors outside the video purple
  var TRACK_COLORS = ["#2dd4bf", "#fbbf24", "#38bdf8", "#a3e635", "#f472b6", "#fb923c"];

  function trackColor(index) {
    return TRACK_COLORS[index % TRACK_COLORS.length];
  }

  function nextId(prefix) {
    idCounter += 1;
    return prefix + "-" + Date.now().toString(36) + "-" + idCounter.toString(36);
  }

  function selectedVideo() {
    return root.selPath && root.clips[root.selPath] ? root.clips[root.selPath] : null;
  }

  function ensureState(clip) {
    if (!clip) return null;
    if (!clip.audioTimeline) {
      clip.audioTimeline = {
        enabled: true,
        linked: true,
        sourceMuted: false,
        sourceGainDb: 0,
        sourceWaveformUrl: "",
        sourceWaveformToken: "",
        sourceWaveformLoading: false,
        tracks: [],
      };
    }
    if (clip.audioTimeline.linked == null) clip.audioTimeline.linked = true;
    return clip.audioTimeline;
  }

  function sourceDuration(clip) {
    return clip && clip.probeData ? Number(clip.probeData.duration) || 0 : 0;
  }

  function sourceTime() {
    var video = root.byId("vid");
    return video ? Number(video.currentTime) || 0 : 0;
  }

  function outputDuration(clip) {
    var full = sourceDuration(clip);
    if (!full || !root.SegmentEditing) return 0;
    return root.SegmentEditing.selectedDuration(
      root.SegmentEditing.segmentsForClip(clip, full),
    );
  }

  function audioSegments(clip) {
    var full = sourceDuration(clip);
    if (!full || !root.SegmentEditing) return [];
    return root.SegmentEditing.audioSegmentsForClip(clip, full);
  }

  function isLinked(clip) {
    return !!(clip && ensureState(clip).linked !== false && !Array.isArray(clip.sourceAudioSegments));
  }

  function materializeAudio(clip) {
    if (!clip || !root.SegmentEditing) return [];
    if (!Array.isArray(clip.sourceAudioSegments))
      clip.sourceAudioSegments = root.SegmentEditing.cloneSegments(
        root.SegmentEditing.segmentsForClip(clip, sourceDuration(clip)),
      );
    ensureState(clip).linked = false;
    return clip.sourceAudioSegments;
  }

  function setAudioSegments(clip, segments) {
    clip.sourceAudioSegments = (segments || []).map(function (segment) {
      return { start: segment.start, end: segment.end };
    });
    ensureState(clip).linked = false;
  }

  function dbToGain(db) {
    return Math.pow(10, Number(db || 0) / 20);
  }

  function setPlanDirty(clip) {
    if (clip) clip.planData = null;
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function reconcile(clip) {
    var state = ensureState(clip);
    var total = sourceDuration(clip);
    if (!state || total <= 0) return;
    if (Array.isArray(clip.sourceAudioSegments) && clip.sourceAudioSegments.length)
      clip.sourceAudioSegments = root.SegmentEditing.normalizeSegments(
        clip.sourceAudioSegments,
        total,
      );
    state.tracks.forEach(function (track) {
      track.clips.sort(function (a, b) {
        return a.timelineStart - b.timelineStart;
      });
      var cursor = 0;
      track.clips = track.clips.filter(function (audioClip) {
        audioClip.timelineStart = Math.max(cursor, Math.min(audioClip.timelineStart, total));
        var remaining = total - audioClip.timelineStart;
        var sourceSpan = Math.max(0, audioClip.sourceOut - audioClip.sourceIn);
        audioClip.timelineDuration = Math.min(audioClip.timelineDuration, remaining);
        if (!audioClip.loop)
          audioClip.timelineDuration = Math.min(audioClip.timelineDuration, sourceSpan);
        if (audioClip.timelineDuration < _MIN_TRIM - 0.000001) return false;
        audioClip.fadeIn = Math.max(0, Math.min(audioClip.fadeIn, audioClip.timelineDuration));
        audioClip.fadeOut = Math.max(
          0,
          Math.min(audioClip.fadeOut, audioClip.timelineDuration - audioClip.fadeIn),
        );
        cursor = audioClip.timelineStart + audioClip.timelineDuration;
        return true;
      });
    });
    if (selectedClipId && !findSelected(clip)) selectedClipId = null;
    if (
      selectedSourceIndex != null &&
      selectedSourceIndex >= audioSegments(clip).length
    )
      selectedSourceIndex = null;
  }

  function findTrack(trackId, clip) {
    var state = ensureState(clip || selectedVideo());
    if (!state) return null;
    for (var i = 0; i < state.tracks.length; i++)
      if (state.tracks[i].id === trackId) return state.tracks[i];
    return null;
  }

  function findSelected(clip) {
    var state = ensureState(clip || selectedVideo());
    if (!state || !selectedClipId) return null;
    for (var t = 0; t < state.tracks.length; t++) {
      for (var c = 0; c < state.tracks[t].clips.length; c++) {
        if (state.tracks[t].clips[c].id === selectedClipId)
          return { track: state.tracks[t], clip: state.tracks[t].clips[c], index: c };
      }
    }
    return null;
  }

  function waveformStyle(track, audioClip) {
    if (!track.waveformUrl) return "";
    var sourceSpan = Math.max(_MIN_TRIM, audioClip.sourceOut - audioClip.sourceIn);
    var size = audioClip.loop
      ? Math.max(12, (track.sourceDuration / sourceSpan) * 100)
      : Math.max(100, (track.sourceDuration / sourceSpan) * 100);
    var position = track.sourceDuration
      ? Math.max(0, Math.min(100, (audioClip.sourceIn / track.sourceDuration) * 100))
      : 0;
    return (
      "background-image:url('" +
      track.waveformUrl.replace(/'/g, "%27") +
      "');background-size:" +
      size +
      "% 100%;background-position:" +
      position +
      "% center"
    );
  }

  function pct(value, total) {
    return (value / Math.max(total, 0.0001)) * 100 + "%";
  }

  function renderSourceTrack(clip, state, total) {
    var lane = root.byId("source-audio-lane");
    var sourceTrack = root.byId("source-audio-track");
    if (!lane || !sourceTrack) return;
    var hasAudio = !!(clip.probeData && clip.probeData.has_audio);
    sourceTrack.classList.toggle("disabled", !hasAudio || !state.enabled);
    var muteButton = root.byId("source-audio-mute");
    if (muteButton) {
      muteButton.disabled = !hasAudio;
      muteButton.classList.toggle("on", state.sourceMuted);
      muteButton.setAttribute("aria-pressed", state.sourceMuted ? "true" : "false");
    }
    var gain = root.byId("source-audio-gain");
    if (gain) gain.value = String(state.sourceGainDb);
    paintSourceLane(clip, state, total);
  }

  function paintSourceLane(clip, state, total) {
    var lane = root.byId("source-audio-lane");
    if (!lane) return;
    lane.replaceChildren();
    if (!clip || !state || total <= 0) return;
    if (!clip.probeData || !clip.probeData.has_audio || !state.enabled) return;
    var videoSegs = root.SegmentEditing.segmentsForClip(clip, total);
    var videoActive =
      clip && Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
    videoSegs.forEach(function (segment, index) {
      if (root.SegmentEditing.isGrouped && !root.SegmentEditing.isGrouped(segment))
        return;
      if (segment.audio === false || segment.grouped === false) return;
      lane.appendChild(
        sourceAudioBlock(segment, index, index === videoActive, state, total, "grouped"),
      );
    });
    (clip.sourceAudioSegments || []).forEach(function (segment, index) {
      lane.appendChild(
        sourceAudioBlock(
          segment,
          index,
          selectedSourceIndex === index && selectedTrackId === "source",
          state,
          total,
          "detached",
        ),
      );
    });
  }

  function sourceAudioBlock(segment, index, selected, state, total, kind) {
    var block = root.document.createElement("div");
    block.className =
      "seq-audio-clip" +
      (selected ? " selected" : "") +
      (kind === "detached" ? " detached" : "") +
      (segment.muted ? " muted" : "");
    block.title = segment.muted
      ? "Muted"
      : kind === "detached"
        ? "Click to mute"
        : "Grouped with video";
    block.dataset.audioKind = "source";
    block.dataset.audioRole = kind;
    block.dataset.segmentIndex = String(index);
    block.style.setProperty("--segment-color", root.segmentColor(index));
    block.style.left = pct(segment.start, total);
    block.style.width = pct(Math.max(0, segment.end - segment.start), total);
    if (state.sourceWaveformUrl) {
      var wave = root.document.createElement("div");
      wave.className = "audio-waveform";
      wave.style.backgroundImage =
        "url('" + state.sourceWaveformUrl.replace(/'/g, "%27") + "')";
      wave.style.backgroundSize =
        Math.max(100, (total / Math.max(segment.end - segment.start, _MIN_TRIM)) * 100) +
        "% 100%";
      wave.style.backgroundPosition = (segment.start / total) * 100 + "% center";
      block.appendChild(wave);
    }
    if (selected) {
      var edgeIn = root.document.createElement("span");
      edgeIn.className = "clip-edge start";
      edgeIn.dataset.edge = "start";
      var edgeOut = root.document.createElement("span");
      edgeOut.className = "clip-edge end";
      edgeOut.dataset.edge = "end";
      block.append(edgeIn, edgeOut);
    }
    return block;
  }

  function renderImportedTrack(track, total, index) {
    var row = root.document.createElement("div");
    row.className = "seq-row audio imported";
    row.dataset.trackId = track.id;
    row.style.setProperty("--segment-color", trackColor(index));

    var head = root.document.createElement("div");
    head.className = "seq-head";
    var indexEl = root.document.createElement("button");
    indexEl.type = "button";
    indexEl.className = "seq-track-index" + (track.id === selectedTrackId ? " on" : "");
    indexEl.textContent = "A" + (index + 2);
    indexEl.title = track.name;
    indexEl.setAttribute("aria-label", track.name);
    indexEl.onclick = function (event) {
      event.stopPropagation();
      apiObject.selectTrack(track.id);
    };
    head.appendChild(indexEl);
    head.title = track.name;

    var mute = root.document.createElement("button");
    mute.type = "button";
    mute.className = "audio-mute-button" + (track.muted ? " on" : "");
    mute.textContent = "M";
    mute.title = track.muted ? "Unmute track" : "Mute track";
    mute.setAttribute("aria-pressed", track.muted ? "true" : "false");
    mute.onclick = function () {
      apiObject.toggleTrackMute(track.id);
    };
    head.appendChild(mute);

    var gain = root.document.createElement("label");
    gain.className = "audio-gain-control";
    gain.title = "Track gain";
    var gainInput = root.document.createElement("input");
    gainInput.type = "number";
    gainInput.min = "-60";
    gainInput.max = "12";
    gainInput.step = "1";
    gainInput.value = String(track.gainDb);
    gainInput.setAttribute("aria-label", track.name + " gain in decibels");
    gainInput.onchange = function () {
      apiObject.setTrackGain(track.id, this.value);
    };
    var db = root.document.createElement("span");
    db.textContent = "dB";
    gain.append(gainInput, db);
    head.appendChild(gain);

    var remove = root.document.createElement("button");
    remove.type = "button";
    remove.className = "audio-remove-track";
    remove.textContent = "×";
    remove.title = "Remove track";
    remove.setAttribute("aria-label", "Remove " + track.name);
    remove.onclick = function () {
      apiObject.removeTrack(track.id);
    };
    head.appendChild(remove);
    row.appendChild(head);

    var lane = root.document.createElement("div");
    lane.className = "seq-lane audio-lane";
    lane.dataset.trackId = track.id;
    lane.addEventListener("pointerdown", onLanePointerDown);
    track.clips.forEach(function (audioClip) {
      var selected = audioClip.id === selectedClipId;
      var el = root.document.createElement("div");
      el.className =
        "seq-audio-clip imported" +
        (selected ? " selected" : "") +
        (audioClip.muted ? " muted" : "");
      el.dataset.clipId = audioClip.id;
      el.dataset.trackId = track.id;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.setAttribute("aria-pressed", selected ? "true" : "false");
      el.setAttribute(
        "aria-label",
        track.name +
          " audio clip" +
          (audioClip.loop ? ", looping" : "") +
          (audioClip.muted ? ", muted" : ""),
      );
      el.style.left = pct(audioClip.timelineStart, total);
      el.style.width = pct(audioClip.timelineDuration, total);

      var wave = root.document.createElement("div");
      wave.className = "audio-waveform";
      wave.setAttribute("style", waveformStyle(track, audioClip));
      el.appendChild(wave);
      if (audioClip.fadeIn > 0) {
        var fadeIn = root.document.createElement("span");
        fadeIn.className = "audio-fade in";
        fadeIn.style.width =
          Math.min(100, (audioClip.fadeIn / audioClip.timelineDuration) * 100) + "%";
        el.appendChild(fadeIn);
      }
      if (audioClip.fadeOut > 0) {
        var fadeOut = root.document.createElement("span");
        fadeOut.className = "audio-fade out";
        fadeOut.style.width =
          Math.min(100, (audioClip.fadeOut / audioClip.timelineDuration) * 100) + "%";
        el.appendChild(fadeOut);
      }
      if (selected) {
        var edgeIn = root.document.createElement("span");
        edgeIn.className = "clip-edge start";
        edgeIn.dataset.edge = "start";
        var edgeOut = root.document.createElement("span");
        edgeOut.className = "clip-edge end";
        edgeOut.dataset.edge = "end";
        el.append(edgeIn, edgeOut);
      }
      lane.appendChild(el);
    });
    row.appendChild(lane);
    return row;
  }

  function renderInspector(videoClip) {
    var actions = root.byId("audio-selection-actions");
    if (!actions) return;
    var selected = findSelected(videoClip);
    actions.classList.toggle("hid", !selected);
    if (!selected) return;
    var muteBtn = root.byId("audio-clip-mute");
    if (muteBtn) {
      muteBtn.classList.toggle("on", !!selected.clip.muted);
      muteBtn.setAttribute("aria-pressed", selected.clip.muted ? "true" : "false");
      muteBtn.textContent = selected.clip.muted ? "Unmute" : "Mute";
    }
    var loopBtn = root.byId("audio-clip-loop");
    if (loopBtn) {
      loopBtn.classList.toggle("on", !!selected.clip.loop);
      loopBtn.setAttribute("aria-pressed", selected.clip.loop ? "true" : "false");
    }
    var fadeInInput = root.byId("audio-clip-fade-in");
    if (fadeInInput && root.document.activeElement !== fadeInInput)
      fadeInInput.value = (Math.round(selected.clip.fadeIn * 10) / 10).toString();
    var fadeOutInput = root.byId("audio-clip-fade-out");
    if (fadeOutInput && root.document.activeElement !== fadeOutInput)
      fadeOutInput.value = (Math.round(selected.clip.fadeOut * 10) / 10).toString();
  }

  function render() {
    var clip = selectedVideo();
    var editor = root.byId("audio-editor");
    if (!editor) return;
    if (!clip || !clip.probed) {
      editor.classList.add("disabled");
      var emptyLane = root.byId("source-audio-lane");
      if (emptyLane) emptyLane.replaceChildren();
      root.byId("imported-audio-tracks").replaceChildren();
      root.byId("audio-selection-actions").classList.add("hid");
      var out = root.byId("seq-output-duration");
      if (out) out.textContent = "Out 0:00";
      return;
    }
    editor.classList.remove("disabled");
    var state = ensureState(clip);
    reconcile(clip);
    var total = sourceDuration(clip);
    var master = root.byId("audio-master-toggle");
    master.classList.toggle("on", state.enabled);
    master.setAttribute("aria-pressed", state.enabled ? "true" : "false");
    var masterLabel = root.byId("audio-master-label");
    if (masterLabel) masterLabel.textContent = state.enabled ? "Audio" : "Muted";
    var clock = root.byId("audio-output-time");
    if (clock) clock.textContent = root.fmtt(sourceTime()) + " / " + root.fmtt(total);
    var outDur = root.byId("seq-output-duration");
    if (outDur) outDur.textContent = "Out " + root.fmtt(outputDuration(clip));
    renderSourceTrack(clip, state, total);
    var tracks = root.byId("imported-audio-tracks");
    tracks.replaceChildren();
    state.tracks.forEach(function (track, index) {
      tracks.appendChild(renderImportedTrack(track, total, index));
    });
    renderInspector(clip);
    paintMixer(clip);
    updatePlayheads(sourceTime(), total);
    applyPreviewVolume();
  }

  function paintMixer(clip) {
    var mixer = root.byId("audio-mixer");
    if (!mixer) return;
    if (!clip || !clip.probed) {
      mixer.hidden = true;
      return;
    }
    mixer.hidden = false;
    var state = ensureState(clip);
    var muted = false;
    var gain = 0;
    var label = "A";
    var mixerColor = "";
    if (selectedTrackId !== "source") {
      var track = findTrack(selectedTrackId, clip);
      if (!track) selectedTrackId = "source";
      else {
        muted = !!track.muted;
        gain = Number(track.gainDb) || 0;
        var trackIndex = state.tracks.indexOf(track);
        label = "A" + (trackIndex + 2);
        mixerColor = trackColor(trackIndex);
      }
    }
    if (selectedTrackId === "source") {
      muted = !!state.sourceMuted;
      gain = Number(state.sourceGainDb) || 0;
      label = "A";
    }
    if (mixerColor) mixer.style.setProperty("--segment-color", mixerColor);
    else mixer.style.removeProperty("--segment-color");
    var name = root.byId("audio-mixer-name");
    var mute = root.byId("audio-mixer-mute");
    var slider = root.byId("audio-mixer-gain");
    var db = root.byId("audio-mixer-db");
    if (name) name.textContent = label;
    if (mute) {
      mute.classList.toggle("on", muted);
      mute.setAttribute("aria-pressed", muted ? "true" : "false");
    }
    if (slider && document.activeElement !== slider)
      slider.value = String(Math.max(-24, Math.min(12, gain)));
    if (db) db.textContent = (gain > 0 ? "+" : "") + String(gain) + " dB";
    var removeBtn = root.byId("audio-mixer-remove");
    if (removeBtn) removeBtn.classList.toggle("hid", selectedTrackId === "source");
    var sourceLabel = root.byId("source-audio-label");
    if (sourceLabel) sourceLabel.classList.toggle("on", selectedTrackId === "source");
    var fragMute = root.byId("audio-fragment-mute");
    var fragDel = root.byId("audio-fragment-delete");
    var detached =
      selectedTrackId === "source" &&
      selectedSourceIndex != null &&
      clip.sourceAudioSegments &&
      clip.sourceAudioSegments[selectedSourceIndex];
    var fragmentMuted = false;
    if (detached) fragmentMuted = !!detached.muted;
    else if (selectedTrackId === "source" && root.SegmentEditing) {
      var segs = root.SegmentEditing.segmentsForClip(clip, sourceDuration(clip));
      var active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
      fragmentMuted = !!(segs[active] && segs[active].muted);
    }
    if (fragMute) {
      fragMute.classList.toggle("hid", selectedTrackId !== "source");
      fragMute.classList.toggle("on", fragmentMuted);
      fragMute.setAttribute("aria-pressed", fragmentMuted ? "true" : "false");
      fragMute.textContent = fragmentMuted ? "Unmute" : "Mute";
    }
    if (fragDel) fragDel.classList.toggle("hid", !detached);
  }

  function updatePlayheads(time, total) {
    var pctValue = total > 0 ? Math.max(0, Math.min(100, (time / total) * 100)) : 0;
    var layer = root.byId("seq-playhead-layer");
    if (layer) layer.style.setProperty("--playhead", pctValue + "%");
    var clip = selectedVideo();
    if (clip && root.byId("audio-output-time"))
      root.byId("audio-output-time").textContent =
        root.fmtt(time) + " / " + root.fmtt(total);
  }

  function selectAudioClip(id) {
    selectedClipId = id;
    selectedSourceIndex = null;
    render();
  }

  function neighborBounds(track, index, total, duration) {
    return {
      min: index > 0 ? track.clips[index - 1].timelineStart + track.clips[index - 1].timelineDuration : 0,
      max:
        (index + 1 < track.clips.length ? track.clips[index + 1].timelineStart : total) -
        duration,
    };
  }

  function onLanePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    var lane = event.currentTarget;
    var clipEl = event.target.closest
      ? event.target.closest(".seq-audio-clip, .audio-clip")
      : null;
    var videoClip = selectedVideo();
    var total = sourceDuration(videoClip);
    if (!videoClip || total <= 0) return;
    if (!clipEl) {
      var ratio = (event.clientX - lane.getBoundingClientRect().left) / lane.clientWidth;
      apiObject.seekSource(Math.max(0, Math.min(total, ratio * total)));
      return;
    }
    if (clipEl.dataset.audioKind === "source") {
      selectedClipId = null;
      selectedTrackId = "source";
      var edge = event.target.closest ? event.target.closest(".clip-edge") : null;
      var ratio = (event.clientX - lane.getBoundingClientRect().left) / lane.clientWidth;
      var time = Math.max(0, Math.min(total, ratio * total));
      if (edge && clipEl.dataset.audioRole === "detached") {
        selectedSourceIndex = parseInt(clipEl.dataset.segmentIndex, 10);
        var extra = (videoClip.sourceAudioSegments || [])[selectedSourceIndex];
        if (!extra) return;
        dragState = {
          kind: "detached-trim",
          edge: edge.dataset.edge,
          index: selectedSourceIndex,
          original: { start: extra.start, end: extra.end, muted: !!extra.muted },
          startX: event.clientX,
          rect: lane.getBoundingClientRect(),
          total: total,
          element: clipEl,
        };
        if (lane.setPointerCapture && event.pointerId != null) {
          try {
            lane.setPointerCapture(event.pointerId);
          } catch (err) {}
        }
        event.preventDefault();
        return;
      }
      if (edge && clipEl.dataset.audioRole !== "detached") {
        if (typeof root.applyTrimStart === "function") {
          dragState = {
            kind: "group-trim",
            edge: edge.dataset.edge,
            startX: event.clientX,
            rect: lane.getBoundingClientRect(),
            total: total,
          };
          if (lane.setPointerCapture && event.pointerId != null) {
            try {
              lane.setPointerCapture(event.pointerId);
            } catch (err) {}
          }
          event.preventDefault();
          return;
        }
      }
      if (clipEl.dataset.audioRole !== "detached") {
        selectedSourceIndex = null;
        var videoSegs = root.SegmentEditing.segmentsForClip(videoClip, total);
        var videoIndex = root.SegmentEditing.segmentIndexAtTime(videoSegs, time, 0);
        if (videoIndex >= 0 && typeof root.selectSegment === "function")
          root.selectSegment(videoIndex, false);
        apiObject.seekSource(time);
        dragState = {
          kind: "group-move",
          index: videoIndex,
          offset: videoIndex >= 0 ? time - videoSegs[videoIndex].start : 0,
          startX: event.clientX,
          rect: lane.getBoundingClientRect(),
          total: total,
          clickMute: false,
        };
        if (lane.setPointerCapture && event.pointerId != null) {
          try {
            lane.setPointerCapture(event.pointerId);
          } catch (err) {}
        }
        event.preventDefault();
        paintMixer(videoClip);
        return;
      }
      var detachedIndex = parseInt(clipEl.dataset.segmentIndex, 10);
      var wasSelected = selectedSourceIndex === detachedIndex;
      selectedSourceIndex = detachedIndex;
      var detached = (videoClip.sourceAudioSegments || [])[selectedSourceIndex];
      if (!detached) return;
      dragState = {
        action: "source-move",
        kind: "detached",
        index: selectedSourceIndex,
        original: {
          start: detached.start,
          end: detached.end,
          muted: !!detached.muted,
          audioLink: detached.audioLink,
        },
        startX: event.clientX,
        clickMute: wasSelected,
        rect: lane.getBoundingClientRect(),
        total: total,
        element: clipEl,
      };
      paintMixer(videoClip);
      if (lane.setPointerCapture && event.pointerId != null) {
        try {
          lane.setPointerCapture(event.pointerId);
        } catch (err) {}
      }
      event.preventDefault();
      renderInspector(videoClip);
      return;
    }
    var track = findTrack(clipEl.dataset.trackId, videoClip);
    if (!track) return;
    var index = track.clips.findIndex(function (item) {
      return item.id === clipEl.dataset.clipId;
    });
    if (index < 0) return;
    selectedClipId = track.clips[index].id;
    selectedSourceIndex = null;
    selectedTrackId = track.id;
    var importedEdge = event.target.closest ? event.target.closest(".clip-edge") : null;
    var importedAction = importedEdge
      ? importedEdge.dataset.edge === "start"
        ? "trim-start"
        : "trim-end"
      : event.target.dataset.audioAction || "move";
    dragState = {
      action: importedAction,
      kind: "imported",
      track: track,
      clip: track.clips[index],
      index: index,
      original: Object.assign({}, track.clips[index]),
      startX: event.clientX,
      rect: lane.getBoundingClientRect(),
      total: total,
      element: clipEl,
    };
    if (lane.setPointerCapture && event.pointerId != null) {
      try {
        lane.setPointerCapture(event.pointerId);
      } catch (err) {}
    }
    event.preventDefault();
    renderInspector(videoClip);
  }

  function paintDragged() {
    if (!dragState || !dragState.element) return;
    if (
      dragState.kind === "source" ||
      dragState.kind === "detached" ||
      dragState.kind === "detached-trim"
    ) {
      dragState.element.style.left = pct(dragState.current.start, dragState.total);
      dragState.element.style.width = pct(
        dragState.current.end - dragState.current.start,
        dragState.total,
      );
      return;
    }
    dragState.element.style.left = pct(dragState.clip.timelineStart, dragState.total);
    dragState.element.style.width = pct(dragState.clip.timelineDuration, dragState.total);
  }

  function onPointerMove(event) {
    if (!dragState) return;
    var delta = ((event.clientX - dragState.startX) / dragState.rect.width) * dragState.total;
    var videoClip = selectedVideo();
    if (dragState.kind === "group-move") {
      if (Math.abs(event.clientX - dragState.startX) > 4) dragState.clickMute = false;
      var time =
        ((event.clientX - dragState.rect.left) / dragState.rect.width) * dragState.total;
      if (typeof root.moveActiveSegment === "function") {
        var moved = root.moveActiveSegment(time - dragState.offset);
        if (moved && typeof root.paintTrimChrome === "function") root.paintTrimChrome();
      }
      updatePlayheads(
        Math.max(0, Math.min(dragState.total, time)),
        dragState.total,
      );
      event.preventDefault();
      return;
    }
    if (dragState.kind === "group-trim") {
      var trimTime =
        ((event.clientX - dragState.rect.left) / dragState.rect.width) * dragState.total;
      if (dragState.edge === "start" && typeof root.applyTrimStart === "function")
        root.applyTrimStart(trimTime);
      else if (typeof root.applyTrimEnd === "function") root.applyTrimEnd(trimTime);
      if (typeof root.paintTrimChrome === "function") root.paintTrimChrome();
      event.preventDefault();
      return;
    }
    if (dragState.kind === "detached-trim") {
      var next = {
        start: dragState.original.start,
        end: dragState.original.end,
        muted: !!dragState.original.muted,
        audioLink: dragState.original.audioLink,
      };
      var at =
        dragState.original[dragState.edge === "start" ? "start" : "end"] + delta;
      if (dragState.edge === "start")
        next.start = Math.max(0, Math.min(at, dragState.original.end - 0.05));
      else
        next.end = Math.max(
          dragState.original.start + 0.05,
          Math.min(dragState.total, at),
        );
      var extras = (videoClip.sourceAudioSegments || []).slice();
      extras[dragState.index] = next;
      videoClip.sourceAudioSegments = extras;
      dragState.current = next;
      paintDragged();
      event.preventDefault();
      return;
    }
    if (dragState.kind === "detached") {
      if (Math.abs(event.clientX - dragState.startX) > 4) dragState.clickMute = false;
      var span = dragState.original.end - dragState.original.start;
      var nextStart = Math.max(
        0,
        Math.min(dragState.total - span, dragState.original.start + delta),
      );
      var extras = (videoClip.sourceAudioSegments || []).slice();
      extras[dragState.index] = {
        start: nextStart,
        end: nextStart + span,
        muted: !!dragState.original.muted,
        audioLink: dragState.original.audioLink,
      };
      videoClip.sourceAudioSegments = extras;
      dragState.current = extras[dragState.index];
      paintDragged();
      updatePlayheads(sourceTime(), dragState.total);
      event.preventDefault();
      return;
    }
    if (dragState.kind === "source") {
      var segs = materializeAudio(videoClip);
      var edited;
      if (dragState.action === "source-trim-start") {
        edited = root.SegmentEditing.editEndpoint(
          segs,
          dragState.index,
          "start",
          dragState.original.start + delta,
          dragState.total,
        );
      } else if (dragState.action === "source-trim-end") {
        edited = root.SegmentEditing.editEndpoint(
          segs,
          dragState.index,
          "end",
          dragState.original.end + delta,
          dragState.total,
        );
      } else {
        edited = root.SegmentEditing.moveSegment(
          segs,
          dragState.index,
          dragState.original.start + delta,
          dragState.total,
        );
      }
      setAudioSegments(videoClip, edited);
      dragState.current = edited[dragState.index];
      paintDragged();
      updatePlayheads(sourceTime(), dragState.total);
      event.preventDefault();
      return;
    }
    var original = dragState.original;
    var audioClip = dragState.clip;
    var bounds = neighborBounds(
      dragState.track,
      dragState.index,
      dragState.total,
      original.timelineDuration,
    );
    if (dragState.action === "move") {
      audioClip.timelineStart = Math.max(
        bounds.min,
        Math.min(bounds.max, original.timelineStart + delta),
      );
    } else if (dragState.action === "trim-start") {
      var maximumDelta = original.timelineDuration - _MIN_TRIM;
      if (!original.loop) maximumDelta = Math.min(maximumDelta, original.sourceOut - original.sourceIn - 0.05);
      var actual = Math.max(bounds.min - original.timelineStart, Math.min(maximumDelta, delta));
      audioClip.timelineStart = original.timelineStart + actual;
      audioClip.timelineDuration = original.timelineDuration - actual;
      if (!original.loop) audioClip.sourceIn = original.sourceIn + actual;
    } else {
      var nextStart =
        dragState.index + 1 < dragState.track.clips.length
          ? dragState.track.clips[dragState.index + 1].timelineStart
          : dragState.total;
      var maxDuration = nextStart - original.timelineStart;
      if (!original.loop) maxDuration = Math.min(maxDuration, original.sourceOut - original.sourceIn);
      audioClip.timelineDuration = Math.max(_MIN_TRIM, Math.min(maxDuration, original.timelineDuration + delta));
      if (!original.loop) audioClip.sourceOut = original.sourceIn + audioClip.timelineDuration;
    }
    audioClip.fadeIn = Math.min(audioClip.fadeIn, audioClip.timelineDuration);
    audioClip.fadeOut = Math.min(
      audioClip.fadeOut,
      audioClip.timelineDuration - audioClip.fadeIn,
    );
    paintDragged();
    updatePlayheads(sourceTime(), dragState.total);
    event.preventDefault();
  }

  function onPointerUp() {
    if (!dragState) return;
    var shouldMute = !!dragState.clickMute;
    dragState = null;
    if (shouldMute) apiObject.toggleFragmentMute();
    else {
      render();
      setPlanDirty(selectedVideo());
    }
  }

  function clipFadeFactor(audioClip, localTime) {
    var factor = 1;
    if (audioClip.fadeIn > 0 && localTime < audioClip.fadeIn)
      factor = Math.min(factor, localTime / audioClip.fadeIn);
    var remaining = audioClip.timelineDuration - localTime;
    if (audioClip.fadeOut > 0 && remaining < audioClip.fadeOut)
      factor = Math.min(factor, remaining / audioClip.fadeOut);
    return Math.max(0, Math.min(1, factor));
  }

  function previewElement(track) {
    var element = previewElements[track.id];
    if (!element && track.mediaUrl) {
      element = root.document.createElement("audio");
      element.preload = "auto";
      element.src = track.mediaUrl;
      previewElements[track.id] = element;
    }
    return element;
  }

  function previewBaseVolume() {
    var slider = root.byId("vbar");
    if (root.muted || !slider) return 0;
    return Math.max(0, Math.min(1, Number(slider.value) / 100));
  }

  function sourceAudioAudibleAt(clip, time) {
    var segs = audioSegments(clip);
    if (!segs.length) return false;
    return root.SegmentEditing.segmentIndexAtTime(segs, time, 0.02) >= 0;
  }

  function applyPreviewVolume() {
    var videoClip = selectedVideo();
    var video = root.byId("vid");
    if (!videoClip || !video) return;
    var state = ensureState(videoClip);
    var base = previewBaseVolume();
    var time = Number(video.currentTime) || 0;
    var sourceAudible =
      state.enabled &&
      !state.sourceMuted &&
      videoClip.probeData &&
      videoClip.probeData.has_audio &&
      sourceAudioAudibleAt(videoClip, time);
    video.volume = sourceAudible
      ? Math.max(0, Math.min(1, base * dbToGain(state.sourceGainDb)))
      : 0;
    syncPreview();
  }

  function syncPreview() {
    var videoClip = selectedVideo();
    var video = root.byId("vid");
    if (!videoClip || !video || !videoClip.probed) return;
    var state = ensureState(videoClip);
    var total = sourceDuration(videoClip);
    var time = Number(video.currentTime) || 0;
    updatePlayheads(time, total);
    var base = previewBaseVolume();
    var sourceAudible =
      state.enabled &&
      !state.sourceMuted &&
      videoClip.probeData &&
      videoClip.probeData.has_audio &&
      sourceAudioAudibleAt(videoClip, time);
    video.volume = sourceAudible
      ? Math.max(0, Math.min(1, base * dbToGain(state.sourceGainDb)))
      : 0;
    state.tracks.forEach(function (track) {
      var element = previewElement(track);
      if (!element) return;
      var active = null;
      for (var i = 0; i < track.clips.length; i++) {
        var candidate = track.clips[i];
        if (
          time >= candidate.timelineStart - 0.02 &&
          time < candidate.timelineStart + candidate.timelineDuration - 0.01
        ) {
          active = candidate;
          break;
        }
      }
      if (!state.enabled || track.muted || !active || active.muted || video.paused) {
        if (!element.paused) element.pause();
        return;
      }
      var local = Math.max(0, time - active.timelineStart);
      var span = Math.max(_MIN_TRIM, active.sourceOut - active.sourceIn);
      var sourcePos = active.sourceIn + (active.loop ? local % span : local);
      if (!Number.isFinite(element.currentTime) || Math.abs(element.currentTime - sourcePos) > 0.12) {
        try {
          element.currentTime = sourcePos;
        } catch (err) {}
      }
      element.volume = Math.max(
        0,
        Math.min(
          1,
          base *
            dbToGain(track.gainDb + active.gainDb) *
            clipFadeFactor(active, local),
        ),
      );
      var promise = element.play();
      if (promise && typeof promise.catch === "function") promise.catch(function () {});
    });
  }

  function stopPreviewElements() {
    Object.keys(previewElements).forEach(function (key) {
      try {
        previewElements[key].pause();
        previewElements[key].src = "";
      } catch (err) {}
    });
    previewElements = {};
  }

  async function loadWaveform(clip, target, path) {
    if (!root.api || typeof root.api.getWaveform !== "function") return;
    try {
      var result = await root.api.getWaveform(path);
      if (!result.ok || !result.url || !clip.audioTimeline) return;
      if (target === clip.audioTimeline) {
        target.sourceWaveformUrl = result.url;
        target.sourceWaveformToken = result.token || "";
        target.sourceWaveformLoading = false;
      } else {
        target.waveformUrl = result.url;
        target.waveformToken = result.token || "";
      }
      if (selectedVideo() === clip) render();
    } catch (err) {
      if (target === clip.audioTimeline) target.sourceWaveformLoading = false;
    }
  }

  function loadSourceWaveform(clip) {
    var state = ensureState(clip);
    if (
      !clip ||
      !clip.probeData ||
      !clip.probeData.has_audio ||
      state.sourceWaveformUrl ||
      state.sourceWaveformLoading
    )
      return;
    state.sourceWaveformLoading = true;
    loadWaveform(clip, state, clip.path);
  }

  async function addPaths(paths, rejected) {
    var videoClip = selectedVideo();
    if (!videoClip) {
      root.toast("Select a video before adding audio.", "err");
      return;
    }
    var state = ensureState(videoClip);
    var start = sourceTime();
    var total = sourceDuration(videoClip);
    if (total <= 0) {
      root.toast("Wait for the video to finish loading before adding audio.", "err");
      return;
    }
    var added = 0;
    for (var i = 0; i < paths.length; i++) {
      try {
        if (
          state.tracks.some(function (track) {
            return track.path.toLowerCase() === paths[i].toLowerCase();
          })
        ) {
          throw new Error("This audio source is already on the timeline; split its clip to reuse it");
        }
        var probed = await root.api.probeAudioFile(paths[i]);
        if (!probed.ok || !probed.data) throw new Error(probed.error || "Could not read audio");
        var media = await root.api.getMediaUrl(paths[i]);
        if (!media.ok || !media.url) throw new Error(media.error || "Could not load audio");
        var duration = Number(probed.data.duration) || 0;
        if (duration < _MIN_TRIM) throw new Error("Audio file is too short");
        var timelineStart = Math.min(start, Math.max(0, total - 0.05));
        var clipDuration = Math.min(duration, total - timelineStart);
        var track = {
          id: nextId("track"),
          name: paths[i].split(/[\\/]/).pop(),
          path: paths[i],
          codec: probed.data.codec || "audio",
          sourceDuration: duration,
          muted: false,
          gainDb: 0,
          mediaUrl: media.url,
          mediaToken: media.token || "",
          waveformUrl: "",
          waveformToken: "",
          clips: [
            {
              id: nextId("audio"),
              timelineStart: timelineStart,
              sourceIn: 0,
              sourceOut: duration,
              timelineDuration: clipDuration,
              gainDb: 0,
              fadeIn: 0,
              fadeOut: 0,
              loop: false,
              muted: false,
            },
          ],
        };
        state.tracks.push(track);
        selectedClipId = track.clips[0].id;
        selectedSourceIndex = null;
        added += 1;
        loadWaveform(videoClip, track, paths[i]);
      } catch (err) {
        root.toast(
          "Could not add " + paths[i].split(/[\\/]/).pop() + ": " + (err.message || err),
          "err",
        );
      }
    }
    if (added) {
      stopPreviewElements();
      render();
      setPlanDirty(videoClip);
      root.toast("Added " + added + " audio " + (added === 1 ? "track." : "tracks."), "ok");
    }
    if (rejected && rejected.length)
      root.toast("Skipped " + rejected.length + " unsupported audio file(s).", "err");
  }

  function releaseToken(token) {
    if (token && root.api && typeof root.api.releaseMediaToken === "function")
      root.api.releaseMediaToken(token);
  }

  function disposeClip(videoClip) {
    if (!videoClip || !videoClip.audioTimeline) return;
    releaseToken(videoClip.audioTimeline.sourceWaveformToken);
    videoClip.audioTimeline.tracks.forEach(function (track) {
      releaseToken(track.mediaToken);
      releaseToken(track.waveformToken);
      if (previewElements[track.id]) {
        previewElements[track.id].pause();
        delete previewElements[track.id];
      }
    });
  }

  function requestPayload(videoClip) {
    var state = ensureState(videoClip);
    if (!state) return {};
    reconcile(videoClip);
    var payload = {
      audio_enabled: !!state.enabled,
      source_audio_muted: !!state.sourceMuted,
      source_audio_gain_db: Number(state.sourceGainDb) || 0,
      audio_tracks: state.tracks.map(function (track) {
        return {
          track_id: track.id,
          name: track.name,
          gain_db: Number(track.gainDb) || 0,
          muted: !!track.muted,
          clips: track.clips.map(function (audioClip) {
            return {
              source: track.path,
              timeline_start: audioClip.timelineStart,
              source_in: audioClip.sourceIn,
              source_out: audioClip.sourceOut,
              timeline_duration: audioClip.timelineDuration,
              gain_db: Number(audioClip.gainDb) || 0,
              fade_in: audioClip.fadeIn,
              fade_out: audioClip.fadeOut,
              loop: !!audioClip.loop,
              muted: !!audioClip.muted,
            };
          }),
        };
      }),
    };
    var videoSegs = root.SegmentEditing
      ? root.SegmentEditing.segmentsForClip(videoClip, sourceDuration(videoClip))
      : [];
    var keptAudio = root.SegmentEditing
      ? root.SegmentEditing.audioSegmentsForClip(videoClip, sourceDuration(videoClip))
      : videoSegs.filter(function (segment) {
          return segment.grouped !== false && segment.audio !== false;
        });
    var followsVideo =
      keptAudio.length === videoSegs.length &&
      videoSegs.every(function (segment, index) {
        return (
          keptAudio[index] &&
          Math.abs(keptAudio[index].start - segment.start) < 1e-6 &&
          Math.abs(keptAudio[index].end - segment.end) < 1e-6
        );
      });
    if (!followsVideo)
      payload.source_audio_segments = keptAudio.map(function (segment) {
        return { start: segment.start, end: segment.end };
      });
    return payload;
  }

  var apiObject = {
    render: render,
    selectVideo: function (clip) {
      stopPreviewElements();
      selectedClipId = null;
      selectedSourceIndex = null;
      if (clip) {
        ensureState(clip);
        loadSourceWaveform(clip);
      }
      render();
    },
    onProbe: function (clip) {
      ensureState(clip);
      if (selectedVideo() === clip) {
        loadSourceWaveform(clip);
        render();
      }
    },
    disposeClip: disposeClip,
    requestPayload: requestPayload,
    paintSource: function () {
      var clip = selectedVideo();
      if (!clip) return;
      paintSourceLane(clip, ensureState(clip), sourceDuration(clip));
    },
    syncPreview: syncPreview,
    applyPreviewVolume: applyPreviewVolume,
    hasSelection: function () {
      return !!(selectedClipId || selectedSourceIndex != null);
    },
    onVideoSplit: function () {},
    browse: async function () {
      if (!root.api || typeof root.api.pickAudioFiles !== "function") return;
      try {
        var result = await root.api.pickAudioFiles();
        if (result.ok && result.files && result.files.length) addPaths(result.files, []);
        else if (!result.ok) root.toast(result.error || "Could not choose audio files.", "err");
      } catch (err) {
        root.toast("Could not choose audio files.", "err");
      }
    },
    addPaths: addPaths,
    toggleMaster: function () {
      var clip = selectedVideo();
      var state = ensureState(clip);
      if (!state) return;
      state.enabled = !state.enabled;
      render();
      setPlanDirty(clip);
    },
    toggleLink: function () {
      var clip = selectedVideo();
      if (!clip || !root.SegmentEditing) return;
      var full = sourceDuration(clip);
      var segs = root.SegmentEditing.segmentsForClip(clip, full);
      var active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
      active = Math.max(0, Math.min(segs.length - 1, active));
      if (!segs[active]) return;
      var grouped = root.SegmentEditing.isGrouped
        ? root.SegmentEditing.isGrouped(segs[active])
        : root.SegmentEditing.hasAudio(segs[active]);
      if (grouped) {
        var unlinked = root.SegmentEditing.unlinkSegmentAudio(
          segs,
          clip.sourceAudioSegments,
          active,
          full,
        );
        segs = unlinked.segments;
        clip.sourceAudioSegments = unlinked.detached;
        selectedSourceIndex = clip.sourceAudioSegments.length - 1;
      } else {
        var relinked = root.SegmentEditing.relinkSegmentAudio(
          segs,
          clip.sourceAudioSegments,
          active,
          full,
        );
        segs = relinked.segments;
        clip.sourceAudioSegments = relinked.detached;
        selectedSourceIndex = null;
      }
      if (typeof root.setClipSegments === "function")
        root.setClipSegments(clip, segs, active);
      selectedTrackId = "source";
      if (typeof root.paintTrimChrome === "function") root.paintTrimChrome();
      render();
      setPlanDirty(clip);
    },
    toggleFragmentMute: function () {
      var clip = selectedVideo();
      if (!clip || !root.SegmentEditing) return;
      var full = sourceDuration(clip);
      if (selectedSourceIndex != null && clip.sourceAudioSegments) {
        var extras = clip.sourceAudioSegments.slice();
        if (!extras[selectedSourceIndex]) return;
        extras[selectedSourceIndex] = Object.assign({}, extras[selectedSourceIndex], {
          muted: !extras[selectedSourceIndex].muted,
        });
        clip.sourceAudioSegments = extras;
      } else {
        var segs = root.SegmentEditing.segmentsForClip(clip, full);
        var active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
        if (!segs[active]) return;
        segs[active].muted = !segs[active].muted;
        if (typeof root.setClipSegments === "function")
          root.setClipSegments(clip, segs, active);
      }
      if (typeof root.paintTrimChrome === "function") root.paintTrimChrome();
      render();
      setPlanDirty(clip);
    },
    selectTrack: function (trackId) {
      selectedTrackId = trackId || "source";
      if (trackId !== "source") selectedSourceIndex = null;
      selectedClipId = null;
      paintMixer(selectedVideo());
    },
    toggleSourceMute: function () {
      var clip = selectedVideo();
      var state = ensureState(clip);
      if (!state) return;
      state.sourceMuted = !state.sourceMuted;
      render();
      setPlanDirty(clip);
    },
    setSourceGain: function (value) {
      var clip = selectedVideo();
      var state = ensureState(clip);
      if (!state) return;
      state.sourceGainDb = Math.max(-60, Math.min(12, Number(value) || 0));
      applyPreviewVolume();
      paintMixer(clip);
      setPlanDirty(clip);
    },
    toggleTrackMute: function (trackId) {
      var clip = selectedVideo();
      var track = findTrack(trackId, clip);
      if (!track) return;
      track.muted = !track.muted;
      render();
      setPlanDirty(clip);
    },
    toggleMixerMute: function () {
      if (selectedTrackId === "source") return apiObject.toggleSourceMute();
      apiObject.toggleTrackMute(selectedTrackId);
    },
    setMixerGain: function (value) {
      if (selectedTrackId === "source") return apiObject.setSourceGain(value);
      apiObject.setTrackGain(selectedTrackId, value);
      paintMixer(selectedVideo());
    },
    setTrackGain: function (trackId, value) {
      var clip = selectedVideo();
      var track = findTrack(trackId, clip);
      if (!track) return;
      track.gainDb = Math.max(-60, Math.min(12, Number(value) || 0));
      syncPreview();
      paintMixer(clip);
      setPlanDirty(clip);
    },
    removeTrack: function (trackId) {
      var clip = selectedVideo();
      var state = ensureState(clip);
      var track = findTrack(trackId, clip);
      if (!state || !track) return;
      root.confirmToast("Remove audio track “" + track.name + "”?", function () {
        var selected = findSelected(clip);
        releaseToken(track.mediaToken);
        releaseToken(track.waveformToken);
        if (previewElements[track.id]) {
          previewElements[track.id].pause();
          delete previewElements[track.id];
        }
        state.tracks = state.tracks.filter(function (item) {
          return item.id !== trackId;
        });
        if (selected && selected.track.id === trackId) selectedClipId = null;
        render();
        setPlanDirty(clip);
      });
    },
    toggleSelectedMute: function () {
      var selected = findSelected();
      if (!selected) return;
      selected.clip.muted = !selected.clip.muted;
      render();
      setPlanDirty(selectedVideo());
    },
    splitSelected: function () {
      var videoClip = selectedVideo();
      if (!videoClip) return;
      var at = sourceTime();
      var full = sourceDuration(videoClip);
      if (selectedSourceIndex != null || (!selectedClipId && audioSegments(videoClip).length)) {
        var index =
          selectedSourceIndex != null
            ? selectedSourceIndex
            : root.SegmentEditing.segmentIndexAtTime(audioSegments(videoClip), at, 0);
        if (index < 0) {
          root.toast("Move the playhead inside the source audio clip to split it.", "err");
          return;
        }
        var splitAudio = root.SegmentEditing.splitAt(audioSegments(videoClip), at, full);
        if (!splitAudio) {
          root.toast("Move the playhead inside the source audio clip to split it.", "err");
          return;
        }
        setAudioSegments(videoClip, splitAudio.segments);
        selectedSourceIndex = splitAudio.index;
        selectedClipId = null;
        render();
        setPlanDirty(videoClip);
        return;
      }
      var selected = findSelected(videoClip);
      if (!selected) return;
      var split = core.splitClip(selected.clip, at, nextId("audio"));
      if (!split) {
        root.toast("Move the playhead inside the selected audio clip to split it.", "err");
        return;
      }
      selected.track.clips.splice(selected.index, 1, split[0], split[1]);
      selectedClipId = split[1].id;
      render();
      setPlanDirty(videoClip);
    },
    deleteSelected: function () {
      var videoClip = selectedVideo();
      if (!videoClip) return;
      if (selectedSourceIndex != null && Array.isArray(videoClip.sourceAudioSegments)) {
        videoClip.sourceAudioSegments.splice(selectedSourceIndex, 1);
        selectedSourceIndex = null;
        render();
        setPlanDirty(videoClip);
        return;
      }
      var selected = findSelected(videoClip);
      if (!selected) return;
      selected.track.clips.splice(selected.index, 1);
      selectedClipId = null;
      render();
      setPlanDirty(videoClip);
    },
    toggleSelectedLoop: function () {
      var selected = findSelected();
      if (!selected) return;
      selected.clip.loop = !selected.clip.loop;
      render();
      setPlanDirty(selectedVideo());
    },
    setSelectedFadeIn: function (value) {
      var videoClip = selectedVideo();
      var selected = findSelected(videoClip);
      if (!selected) return;
      var fade = Math.max(0, Number(value) || 0);
      selected.clip.fadeIn = Math.min(fade, selected.clip.timelineDuration - selected.clip.fadeOut);
      render();
      setPlanDirty(videoClip);
    },
    setSelectedFadeOut: function (value) {
      var videoClip = selectedVideo();
      var selected = findSelected(videoClip);
      if (!selected) return;
      var fade = Math.max(0, Number(value) || 0);
      selected.clip.fadeOut = Math.min(fade, selected.clip.timelineDuration - selected.clip.fadeIn);
      render();
      setPlanDirty(videoClip);
    },
    removeSelectedTrack: function () {
      if (selectedTrackId === "source") return;
      apiObject.removeTrack(selectedTrackId);
    },
    seekSource: function (seconds) {
      var videoClip = selectedVideo();
      var video = root.byId("vid");
      if (!videoClip || !video || !videoClip.probeData) return;
      video.currentTime = Math.max(0, Math.min(sourceDuration(videoClip), seconds));
      syncPreview();
    },
    seekOutput: function (seconds) {
      var videoClip = selectedVideo();
      var video = root.byId("vid");
      if (!videoClip || !video || !videoClip.probeData) return;
      var segments = root.SegmentEditing.segmentsForClip(
        videoClip,
        Number(videoClip.probeData.duration),
      );
      video.currentTime = core.outputToSourceTime(segments, seconds);
      syncPreview();
    },
    resetAudio: function (clip) {
      if (!clip) return;
      clip.sourceAudioSegments = null;
      if (clip.audioTimeline) clip.audioTimeline.linked = true;
      selectedSourceIndex = null;
    },
  };

  root.AudioEditing = core;
  root.AudioTimeline = apiObject;
  root.addAudioFiles = function (paths, rejected) {
    if (!Array.isArray(paths)) return;
    addPaths(paths, rejected || []);
  };
  var sourceLane = root.document.getElementById("source-audio-lane");
  if (sourceLane) sourceLane.addEventListener("pointerdown", onLanePointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  var video = root.document.getElementById("vid");
  if (video) {
    video.addEventListener("play", syncPreview);
    video.addEventListener("pause", syncPreview);
    video.addEventListener("timeupdate", syncPreview);
    video.addEventListener("seeked", syncPreview);
  }
  root.document.addEventListener("keydown", function (event) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target && event.target.tagName)) return;
    if (event.key === "Delete" && (selectedClipId || selectedSourceIndex != null)) {
      event.preventDefault();
      apiObject.deleteSelected();
    }
    if ((event.key === "s" || event.key === "S") && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (typeof root.splitAtPlayhead === "function") root.splitAtPlayhead();
      else apiObject.splitSelected();
    }
  });
})(typeof window !== "undefined" ? window : null, function () {
  function selectedDuration(segments) {
    return (segments || []).reduce(function (total, segment) {
      return total + Math.max(0, Number(segment.end) - Number(segment.start));
    }, 0);
  }

  function sourceToOutputTime(segments, sourceTime) {
    var cursor = 0;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (sourceTime < segment.start) return cursor;
      if (sourceTime <= segment.end)
        return cursor + Math.max(0, sourceTime - segment.start);
      cursor += segment.end - segment.start;
    }
    return cursor;
  }

  function outputToSourceTime(segments, outputTime) {
    var remaining = Math.max(0, Number(outputTime) || 0);
    for (var i = 0; i < segments.length; i++) {
      var duration = segments[i].end - segments[i].start;
      if (remaining <= duration) return segments[i].start + remaining;
      remaining -= duration;
    }
    return segments.length ? segments[segments.length - 1].end : 0;
  }

  function splitClip(clip, timelineTime, newId) {
    var local = timelineTime - clip.timelineStart;
    if (local < 0.05 || local > clip.timelineDuration - 0.05) return null;
    var left = Object.assign({}, clip, {
      timelineDuration: local,
      fadeOut: 0,
    });
    var right = Object.assign({}, clip, {
      id: newId,
      timelineStart: timelineTime,
      timelineDuration: clip.timelineDuration - local,
      fadeIn: 0,
    });
    if (!clip.loop) {
      left.sourceOut = clip.sourceIn + local;
      right.sourceIn = left.sourceOut;
    }
    left.fadeIn = Math.min(left.fadeIn, left.timelineDuration);
    right.fadeOut = Math.min(right.fadeOut, right.timelineDuration);
    return [left, right];
  }

  return {
    selectedDuration: selectedDuration,
    sourceToOutputTime: sourceToOutputTime,
    outputToSourceTime: outputToSourceTime,
    splitClip: splitClip,
  };
});
