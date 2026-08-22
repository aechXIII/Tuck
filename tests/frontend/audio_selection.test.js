"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../../tuck/web/shortcuts.js");

function classList() {
  const values = new Set();
  return {
    contains(name) {
      return values.has(name);
    },
    toggle(name, active) {
      if (active) values.add(name);
      else values.delete(name);
    },
  };
}

function selectable(dataset) {
  return {
    dataset: dataset || {},
    classList: classList(),
    attributes: {},
    pressed: "false",
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === "aria-pressed") this.pressed = value;
    },
  };
}

const videoRow = selectable();
const sourceRow = selectable();
const importedRow = selectable({ trackId: "music-track" });
const importedClip = selectable({ clipId: "music-clip" });
const activeVideoSegment = selectable();
activeVideoSegment.classList.toggle("active", true);
const fragmentMute = selectable();
const sourceLane = { addEventListener() {} };
const video = { addEventListener() {}, currentTime: 4 };
const importedTracks = {
  querySelectorAll() {
    return [importedRow];
  },
};

global.window = global;
global.document = {
  addEventListener() {},
  getElementById(id) {
    if (id === "video-track") return videoRow;
    if (id === "source-audio-track") return sourceRow;
    if (id === "audio-fragment-mute") return fragmentMute;
    if (id === "source-audio-lane") return sourceLane;
    if (id === "imported-audio-tracks") return importedTracks;
    if (id === "vid") return video;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === ".seq-audio-clip.imported[data-clip-id]") return [importedClip];
    if (selector === "#tl-segments .tl-segment") return [activeVideoSegment];
    return [];
  },
};
global.addEventListener = function () {};
global.byId = global.document.getElementById.bind(global.document);
global.SegmentEditing = {
  MIN_DURATION: 0.05,
  segmentsForClip() {
    return [{ start: 0, end: 12 }];
  },
};
global.selPath = "video.mp4";
global.clips = {
  "video.mp4": {
    probed: true,
    probeData: { duration: 12, has_audio: true },
    audioTimeline: {
      enabled: true,
      sourceMuted: false,
      sourceGainDb: 0,
      tracks: [
        {
          id: "music-track",
          clips: [{ id: "music-clip" }],
        },
      ],
    },
  },
};
global.renderAudioMixerList = function () {};
global.renderAudioLibraryPanel = function () {};

require("../../tuck/web/audio.js");

test("clicking video replaces the imported audio command target and selected styling", () => {
  global.AudioTimeline.selectClip("music-track", "music-clip");

  assert.equal(global.AudioTimeline.hasSelection(), true);
  assert.equal(importedRow.classList.contains("selected"), true);
  assert.equal(importedClip.classList.contains("selected"), true);

  global.AudioTimeline.selectVideoTrack();

  assert.equal(global.AudioTimeline.hasSelection(), false);
  assert.equal(videoRow.classList.contains("selected"), true);
  assert.equal(sourceRow.classList.contains("selected"), true);
  assert.equal(importedRow.classList.contains("selected"), false);
  assert.equal(importedClip.classList.contains("selected"), false);
  assert.equal(importedClip.pressed, "false");
  assert.equal(fragmentMute.classList.contains("hid"), false);
  assert.equal(
    fragmentMute.attributes["aria-label"],
    "Mute this segment's source audio",
  );
});

test("selecting imported audio deselects linked video and source segments together", () => {
  global.AudioTimeline.selectVideoTrack();
  assert.equal(activeVideoSegment.classList.contains("active"), true);
  assert.equal(videoRow.classList.contains("selected"), true);
  assert.equal(sourceRow.classList.contains("selected"), true);
  assert.equal(activeVideoSegment.pressed, "true");

  global.AudioTimeline.selectClip("music-track", "music-clip");

  assert.equal(activeVideoSegment.classList.contains("active"), true);
  assert.equal(videoRow.classList.contains("selected"), false);
  assert.equal(sourceRow.classList.contains("selected"), false);
  assert.equal(activeVideoSegment.pressed, "false");
});

test("selected imported audio fragments use the segment mute command independently", () => {
  const track = global.clips["video.mp4"].audioTimeline.tracks[0];
  const audioClip = track.clips[0];
  audioClip.muted = false;
  track.muted = false;

  global.AudioTimeline.selectClip(track.id, audioClip.id);

  assert.equal(fragmentMute.classList.contains("hid"), false);
  assert.equal(fragmentMute.attributes["aria-label"], "Mute selected audio fragment");

  global.AudioTimeline.toggleFragmentMute();
  global.AudioTimeline.paintMixer();

  assert.equal(audioClip.muted, true);
  assert.equal(track.muted, false);
  assert.equal(fragmentMute.classList.contains("on"), true);
  assert.equal(fragmentMute.attributes["aria-label"], "Unmute selected audio fragment");

  global.AudioTimeline.selectTrack(track.id);

  assert.equal(fragmentMute.classList.contains("hid"), true);
});

test("keyboard delete uses the current history-wrapped audio action", () => {
  global.AudioTimeline.selectClip("music-track", "music-clip");
  let wrappedCalls = 0;
  global.AudioTimeline.deleteSelected = function () {
    wrappedCalls++;
  };
  const event = {
    key: "Delete",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
  };

  global.TuckShortcuts.dispatch(event, {
    modalOpen: false,
    settingsOpen: false,
    formControlFocused: false,
  });

  assert.equal(wrappedCalls, 1);
});
