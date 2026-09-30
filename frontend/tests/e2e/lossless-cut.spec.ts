import {expect, test, type Page} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";
import type {CutPlanPreview, CutPlanRequest, CutPlanPayload} from "../../src/backend/cutting-types";
import type {BackendResult, DataPayload, PlanRequest} from "../../src/backend/types";

const time = (seconds: number) => ({ticks:String(Math.round(seconds*10)),time_base_num:1,time_base_den:10});
const source = "C:/videos/Morning ride.mp4";
const plan: CutPlanPreview = {
  operation:"cut",precision:"keyframes",container:"mp4",include_audio:true,
  output_path:"C:/videos/Morning ride_cut.mp4",exported_duration:time(11.9),estimated_bytes:13000000,
  fingerprint:"a".repeat(64),issues:[],exact_available:false,exact_reason:"Exact cutting is not available yet.",unverified:[],tracks:[],chapter_count:0,
  source_identity:{path:source,size:15000000,mtime_ns:"1",signature:"b".repeat(64)},
  segments:[{requested:{start:time(0),end:time(12)},resolved:{start:time(0),end:time(11.9)},start_kind:"at_start",end_frames_moved:3,audio_source:null,audio_output:null,audio_packet_count:0,copied:null}],
};

async function setup(page: Page, options: {pending?:boolean; collapsed?:boolean; moved?:boolean; shortMoved?:boolean; files?:string[]; startupCut?:boolean; holdAnalysis?:boolean; holdExportPlan?:boolean; rejectExport?:boolean; scanning?:boolean; exact?:boolean; planOverride?:Partial<CutPlanPreview>} = {}) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = options.files ?? [source];
  fixture.responses.probeFile = {data:{duration:12,width:1920,height:1080,fps:30,has_audio:true,video_codec:"h264",audio_codec:"aac",file_size:15000000}};
  const analysis = {work_id:"scan",status:"ready",progress:1,coverage_end:time(12),keyframes:[time(0),time(4),time(8)],issue:null,
    analysis:{duration:time(12),frame_duration:{ticks:"1",time_base_num:1,time_base_den:30},exact_available:false,exact_reason:plan.exact_reason,issues:[],version:"1",streams:[]}};
  if (options.shortMoved) {
    fixture.responses.probeFile = {data:{duration:4+1/30,width:1920,height:1080,fps:30,has_audio:false}};
    analysis.analysis.duration = {ticks:"121",time_base_num:1,time_base_den:30};
  }
  fixture.responses.getCutAnalysis = options.pending ? {...analysis,status:"reading",analysis:null,progress:null}
    : options.scanning ? {...analysis,status:"reading",analysis:null,progress:0.5,coverage_end:time(6),keyframes:[time(0),time(4)]} : analysis;
  fixture.responses.analyzeCut = analysis;
  fixture.responses.enqueueWithOptions = {item_id:"cut-1"};
  fixture.responses.getSettings = {...fixture.responses.getSettings as object,profiles:[
    {profile_id:"compress",name:"Compress",workflow:"compression"},
    {profile_id:"up-one",name:"Upscale one",workflow:"upscale"},
    {profile_id:"up-two",name:"Upscale two",workflow:"upscale"},
  ]};
  if (options.holdAnalysis) fixture.holdMethods = ["getCutAnalysis"];
  if (options.rejectExport) fixture.responses.enqueueWithOptions = {ok:false,error:"The video changed. Check the cut points.",code:"SOURCE_CHANGED"};
  if (options.startupCut) fixture.responses.getSettings = {...fixture.responses.getSettings as object,last_task:"cut"};
  await installFakeBackend(page,fixture);
  await page.addInitScript(({planJson,collapsed,moved,holdExportPlan,exact}) => {
    const plan = JSON.parse(planJson) as CutPlanPreview;
    const backend = window.tuckBackendClient!;
    const create = backend.createPlan.bind(backend);
    let cutPlans = 0;
    function createPlan(request: CutPlanRequest): Promise<BackendResult<CutPlanPayload>>;
    function createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>>;
    async function createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>> {
      const result = await create(request);
      if (request.operation !== "cut") return result;
      if (++cutPlans === 2 && holdExportPlan) {
        await new Promise<void>(resolve => {
          const release = window.__tuckReleaseHeld;
          window.__tuckReleaseHeld = (method,value) => method === "cut-plan" ? resolve() : release?.(method,value);
        });
      }
      const issues = Array.isArray(request.edits) && request.edits.length && !request.without_edits
        ? [{code:"incompatible_edit",field:"edits",message:"Crop needs re-encoding. Choose Compress or export without these edits.",title:"Crop needs re-encoding"}] : [];
      if (collapsed) issues.push({code:"segment_collapsed",field:"segments",message:"A segment has no copyable frames.",title:""});
      if (exact) {
        const precise = request.precision === "exact";
        const tenth = (value: number) => ({ticks:String(value),time_base_num:1,time_base_den:10});
        return {ok:true,value:{data:{...plan,precision:precise ? "exact" : "keyframes",exact_available:true,exact_reason:"",issues,
          source_identity:{...plan.source_identity,path:String(request.source)},include_audio:request.include_audio === true,
          segments:plan.segments.map(segment => precise
            ? {...segment,resolved:{start:tenth(0),end:tenth(120)},start_kind:"exact",end_frames_moved:0,copied:{start:tenth(40),end:tenth(119)}}
            : segment)}}};
      }
      return {ok:true,value:{data:{...plan,source_identity:{...plan.source_identity,path:String(request.source)},include_audio:request.include_audio === true,issues,
        segments:collapsed ? plan.segments.map(segment => ({...segment,start_kind:"collapsed"}))
          : moved ? plan.segments.map(segment => ({...segment,start_kind:"moved",resolved:{...segment.resolved,start:{ticks:"40",time_base_num:1,time_base_den:10}}})) : plan.segments}}};
    }
    backend.createPlan = createPlan;
  },{planJson:JSON.stringify({...(options.shortMoved ? {...plan,exported_duration:{ticks:"1",time_base_num:1,time_base_den:30},segments:plan.segments.map(segment=>({...segment,requested:{start:time(0),end:analysis.analysis.duration},resolved:{start:time(4),end:analysis.analysis.duration},start_kind:"moved",end_frames_moved:0}))} : plan),...options.planOverride}),collapsed:options.collapsed,moved:options.moved,holdExportPlan:options.holdExportPlan,exact:options.exact});
  await page.goto("/");
  if (options.files?.length === 0) return;
  // timeline keyboard edits require decoded media metadata as well as probe data
  await page.locator("#vid").evaluate((video,duration) => {
    Object.defineProperty(video,"duration",{configurable:true,value:duration});
  },options.shortMoved ? 4+1/30 : 12);
  if (!options.startupCut) await expect(page.locator("#btn-one")).toBeEnabled();
}

test("lossless Inspector shows measured boundaries and exports only cut intent", async ({page}) => {
  await setup(page);
  await page.locator("#wf-l").click();
  await expect(page.locator("#cut-list")).toContainText("Ends 3 frames early");
  await expect(page.getByRole("radio",{name:/Exact/})).toBeDisabled();
  await expect(page.locator("#profile-card")).toBeHidden();
  await page.getByRole("button",{name:"Export cut",exact:true}).click();
  const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "enqueueWithOptions")?.args[0]);
  expect(request).toMatchObject({operation:"cut",source,plan_fingerprint:plan.fingerprint});
  expect(request).not.toHaveProperty("profile_id");
  expect(request).not.toHaveProperty("video_encoder");
});

test("checks Tuck cannot make and tracks it keeps are shown without blocking export", async ({page}) => {
  await setup(page,{planOverride:{
    container:"mkv",segments:[{...plan.segments[0]!,start_kind:"keyframe"}],output_path:"C:/videos/Morning ride_cut.mkv",chapter_count:2,
    unverified:[{code:"unverified_start",message:"Cut starts use keyframes that could not be confirmed as clean starting points.",field:null}],
    tracks:[
      {index:1,kind:"audio",codec:"aac",keep:true,reason:""},{index:2,kind:"audio",codec:"opus",keep:true,reason:""},
      {index:3,kind:"subtitle",codec:"ass",keep:true,reason:""},
      {index:4,kind:"data",codec:"bin_data",keep:false,reason:"Timecode and data tracks are not kept."},
    ],
  }});
  await page.locator("#wf-l").click();
  await expect(page.locator("#out-name")).toHaveText("Morning ride_cut.mkv");
  await expect(page.locator("#out-meta")).toContainText("MKV");
  await expect(page.locator("#out-tracks")).toHaveText("Also keeps 2 audio tracks, 1 subtitle track, 2 chapters");
  await expect(page.locator("#cut-dropped")).toHaveText("Timecode and data tracks are not kept.");
  await expect(page.locator("#cut-unchecked")).toContainText("Not checked");
  await expect(page.locator("#cut-unchecked")).toContainText("could not be confirmed");
  await expect(page.locator(".cut-status")).toHaveText("Starts on a keyframe · Ends 3 frames early · Start not checked");
  await expect(page.locator("#btn-one")).toBeEnabled();
});

test("a stale analysis response cannot replace the selected video's state", async ({page}) => {
  await setup(page,{files:[source,"C:/videos/Second.mp4"],holdAnalysis:true});
  await page.locator("#wf-l").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(1);
  await page.locator('[data-clip-path="C:/videos/Second.mp4"]').click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(2);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis",{ok:false,error:"The old video is unavailable."}));
  await expect(page.locator("#cut-message")).not.toContainText("old video");
  await expect(page.locator("#btn-one")).toBeDisabled();
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis"));
  await expect(page.locator("#btn-one")).toBeEnabled();
});

test("selecting another video during export preparation prepares its Inspector", async ({page}) => {
  await setup(page,{files:[source,"C:/videos/Second.mp4"],holdAnalysis:true});
  await page.locator("#wf-l").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(1);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis"));
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#btn-one").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(2);
  await page.locator('[data-clip-path="C:/videos/Second.mp4"]').click();
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis"));
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(3);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis"));
  await expect(page.locator("#btn-one")).toBeEnabled();
});

test("changing tasks does not cancel a cut export already requested", async ({page}) => {
  await setup(page,{holdAnalysis:true});
  await page.locator("#wf-l").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(1);
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis"));
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#btn-one").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBe(2);
  await page.locator("#wf-c").click();
  await page.evaluate(() => window.__tuckReleaseHeld?.("getCutAnalysis"));
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "enqueueWithOptions").length)).toBe(1);
});

test("editing while export planning is pending discards the stale plan and prepares the edit", async ({page}) => {
  await setup(page,{holdExportPlan:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#btn-one").click();
  const plans = () => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "createPlan" && (call.args[0] as {operation?:string})?.operation === "cut").length);
  await expect.poll(plans).toBe(2);
  await page.locator("#tl-in").press("ArrowRight");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","0.01");
  await page.evaluate(() => window.__tuckReleaseHeld?.("cut-plan"));
  await expect.poll(plans).toBe(3);
  await expect(page.locator("#btn-one")).toBeEnabled();
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "enqueueWithOptions"))).toEqual([]);
});

test("changing cut options does not repeat the completed scan announcement", async ({page}) => {
  await setup(page);
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#cut-announcement").evaluate(element => {
    element.setAttribute("data-updates","0");
    new MutationObserver(() => element.setAttribute("data-updates",String(Number(element.getAttribute("data-updates"))+1)))
      .observe(element,{childList:true,characterData:true,subtree:true});
  });
  await page.locator("#cut-audio").uncheck();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#cut-announcement")).toHaveAttribute("data-updates","0");
});

test("export errors stay visible and whole-source mute maps to no audio", async ({page}) => {
  await setup(page,{rejectExport:true});
  await page.locator("#source-audio-label").click();
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#cut-audio")).not.toBeChecked();
  await expect(page.locator("#cut-audio")).toBeDisabled();
  await page.locator("#btn-one").click();
  await expect(page.locator("#cut-message")).toHaveText("The video changed. Check the cut points.");
  await expect(page.locator("#cut-reread")).toBeVisible();
  await expect(page.locator("#btn-one")).toBeDisabled();
});

test("export all uses the reviewed cut settings for each video", async ({page}) => {
  const files = [source,"C:/videos/Second.mp4","C:/videos/Third.mp4"];
  await setup(page,{files});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#cut-audio").uncheck();
  await expect(page.locator("#btn-one")).toBeEnabled();
  for (const path of files.slice(1)) {
    await page.locator(`[data-clip-path="${path}"]`).click();
    await expect(page.locator("#btn-one")).toBeEnabled();
  }
  await page.locator("#right-foot summary").click();
  await page.getByRole("button",{name:"Export all cuts (3)",exact:true}).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "enqueueWithOptions").length)).toBe(3);
  const requests = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "enqueueWithOptions").map(call=>call.args[0]));
  expect(requests).toEqual(files.map((source,index)=>expect.objectContaining({operation:"cut",source,include_audio:index !== 0,plan_fingerprint:plan.fingerprint})));
});

test("task switching keeps encoding settings, segments and per-video audio choices", async ({page}) => {
  await setup(page,{files:[source,"C:/videos/Second.mp4"]});
  await page.locator("#sz-badge").fill("42");
  await page.locator("#sz-badge").press("Enter");
  await page.locator("#tl-in").press("ArrowRight");
  const start = await page.locator("#tl-in").getAttribute("aria-valuenow");
  expect(start).toBe("0.01");
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#cut-audio").uncheck();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator('[data-clip-path="C:/videos/Second.mp4"]').click();
  await expect(page.locator("#cut-audio")).toBeChecked();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator('[data-clip-path="C:/videos/Morning ride.mp4"]').click();
  await expect(page.locator("#cut-audio")).not.toBeChecked();
  await page.locator("#wf-c").click();
  await expect(page.locator("#sz-badge")).toHaveValue("42");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow",start!);
});

test("entering Upscale from Lossless cut restores the last Upscale profile", async ({page}) => {
  await setup(page);
  await page.locator("#wf-u").click();
  await page.locator("#prof-sel").selectOption("up-two");
  await page.locator("#wf-c").click();
  await page.locator("#wf-l").click();
  await page.locator("#wf-u").click();
  await expect(page.locator("#prof-sel")).toHaveValue("up-two");
});

test("conflicting edits require a reversible choice and stay intact", async ({page}) => {
  await setup(page);
  await page.locator("#insp-tab-edit").click();
  await page.getByRole("button",{name:"Rotate 90° clockwise",exact:true}).click();
  await page.locator("#insp-tab-export").click();
  await page.locator("#wf-l").click();
  await expect(page.locator("#cut-conflict")).toBeVisible();
  await expect(page.locator("#btn-one")).toBeDisabled();
  await page.locator("#conflict-remove").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#conflict-restore")).toBeVisible();
  await page.locator("#conflict-restore").click();
  await expect(page.locator('#cut-list [data-cut-index="0"]')).toBeFocused();
  await expect(page.locator("#conflict-remove")).toBeVisible();
  await expect(page.locator("#btn-one")).toBeDisabled();
  await page.locator("#conflict-compress").click();
  await expect(page.locator("#wf-c")).toBeFocused();
  await expect(page.locator("#wf-c")).toHaveAttribute("aria-pressed","true");
  await page.locator("#insp-tab-edit").click();
  await expect(page.locator('[data-action-click="transform-rotation"][data-rotation="90"]')).toHaveClass(/on/);
});

test("pending and too-short cuts cannot export", async ({page}) => {
  await setup(page,{pending:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toHaveText("Reading keyframes…");
  await expect(page.locator("#btn-one")).toBeDisabled();
  await expect(page.locator("#cut-list")).toContainText("Checking keyframes…");
  await expect(page.locator("#cut-scan-bar")).not.toHaveAttribute("value");
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "getCutAnalysis").length)).toBeGreaterThan(0);
  await page.locator("#wf-c").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call=>call.method === "cancelCutWork").length)).toBeGreaterThan(0);
});

test("a collapsed segment blocks export and empty selection stays useful", async ({page}) => {
  await setup(page,{collapsed:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#cut-list")).toContainText("Too short: no keyframe inside");
  await expect(page.locator("#btn-one")).toBeDisabled();
});

test("saved Lossless cut task opens without a video", async ({page}) => {
  await setup(page,{files:[],startupCut:true});
  await expect(page.locator("#wf-l")).toHaveAttribute("aria-pressed","true");
  await expect(page.locator("#cut-message")).toHaveText("Choose a video to cut.");
  await expect(page.locator("#btn-one")).toBeDisabled();
});

test("moving a one-frame cut preserves the timeline when it would be too short", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror",error => errors.push(error.message));
  await setup(page,{shortMoved:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#snap-all").click();
  await expect(page.locator("#toast-ct")).toContainText("too short for the timeline");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","0");
  await expect(page.locator("#btn-one")).toBeEnabled();
  expect(errors).toEqual([]);
});

for (const width of [1440,960]) {
  test(`Inspector keeps the timeline usable at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 960 ? 640 : 900});
    await page.emulateMedia({reducedMotion:"reduce"});
    await setup(page,{moved:true});
    if (width === 960) await page.getByRole("button",{name:"Inspector",exact:true}).click();
    await page.locator("#wf-l").click();
    await expect(page.locator("#snap-all")).toBeVisible();
    await expect(page.locator(".edge-chip")).toBeVisible();
    await expect(page.locator("#btn-one")).toBeEnabled();
    const layout = await page.evaluate(() => {
      const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return {inspector:rect("right").bottom,timeline:rect("audio-editor").top,footer:rect("right-foot").bottom,main:rect("main").bottom,
        lane:rect("kf-lane").top,frame:rect("sequence-frame").top,toolbar:document.getElementById("timeline-row")!.scrollWidth-rect("timeline-row").width,chip:document.querySelector(".edge-chip")!.getBoundingClientRect().left,track:rect("tl-track").left};
    });
    expect(layout.inspector).toBeLessThanOrEqual(layout.timeline);
    expect(layout.lane).toBeGreaterThanOrEqual(layout.frame);
    expect(layout.chip).toBeGreaterThanOrEqual(layout.track);
    expect(layout.toolbar).toBeLessThanOrEqual(1);
    expect(layout.footer).toBeLessThanOrEqual(layout.main);
    await page.locator("#cut-list button").press("Enter");
    await expect(page.locator("#cut-list button")).toBeFocused();
    await page.locator("#snap-all").click();
    await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
    await expect(page.locator("#btn-one")).toBeEnabled();
    await page.getByRole("button",{name:"Undo",exact:true}).click();
    await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","0");
    await expect(page.locator("#btn-one")).toBeEnabled();
    await page.getByRole("button",{name:"Redo",exact:true}).click();
    await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
    await expect(page.locator("#btn-one")).toBeEnabled();
  });
}

test("keyframes show on the timeline only in the Lossless cut task", async ({page}) => {
  await setup(page);
  await expect(page.locator("#kf-lane")).toBeHidden();
  await expect(page.locator("#btn-kf-toggle")).toBeHidden();
  await expect(page.locator("#ptime")).toHaveText("0:00 / 0:12");
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#kf-lane")).toBeVisible();
  await expect(page.locator("#kf-lane .kf")).toHaveCount(3);
  await expect(page.locator("#kf-lane .kf-unread")).toHaveCount(0);
  await expect(page.locator("#ptime")).toHaveText("0:00.00 / 0:12.00");
  await expect(page.locator("#btn-snap-toggle")).toHaveAttribute("data-tip","Snap to keyframes, playhead and clip edges");
  const toggle = page.getByRole("button",{name:"Show keyframes"});
  await expect(toggle).toHaveAttribute("aria-pressed","true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed","false");
  await expect(page.locator("#kf-lane")).toBeHidden();
  await toggle.click();
  await expect(page.locator("#kf-lane")).toBeVisible();
  await page.locator("#wf-c").click();
  await expect(page.locator("#kf-lane")).toBeHidden();
  await expect(page.locator("#btn-kf-toggle")).toBeHidden();
  await expect(page.locator("#ptime")).toHaveText("0:00 / 0:12");
});

test("unread time during a scan is marked instead of looking empty", async ({page}) => {
  await setup(page,{scanning:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#kf-lane .kf")).toHaveCount(2);
  await expect(page.locator("#kf-lane .kf-scan")).toHaveAttribute("style",/width: 50%/);
  await expect(page.locator("#kf-lane .kf-unread")).toHaveAttribute("style",/left: 50%/);
  await expect(page.locator("#btn-one")).toHaveText("Reading keyframes…");
});

test("[ and ] move the playhead, or a focused handle, between keyframes", async ({page}) => {
  await setup(page);
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.keyboard.press("]");
  await expect(page.locator("#tl-time")).toHaveText("0:04.00 / 0:12.00");
  await page.keyboard.press("]");
  await expect(page.locator("#tl-time")).toHaveText("0:08.00 / 0:12.00");
  await page.keyboard.press("[");
  await expect(page.locator("#tl-time")).toHaveText("0:04.00 / 0:12.00");
  await page.locator("#tl-in").focus();
  await page.keyboard.press("]");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
  await expect(page.locator("#tl-in")).toBeFocused();
  await page.locator("#tl-out").focus();
  await page.keyboard.press("[");
  await expect(page.locator("#tl-out")).toHaveAttribute("aria-valuenow","8");
  await expect(page.locator("#tl-time")).toHaveText("0:08.00 / 0:12.00");
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(page.locator("#tl-out")).toHaveAttribute("aria-valuenow","12");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
  await page.locator("#wf-c").click();
  await page.locator("#tl-in").focus();
  await page.keyboard.press("[");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
});

test("a start that moves shows its sliver and note, and the chip opens its cut", async ({page}) => {
  await setup(page,{moved:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  const chip = page.locator(".edge-chip");
  // the clip is wide enough to say it in its own time line, so the chip only shows when focused
  await expect(page.locator(".tl-segment .tl-cut-note")).toHaveText("starts 4.0 s later");
  await expect(chip).toHaveClass(/in-clip/);
  await expect(chip).toHaveCSS("opacity","0");
  await expect(chip).toHaveText("starts 4.0 s later");
  await expect(chip).toHaveAccessibleName("Segment 1. Starts at 0:04.000, the next keyframe, 4.0 s later than where you cut");
  await expect(page.locator(".tl-sliver")).toHaveCount(1);
  await expect(page.locator(".tl-segment.has-sliver")).toHaveCount(1);
  // the chip is a button, so it stays out of the timeline slider and keeps focus through repaints
  await expect(page.locator("#timeline .edge-chip")).toHaveCount(0);
  await chip.focus();
  await page.evaluate(() => { document.getElementById("btn-kf-toggle")!.click(); document.getElementById("btn-kf-toggle")!.click(); });
  await expect(chip).toBeFocused();
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuetext","0:00.000, exported from 0:04.000");
  await expect(page.locator("#tl-out")).toHaveAttribute("aria-valuetext","0:12.000, exported to 0:11.900");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(chip).toBeFocused();
  await expect(chip).toHaveCSS("opacity","1");
  await page.keyboard.press("Enter");
  await expect(page.locator('#cut-list [data-cut-index="0"]')).toBeFocused();
  await expect(page.locator("#tl-time")).toHaveText("0:04.00 / 0:12.00");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","0");
  await page.locator("#snap-all").click();
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
  await expect(page.locator(".edge-chip")).toHaveCount(0);
  await page.locator("#wf-c").click();
  await expect(page.locator(".tl-sliver")).toHaveCount(0);
  await expect(page.locator("#tl-in")).not.toHaveAttribute("aria-valuetext",/./);
});

test("dragging a start snaps to keyframes and lights the keyframe it copies from", async ({page}) => {
  await setup(page);
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  const track = (await page.locator("#tl-track").boundingBox())!;
  const edge = (await page.locator('.tl-segment[data-segment-index="0"] .clip-edge.start').boundingBox())!;
  const x = (seconds: number) => track.x + track.width * seconds / 12;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(edge.x + edge.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x(3.96), y, {steps:6});
  await expect(page.locator("#kf-lane")).toHaveClass(/dragging/);
  await expect(page.locator("#kf-guides .kf-guide.landing")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
  await expect(page.locator("#kf-lane")).not.toHaveClass(/dragging/);
  await expect(page.locator("#kf-guides .kf-guide.landing")).toHaveCount(0);
  await page.locator("#btn-snap-toggle").click();
  const moved = (await page.locator('.tl-segment[data-segment-index="0"] .clip-edge.start').boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x(7.95), y, {steps:6});
  await page.mouse.up();
  await expect(page.locator("#tl-in")).not.toHaveAttribute("aria-valuenow","4");
  await expect(page.locator("#tl-in")).not.toHaveAttribute("aria-valuenow","8");
});

test("Exact is chosen by pointer or keyboard and shows what is re-encoded", async ({page}) => {
  await setup(page,{exact:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  const exact = page.getByRole("radio",{name:/Exact/});
  const keyframes = page.getByRole("radio",{name:"On keyframes"});
  await expect(exact).toBeEnabled();
  await expect(keyframes).toBeChecked();
  await expect(page.locator("#cut-exact-note")).toHaveText("Re-encodes a little video at each cut.");
  await keyframes.focus();
  await page.keyboard.press("ArrowDown");
  await expect(exact).toBeChecked();
  await expect(exact).toBeFocused();
  await expect(page.locator("#cut-list .cut-status")).toHaveText("Exact · 4.1 s re-encoded");
  await expect(page.locator("#cut-list .cut-status")).toHaveClass(/exact/);
  await expect(page.locator(".tl-sliver.exact")).toHaveCount(1);
  await expect(page.locator(".edge-chip.exact")).toHaveText("4.0 s re-encoded");
  await expect(page.locator(".edge-chip.exact")).toHaveAccessibleName("Segment 1. Starts exactly at 0:00.000. 4.0 s near the start is re-encoded");
  await expect(page.locator("#snap-all")).toBeHidden();
  const plans = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "createPlan").map(call => (call.args[0] as {precision?:string}).precision));
  expect(plans?.at(-1)).toBe("exact");
  await page.locator("#btn-one").click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "enqueueWithOptions").length)).toBe(1);
  const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "enqueueWithOptions")?.args[0]);
  expect(request).toMatchObject({operation:"cut",precision:"exact"});
  await keyframes.click();
  await expect(keyframes).toBeChecked();
  await expect(page.locator(".tl-sliver.exact")).toHaveCount(0);
});

test("changing precision keeps the Inspector steady and does not read keyframes again", async ({page}) => {
  await setup(page,{exact:true,holdExportPlan:true});
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  const before = await page.locator("#insp-cut").boundingBox();
  await page.evaluate(() => {
    const button = document.getElementById("btn-one")!;
    new MutationObserver(() => { if (button.hasAttribute("disabled")) document.body.dataset.exportBlinked = "true"; })
      .observe(button,{attributes:true,attributeFilter:["disabled"]});
  });
  await page.getByRole("radio",{name:/Exact/}).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "createPlan").length)).toBe(2);
  // the new plan is held; the last one stays on screen and the button stays usable
  await expect(page.locator("#btn-one")).toHaveText("Export cut");
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#cut-scan")).toBeHidden();
  await expect(page.locator("#cut-list .cut-status")).toHaveText("Starts at the beginning · Ends 3 frames early");
  await expect(page.locator("#out-name")).toHaveText("Morning ride_cut.mp4");
  expect((await page.locator("#insp-cut").boundingBox())?.height).toBe(before?.height);
  expect(await page.evaluate(() => document.body.dataset.exportBlinked)).toBeUndefined();
  // an export clicked now waits for the new plan and sends that one
  await page.locator("#btn-one").click();
  await page.evaluate(() => window.__tuckReleaseHeld?.("cut-plan"));
  await expect(page.locator("#cut-list .cut-status")).toHaveText("Exact · 4.1 s re-encoded");
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "enqueueWithOptions").length)).toBe(1);
  const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "enqueueWithOptions")?.args[0]);
  expect(request).toMatchObject({operation:"cut",precision:"exact"});
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "analyzeCut").length)).toBe(0);
});

test("Exact stays disabled with the reason when this video cannot use it", async ({page}) => {
  await setup(page);
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.getByRole("radio",{name:/Exact/})).toBeDisabled();
  await expect(page.getByRole("radio",{name:"On keyframes"})).toBeChecked();
  await expect(page.locator("#cut-exact-note")).toHaveText("Exact cutting is not available yet.");
});

for (const width of [1440,960]) {
  test(`Exact fits the Inspector and timeline at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 960 ? 640 : 900});
    await setup(page,{exact:true});
    if (width === 960) await page.getByRole("button",{name:"Inspector",exact:true}).click();
    await page.locator("#wf-l").click();
    await page.getByRole("radio",{name:/Exact/}).click();
    await expect(page.locator(".edge-chip.exact")).toBeVisible();
    await expect(page.locator("#btn-one")).toBeEnabled();
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {inspector:rect("#right").bottom,timeline:rect("#audio-editor").top,row:rect("#cut-list .cut-status"),panel:rect("#insp-cut")};
    });
    expect(layout.inspector).toBeLessThanOrEqual(layout.timeline);
    expect(layout.row.right).toBeLessThanOrEqual(layout.panel.right + 1);
  });
}

test("at 960 the cut Inspector leaves the timeline usable by keyboard", async ({page}) => {
  await page.setViewportSize({width:960,height:640});
  await setup(page);
  await page.getByRole("button",{name:"Inspector",exact:true}).click();
  await page.locator("#wf-l").click();
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#audio-editor")).not.toHaveAttribute("inert",/.*/);
  await expect(page.locator("#right")).toHaveAttribute("aria-modal","false");
  await page.locator("#tl-in").focus();
  await expect(page.locator("#tl-in")).toBeFocused();
  await page.keyboard.press("]");
  await expect(page.locator("#tl-in")).toHaveAttribute("aria-valuenow","4");
  // trimming shows Reset; the toolbar still fits
  expect(await page.evaluate(() => { const row = document.getElementById("timeline-row")!; return row.scrollWidth - row.clientWidth; })).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button",{name:"Add audio"})).toBeVisible();
  // other tasks keep the modal drawer
  await page.locator("#wf-c").click();
  await expect(page.locator("#audio-editor")).toHaveAttribute("inert",/.*/);
  await expect(page.locator("#right")).toHaveAttribute("aria-modal","true");
});
