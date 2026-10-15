import assert from "node:assert/strict";
import test from "node:test";
import {
  frameLayout,
  FrameStripStore,
  type FrameRequest,
  type FrameSprite,
} from "../../src/features/timeline/frames.ts";

const geometry = {
  duration: 20,
  trackWidth: 1600,
  tileHeight: 45,
  visibleStart: 0,
  visibleEnd: 20,
};

test("frame tiles stay on the source grid when a segment is trimmed or split", () => {
  const full = frameLayout({ ...geometry, segments: [{ start: 0, end: 20 }] });
  const cut = frameLayout({
    ...geometry,
    segments: [
      { start: 2.25, end: 7 },
      { start: 10, end: 20 },
    ],
  });
  assert.equal(full.step, 1);
  assert.equal(full.tileWidth, 80);
  const first = cut.tiles[0]!;
  assert.deepEqual(first, { segment: 0, index: 2, left: -20 });
  assert.equal(cut.tiles.filter((tile) => tile.segment === 0).at(-1)?.index, 6);
  assert.equal(cut.tiles.find((tile) => tile.segment === 1)?.index, 10);
  assert.ok(!cut.tiles.some((tile) => tile.index >= 7 && tile.index < 10));
});

test("zoomed and long timelines request only visible segment chunks", () => {
  const view = frameLayout({
    duration: 1800,
    trackWidth: 16000,
    tileHeight: 45,
    visibleStart: 800,
    visibleEnd: 900,
    segments: [{ start: 0, end: 1800 }],
  });
  assert.ok(view.tiles.length < 20);
  assert.ok(view.chunks.length <= 2);
  assert.ok(
    view.tiles.every(
      (tile) =>
        (tile.index + 1) * view.step > 800 - view.step &&
        tile.index * view.step < 900 + view.step,
    ),
  );
  assert.equal(
    frameLayout({
      ...geometry,
      visibleStart: 7,
      visibleEnd: 9,
      segments: [
        { start: 0, end: 5 },
        { start: 11, end: 20 },
      ],
    }).tiles.length,
    0,
  );
});

test("invalid or zero geometry keeps the track plain", () => {
  for (const patch of [
    { duration: 0 },
    { trackWidth: 0 },
    { tileHeight: 0 },
    { duration: NaN },
  ]) {
    assert.equal(
      frameLayout({ ...geometry, ...patch, segments: [{ start: 0, end: 20 }] })
        .tiles.length,
      0,
    );
  }
});

function sprite(request: FrameRequest, token = "token"): FrameSprite {
  return {
    url: "http://127.0.0.1:9/" + token,
    token,
    start: request.start,
    step: request.step,
    count: request.count,
    tile_width: 150,
    tile_height: 84,
    columns: request.count,
  };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("late results from a previous video release their token and never paint", async () => {
  let resolve!: (value: FrameSprite) => void;
  const released: string[] = [];
  const store = new FrameStripStore({
    request: () =>
      new Promise((r) => {
        resolve = r;
      }),
    release: (token) => released.push(token),
    changed: () => {},
    load: async () => true,
  });
  store.update({
    path: "a",
    duration: 20,
    step: 1,
    mode: "center",
    chunks: [0],
    exact: false,
  });
  store.clear();
  resolve(
    sprite({
      path: "a",
      start: 0,
      step: 1,
      count: 16,
      mode: "center",
      exact: false,
    }),
  );
  await settle();
  assert.deepEqual(released, ["token"]);
  assert.equal(store.get(0), null);
});

test("keyframe pictures remain available until an exact refinement has loaded", async () => {
  let exactResolve!: (value: FrameSprite) => void;
  const requests: FrameRequest[] = [];
  const store = new FrameStripStore({
    request: async (request) => {
      requests.push(request);
      return request.exact
        ? new Promise((r) => {
            exactResolve = r;
          })
        : sprite(request, "key");
    },
    release: () => {},
    changed: () => {},
    load: async () => true,
  });
  store.update({
    path: "a",
    duration: 20,
    step: 1,
    mode: "center",
    chunks: [0],
    exact: true,
  });
  await settle();
  assert.equal(store.get(0)?.token, "key");
  assert.deepEqual(
    requests.map((r) => r.exact),
    [false, true],
  );
  exactResolve(sprite(requests[1]!, "exact"));
  await settle();
  assert.equal(store.get(0)?.token, "exact");
});

test("request concurrency stays bounded and unavailable pictures do not loop", async () => {
  const requests: FrameRequest[] = [];
  const store = new FrameStripStore({
    request: async (request) => {
      requests.push(request);
      throw new Error("unavailable");
    },
    release: () => {},
    changed: () => {},
    load: async () => true,
  });
  store.update({
    path: "a",
    duration: 600,
    step: 1,
    mode: "center",
    chunks: [0, 1, 2],
    exact: false,
  });
  await settle();
  store.update({
    path: "a",
    duration: 600,
    step: 1,
    mode: "center",
    chunks: [0, 1, 2],
    exact: false,
  });
  await settle();
  assert.equal(requests.length, 3);
  assert.equal(store.get(0), null);
});

test("source or crop changes release cached tokens and begin a new generation", async () => {
  const released: string[] = [];
  const store = new FrameStripStore({
    request: async (request) => sprite(request, request.mode),
    release: (token) => released.push(token),
    changed: () => {},
    load: async () => true,
  });
  store.update({
    path: "a",
    duration: 20,
    step: 1,
    mode: "center",
    chunks: [0],
    exact: false,
  });
  await settle();
  store.update({
    path: "a",
    duration: 20,
    step: 1,
    mode: "whole",
    chunks: [0],
    exact: false,
  });
  await settle();
  assert.deepEqual(released, ["center"]);
  assert.equal(store.get(0)?.token, "whole");
  store.clear();
  assert.deepEqual(released, ["center", "whole"]);
});
