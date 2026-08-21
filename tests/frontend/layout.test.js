const test = require("node:test");
const assert = require("node:assert/strict");

const layout = require("../../tuck/web/layout.js");

test("timeline height bounds preserve a usable preview at supported window sizes", () => {
  assert.deepEqual(layout.timelineHeightBounds(900), {
    min: 170,
    max: 495,
    defaultHeight: 205,
  });
  assert.deepEqual(layout.timelineHeightBounds(640), {
    min: 170,
    max: 310,
    defaultHeight: 205,
  });
});

test("automatic timeline height fits the default tracks and grows for imported audio", () => {
  assert.equal(layout.timelineAutoHeight(0, 900), 205);
  assert.equal(layout.timelineAutoHeight(2, 900), 205);
  assert.equal(layout.timelineAutoHeight(3, 900), 252);
  assert.equal(layout.timelineAutoHeight(5, 900), 346);
  assert.equal(layout.timelineAutoHeight(20, 900), 495);
  assert.equal(layout.timelineAutoHeight(4, 640), 299);
});

test("timeline heights clamp invalid and out-of-range persisted values", () => {
  assert.equal(layout.clampTimelineHeight(100, 900), 170);
  assert.equal(layout.clampTimelineHeight(700, 900), 495);
  assert.equal(layout.clampTimelineHeight(260, 900), 260);
  assert.equal(layout.clampTimelineHeight(0, 900), 205);
  assert.equal(layout.clampTimelineHeight(0, 900, 4), 299);
  assert.equal(layout.clampTimelineHeight("broken", 900), 205);
});

test("timeline separator keys resize predictably and expose range endpoints", () => {
  assert.equal(layout.timelineHeightForKey(260, "ArrowUp", false, 900), 270);
  assert.equal(layout.timelineHeightForKey(260, "ArrowDown", true, 900), 228);
  assert.equal(layout.timelineHeightForKey(260, "Home", false, 900), 170);
  assert.equal(layout.timelineHeightForKey(260, "End", false, 900), 495);
  assert.equal(layout.timelineHeightForKey(260, "Enter", false, 900), null);
});

test("workspace mode reserves docked panels only on wide windows", () => {
  assert.equal(layout.workspaceMode(1440), "docked");
  assert.equal(layout.workspaceMode(1180), "docked");
  assert.equal(layout.workspaceMode(1179), "overlay");
  assert.equal(layout.workspaceMode(390), "overlay");
});

test("workspace panels start open when docked and closed when overlaid", () => {
  assert.deepEqual(layout.initialWorkspacePanels(1440), {
    libraryOpen: true,
    inspectorOpen: true,
  });
  assert.deepEqual(layout.initialWorkspacePanels(960), {
    libraryOpen: false,
    inspectorOpen: false,
  });
});

test("docked panels toggle independently", () => {
  assert.deepEqual(
    layout.toggleWorkspacePanelState(
      { libraryOpen: true, inspectorOpen: true },
      "library",
      1440,
    ),
    { libraryOpen: false, inspectorOpen: true },
  );
});

test("overlay panels are mutually exclusive and toggle closed", () => {
  const library = layout.toggleWorkspacePanelState(
    { libraryOpen: false, inspectorOpen: false },
    "library",
    960,
  );
  assert.deepEqual(library, { libraryOpen: true, inspectorOpen: false });
  assert.deepEqual(layout.toggleWorkspacePanelState(library, "inspector", 960), {
    libraryOpen: false,
    inspectorOpen: true,
  });
  assert.deepEqual(
    layout.toggleWorkspacePanelState(
      { libraryOpen: false, inspectorOpen: true },
      "inspector",
      960,
    ),
    { libraryOpen: false, inspectorOpen: false },
  );
});
