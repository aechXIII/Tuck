import {expect, test, type Page} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";
import type {CutAnalysisPayload, CutPlanRequest, CutPlanPayload} from "../../src/backend/cutting-types";
import type {BackendResult, DataPayload, PlanRequest} from "../../src/backend/types";

const time = (seconds: number) => ({ticks:String(Math.round(seconds*10)),time_base_num:1,time_base_den:10});
const FIRST = "C:/videos/Morning ride.mp4";
const SECOND = "C:/videos/Second.mp4";
const THIRD = "C:/videos/Third.mp4";

interface Options {
  // videos whose keyframes are still being read, and videos whose cut can't be planned
  reading?: string[];
  failing?: string[];
}

// every video's keyframes are ready unless named; plans echo each request's segments
async function setup(page: Page, files: string[], options: Options = {}) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = files;
  fixture.responses.probeFile = {data:{duration:12,width:1920,height:1080,fps:30,has_audio:true,video_codec:"h264",audio_codec:"aac",file_size:15000000}};
  fixture.responses.getSettings = {...fixture.responses.getSettings as object,last_task:"cut"};
  await installFakeBackend(page,fixture);
  await page.addInitScript(({reading,failing}) => {
    const t = (seconds: number) => ({ticks:String(Math.round(seconds*10)),time_base_num:1,time_base_den:10});
    const ready = (path: string) => ({work_id:`scan-${path}`,status:"ready",progress:1,coverage_end:t(12),keyframes:[t(0),t(4),t(8)],issue:null,
      analysis:{duration:t(12),frame_duration:{ticks:"1",time_base_num:1,time_base_den:30},exact_available:false,exact_reason:"",issues:[],version:"1",streams:[]}});
    const backend = window.tuckBackendClient!;
    const create = backend.createPlan.bind(backend);
    const started = new Set<string>();
    // fixtures are plain JSON in the shape the backend sends
    const payload = (value: object) => value as CutAnalysisPayload;
    backend.getCutAnalysis = async (path: string) => {
      window.__tuckFakeBackendCalls?.push({method:"getCutAnalysis",args:[path]});
      if (reading.includes(path)) return {ok:true,value:payload({...ready(path),status:"reading",progress:0.3,analysis:null})};
      return {ok:true,value:payload(started.has(path) ? ready(path) : {...ready(path),status:"missing",analysis:null})};
    };
    backend.analyzeCut = async (path: string, workId: string, background?: boolean) => {
      window.__tuckFakeBackendCalls?.push({method:"analyzeCut",args:background ? [path,workId,true] : [path,workId]});
      started.add(path);
      return {ok:true,value:payload({...ready(path),status:"reading",progress:0,analysis:null,work_id:workId})};
    };
    function createPlan(request: CutPlanRequest): Promise<BackendResult<CutPlanPayload>>;
    function createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>>;
    async function createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>> {
      if (request.operation !== "cut") return create(request);
      const source = String(request.source);
      if (failing.includes(source)) return {ok:false,error:{code:"UNSUPPORTED_CODEC",message:"This video's codec can't be cut without re-encoding.",details:{field:"cut"}}};
      const segments = (request.segments as {start:unknown;end:unknown}[]).map(range => ({requested:range,resolved:range,start_kind:"at_start",end_frames_moved:0,audio_source:null,audio_output:null,audio_packet_count:0,copied:null}));
      const name = source.split("/").pop()!.replace(/\.mp4$/,"");
      return {ok:true,value:{data:{operation:"cut",precision:"keyframes",container:"mp4",include_audio:request.include_audio === true,
        output_path:`C:/videos/${name}_cut.mp4`,exported_duration:t(12),estimated_bytes:13_000_000,fingerprint:"a".repeat(64),issues:[],exact_available:false,
        exact_reason:"",unverified:[],tracks:[],chapter_count:0,source_identity:{path:source,size:15000000,mtime_ns:"1",signature:"b".repeat(64)},segments}} as DataPayload};
    }
    backend.createPlan = createPlan;
  },{reading:options.reading ?? [],failing:options.failing ?? []});
  await page.goto("/");
  await page.locator("#vid").evaluate((video) => Object.defineProperty(video,"duration",{configurable:true,value:12}));
}

const calls = (page: Page, method: string) => page.evaluate((name) => window.__tuckFakeBackendCalls?.filter(call => call.method === name).map(call => call.args) ?? [],method);

test("the Output section says what the cut makes and how big it is", async ({page}) => {
  await setup(page,[FIRST]);
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect(page.locator("#out-name")).toHaveText("Morning ride_cut.mp4");
  await expect(page.locator("#out-plan")).toHaveText("The kept segment is saved as this file · about 12.4 MB");
  await expect(page.locator("#out-meta")).toHaveText("MP4 · H.264 + AAC · 0:12");
  await page.getByRole("button",{name:"Next keyframe"}).click();
  await page.getByRole("button",{name:"Set end at the playhead"}).click();
  await page.getByRole("button",{name:"Next keyframe"}).click();
  await page.keyboard.press("i");
  await expect(page.locator(".tl-segment")).toHaveCount(2);
  await expect(page.locator("#out-plan")).toHaveText("Kept segments are joined into this one file · about 12.4 MB");
});

test("Export all cuts is ready without opening every video", async ({page}) => {
  await setup(page,[FIRST,SECOND,THIRD]);
  await page.locator("#export-go summary").click();
  const all = page.getByRole("button",{name:"Export all cuts (3)",exact:true});
  await expect(all).toBeEnabled();
  await expect(page.locator("#btn-all-note")).toBeHidden();
  // the other videos were read one after another as reads ahead, never as the video on screen
  const reads = await calls(page,"analyzeCut");
  expect(reads.map(args => [args[0],args[2]])).toEqual([[FIRST,undefined],[SECOND,true],[THIRD,true]]);
  await all.click();
  await expect.poll(async () => (await calls(page,"enqueueWithOptions")).length).toBe(3);
});

test("Export all cuts names the videos it is waiting for", async ({page}) => {
  // videos are read ahead in Library order, one at a time
  await setup(page,[FIRST,THIRD,SECOND],{reading:[SECOND],failing:[THIRD]});
  await expect(page.locator("#btn-one")).toBeEnabled();
  await page.locator("#export-go summary").click();
  await expect(page.getByRole("button",{name:"Export all cuts (3)",exact:true})).toBeDisabled();
  await expect(page.locator("#btn-all-note")).toHaveText("Can't be cut yet: Third.mp4. Waiting for keyframes: Second.mp4.");
  // the problem is shown in full when that video is opened
  await page.locator(`[data-clip-path="${THIRD}"]`).click();
  await expect(page.locator("#cut-message")).toHaveText("This video's codec can't be cut without re-encoding.");
});

test("leaving Lossless cut stops reading ahead", async ({page}) => {
  await setup(page,[FIRST,SECOND],{reading:[SECOND]});
  await expect(page.locator("#btn-one")).toBeEnabled();
  await expect.poll(async () => (await calls(page,"getCutAnalysis")).filter(args => args[0] === SECOND).length).toBeGreaterThan(0);
  await page.locator("#wf-c").click();
  const before = (await calls(page,"getCutAnalysis")).length;
  await page.waitForTimeout(1200);
  expect((await calls(page,"getCutAnalysis")).length).toBe(before);
});
