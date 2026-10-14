import assert from "node:assert/strict";
import test from "node:test";
import {
  createFrameExporter,
  frameFileName,
  frameSavePath,
  type FrameSnapshot,
} from "../../src/features/player/frame-export.ts";
import type {
  BackendResult,
  FrameExportRequest,
  FrameExportResult,
  PathSelection,
} from "../../src/backend/types.ts";
import type { ToastAction } from "../../src/features/editor/toast.ts";

const success = <T>(value: T): BackendResult<T> => ({ ok: true, value });
const failure = {
  ok: false,
  error: { code: "FAILED", message: "The disk is full", details: {} },
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  let snapshot: FrameSnapshot | null = {
    source: "C:\\media\\Recording.mp4",
    name: "Recording.mp4",
    time: 3.25,
    transform: {
      crop: { x: 10, y: 20, width: 100, height: 80 },
      crop_aspect: "free",
      rotation: 90,
      flip_horizontal: true,
      flip_vertical: false,
      sizing_mode: "fit",
    },
    lut: { enabled: true, path: "C:\\film.cube", name: "Film", strength: 0.5 },
  };
  const picker = deferred<BackendResult<PathSelection>>();
  const render = deferred<BackendResult<FrameExportResult>>();
  const requests: FrameExportRequest[] = [];
  const picks: unknown[][] = [];
  const notifications: {
    message: string;
    kind: string;
    action: ToastAction | undefined;
  }[] = [];
  const folders: string[] = [];
  const exporter = createFrameExporter({
    capture: () => snapshot,
    ready: () => snapshot !== null,
    client: () => ({
      pickSaveFile: async (...args) => {
        picks.push(args);
        return picker.promise;
      },
      exportFrame: async (request) => {
        requests.push(request);
        return render.promise;
      },
      openOutputFolder: async path => {
        folders.push(path);
        return success({});
      },
    }),
    changed: () => { },
    notify: (message, kind = "", action) => notifications.push({ message, kind, action }),
  });
  return {
    exporter,
    picker,
    render,
    requests,
    picks,
    notifications,
    folders,
    change: (value: FrameSnapshot | null) => {
      snapshot = value;
    },
    get: () => snapshot!,
  };
}
test("frame filenames use a safe source name and millisecond source time", () => {
  assert.equal(frameFileName("Recording.mp4", 3.25), "Recording-frame-00-00-03-250.png");
  assert.equal(frameFileName("a:b?.mkv", 3601.9996), "a-b--frame-01-00-02-000.png");
});

test("Save As starts beside Windows, UNC and Linux sources", () => {
  const filename = "Recording-frame-00-00-03-250.png";
  assert.equal(frameSavePath("C:\\media\\Recording.mp4", "Recording.mp4", 3.25), `C:\\media\\${filename}`);
  assert.equal(frameSavePath("\\\\server\\share\\Recording.mp4", "Recording.mp4", 3.25), `\\\\server\\share\\${filename}`);
  assert.equal(frameSavePath("/home/aech/Recording.mp4", "Recording.mp4", 3.25), `/home/aech/${filename}`);
  assert.equal(frameSavePath("/Recording.mp4", "Recording.mp4", 3.25), `/${filename}`);
  assert.equal(frameSavePath("Recording.mp4", "Recording.mp4", 3.25), filename);
  assert.equal(frameSavePath("C:/映像/朝.mp4", "朝.mp4", 0), "C:/映像/朝-frame-00-00-00-000.png");
});
test("saving captures source time and edits before the native picker and reports success only after rendering", async () => {
  const s = setup();
  const pending = s.exporter.save();
  assert.equal(s.exporter.state().phase, "choosing");
  assert.deepEqual(s.picks, [["C:\\media\\Recording-frame-00-00-03-250.png", "png"]]);
  assert.equal(s.notifications.length, 0);
  s.get().transform!.crop!.width = 12;
  s.get().lut!.strength = 1;
  s.change({ source: "other.mp4", name: "Other.mp4", time: 9 });
  s.picker.resolve(success({ path: "C:\\out.png" }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(s.exporter.state().phase, "saving");
  assert.equal(s.notifications.length, 0);
  assert.deepEqual(s.requests[0], {
    source: "C:\\media\\Recording.mp4",
    output: "C:\\out.png",
    time: 3.25,
    transform: {
      crop: { x: 10, y: 20, width: 100, height: 80 },
      crop_aspect: "free",
      rotation: 90,
      flip_horizontal: true,
      flip_vertical: false,
      sizing_mode: "fit",
    },
    lut: { enabled: true, path: "C:\\film.cube", name: "Film", strength: 0.5 },
  });
  s.render.resolve(success({ path: "C:\\out.png", width: 80, height: 100, time: 3.25, warnings: [] }));
  await pending;
  assert.equal(s.exporter.state().phase, "success");
  assert.match(s.exporter.state().message, /Recording.mp4/);
  assert.equal(s.exporter.state().path, "C:\\out.png");
  assert.equal(s.notifications.length, 1);
  assert.equal(s.notifications[0]!.kind, "ok");
  assert.match(s.notifications[0]!.message, /C:\\out.png/);
  assert.equal(s.notifications[0]!.action?.label, "Show in folder");
  s.notifications[0]!.action!.run();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(s.folders, ["C:\\out.png"]);
});
test("double activation makes one picker and cancellation stays quiet", async () => {
  const s = setup();
  const pending = s.exporter.save();
  await s.exporter.save();
  assert.equal(s.picks.length, 1);
  s.picker.resolve(success({ path: "" }));
  await pending;
  assert.equal(s.requests.length, 0);
  assert.equal(s.exporter.state().phase, "idle");
  assert.equal(s.notifications.length, 0);
});
test("picker and rendering failures remain visible without a result action", async () => {
  for (const where of ["picker", "render"]) {
    const s = setup();
    const pending = s.exporter.save();
    s.picker.resolve(where === "picker" ? failure : success({ path: "out.png" }));
    s.render.resolve(failure);
    await pending;
    assert.equal(s.exporter.state().phase, "error");
    assert.match(s.exporter.state().message, /disk is full/);
    assert.equal(s.exporter.state().path, "");
    assert.equal(s.notifications[0]?.kind, "err");
  }
});

test("each success notification reveals its own saved path after another frame finishes", async () => {
  let output = "first.png";
  const folders: string[] = [];
  const actions: ToastAction[] = [];
  const exporter = createFrameExporter({
    ready: () => true,
    capture: () => ({ source: "source.mp4", name: "source.mp4", time: 1 }),
    changed: () => { },
    notify: (_message, _kind, action) => {
      if (action) actions.push(action);
    },
    client: () => ({
      pickSaveFile: async () => success({ path: output }),
      exportFrame: async () => success({ path: output, width: 10, height: 10, time: 1, warnings: [] }),
      openOutputFolder: async path => {
        folders.push(path);
        throw new Error("Folder unavailable");
      },
    }),
  });
  await exporter.save();
  output = "second.png";
  await exporter.save();
  actions[0]!.run();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(folders, ["first.png"]);
  assert.equal(exporter.state().path, "second.png");
  assert.equal(exporter.state().folderError, undefined);
});
test("no clip and invalid source clocks never open a picker", async () => {
  const s = setup();
  s.change(null);
  await s.exporter.save();
  assert.equal(s.picks.length, 0);
  for (const time of [NaN, Infinity, -1]) {
    s.change({ source: "a.mp4", name: "a.mp4", time });
    await s.exporter.save();
    assert.equal(s.exporter.state().phase, "error");
  }
  assert.equal(s.picks.length, 0);
});
test("folder errors belong to the saved file and survive state refreshes", async () => {
  const s = setup();
  const pending = s.exporter.save();
  s.picker.resolve(success({ path: "out.png" }));
  s.render.resolve(success({ path: "out.png", width: 1920, height: 1080, time: 3.25, warnings: [] }));
  await pending;
  s.exporter.folderFailed("other.png", "Old result");
  assert.equal(s.exporter.state().folderError, undefined);
  s.exporter.folderFailed("out.png", "Folder unavailable");
  assert.equal(s.exporter.state().folderError, "Folder unavailable");
  assert.equal(s.exporter.state().path, "out.png");
});
