import assert from "node:assert/strict";
import test from "node:test";

import {
  copyEdits,
  cropForSize,
  pasteEdits,
  segmentsForLength,
} from "../../src/features/editor/edit-transfer.ts";
import { createEditorClip, type EditorClip } from "../../src/features/editor/types.ts";
import { pasteSummary } from "../../src/features/library/row-menu.ts";

function readClip(path: string, duration: number, width = 1920, height = 1080, audioTracks = 1): EditorClip {
  const clip = createEditorClip(path);
  clip.probed = true;
  clip.probeData = { duration, width, height, has_audio: true, audio_stream_count: audioTracks };
  return clip;
}

test("copied edits are the video's segments, crop, turn, flips, sizing and audio levels", () => {
  const source = readClip("C:\\a.mp4", 60, 1920, 1080, 2);
  source.segments = [{ start: 5, end: 20 }, { start: 30, end: 40, muted: true }];
  source.cropAspect = "free";
  source.crop = { x: 100, y: 50, width: 800, height: 600 };
  source.rotation = 90;
  source.flipHorizontal = true;
  source.sizingMode = "fill";
  source.audioTimeline = {
    enabled: true, sourceMuted: true, sourceGainDb: -6, sourceWaveformUrl: "w", sourceWaveformToken: "t",
    sourceWaveformLoading: false, tracks: [],
    sourceExtraTracks: [{ muted: true, gainDb: 3, waveformUrl: "", waveformToken: "", waveformLoading: false }],
  };
  const edits = copyEdits(source);
  assert.ok(edits);
  assert.deepEqual(edits.segments, [{ start: 5, end: 20 }, { start: 30, end: 40, muted: true }]);
  assert.deepEqual(edits.audio, { enabled: true, sourceMuted: true, sourceGainDb: -6, extraTracks: [{ muted: true, gainDb: 3 }] });
  // the copy is its own: later edits to the source don't change it
  assert.notEqual(edits.crop, source.crop);
  source.segments[0] = { start: 0, end: 1 };
  assert.deepEqual(edits.segments?.[0], { start: 5, end: 20 });

  const target = readClip("C:\\b.mp4", 60, 1920, 1080, 3);
  target.audioTimeline = {
    enabled: false, sourceMuted: false, sourceGainDb: 0, sourceWaveformUrl: "mine", sourceWaveformToken: "mine",
    sourceWaveformLoading: false, tracks: [{ id: "music", sourceDuration: 10, clips: [] }],
  };
  assert.deepEqual(pasteEdits(edits, target), { shortened: false, segmentsSkipped: false });
  assert.deepEqual(target.segments, [{ start: 5, end: 20 }, { start: 30, end: 40, muted: true }]);
  assert.deepEqual(target.crop, { x: 100, y: 50, width: 800, height: 600 });
  assert.equal(target.rotation, 90);
  assert.equal(target.flipHorizontal, true);
  assert.equal(target.sizingMode, "fill");
  assert.equal(target.transformOverride, true);
  // levels and mutes come across; the target's own waveform and added tracks stay
  assert.equal(target.audioTimeline?.enabled, true);
  assert.equal(target.audioTimeline?.sourceGainDb, -6);
  assert.equal(target.audioTimeline?.sourceWaveformUrl, "mine");
  assert.equal(target.audioTimeline?.tracks.length, 1);
  assert.deepEqual(target.audioTimeline?.sourceExtraTracks?.map((track) => [track.muted, track.gainDb]), [[true, 3], [false, 0]]);
});

test("a video that hasn't been read can't be copied from or pasted to", () => {
  const loading = createEditorClip("C:\\c.mp4");
  assert.equal(copyEdits(loading), null);
  const edits = copyEdits(readClip("C:\\a.mp4", 10));
  assert.ok(edits);
  assert.equal(pasteEdits(edits, loading), null);
  assert.equal(loading.transformOverride, false);
});

test("segments keep their source times and stop at a shorter video's end", () => {
  const segments = [{ start: 2, end: 6 }, { start: 8, end: 14 }, { start: 20, end: 25 }];
  assert.deepEqual(segmentsForLength(segments, 30), { segments, shortened: false });
  assert.deepEqual(segmentsForLength(segments, 10), {
    segments: [{ start: 2, end: 6 }, { start: 8, end: 10 }],
    shortened: true,
  });
  // a segment placed elsewhere on the timeline is cut by where its footage runs out
  assert.deepEqual(segmentsForLength([{ start: 0, end: 5, sourceStart: 6 }], 8), {
    segments: [{ start: 0, end: 2, sourceStart: 6 }],
    shortened: true,
  });
  // nothing reaches into a 1 second video, and a sliver shorter than a segment can be is dropped
  assert.equal(segmentsForLength(segments, 1), null);
  assert.equal(segmentsForLength([{ start: 2, end: 6 }], 2.02), null);
});

test("pasting onto a shorter video cuts its segments and says so", () => {
  const source = readClip("C:\\long.mp4", 60);
  source.segments = [{ start: 10, end: 50 }];
  const edits = copyEdits(source);
  assert.ok(edits);
  const short = readClip("C:\\short.mp4", 30);
  assert.deepEqual(pasteEdits(edits, short), { shortened: true, segmentsSkipped: false });
  assert.deepEqual(short.segments, [{ start: 10, end: 30 }]);
  const tiny = readClip("C:\\tiny.mp4", 8);
  tiny.segments = [{ start: 1, end: 3 }];
  assert.deepEqual(pasteEdits(edits, tiny), { shortened: false, segmentsSkipped: true });
  assert.deepEqual(tiny.segments, [{ start: 1, end: 3 }]);
  // a whole video pastes as a whole video
  const whole = copyEdits(readClip("C:\\whole.mp4", 60));
  assert.ok(whole);
  assert.equal(whole.segments, null);
  pasteEdits(whole, short);
  assert.equal(short.segments, null);
});

test("a crop keeps its share of the picture on a video of another size", () => {
  const crop = { x: 480, y: 270, width: 960, height: 540 };
  assert.deepEqual(cropForSize(crop, "free", { width: 1920, height: 1080 }, { width: 1280, height: 720 }, 0), {
    x: 320, y: 180, width: 640, height: 360,
  });
  assert.deepEqual(cropForSize(crop, "16:9", { width: 1920, height: 1080 }, { width: 1280, height: 720 }, 0), {
    x: 320, y: 180, width: 640, height: 360,
  });
  // sizes stay even, and a crop turned off stays off
  assert.deepEqual(cropForSize({ x: 1, y: 1, width: 100, height: 100 }, "free", { width: 200, height: 200 }, { width: 333, height: 333 }, 0), {
    x: 2, y: 2, width: 166, height: 166,
  });
  assert.equal(cropForSize(crop, "off", { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, 0), null);
  assert.equal(cropForSize({ x: 0, y: 0, width: 1920, height: 1080 }, "free", { width: 1920, height: 1080 }, { width: 1280, height: 720 }, 0), null);
});

test("the paste message names shorter and loading videos plainly", () => {
  const done = { shortened: false, segmentsSkipped: false };
  assert.deepEqual(pasteSummary([{ name: "a.mp4", result: done }]), { message: "Pasted edits to a.mp4.", kind: "ok" });
  assert.deepEqual(
    pasteSummary([
      { name: "a.mp4", result: done },
      { name: "b.mp4", result: { shortened: true, segmentsSkipped: false } },
      { name: "c.mp4", result: null },
    ]),
    {
      message: "Pasted edits to 2 videos. b.mp4 is shorter, so segments past its end were cut there. c.mp4 is still loading, so it was skipped.",
      kind: "info",
    },
  );
  assert.deepEqual(
    pasteSummary([{ name: "t.mp4", result: { shortened: false, segmentsSkipped: true } }]),
    {
      message: "Pasted edits to t.mp4. t.mp4 is too short for any of the copied segments, so it keeps its own.",
      kind: "info",
    },
  );
  assert.equal(pasteSummary([{ name: "c.mp4", result: null }]).kind, "err");
});
