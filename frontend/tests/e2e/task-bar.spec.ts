import { expect, test, type Page } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

const MORNING = "C:\\videos\\Morning ride.mp4";
const KITCHEN = "C:\\videos\\Kitchen.mov";
const TRAIL = "C:\\videos\\Trail run.mp4";

function probe(size: number) {
  return { ok: true, data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, file_size: size } };
}

async function open(page: Page, options: { queue?: unknown[]; width?: number; holdPlans?: boolean; lastPanel?: string; hidden?: string[]; lastTask?: string } = {}) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = [MORNING, KITCHEN, TRAIL];
  fixture.responses.probeFile = probe(15_000_000);
  fixture.responses.createPlan = { ok: true, data: { video_bitrate_kbps: 1200, segment_count: 1, selected_duration: 12 } };
  if (options.queue) fixture.responses.getQueueState = { items: options.queue };
  if (options.lastTask) fixture.responses.getSettings = { ...fixture.responses.getSettings as object, last_task: options.lastTask };
  if (options.hidden) fixture.responses.getSettings = { ...fixture.responses.getSettings as object, hidden_ui: options.hidden };
  if (options.lastPanel) fixture.responses.getSettings = { ...fixture.responses.getSettings as object, last_inspector_panel: options.lastPanel, inspector_start_panel: "last" };
  // Lossless cut reads keyframes; the real client only passes a complete analysis on
  const time = (seconds: number) => ({ ticks: String(seconds * 10), time_base_num: 1, time_base_den: 10 });
  const analysis = { work_id: "scan", status: "ready", progress: 1, coverage_end: time(12), keyframes: [time(0), time(4), time(8)], issue: null,
    analysis: { duration: time(12), frame_duration: { ticks: "1", time_base_num: 1, time_base_den: 30 }, exact_available: false, exact_reason: "", issues: [], version: "1", streams: [] } };
  fixture.responses.getCutAnalysis = analysis;
  fixture.responses.analyzeCut = analysis;
  // the fake answers every plan with the Compress shape; tests that only switch tasks keep plans pending
  if (options.holdPlans) fixture.holdMethods = ["createPlan"];
  await page.setViewportSize({ width: options.width ?? 1440, height: options.width === 960 ? 640 : 900 });
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await expect(page.locator(".clip")).toHaveCount(3);
}

const calls = (page: Page, method: string) =>
  page.evaluate((name) => (window.__tuckFakeBackendCalls ?? []).filter((call) => call.method === name).map((call) => call.args), method);

test("the task tabs sit in the middle of the bottom bar and switch by click or number key", async ({ page }) => {
  await open(page, { holdPlans: true });
  const compress = page.locator("#wf-c");
  await expect(compress).toHaveAttribute("aria-pressed", "true");
  await expect(compress).toHaveAttribute("aria-keyshortcuts", "1");
  await expect(compress).toHaveAttribute("data-tip", "Compress (1)");
  const centre = await page.locator("#task-wf").evaluate((tabs) => {
    const box = tabs.getBoundingClientRect();
    return box.left + box.width / 2 - window.innerWidth / 2;
  });
  expect(Math.abs(centre)).toBeLessThanOrEqual(1);

  await page.locator("#wf-u").click();
  await expect(page.locator("#wf-u")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#btn-one")).toHaveText(/Upscale/);

  await page.locator("#clips .clip").first().focus();
  await page.keyboard.press("3");
  await expect(page.locator("body")).toHaveClass(/task-cut/);
  await page.keyboard.press("1");
  await expect(page.locator("body")).not.toHaveClass(/task-cut/);
  await expect(compress).toHaveAttribute("aria-pressed", "true");

  // typing a number into a field never switches the task
  await page.locator("#sz-badge").focus();
  await page.keyboard.press("2");
  await expect(compress).toHaveAttribute("aria-pressed", "true");
});

// the thumb is a pseudo-element, so its box comes from its computed size and offset
const thumbOver = (page: Page, id: string) => page.evaluate((tabId) => {
  const group = document.getElementById("task-wf")!, tab = document.getElementById(tabId)!.getBoundingClientRect();
  const thumb = getComputedStyle(group, "::before");
  const left = group.getBoundingClientRect().left + parseFloat(thumb.left) + new DOMMatrix(thumb.transform).m41;
  return Math.max(Math.abs(left - tab.left), Math.abs(parseFloat(thumb.width) - tab.width));
}, id);

test("the thumb sits under the chosen task, also when a task is hidden", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, { holdPlans: true });
  for (const id of ["wf-c", "wf-u", "wf-l"]) {
    await page.locator(`#${id}`).click();
    await expect.poll(() => thumbOver(page, id)).toBeLessThanOrEqual(1);
  }

  await open(page, { holdPlans: true, hidden: ["upscale"] });
  await expect(page.locator("#wf-u")).toBeHidden();
  for (const id of ["wf-l", "wf-c"]) {
    await page.locator(`#${id}`).click();
    await expect.poll(() => thumbOver(page, id)).toBeLessThanOrEqual(1);
  }
});

test("choosing a task never changes the task switch's size or place", async ({ page }) => {
  await open(page, { holdPlans: true });
  // plain labels at a regular weight make the chosen one's heavier label much wider in any font
  await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans"; } .task-tab { font-weight: 400; }' });
  const box = () => page.locator("#task-wf").evaluate((tabs) => {
    const { left, width } = tabs.getBoundingClientRect();
    return [Math.round(left * 2) / 2, Math.round(width * 2) / 2];
  });
  const first = await box();
  for (const id of ["wf-l", "wf-u", "wf-c", "wf-l"]) {
    await page.locator(`#${id}`).click();
    await expect(page.locator(`#${id}`)).toHaveAttribute("aria-pressed", "true");
    expect(await box()).toEqual(first);
  }
});

test("the thumb starts on the saved task and only slides when the task changes", async ({ page }) => {
  const slides = () => page.evaluate(() => document.getAnimations().filter((animation) =>
    animation instanceof CSSTransition && animation.transitionProperty === "transform" && (animation.effect as KeyframeEffect).pseudoElement === "::before").length);
  await open(page, { holdPlans: true, lastTask: "upscale" });
  await expect(page.locator("#wf-u")).toHaveAttribute("aria-pressed", "true");
  expect(await slides()).toBe(0);
  await page.locator("#wf-l").click();
  expect(await slides()).toBe(1);
});

test("the bottom bar shows the Library total and nothing on the right while nothing exports", async ({ page }) => {
  await open(page);
  await expect(page.locator("#library-summary")).toHaveText("3 videos · 42.9 MB");
  await expect(page.locator("#qbar")).toBeHidden();
});

test("the export status opens every export this session with its own action", async ({ page }) => {
  await open(page, { queue: [
    { id: "run", source: "Morning ride.mp4", source_path: MORNING, state: "running", progress: 42, progress_info: { eta_seconds: 83 } },
    { id: "wait", source: "Kitchen.mov", source_path: KITCHEN, state: "pending", progress: 0 },
    { id: "bad", source: "Trail run.mp4", source_path: TRAIL, state: "failed", error: "NVENC is not available on this GPU" },
    { id: "old", source: "Earlier.mp4", source_path: "C:\\videos\\Earlier.mp4", state: "completed", result_path: "C:\\videos\\Earlier_compressed.mp4", result_size: 9_700_000 },
  ] });
  const status = page.locator("#qstatus");
  await expect(page.locator("#qfname")).toHaveText("Morning ride.mp4");
  await expect(page.locator("#qpct")).toHaveText("42%");
  await expect(page.locator("#qleft")).toHaveText("1:23 left");
  // a failure shows while the rest of the batch runs, not only once it ends
  await expect(page.locator("#qeta")).toHaveText("1 waiting · 1 failed");
  await expect(page.locator("#qprog")).toHaveAttribute("value", "42");
  await expect(status).toHaveAttribute("aria-label", "Exporting Morning ride.mp4, 42%, 1:23 left, 1 waiting · 1 failed. Show Exports");

  await status.click();
  const panel = page.getByRole("dialog", { name: "Exports" });
  await expect(panel).toBeVisible();
  await expect(status).toHaveAttribute("aria-expanded", "true");
  await expect(panel.locator(".exports-group")).toHaveText(["Waiting", "Finished"]);
  await expect(panel.locator(".exports-row.failed .exports-detail")).toHaveText("Failed: NVENC is not available on this GPU");
  await expect(panel.locator(".exports-row.completed .exports-detail")).toHaveText("Done");

  await panel.getByRole("button", { name: "Retry Trail run.mp4" }).click();
  await expect.poll(() => calls(page, "retryItem")).toEqual([["bad"]]);
  await panel.getByRole("button", { name: "Show Earlier.mp4" }).click();
  await expect.poll(() => calls(page, "openOutputFolder")).toEqual([["C:\\videos\\Earlier_compressed.mp4"]]);
  await panel.getByRole("button", { name: "Cancel Kitchen.mov" }).click();
  await expect.poll(() => calls(page, "cancelItem")).toEqual([["wait"]]);

  // Escape closes the panel and returns to the status
  await panel.getByRole("button", { name: "Cancel Kitchen.mov" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(status).toBeFocused();
  await expect(status).toHaveAttribute("aria-expanded", "false");

  // clicking elsewhere closes it too
  await status.click();
  await expect(panel).toBeVisible();
  await page.locator("#stage").click({ position: { x: 20, y: 20 } });
  await expect(panel).toBeHidden();
});

test("a finished queue with a failure leads with it and its Retry, and the panel keeps the saving", async ({ page }) => {
  await open(page, { queue: [
    { id: "a", source: "Morning ride.mp4", source_path: MORNING, state: "completed", result_path: "C:\\videos\\a.mp4", result_size: 5_000_000 },
    { id: "b", source: "Trail run.mp4", source_path: TRAIL, state: "failed", error: "Out of disk space" },
  ] });
  await expect(page.locator("#qbar")).toHaveClass(/finished/);
  await expect(page.locator("#qfname")).toHaveText("1 of 2 failed");
  await expect(page.locator("#qeta")).toHaveText("Out of disk space");
  await expect(page.locator("#qstatus")).toHaveAttribute("aria-label", "1 of 2 failed. Trail run.mp4: Out of disk space. Show Exports");
  await page.locator("#qactions").getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => calls(page, "retryAllItems")).toHaveLength(1);
  await page.locator("#qstatus").click();
  await expect(page.locator(".exports-row.completed .exports-detail")).toHaveText("14.3 MB → 4.8 MB · saved 67%");
  await expect(page.locator("#exports-saved")).toHaveText("Saved 9.5 MB so far");
});

const exported = (count: number) => Array.from({ length: count }, (_, index) => (
  { id: `done-${index}`, source: "Morning ride.mp4", source_path: MORNING, state: "completed", result_path: `C:\\videos\\${index}.mp4`, result_size: 5_000_000 }));
// brought back after Tuck closed mid-batch, waiting for Resume
const paused = (count: number) => Array.from({ length: count }, (_, index) => (
  { id: `paused-${index}`, source: "Morning ride.mp4", source_path: MORNING, state: "paused" }));

async function measureBar(page: Page) {
  return page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const name = document.getElementById("qfname")!;
    return {
      cut: name.scrollWidth > name.clientWidth,
      centre: box("task-wf").left + box("task-wf").width / 2 - window.innerWidth / 2,
      statusEnd: box("qbar").right,
      tabs: box("task-wf").left,
      tabsEnd: box("task-wf").right,
      exportStart: box("export-go").left,
      exportWidth: box("btn-one").width,
    };
  });
}

for (const [kind, queue, count] of [["finished", exported(12), "12 videos exported"], ["paused", paused(12), "12 exports paused"]] as const) for (const width of [960, 1180]) {
  test(`at ${width} wide a ${kind} batch says "${count}" in full, beside a centred task switch`, async ({ page }) => {
    await open(page, { width, queue });
    // Arial and Liberation Sans have the same widths and are on every test machine; the Linux
    // runners would otherwise fall back to DejaVu Sans, which is wider than the bar is made for
    await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans", sans-serif; }' });
    await expect(page.locator("#qbar")).toHaveClass(new RegExp(kind));
    await expect(page.locator("#qfname")).toHaveText(count);
    await expect(page.locator("#btn-one")).toHaveText("Compress this video");
    const bar = await measureBar(page);
    expect(bar.cut).toBe(false);
    expect(Math.abs(bar.centre)).toBeLessThanOrEqual(1);
    expect(bar.statusEnd).toBeLessThanOrEqual(bar.tabs);
    expect(bar.tabsEnd).toBeLessThanOrEqual(bar.exportStart);
  });
}

test("a status too wide for its half moves the task switch aside instead of cutting the count", async ({ page }) => {
  await open(page, { width: 960, queue: exported(12) });
  const before = await measureBar(page);
  await page.addStyleTag({ content: "#qfname { letter-spacing: 6px; }" });
  await expect(page.locator("#qfname")).toHaveText("12 videos exported");
  const bar = await measureBar(page);
  expect(bar.cut).toBe(false);
  expect(bar.centre).toBeGreaterThan(1);
  expect(bar.statusEnd).toBeLessThanOrEqual(bar.tabs);
  expect(bar.tabsEnd).toBeLessThanOrEqual(bar.exportStart);
  // the export button keeps its size whatever the left side needs
  expect(bar.exportWidth).toBe(before.exportWidth);
});

test("a running export keeps the task switch and its own size while its numbers change", async ({ page }) => {
  const running = (progress: number, fps: number, eta: number) => [
    { id: "run", source: "Morning ride.mp4", source_path: MORNING, state: "running", progress, two_pass: true, status_text: "Pass 2 of 2",
      progress_info: { stage: progress < 50 ? "pass_1" : "pass_2", fps, eta_seconds: eta } },
    { id: "wait", source: "Kitchen.mov", source_path: KITCHEN, state: "pending", progress: 0 },
  ];
  for (const width of [960, 1440]) {
    await open(page, { width, queue: running(8, 9.4, 3_725) });
    await page.addStyleTag({ content: ':root { --font: Arial, "Liberation Sans", sans-serif; }' });
    // later polls answer whatever the test sets, the way the backend reports its own progress
    await page.evaluate(() => {
      const client = window.tuckBackendClient!;
      const answer = client.getQueueState.bind(client);
      const live = window as unknown as { __queue?: unknown[] };
      client.getQueueState = (async () => live.__queue ? { ok: true, value: { items: live.__queue } } : answer()) as typeof client.getQueueState;
    });
    await expect(page.locator("#qfps")).toHaveText("9.4 fps");
    await expect(page.locator("#qleft")).toHaveText("1:02:05 left");
    // the first pass fills the first half of the track
    await expect(page.locator("#qtrack .qseg")).toHaveCount(2);
    // the bar slides in when it appears, so measure it once it has settled
    await page.locator("#qbar").evaluate(async (bar) => { await Promise.all(bar.getAnimations().map((animation) => animation.finished)); });
    const first = await measureBar(page);
    const size = await page.locator("#qstatus").boundingBox();
    expect(Math.abs(first.centre)).toBeLessThanOrEqual(1);

    await page.evaluate((items) => { (window as unknown as { __queue?: unknown[] }).__queue = items; }, running(78, 146.4, 11));
    await expect(page.locator("#qfps")).toHaveText("146 fps");
    await expect(page.locator("#qleft")).toHaveText("0:11 left");
    await expect(page.locator("#qpct")).toHaveText("78%");
    expect(await page.locator("#qtrack .qfill").evaluateAll((fills) => fills.map((fill) => (fill as HTMLElement).style.width))).toEqual(["100%", "56%"]);
    expect(await page.locator("#qstatus").boundingBox()).toEqual(size);
    expect((await measureBar(page)).tabs).toBe(first.tabs);
  }
});

test("at 960 wide the drawers stop above the bottom bar, which stays usable", async ({ page }) => {
  await open(page, { width: 960 });
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  const geometry = await page.evaluate(() => ({
    drawer: document.getElementById("right")!.getBoundingClientRect().bottom,
    bar: document.getElementById("task-bar")!.getBoundingClientRect().top,
  }));
  expect(geometry.drawer).toBeLessThanOrEqual(geometry.bar + 1);
  await page.locator("#wf-u").click();
  await expect(page.locator("#wf-u")).toHaveAttribute("aria-pressed", "true");
});

test("the export button says it acts on the selected video", async ({ page }) => {
  await open(page, { holdPlans: true });
  await expect(page.locator("#btn-one")).toHaveText("Compress this video");
  await page.locator("#wf-u").click();
  await expect(page.locator("#btn-one")).toHaveText("Upscale this video");
});

test("This video holds the transform and audio together, and export stays in reach", async ({ page }) => {
  await open(page, { holdPlans: true });
  await expect(page.locator("#insp-tab-edit")).toHaveText("This video");
  await page.locator("#insp-tab-edit").click();
  await expect(page.locator("#insp-edit")).toBeVisible();
  await expect(page.locator("#insp-audio")).toBeVisible();
  // the export button lives in the bottom bar, so editing a video never hides it
  await expect(page.locator("#export-go")).toBeVisible();
  await page.locator("#insp-tab-export").click();
  await expect(page.locator("#insp-audio")).toBeHidden();
  await expect(page.locator("#export-go")).toBeVisible();
});

test("an Inspector last left on the old Audio panel opens This video", async ({ page }) => {
  await open(page, { holdPlans: true, lastPanel: "audio" });
  await expect(page.locator("#insp-tab-edit")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#insp-audio")).toBeVisible();
});
test("the top bar is icons with names, and the selected video's name sits over the player", async ({ page }) => {
  await open(page, { holdPlans: true });
  for (const name of ["Window menu", "Library", "Undo", "Redo", "Keyboard shortcuts", "Settings", "Inspector", "Minimize", "Maximize", "Close"]) {
    await expect(page.locator("#tb").getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.locator(".clip").filter({ hasText: "Kitchen.mov" }).click();
  await expect(page.locator("#tb-title-name")).toHaveText("Kitchen.mov");
  // centred over the player, also once a panel beside it is hidden
  const offCentre = async () => {
    const title = (await page.locator("#tb-title").boundingBox())!;
    const player = (await page.locator("#center").boundingBox())!;
    return Math.abs(title.x + title.width / 2 - (player.x + player.width / 2));
  };
  expect(await offCentre()).toBeLessThanOrEqual(1);
  await page.locator("#panel-toggle-library").click();
  await expect(page.locator("#left")).toBeHidden();
  expect(await offCentre()).toBeLessThanOrEqual(1);
  await page.locator("#panel-toggle-inspector").click();
  await expect(page.locator("#right")).toBeHidden();
  expect(await offCentre()).toBeLessThanOrEqual(1);
  // below 1440 wide the Inspector takes its width from a different rule
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.locator("#panel-toggle-library").click();
  await page.locator("#panel-toggle-inspector").click();
  await expect(page.locator("#right")).toBeVisible();
  expect(await offCentre()).toBeLessThanOrEqual(1);
});


test("Windows gets Tuck's own title bar with the window buttons at the right edge", async ({ page }) => {
  await open(page, { holdPlans: true, width: 960 });
  await expect(page.locator("body")).toHaveClass(/custom-titlebar/);
  await expect(page.locator("#tb")).toHaveAttribute("data-tauri-drag-region", "");
  const layout = await page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return {
      inspectorRight: box("panel-toggle-inspector").right,
      minimizeLeft: box("window-minimize").left,
      closeRight: box("window-close").right,
      closeTop: box("window-close").top,
      closeHeight: box("window-close").height,
      viewport: window.innerWidth,
    };
  });
  // a gap keeps the Inspector toggle off Minimize
  expect(layout.minimizeLeft - layout.inspectorRight).toBeGreaterThanOrEqual(14);
  expect(Math.abs(layout.closeRight - layout.viewport)).toBeLessThanOrEqual(0.5);
  expect(layout.closeTop).toBe(0);
  expect(layout.closeHeight).toBe(40);
});

test("Undo and Redo name their keys, and an open panel fills its half of the toggle", async ({ page }) => {
  await open(page, { holdPlans: true });
  await expect(page.locator("#btn-undo")).toHaveAttribute("data-tip", "Undo (Ctrl+Z)");
  await expect(page.locator("#btn-redo")).toHaveAttribute("data-tip", "Redo (Ctrl+Shift+Z or Ctrl+Y)");
  const toggle = page.locator("#panel-toggle-library");
  const look = () => toggle.evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    fill: getComputedStyle(button.querySelector(".tb-panel-fill")!).fill,
  }));
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const shown = await look();
  expect(shown.background).toBe("rgba(0, 0, 0, 0)");
  expect(shown.fill).not.toBe("rgba(0, 0, 0, 0)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect((await look()).fill).toBe("rgba(0, 0, 0, 0)");
});

test("a modal stops under the title bar, so the window buttons stay in reach", async ({ page }) => {
  await open(page, { holdPlans: true });
  await page.locator("#settings-toggle").click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  const hits = await page.evaluate(() => {
    const at = (id: string) => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("button")?.id ?? null;
    };
    return {
      close: at("window-close"),
      menu: at("window-menu"),
    };
  });
  expect(hits.close).toBe("window-close");
  expect(hits.menu).toBe("window-menu");
  // the editor's own buttons in the bar wait until the modal closes
  await expect(page.locator("#tb-editor-end")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.locator("#tb-editor-end")).not.toHaveAttribute("inert", "");
});

test("the bottom bar is a card on the floor, a gutter from the timeline and the window edge", async ({ page }) => {
  await open(page, { holdPlans: true });
  const geometry = await page.evaluate(() => {
    const bar = document.getElementById("task-bar")!;
    const box = bar.getBoundingClientRect();
    const timeline = document.getElementById("audio-editor")!.getBoundingClientRect();
    return {
      height: box.height,
      fromBottom: window.innerHeight - box.bottom,
      fromTimeline: box.top - timeline.bottom,
      left: box.left,
      radius: getComputedStyle(bar).borderTopLeftRadius,
    };
  });
  expect(geometry.height).toBe(44);
  expect(geometry.fromBottom).toBe(8);
  expect(geometry.fromTimeline).toBe(8);
  expect(geometry.left).toBe(8);
  expect(geometry.radius).toBe("12px");
});

test("dragging the timeline snaps back to the height its tracks need", async ({ page }) => {
  await open(page, { holdPlans: true, width: 1440 });
  const ratio = () => page.locator("#media-viewport").evaluate((stage) => {
    const box = stage.getBoundingClientRect();
    return box.width / box.height;
  });
  await expect.poll(ratio).toBeCloseTo(16 / 9, 2);
  const separator = page.getByRole("separator", { name: "Resize timeline" });
  const fitted = Number(await separator.getAttribute("aria-valuenow"));
  const handle = (await separator.boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 4 });
  await expect(separator).toHaveAttribute("aria-valuenow", String(fitted + 60));
  // within a few pixels of the fit, the timeline lands on it
  await page.mouse.move(x, y - 7, { steps: 4 });
  await expect(separator).toHaveAttribute("aria-valuenow", String(fitted));
  await page.mouse.up();
  await expect.poll(ratio).toBeCloseTo(16 / 9, 2);
  // landing on the fit keeps the height automatic, so it follows the tracks from here
  await expect.poll(async () => (await calls(page, "saveSettings")).at(-1)).toEqual([{ timeline_height: 0 }]);
});

test("manually enlarging the timeline grows the Video and Source audio rows", async ({ page }) => {
  await open(page, { holdPlans: true, width: 1440 });
  const fill = () => page.evaluate(() => {
    const frame = document.getElementById("sequence-frame")!;
    const stack = document.getElementById("sequence-stack")!;
    return { empty: frame.clientHeight - stack.offsetHeight, video: document.querySelector("#video-track .seq-head")!.getBoundingClientRect().height };
  });
  await expect.poll(async () => (await fill()).empty).toBe(0);
  expect((await fill()).video).toBe(60);
  const separator = page.getByRole("separator", { name: "Resize timeline" });
  await separator.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await fill()).empty).toBe(0);
  expect((await fill()).video).toBeGreaterThan(60);
});

test("the Inspector's This video and Export switch slides its thumb under the chosen view", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, { holdPlans: true });
  const offset = (id: string) => page.evaluate((tabId) => {
    const group = document.getElementById("insp-tabs")!, tab = document.getElementById(tabId)!.getBoundingClientRect();
    const thumb = getComputedStyle(group, "::before");
    const left = group.getBoundingClientRect().left + parseFloat(thumb.left) + new DOMMatrix(thumb.transform).m41;
    return Math.max(Math.abs(left - tab.left), Math.abs(parseFloat(thumb.width) - tab.width));
  }, id);
  for (const id of ["insp-tab-edit", "insp-tab-export"]) {
    await page.locator(`#${id}`).click();
    await expect(page.locator(`#${id}`)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => offset(id)).toBeLessThanOrEqual(1);
  }
});
