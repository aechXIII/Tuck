(function (root, factory) {
  var core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  if (!root || !root.document) return;

  var selectedClipId = null;
  var selectedTrackId = "source";
  var idCounter = 0;
  var dragState = null;
  var previewElements = {};
  var _DRAG_THRESHOLD = 5;
  var _groupDragRaf = 0;
  var _groupDragEvent = null;
  var _MIN_TRIM = root.SegmentEditing.MIN_DURATION;

  // Imported tracks use colors outside the video purple
  var TRACK_COLORS = ["#0d9488", "#b45309", "#0369a1", "#4d7c0f", "#a21caf", "#c2410c"];

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
        sourceMuted: false,
        sourceGainDb: 0,
        sourceWaveformUrl: "",
        sourceWaveformToken: "",
        sourceWaveformLoading: false,
        tracks: [],
      };
    }
    return clip.audioTimeline;
  }

  function sourceDuration(clip) {
    return clip && clip.probeData ? Number(clip.probeData.duration) || 0 : 0;
  }

  function sourceTime() {
    var video = root.byId("vid");
    return video ? Number(video.currentTime) || 0 : 0;
  }

  function audioSegments(clip) {
    var full = sourceDuration(clip);
    if (!full || !root.SegmentEditing) return [];
    return root.SegmentEditing.audioSegmentsForClip(clip, full);
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

  function selectedClipRangeData(clip) {
    var videoClip = clip || selectedVideo();
    var selected = findSelected(videoClip);
    if (!selected) return null;
    var state = ensureState(videoClip);
    var index = state.tracks.indexOf(selected.track);
    return Object.assign(core.sourceRangeState(selected.clip, selected.track.sourceDuration), {
      clipId: selected.clip.id,
      trackId: selected.track.id,
      code: "A" + (index + 2),
      name: selected.track.name,
      color: trackColor(index),
      waveformUrl: selected.track.waveformUrl || "",
      timelineStart: selected.clip.timelineStart,
      timelineDuration: selected.clip.timelineDuration,
    });
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

  function paintTimelineSelection() {
    var videoTrack = root.byId("video-track");
    var sourceTrack = root.byId("source-audio-track");
    var sourceGroupSelected = selectedTrackId === "source";
    if (videoTrack) videoTrack.classList.toggle("selected", sourceGroupSelected);
    if (sourceTrack) sourceTrack.classList.toggle("selected", sourceGroupSelected);

    Array.from(root.document.querySelectorAll("#tl-segments .tl-segment")).forEach(
      function (segment) {
        var selected = sourceGroupSelected && segment.classList.contains("active");
        segment.setAttribute("aria-pressed", selected ? "true" : "false");
      },
    );

    var importedTracks = root.byId("imported-audio-tracks");
    if (importedTracks) {
      Array.from(importedTracks.querySelectorAll(".seq-row.audio.imported")).forEach(
        function (row) {
          row.classList.toggle("selected", row.dataset.trackId === selectedTrackId);
        },
      );
    }
    Array.from(
      root.document.querySelectorAll(".seq-audio-clip.imported[data-clip-id]"),
    ).forEach(function (audioClip) {
      var selected = audioClip.dataset.clipId === selectedClipId;
      audioClip.classList.toggle("selected", selected);
      audioClip.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function setTimelineSelection(trackId, clipId) {
    var selection = core.timelineSelection(trackId, clipId);
    selectedTrackId = selection.trackId;
    selectedClipId = selection.clipId;
    paintTimelineSelection();
  }

  function renderSourceTrack(clip, state, total) {
    var lane = root.byId("source-audio-lane");
    var sourceTrack = root.byId("source-audio-track");
    if (!lane || !sourceTrack) return;
    var hasAudio = !!(clip.probeData && clip.probeData.has_audio);
    sourceTrack.classList.toggle("disabled", !hasAudio || !state.enabled);
    sourceTrack.classList.toggle("muted", state.sourceMuted);
    sourceTrack.setAttribute(
      "aria-label",
      state.sourceMuted ? "Source audio track, muted" : "Source audio track",
    );
    var sourceLabel = root.byId("source-audio-label");
    if (sourceLabel) {
      sourceLabel.classList.toggle("muted", state.sourceMuted);
      sourceLabel.dataset.tip = state.sourceMuted ? "Unmute source audio" : "Mute source audio";
      sourceLabel.setAttribute("aria-pressed", state.sourceMuted ? "true" : "false");
      sourceLabel.setAttribute(
        "aria-label",
        state.sourceMuted ? "Unmute source audio" : "Mute source audio",
      );
    }
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
      lane.appendChild(sourceAudioBlock(segment, index, index === videoActive, state, total));
    });
  }

  function sourceAudioBlock(segment, index, selected, state, total) {
    var block = root.document.createElement("div");
    block.className =
      "seq-audio-clip" + (selected ? " selected" : "") + (segment.muted ? " muted" : "");
    if (segment.muted) block.dataset.tip = "Source audio muted for this segment";
    block.dataset.audioKind = "source";
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
    if (segment.muted) {
      var mutedIndicator = root.document.createElement("span");
      mutedIndicator.className = "audio-muted-indicator";
      mutedIndicator.textContent = "Muted";
      mutedIndicator.setAttribute("aria-hidden", "true");
      block.appendChild(mutedIndicator);
    }
    var edgeIn = root.document.createElement("span");
    edgeIn.className = "clip-edge start";
    edgeIn.dataset.edge = "start";
    var edgeOut = root.document.createElement("span");
    edgeOut.className = "clip-edge end";
    edgeOut.dataset.edge = "end";
    block.append(edgeIn, edgeOut);
    return block;
  }

  function renderImportedTrack(track, total, index) {
    var row = root.document.createElement("div");
    row.className = "seq-row audio imported" + (track.muted ? " muted" : "");
    row.dataset.trackId = track.id;
    row.style.setProperty("--segment-color", trackColor(index));
    row.setAttribute(
      "aria-label",
      track.name + " audio track" + (track.muted ? ", muted" : ""),
    );

    var head = root.document.createElement("div");
    head.className = "seq-head";
    var codeEl = root.document.createElement("span");
    codeEl.className = "seq-track-code";
    codeEl.textContent = "A" + (index + 2);
    codeEl.setAttribute("aria-hidden", "true");
    head.appendChild(codeEl);

    var nameEl = root.document.createElement("span");
    nameEl.className = "seq-track-name";
    nameEl.textContent = track.name;
    nameEl.title = track.name;
    head.appendChild(nameEl);

    var muteEl = root.document.createElement("button");
    muteEl.type = "button";
    muteEl.className = "seq-track-mute" + (track.muted ? " muted" : "");
    muteEl.textContent = "M";
    muteEl.dataset.tip = track.muted ? "Unmute " + track.name : "Mute " + track.name;
    muteEl.setAttribute("aria-pressed", track.muted ? "true" : "false");
    muteEl.setAttribute("aria-label", muteEl.dataset.tip);
    muteEl.onclick = function (event) {
      event.stopPropagation();
      selectedTrackId = track.id;
      apiObject.toggleTrackMute(track.id);
    };
    head.appendChild(muteEl);

    var removeEl = root.document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "seq-track-remove";
    removeEl.textContent = "×";
    removeEl.dataset.tip = "Remove " + track.name;
    removeEl.setAttribute("aria-label", removeEl.dataset.tip);
    removeEl.onclick = function (event) {
      event.stopPropagation();
      selectedTrackId = track.id;
      apiObject.removeTrack(track.id);
    };
    head.appendChild(removeEl);

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
      el.dataset.tip = "Drag to move · Alt-drag to choose another source fragment";
      el.style.left = pct(audioClip.timelineStart, total);
      el.style.width = pct(audioClip.timelineDuration, total);

      var wave = root.document.createElement("div");
      wave.className = "audio-waveform";
      wave.setAttribute("style", waveformStyle(track, audioClip));
      el.appendChild(wave);
      var clipLabel = root.document.createElement("span");
      clipLabel.className = "audio-clip-label";
      clipLabel.textContent = track.name;
      el.appendChild(clipLabel);
      if (audioClip.muted) {
        var clipMutedIndicator = root.document.createElement("span");
        clipMutedIndicator.className = "audio-muted-indicator";
        clipMutedIndicator.textContent = "Muted";
        clipMutedIndicator.setAttribute("aria-hidden", "true");
        el.appendChild(clipMutedIndicator);
      }
      if (selected) {
        var sourceReadout = root.document.createElement("span");
        sourceReadout.className = "audio-source-range-readout";
        sourceReadout.textContent =
          "Source " +
          core.formatSourceTime(audioClip.sourceIn) +
          "–" +
          core.formatSourceTime(audioClip.sourceOut);
        el.appendChild(sourceReadout);
      }
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
      var edgeIn = root.document.createElement("span");
      edgeIn.className = "clip-edge start";
      edgeIn.dataset.edge = "start";
      var edgeOut = root.document.createElement("span");
      edgeOut.className = "clip-edge end";
      edgeOut.dataset.edge = "end";
      el.append(edgeIn, edgeOut);
      lane.appendChild(el);
    });
    row.appendChild(lane);
    return row;
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
      if (typeof root.syncTimelineTrackCount === "function") root.syncTimelineTrackCount(0);
      paintMixer(clip);
      return;
    }
    editor.classList.remove("disabled");
    var state = ensureState(clip);
    reconcile(clip);
    var total = sourceDuration(clip);
    var master = root.byId("audio-master-toggle");
    if (master) {
      master.classList.toggle("on", state.enabled);
      master.setAttribute("aria-checked", state.enabled ? "true" : "false");
      master.setAttribute(
        "aria-label",
        state.enabled ? "Exclude from export" : "Include in export",
      );
    }
    renderSourceTrack(clip, state, total);
    var tracks = root.byId("imported-audio-tracks");
    tracks.replaceChildren();
    state.tracks.forEach(function (track, index) {
      tracks.appendChild(renderImportedTrack(track, total, index));
    });
    if (typeof root.syncTimelineTrackCount === "function")
      root.syncTimelineTrackCount(state.tracks.length);
    paintMixer(clip);
    paintTimelineSelection();
    updatePlayheads(sourceTime(), total);
    applyPreviewVolume();
  }

  function paintMixer(clip) {
    if (!clip || !clip.probed) {
      var fragMuteEmpty = root.byId("audio-fragment-mute");
      if (fragMuteEmpty) fragMuteEmpty.classList.add("hid");
      if (typeof root.renderAudioMixerList === "function") root.renderAudioMixerList();
      if (typeof root.renderAudioLibraryPanel === "function") root.renderAudioLibraryPanel();
      return;
    }
    ensureState(clip);
    if (
      selectedTrackId !== "source" &&
      !findTrack(selectedTrackId, clip)
    ) {
      selectedTrackId = "source";
    }
    var fragMute = root.byId("audio-fragment-mute");
    var fragmentMuted = false;
    var selectedFragment = null;
    if (selectedTrackId === "source" && root.SegmentEditing) {
      var segs = root.SegmentEditing.segmentsForClip(clip, sourceDuration(clip));
      var active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
      fragmentMuted = !!(segs[active] && segs[active].muted);
    } else {
      selectedFragment = findSelected(clip);
      fragmentMuted = !!(selectedFragment && selectedFragment.clip.muted);
    }
    if (fragMute) {
      var hasFragmentTarget = selectedTrackId === "source" || !!selectedFragment;
      fragMute.classList.toggle("hid", !hasFragmentTarget);
      fragMute.classList.toggle("on", fragmentMuted);
      fragMute.setAttribute("aria-pressed", fragmentMuted ? "true" : "false");
      var fragMuteLabel;
      if (selectedFragment) {
        fragMuteLabel = fragmentMuted
          ? "Unmute selected audio fragment"
          : "Mute selected audio fragment";
      } else {
        fragMuteLabel = fragmentMuted
          ? "Unmute this segment's source audio"
          : "Mute this segment's source audio";
      }
      fragMute.setAttribute("aria-label", fragMuteLabel);
      fragMute.dataset.tip = fragMuteLabel;
    }
    if (typeof root.renderAudioMixerList === "function") root.renderAudioMixerList();
    if (typeof root.renderAudioLibraryPanel === "function") root.renderAudioLibraryPanel();
  }

  function updatePlayheads(time, total) {
    var pctValue = total > 0 ? Math.max(0, Math.min(100, (time / total) * 100)) : 0;
    var layer = root.byId("seq-playhead-layer");
    if (layer) layer.style.setProperty("--playhead", pctValue + "%");
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
      setTimelineSelection("source", null);
      var edge = event.target.closest ? event.target.closest(".clip-edge") : null;
      var sourceSegmentIndex = Number(clipEl.dataset.segmentIndex);
      var ratio = (event.clientX - lane.getBoundingClientRect().left) / lane.clientWidth;
      var time = Math.max(0, Math.min(total, ratio * total));
      if (edge && typeof root.applyTrimStart === "function") {
        if (Number.isInteger(sourceSegmentIndex) && typeof root.selectSegment === "function")
          root.selectSegment(sourceSegmentIndex, false);
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
    var track = findTrack(clipEl.dataset.trackId, videoClip);
    if (!track) return;
    var index = track.clips.findIndex(function (item) {
      return item.id === clipEl.dataset.clipId;
    });
    if (index < 0) return;
    setTimelineSelection(track.id, track.clips[index].id);
    var importedEdge = event.target.closest ? event.target.closest(".clip-edge") : null;
    var importedAction = core.importedDragAction(
      importedEdge ? importedEdge.dataset.edge : null,
      !!event.altKey,
      event.target.dataset.audioAction || "move",
    );
    if (importedAction === "slip" && !clipEl.querySelector(".audio-source-range-readout")) {
      var slipReadout = root.document.createElement("span");
      slipReadout.className = "audio-source-range-readout";
      slipReadout.textContent =
        "Source " +
        core.formatSourceTime(track.clips[index].sourceIn) +
        "–" +
        core.formatSourceTime(track.clips[index].sourceOut);
      clipEl.appendChild(slipReadout);
    }
    if (root.History) root.History.begin(root.selPath);
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
  }

  function audioClipSnapCandidates(excludeClipId) {
    var clip = selectedVideo();
    var total = sourceDuration(clip);
    var points = [0, total, sourceTime()];
    if (clip && root.SegmentEditing) {
      root.SegmentEditing.segmentsForClip(clip, total).forEach(function (segment) {
        points.push(segment.start, segment.end);
      });
    }
    var state = ensureState(clip);
    state.tracks.forEach(function (track) {
      track.clips.forEach(function (audioClip) {
        if (audioClip.id === excludeClipId) return;
        points.push(audioClip.timelineStart, audioClip.timelineStart + audioClip.timelineDuration);
      });
    });
    return points;
  }

  function paintDragged() {
    if (!dragState || !dragState.element) return;
    dragState.element.style.left = pct(dragState.clip.timelineStart, dragState.total);
    dragState.element.style.width = pct(dragState.clip.timelineDuration, dragState.total);
    var wave = dragState.element.querySelector(".audio-waveform");
    if (wave) wave.setAttribute("style", waveformStyle(dragState.track, dragState.clip));
    var readout = dragState.element.querySelector(".audio-source-range-readout");
    if (readout)
      readout.textContent =
        "Source " +
        core.formatSourceTime(dragState.clip.sourceIn) +
        "–" +
        core.formatSourceTime(dragState.clip.sourceOut);
  }

  function processGroupDragMove(event) {
    if (!dragState) return;
    if (dragState.kind === "group-move") {
      if (Math.abs(event.clientX - dragState.startX) < _DRAG_THRESHOLD) return;
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
      return;
    }
    var trimTime =
      ((event.clientX - dragState.rect.left) / dragState.rect.width) * dragState.total;
    if (dragState.edge === "start" && typeof root.applyTrimStart === "function")
      root.applyTrimStart(trimTime);
    else if (typeof root.applyTrimEnd === "function") root.applyTrimEnd(trimTime);
    if (typeof root.paintTrimChrome === "function") root.paintTrimChrome();
  }

  function onPointerMove(event) {
    if (!dragState) return;
    if (dragState.kind === "group-move" || dragState.kind === "group-trim") {
      event.preventDefault();
      _groupDragEvent = event;
      if (_groupDragRaf) return;
      _groupDragRaf = requestAnimationFrame(function () {
        _groupDragRaf = 0;
        var evt = _groupDragEvent;
        _groupDragEvent = null;
        if (evt) processGroupDragMove(evt);
      });
      return;
    }
    var delta = ((event.clientX - dragState.startX) / dragState.rect.width) * dragState.total;
    var original = dragState.original;
    var audioClip = dragState.clip;
    var bounds = neighborBounds(
      dragState.track,
      dragState.index,
      dragState.total,
      original.timelineDuration,
    );
    if (dragState.action === "move") {
      if (Math.abs(event.clientX - dragState.startX) < _DRAG_THRESHOLD) {
        event.preventDefault();
        return;
      }
      var proposedStart = Math.max(
        bounds.min,
        Math.min(bounds.max, original.timelineStart + delta),
      );
      if (typeof root.snapCandidateTime === "function") {
        var pxPerSecond = dragState.rect.width / dragState.total;
        var candidates = audioClipSnapCandidates(audioClip.id);
        var snappedStart = root.snapCandidateTime(proposedStart, candidates, pxPerSecond);
        var snappedEnd = root.snapCandidateTime(
          proposedStart + original.timelineDuration,
          candidates,
          pxPerSecond,
        );
        if (snappedEnd !== proposedStart + original.timelineDuration)
          proposedStart = snappedEnd - original.timelineDuration;
        else proposedStart = snappedStart;
        proposedStart = Math.max(bounds.min, Math.min(bounds.max, proposedStart));
      }
      audioClip.timelineStart = proposedStart;
    } else if (dragState.action === "slip") {
      var slipped = core.slipClip(original, dragState.track.sourceDuration, delta);
      audioClip.sourceIn = slipped.sourceIn;
      audioClip.sourceOut = slipped.sourceOut;
      dragState.element.classList.add("slipping");
    } else if (dragState.action === "trim-start") {
      var maximumDelta = original.timelineDuration - _MIN_TRIM;
      var minimumDelta = bounds.min - original.timelineStart;
      if (!original.loop) {
        maximumDelta = Math.min(maximumDelta, original.sourceOut - original.sourceIn - _MIN_TRIM);
        // Keep the trim inside the source
        minimumDelta = Math.max(minimumDelta, -original.sourceIn);
      }
      var actual = Math.max(minimumDelta, Math.min(maximumDelta, delta));
      audioClip.timelineStart = original.timelineStart + actual;
      audioClip.timelineDuration = original.timelineDuration - actual;
      if (!original.loop) audioClip.sourceIn = original.sourceIn + actual;
    } else {
      var nextStart =
        dragState.index + 1 < dragState.track.clips.length
          ? dragState.track.clips[dragState.index + 1].timelineStart
          : dragState.total;
      var maxDuration = nextStart - original.timelineStart;
      // Use all audio left in the source
      if (!original.loop)
        maxDuration = Math.min(maxDuration, dragState.track.sourceDuration - original.sourceIn);
      audioClip.timelineDuration = Math.max(
        _MIN_TRIM,
        Math.min(maxDuration, original.timelineDuration + delta),
      );
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
    if (_groupDragRaf) {
      cancelAnimationFrame(_groupDragRaf);
      _groupDragRaf = 0;
    }
    if (_groupDragEvent) {
      processGroupDragMove(_groupDragEvent);
      _groupDragEvent = null;
    }
    var completedDrag = dragState;
    dragState = null;
    if (completedDrag.element) completedDrag.element.classList.remove("slipping");
    render();
    setPlanDirty(selectedVideo());
    if (root.History) root.History.commit();
  }

  function updateSelectedSourceRange(value, finalize) {
    var videoClip = selectedVideo();
    var selected = findSelected(videoClip);
    if (!selected) return null;
    var desired = Number(value);
    if (!Number.isFinite(desired)) desired = selected.clip.sourceIn;
    var slipped = core.slipClip(
      selected.clip,
      selected.track.sourceDuration,
      desired - selected.clip.sourceIn,
    );
    selected.clip.sourceIn = slipped.sourceIn;
    selected.clip.sourceOut = slipped.sourceOut;
    if (finalize) {
      render();
      setPlanDirty(videoClip);
    } else {
      var element = root.document.querySelector(
        '[data-clip-id="' + selected.clip.id + '"]',
      );
      if (element) {
        var wave = element.querySelector(".audio-waveform");
        if (wave) wave.setAttribute("style", waveformStyle(selected.track, selected.clip));
        var readout = element.querySelector(".audio-source-range-readout");
        if (readout)
          readout.textContent =
            "Source " +
            core.formatSourceTime(selected.clip.sourceIn) +
            "–" +
            core.formatSourceTime(selected.clip.sourceOut);
        element.classList.add("slipping");
      }
      syncPreview();
    }
    return selectedClipRangeData(videoClip);
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
        var placement = core.fitClipToTimeline(duration, total, start, _MIN_TRIM);
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
              timelineStart: placement.timelineStart,
              sourceIn: placement.sourceIn,
              sourceOut: placement.sourceOut,
              timelineDuration: placement.timelineDuration,
              gainDb: 0,
              fadeIn: 0,
              fadeOut: 0,
              loop: false,
              muted: false,
            },
          ],
        };
        state.tracks.push(track);
        setTimelineSelection(track.id, track.clips[0].id);
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
    var keptAudio = root.SegmentEditing.audioSegmentsForClip(
      videoClip,
      sourceDuration(videoClip),
    );
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
    trackColor: trackColor,
    selectVideo: function (clip) {
      stopPreviewElements();
      setTimelineSelection("source", null);
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
    paintMixer: function () {
      paintMixer(selectedVideo());
    },
    syncPreview: syncPreview,
    applyPreviewVolume: applyPreviewVolume,
    hasSelection: function () {
      return !!selectedClipId;
    },
    getSelectedClipRange: function () {
      return selectedClipRangeData(selectedVideo());
    },
    setSelectedSourceIn: function (value, finalize) {
      return updateSelectedSourceRange(value, !!finalize);
    },
    resetSelectedSource: function () {
      var selected = findSelected(selectedVideo());
      if (!selected) return null;
      return updateSelectedSourceRange(0, true);
    },
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
    toggleFragmentMute: function () {
      var clip = selectedVideo();
      if (!clip) return;
      if (selectedTrackId !== "source") {
        var selected = findSelected(clip);
        if (!selected) return;
        if (root.History) root.History.begin(root.selPath);
        selected.clip.muted = !selected.clip.muted;
        render();
        setPlanDirty(clip);
        if (root.History) root.History.commit();
        return;
      }
      if (!root.SegmentEditing) return;
      var full = sourceDuration(clip);
      var segs = root.SegmentEditing.segmentsForClip(clip, full);
      var active = Number.isInteger(clip.activeSegment) ? clip.activeSegment : 0;
      if (!segs[active]) return;
      segs[active].muted = !segs[active].muted;
      if (typeof root.setClipSegments === "function")
        root.setClipSegments(clip, segs, active);
      if (typeof root.paintTrimChrome === "function") root.paintTrimChrome();
      render();
      setPlanDirty(clip);
    },
    selectTrack: function (trackId) {
      setTimelineSelection(trackId || "source", null);
      paintMixer(selectedVideo());
    },
    selectClip: function (trackId, clipId) {
      setTimelineSelection(trackId, clipId);
      paintMixer(selectedVideo());
    },
    selectVideoTrack: function () {
      setTimelineSelection("video", null);
      paintMixer(selectedVideo());
    },
    isSourceGroupSelected: function () {
      return selectedTrackId === "source";
    },
    toggleSourceMute: function () {
      var clip = selectedVideo();
      var state = ensureState(clip);
      if (!state) return;
      selectedTrackId = "source";
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
      setPlanDirty(clip);
    },
    toggleTrackMute: function (trackId) {
      var clip = selectedVideo();
      var track = findTrack(trackId, clip);
      if (!track) return;
      selectedTrackId = trackId;
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
    },
    setTrackGain: function (trackId, value) {
      var clip = selectedVideo();
      var track = findTrack(trackId, clip);
      if (!track) return;
      track.gainDb = Math.max(-60, Math.min(12, Number(value) || 0));
      syncPreview();
      setPlanDirty(clip);
    },
    removeTrack: function (trackId) {
      var clip = selectedVideo();
      var state = ensureState(clip);
      var track = findTrack(trackId, clip);
      if (!state || !track) return;
      root.confirmToast("Remove audio track “" + track.name + "”?", function () {
        if (root.History) root.History.begin(root.selPath);
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
        if (root.History) root.History.commit();
      });
    },
    splitSelected: function () {
      var videoClip = selectedVideo();
      if (!videoClip) return;
      var at = sourceTime();
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
      var selected = findSelected(videoClip);
      if (!selected) return;
      selected.track.clips.splice(selected.index, 1);
      selectedClipId = null;
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
    if (
      root.TuckShortcuts &&
      !root.TuckShortcuts.editorCommandsEnabled(root.document)
    )
      return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target && event.target.tagName)) return;
    if (event.key === "Delete" && selectedClipId) {
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

  function fitClipToTimeline(sourceDuration, timelineDuration, playhead, minimumDuration) {
    var source = Math.max(0, Number(sourceDuration) || 0);
    var timeline = Math.max(0, Number(timelineDuration) || 0);
    var minimum = Math.max(0, Number(minimumDuration) || 0.05);
    var maxStart = Math.max(0, timeline - Math.min(minimum, timeline));
    var timelineStart = Math.max(0, Math.min(maxStart, Number(playhead) || 0));
    var duration = Math.min(source, Math.max(0, timeline - timelineStart));
    return {
      timelineStart: timelineStart,
      timelineDuration: duration,
      sourceIn: 0,
      sourceOut: duration,
    };
  }

  function sourceRangePointerValue(
    clientX,
    contentLeft,
    contentWidth,
    grabOffset,
    sourceDuration,
    maxSourceIn,
  ) {
    var width = Math.max(1, Number(contentWidth) || 0);
    var value =
      ((Number(clientX) - Number(contentLeft) - (Number(grabOffset) || 0)) / width) *
      Math.max(0, Number(sourceDuration) || 0);
    return Math.max(0, Math.min(Math.max(0, Number(maxSourceIn) || 0), value));
  }

  function sourceRangeDetailState(sourceIn, sourceSpan, sourceDuration) {
    var start = Math.max(0, Number(sourceIn) || 0);
    var span = Math.max(0, Number(sourceSpan) || 0);
    var total = Math.max(0, Number(sourceDuration) || 0);
    var visibleSpan = span ? Math.min(total, span * 2.5) : total;
    if (!visibleSpan) {
      return {
        visibleSpan: 0,
        viewportStart: 0,
        waveformLeftPct: 0,
        waveformWidthPct: 100,
        waveformPositionPct: 0,
        selectionStartPct: 0,
        selectionWidthPct: 100,
      };
    }
    if (visibleSpan >= total) {
      return {
        visibleSpan: visibleSpan,
        viewportStart: 0,
        waveformLeftPct: 0,
        waveformWidthPct: 100,
        waveformPositionPct: 0,
        selectionStartPct: total ? (start / total) * 100 : 0,
        selectionWidthPct: total ? (span / total) * 100 : 100,
      };
    }
    var context = Math.max(0, (visibleSpan - span) / 2);
    var viewportStart = start - context;
    var waveformLeftPct = (-viewportStart / visibleSpan) * 100;
    var waveformWidthPct = (total / visibleSpan) * 100;
    return {
      visibleSpan: visibleSpan,
      viewportStart: viewportStart,
      waveformLeftPct: waveformLeftPct,
      waveformWidthPct: waveformWidthPct,
      waveformPositionPct: (waveformLeftPct / (100 - waveformWidthPct)) * 100,
      selectionStartPct: (context / visibleSpan) * 100,
      selectionWidthPct: (span / visibleSpan) * 100,
    };
  }

  function sourceRangeDetailDragValue(current, deltaX, visibleSpan, contentWidth, maxSourceIn) {
    var width = Math.max(1, Number(contentWidth) || 0);
    var value =
      (Number(current) || 0) -
      ((Number(deltaX) || 0) / width) * Math.max(0, Number(visibleSpan) || 0);
    return Math.max(0, Math.min(Math.max(0, Number(maxSourceIn) || 0), value));
  }

  function sourceRangeKeyboardValue(current, maximum, key, largeStep) {
    var value = Math.max(0, Number(current) || 0);
    var max = Math.max(0, Number(maximum) || 0);
    if (key === "Home") return 0;
    if (key === "End") return max;
    var direction = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (!direction) return null;
    var step = largeStep ? 1 : 0.1;
    return Math.max(0, Math.min(max, value + direction * step));
  }

  function sourceSelectionSpan(clip) {
    var selected = Math.max(0, (Number(clip.sourceOut) || 0) - (Number(clip.sourceIn) || 0));
    var timeline = Math.max(0, Number(clip.timelineDuration) || 0);
    return clip.loop || !timeline ? selected : timeline;
  }

  function slipClip(clip, sourceDuration, delta) {
    var result = Object.assign({}, clip);
    var sourceIn = Number(clip.sourceIn) || 0;
    var span = sourceSelectionSpan(clip);
    var total = Math.max(0, Number(sourceDuration) || 0);
    if (!span || total < span) return result;
    var nextIn = sourceIn + (Number(delta) || 0);
    nextIn = Math.max(0, Math.min(total - span, nextIn));
    result.sourceIn = nextIn;
    result.sourceOut = nextIn + span;
    return result;
  }

  function resetSlip(clip, sourceDuration) {
    return slipClip(clip, sourceDuration, -(Number(clip.sourceIn) || 0));
  }

  function sourceRangeState(clip, sourceDuration) {
    var total = Math.max(0, Number(sourceDuration) || 0);
    var rawIn = Math.max(0, Number(clip.sourceIn) || 0);
    var span = Math.min(total, sourceSelectionSpan(clip));
    var maxSourceIn = Math.max(0, total - span);
    var sourceIn = Math.max(0, Math.min(maxSourceIn, rawIn));
    return {
      sourceIn: sourceIn,
      sourceOut: sourceIn + span,
      sourceSpan: span,
      sourceDuration: total,
      maxSourceIn: maxSourceIn,
      startPct: total ? (sourceIn / total) * 100 : 0,
      widthPct: total ? (span / total) * 100 : 0,
      canSlip: maxSourceIn > 0.000001,
    };
  }

  function formatSourceTime(seconds) {
    var totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    var milliseconds = totalMs % 1000;
    var totalSeconds = Math.floor(totalMs / 1000);
    var secs = totalSeconds % 60;
    var totalMinutes = Math.floor(totalSeconds / 60);
    var minutes = totalMinutes % 60;
    var hours = Math.floor(totalMinutes / 60);
    var prefix = hours ? hours + ":" + String(minutes).padStart(2, "0") : String(minutes);
    return (
      prefix +
      ":" +
      String(secs).padStart(2, "0") +
      "." +
      String(milliseconds).padStart(3, "0")
    );
  }

  function importedDragAction(edge, altKey, explicitAction) {
    if (edge === "start") return "trim-start";
    if (edge === "end") return "trim-end";
    if (altKey) return "slip";
    return explicitAction || "move";
  }

  function timelineSelection(trackId, clipId) {
    var targetTrackId = !trackId || trackId === "video" ? "source" : trackId;
    return {
      trackId: targetTrackId,
      clipId: targetTrackId === "source" ? null : clipId || null,
    };
  }

  return {
    selectedDuration: selectedDuration,
    sourceToOutputTime: sourceToOutputTime,
    outputToSourceTime: outputToSourceTime,
    fitClipToTimeline: fitClipToTimeline,
    sourceRangePointerValue: sourceRangePointerValue,
    sourceRangeDetailState: sourceRangeDetailState,
    sourceRangeDetailDragValue: sourceRangeDetailDragValue,
    sourceRangeKeyboardValue: sourceRangeKeyboardValue,
    splitClip: splitClip,
    slipClip: slipClip,
    resetSlip: resetSlip,
    sourceRangeState: sourceRangeState,
    formatSourceTime: formatSourceTime,
    importedDragAction: importedDragAction,
    timelineSelection: timelineSelection,
  };
});
