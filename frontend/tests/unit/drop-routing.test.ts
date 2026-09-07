import assert from "node:assert/strict";
import test from "node:test";

import { isAudioPath, routeDroppedPaths } from "../../src/features/editor/drop-routing.ts";

test("audio extensions are recognized regardless of case", () => {
  assert.equal(isAudioPath("/music/Sushi Dip.mp3"), true);
  assert.equal(isAudioPath("C:/beats/track.FLAC"), true);
  assert.equal(isAudioPath("song.OpUs"), true);
});

test("non-audio and extensionless paths are not audio", () => {
  assert.equal(isAudioPath("/clips/holiday.mp4"), false);
  assert.equal(isAudioPath("/clips/holiday.mkv"), false);
  assert.equal(isAudioPath("/some.dir/README"), false);
  assert.equal(isAudioPath("mp3"), false);
});

test("a mixed drop is split so each importer gets its own kind", () => {
  const { videoPaths, audioPaths } = routeDroppedPaths([
    "/a/clip.mp4",
    "/a/Sushi Dip.mp3",
    "/a/take.mov",
    "/a/loop.wav",
  ]);
  assert.deepEqual(videoPaths, ["/a/clip.mp4", "/a/take.mov"]);
  assert.deepEqual(audioPaths, ["/a/Sushi Dip.mp3", "/a/loop.wav"]);
});

test("an all-audio drop routes nothing to the Library", () => {
  const { videoPaths, audioPaths } = routeDroppedPaths(["/x/one.mp3", "/x/two.aac"]);
  assert.deepEqual(videoPaths, []);
  assert.deepEqual(audioPaths, ["/x/one.mp3", "/x/two.aac"]);
});
