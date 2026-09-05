import assert from "node:assert/strict";
import test from "node:test";

import { installAudioTimeline } from "../../src/features/audio/audio-timeline.ts";
import { createEditorSession } from "../../src/features/editor/session.ts";
import type { EditorClip } from "../../src/features/editor/types.ts";
import {
  commands,
  createRegistry,
  type ShortcutRegistry,
} from "../../src/features/shortcuts/shortcuts.ts";

function classList() {
  const values = new Set<string>();
  return {
    contains(name: string) {
      return values.has(name);
    },
    toggle(name: string, active?: boolean) {
      if (active) values.add(name);
      else values.delete(name);
    },
    add(name: string) {
      values.add(name);
    },
    remove(name: string) {
      values.delete(name);
    },
  };
}

function selectable(dataset: Record<string, string> = {}) {
  return {
    dataset,
    classList: classList(),
    attributes: {} as Record<string, string>,
    pressed: "false",
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
      if (name === "aria-pressed") this.pressed = value;
    },
  };
}

const videoRow = selectable();
const sourceRow = Object.assign(selectable(), {
  setAttribute() {},
});
const importedRow = selectable({ trackId: "music-track" });
const importedClip = selectable({ clipId: "music-clip" });
const activeVideoSegment = selectable();
activeVideoSegment.classList.toggle("active", true);
const fragmentMute = Object.assign(selectable(), {
  dataset: {} as Record<string, string>,
});
const sourceLane = {
  addEventListener() {},
  replaceChildren() {},
  appendChild(child: unknown) {
    return child;
  },
  append() {},
  getBoundingClientRect() {
    return { left: 0, width: 100, top: 0, height: 20, right: 100, bottom: 20 };
  },
};
const video = { addEventListener() {}, currentTime: 4, paused: true, volume: 1 };
const importedTracks = {
  querySelectorAll() {
    return [importedRow];
  },
  replaceChildren() {},
  appendChild() {},
};

const documentRef = {
  addEventListener() {},
  createElement(tag: string) {
    const el = selectable();
    return Object.assign(el, {
      tagName: tag.toUpperCase(),
      style: {
        setProperty() {},
        width: "",
        left: "",
        backgroundImage: "",
        backgroundSize: "",
        backgroundPosition: "",
      },
      append() {},
      appendChild(child: unknown) {
        return child;
      },
      replaceChildren() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      textContent: "",
      innerHTML: "",
      type: "button",
      title: "",
      tabIndex: 0,
      hidden: false,
      disabled: false,
      addEventListener() {},
      removeEventListener() {},
      setPointerCapture() {},
      releasePointerCapture() {},
      closest() {
        return null;
      },
    });
  },
  getElementById(id: string) {
    if (id === "video-track") return videoRow;
    if (id === "source-audio-track") return sourceRow;
    if (id === "audio-fragment-mute") return fragmentMute;
    if (id === "source-audio-lane") return sourceLane;
    if (id === "imported-audio-tracks") return importedTracks;
    if (id === "vid") return video;
    if (id === "audio-editor") {
      return {
        classList: classList(),
        replaceChildren() {},
      };
    }
    if (id === "audio-master-toggle") {
      return { classList: classList(), setAttribute() {} };
    }
    if (id === "vbar") return { value: "80" };
    if (id === "seq-playhead-layer") {
      return { style: { setProperty() {} } };
    }
    return null;
  },
  querySelectorAll(selector: string) {
    if (selector === ".seq-audio-clip.imported[data-clip-id]") return [importedClip];
    if (selector === "#tl-segments .tl-segment") return [activeVideoSegment];
    return [];
  },
  querySelector() {
    return null;
  },
};

const session = createEditorSession({
  selPath: "video.mp4",
  clips: {
    "video.mp4": {
      path: "video.mp4",
      name: "video.mp4",
      probed: true,
      probing: false,
      probeData: { duration: 12, has_audio: true },
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
      audioTimeline: {
        enabled: true,
        sourceMuted: false,
        sourceGainDb: 0,
        sourceWaveformUrl: "",
        sourceWaveformToken: "",
        sourceWaveformLoading: false,
        tracks: [
          {
            id: "music-track",
            sourceDuration: 20,
            name: "music",
            path: "music.wav",
            clips: [
              {
                id: "music-clip",
                timelineStart: 2,
                timelineDuration: 8,
                sourceIn: 1,
                sourceOut: 9,
                fadeIn: 0,
                fadeOut: 0,
                loop: false,
                muted: false,
              },
            ],
          },
        ],
      },
    } as EditorClip,
  },
});

const inspectorTabs: string[] = [];
const shortcuts: ShortcutRegistry = createRegistry(commands);

const setClipSegmentsCalls: Array<{
  clip: EditorClip;
  segments: unknown[];
  active?: number;
}> = [];
let canTrim = false;
const trimEndpoints: string[] = [];
let canRemove = false;
let removeCalls = 0;

const windowRef = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  requestAnimationFrame: (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
  innerHeight: 800,
  appSettings: {},
};

const AudioTimeline = installAudioTimeline({
  session,
  byId: (id) => documentRef.getElementById(id) as HTMLElement | null,
  documentRef: documentRef as unknown as Document,
  windowRef: windowRef as unknown as Window & typeof globalThis,
  toast() {},
  confirmToast(_msg, cb) {
    cb();
  },
  setInspectorTab(tab) {
    inspectorTabs.push(tab);
  },
  renderClips() {},
  reqPreview() {},
  setClipSegments(clip, segments, active) {
    if (active === undefined) setClipSegmentsCalls.push({ clip, segments });
    else setClipSegmentsCalls.push({ clip, segments, active });
    clip.segments = segments as EditorClip["segments"];
    if (active != null) clip.activeSegment = active;
  },
  paintTrimChrome() {},
  syncTimelineTrackCount() {},
  renderAudioMixerList() {},
  renderAudioLibraryPanel() {},
  segmentColor: () => "#6D28D9",
  canTrimActiveSegmentToPlayhead: () => canTrim,
  trimActiveSegmentToPlayhead(endpoint) {
    trimEndpoints.push(endpoint);
    return 0;
  },
  canRemoveActiveSegment: () => canRemove,
  removeActiveSegment() {
    removeCalls += 1;
  },
  TuckShortcuts: shortcuts,
});

// provide SegmentEditing for source-mute path through module import already used inside install

test("selecting imported audio reveals the Audio inspector", () => {
  inspectorTabs.length = 0;
  AudioTimeline.selectClip("music-track", "music-clip");
  assert.deepEqual(inspectorTabs, ["audio"]);
});

test("selecting video or source audio does not change inspector tabs", () => {
  inspectorTabs.length = 0;
  AudioTimeline.selectVideoTrack();
  assert.deepEqual(inspectorTabs, []);
});

test("clicking video replaces the imported audio command target and selected styling", () => {
  AudioTimeline.selectClip("music-track", "music-clip");
  assert.equal(AudioTimeline.hasSelection(), true);
  assert.equal(importedRow.classList.contains("selected"), true);
  assert.equal(importedClip.classList.contains("selected"), true);

  AudioTimeline.selectVideoTrack();

  assert.equal(AudioTimeline.hasSelection(), false);
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
  AudioTimeline.selectVideoTrack();
  assert.equal(activeVideoSegment.classList.contains("active"), true);
  assert.equal(videoRow.classList.contains("selected"), true);
  assert.equal(sourceRow.classList.contains("selected"), true);
  assert.equal(activeVideoSegment.pressed, "true");

  AudioTimeline.selectClip("music-track", "music-clip");

  assert.equal(activeVideoSegment.classList.contains("active"), true);
  assert.equal(videoRow.classList.contains("selected"), false);
  assert.equal(sourceRow.classList.contains("selected"), false);
  assert.equal(activeVideoSegment.pressed, "false");
});

test("selected imported audio fragments use the segment mute command independently", () => {
  const track = session.clips["video.mp4"]!.audioTimeline!.tracks[0]!;
  const audioClip = track.clips[0]!;
  audioClip.muted = false;
  track.muted = false;

  AudioTimeline.selectClip(track.id, audioClip.id!);

  assert.equal(fragmentMute.classList.contains("hid"), false);
  assert.equal(fragmentMute.attributes["aria-label"], "Mute selected audio fragment");

  AudioTimeline.toggleFragmentMute();
  AudioTimeline.paintMixer();

  assert.equal(audioClip.muted, true);
  assert.equal(track.muted, false);
  assert.equal(fragmentMute.classList.contains("on"), true);
  assert.equal(fragmentMute.attributes["aria-label"], "Unmute selected audio fragment");

  AudioTimeline.selectTrack(track.id);
  assert.equal(fragmentMute.classList.contains("hid"), true);
});

test("M toggles the selected imported audio fragment", () => {
  const audioClip = session.clips["video.mp4"]!.audioTimeline!.tracks[0]!.clips[0]!;
  audioClip.muted = false;
  AudioTimeline.selectClip("music-track", "music-clip");

  shortcuts.dispatch(
    {
      key: "m",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    },
    {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
      textEntryFocused: false,
    },
  );

  assert.equal(audioClip.muted, true);
});

test("M toggles source audio for the active video segment", () => {
  const clip = session.clips["video.mp4"]!;
  clip.segments = [{ start: 0, end: 12, muted: false }];
  setClipSegmentsCalls.length = 0;
  AudioTimeline.selectVideoTrack();

  shortcuts.dispatch(
    {
      key: "m",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    },
    {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
      textEntryFocused: false,
    },
  );

  assert.equal(clip.segments[0]?.muted, true);
});

test("I sets the selected imported audio fragment start to the playhead", () => {
  const audioClip = session.clips["video.mp4"]!.audioTimeline!.tracks[0]!.clips[0]!;
  Object.assign(audioClip, {
    timelineStart: 2,
    timelineDuration: 8,
    sourceIn: 1,
    sourceOut: 9,
  });
  video.currentTime = 5;
  AudioTimeline.selectClip("music-track", "music-clip");

  shortcuts.dispatch(
    {
      key: "i",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    },
    {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
      textEntryFocused: false,
    },
  );

  assert.deepEqual(
    {
      timelineStart: audioClip.timelineStart,
      timelineDuration: audioClip.timelineDuration,
      sourceIn: audioClip.sourceIn,
      sourceOut: audioClip.sourceOut,
    },
    { timelineStart: 5, timelineDuration: 5, sourceIn: 4, sourceOut: 9 },
  );
});

test("O sets the selected imported audio fragment end to the playhead", () => {
  const audioClip = session.clips["video.mp4"]!.audioTimeline!.tracks[0]!.clips[0]!;
  Object.assign(audioClip, {
    timelineStart: 2,
    timelineDuration: 8,
    sourceIn: 1,
    sourceOut: 9,
  });
  video.currentTime = 7;
  AudioTimeline.selectClip("music-track", "music-clip");

  shortcuts.dispatch(
    {
      key: "o",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    },
    {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
      textEntryFocused: false,
    },
  );

  assert.deepEqual(
    {
      timelineStart: audioClip.timelineStart,
      timelineDuration: audioClip.timelineDuration,
      sourceIn: audioClip.sourceIn,
      sourceOut: audioClip.sourceOut,
    },
    { timelineStart: 2, timelineDuration: 5, sourceIn: 1, sourceOut: 6 },
  );
});

test("I and O route to the active video segment when imported audio is not selected", () => {
  trimEndpoints.length = 0;
  canTrim = true;
  AudioTimeline.selectVideoTrack();

  for (const key of ["i", "o"]) {
    shortcuts.dispatch(
      {
        key,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault() {},
      },
      {
        modalOpen: false,
        settingsOpen: false,
        formControlFocused: false,
        textEntryFocused: false,
      },
    );
  }

  assert.deepEqual(trimEndpoints, ["start", "end"]);
});

test("keyboard delete uses the current history-wrapped audio action", () => {
  AudioTimeline.selectClip("music-track", "music-clip");
  let wrappedCalls = 0;
  AudioTimeline.deleteSelected = function () {
    wrappedCalls += 1;
  };
  shortcuts.dispatch(
    {
      key: "Delete",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    },
    {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
    },
  );
  assert.equal(wrappedCalls, 1);
});

test("keyboard delete removes the active video segment when audio is not selected", () => {
  AudioTimeline.selectVideoTrack();
  removeCalls = 0;
  canRemove = true;
  shortcuts.dispatch(
    {
      key: "Delete",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    },
    {
      modalOpen: false,
      settingsOpen: false,
      formControlFocused: false,
      textEntryFocused: false,
    },
  );
  assert.equal(removeCalls, 1);
});
