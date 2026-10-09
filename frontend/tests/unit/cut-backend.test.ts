import assert from "node:assert/strict";
import test from "node:test";
import { createTauriBackendClient } from "../../src/backend/tauri.ts";
import type { CutEnqueueRequest, CutPlanPreview } from "../../src/backend/cutting-types.ts";
import { keyframeCursor, mergeKeyframePage, moreKeyframesToRead } from "../../src/backend/cutting-types.ts";

const zero = {ticks:"0",time_base_num:1,time_base_den:90000};
const pending = {work_id:"scan-1",status:"pending",progress:null,coverage_end:zero,keyframes:[],issue:null,analysis:null};

test("cut analysis uses allowlisted commands and validates progress payloads", async () => {
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (_command,args) => {calls.push(args); return pending;});
  assert.deepEqual(await client.analyzeCut("clip.mp4","scan-1"), {ok:true,value:pending});
  assert.deepEqual(calls,[{command:{command:"analyze_cut",payload:{path:"clip.mp4",work_id:"scan-1"}}}]);
  assert.equal((await client.getCutAnalysis("clip.mp4")).ok,true);
  for (const bad of [{...pending,progress:2},{...pending,coverage_end:{...zero,ticks:4}},{...pending,status:"success"},{...pending,status:["pending"]},{...pending,keyframes:[{...zero,time_base_den:0}]}]) {
    const broken = createTauriBackendClient(async () => bad);
    assert.equal((await broken.getCutAnalysis("clip.mp4")).ok,false);
  }
});

test("cut cancellation and domain errors keep their details", async () => {
  const error = {code:"SOURCE_CHANGED",message:"The video changed.",details:{field:"cut",_request_id:7}};
  const client = createTauriBackendClient(async (_command,args) => {
    const command = args.command;
    if (typeof command === "object" && command !== null && "command" in command && command.command === "cancel_cut_work") return {cancelled:true};
    throw error;
  });
  assert.deepEqual(await client.cancelCutWork("scan-1"),{ok:true,value:{cancelled:true}});
  assert.deepEqual(await client.getCutAnalysis("clip.mp4"),{ok:false,error});
});

test("cut plan rejects a generic or malformed success response", async () => {
  const request = {operation:"cut" as const,source:"clip.mp4",segments:[{start:zero,end:{...zero,ticks:"9007199254741009"}}]};
  const client = createTauriBackendClient(async () => ({data:{duration:4}}));
  assert.equal((await client.createPlan(request)).ok,false);
});

test("typed cut previews retain ticks above JavaScript's integer precision", async () => {
  const end = {...zero,ticks:"9007199254741009"};
  const plan: CutPlanPreview = {
    operation:"cut",precision:"keyframes",container:"mp4",include_audio:false,
    output_path:"clip_cut.mp4",exported_duration:end,estimated_bytes:1000,
    fingerprint:"a".repeat(64),issues:[],exact_available:false,exact_reason:"Not available in this build.",unverified:[],tracks:[],chapter_count:0,
    source_identity:{path:"clip.mp4",size:1000,mtime_ns:"1234567890123456789",signature:"b".repeat(64)},
    segments:[{requested:{start:zero,end},resolved:{start:zero,end},start_kind:"at_start",end_frames_moved:0,audio_source:null,audio_output:null,audio_packet_count:0,copied:null}],
  };
  const client = createTauriBackendClient(async () => ({data:plan,_request_id:4}));
  const result = await client.createPlan({operation:"cut",source:"clip.mp4",segments:[{start:zero,end}]});
  assert.ok(result.ok);
  assert.equal(result.value.data.segments[0]?.requested.end.ticks,end.ticks);
  assert.equal(result.value._request_id,4);
});
test("cut previews keep the source container and carry unchecked notes and tracks", async () => {
  const plan = {
    operation:"cut",precision:"keyframes",container:"mkv",include_audio:true,
    output_path:"clip_cut.mkv",exported_duration:zero,estimated_bytes:1,
    fingerprint:"a".repeat(64),issues:[],exact_available:false,exact_reason:"",
    unverified:[{code:"unverified_start",message:"Starts not confirmed.",field:null}],
    tracks:[{index:1,kind:"subtitle",codec:"ass",keep:true,reason:""},{index:2,kind:"data",codec:"bin_data",keep:false,reason:"Not kept."}],
    chapter_count:2,
    source_identity:{path:"clip.mkv",size:1,mtime_ns:"1",signature:"b".repeat(64)},
    segments:[],
  };
  const request = {operation:"cut" as const,source:"clip.mkv",segments:[]};
  const result = await createTauriBackendClient(async () => ({data:plan})).createPlan(request);
  assert.ok(result.ok);
  assert.deepEqual(result.value,{data:plan});
  for (const broken of [{container:"MP4 "},{tracks:[{index:1,kind:"audio"}]},{unverified:null},{chapter_count:-1}]) {
    assert.equal((await createTauriBackendClient(async () => ({data:{...plan,...broken}})).createPlan(request)).ok,false);
  }
});
test("cut enqueue validates success and preserves stale-plan error details", async () => {
  const request: CutEnqueueRequest = {operation: "cut", source: "clip.mp4", segments: [{start: zero, end: zero}], plan_fingerprint: "a".repeat(64)};
  const calls: unknown[] = [];
  const client = createTauriBackendClient(async (_command, args) => {calls.push(args); return {item_id: "cut-1"};});
  assert.deepEqual(await client.enqueueWithOptions(request), {ok: true, value: {item_id: "cut-1"}});
  assert.deepEqual(calls, [{command: {command: "enqueue_with_options", payload: {request}}}]);
  for (const value of [{}, {item_id: 3}]) {
    assert.equal((await createTauriBackendClient(async () => value).enqueueWithOptions(request)).ok, false);
  }
  const error = {code: "PLAN_CHANGED", message: "Review the current cuts.", details: {field: "cut", current_plan: {fingerprint: "b".repeat(64)}}};
  assert.deepEqual(await createTauriBackendClient(async () => {throw error;}).enqueueWithOptions(request), {ok: false, error});
});

test("status reads send the keyframe cursor and validate the page it answers with", async () => {
  const calls: unknown[] = [];
  const page = {...pending,status:"reading",keyframes:[zero],keyframes_revision:3,keyframes_from:5,keyframe_count:6};
  const client = createTauriBackendClient(async (_command,args) => {calls.push(args); return page;});
  assert.deepEqual(await client.getCutAnalysis("clip.mp4",{revision:3,from:5}),{ok:true,value:page});
  assert.deepEqual(calls,[{command:{command:"get_cut_analysis",payload:{path:"clip.mp4",keyframes_revision:3,keyframes_from:5}}}]);
  for (const bad of [{keyframes_from:-1},{keyframes_revision:1.5},{keyframe_count:5},{keyframes_from:"5"}]) {
    assert.equal((await createTauriBackendClient(async () => ({...page,...bad})).getCutAnalysis("clip.mp4")).ok,false);
  }
});

const second = (n: number) => ({ticks:String(n),time_base_num:1,time_base_den:1});
const seconds = (from: number, to: number) => Array.from({length:to-from},(_,n) => second(from+n));
const reading = {...pending,status:"reading" as const};

test("keyframe pages join into one list until the list is replaced", () => {
  const first = mergeKeyframePage(null,{...reading,keyframes:seconds(0,3),keyframes_revision:1,keyframes_from:0,keyframe_count:3});
  assert.deepEqual(keyframeCursor(first),{revision:1,from:3});
  const next = mergeKeyframePage(first,{...reading,keyframes:seconds(3,5),keyframes_revision:1,keyframes_from:3,keyframe_count:5});
  assert.deepEqual(next.keyframes,seconds(0,5));
  assert.equal(next.keyframes_from,0);
  // the backend replaced the list, so it sent the new one from the start
  const replaced = mergeKeyframePage(next,{...reading,keyframes:[second(0),second(7)],keyframes_revision:2,keyframes_from:0,keyframe_count:2});
  assert.deepEqual(replaced.keyframes,[second(0),second(7)]);
  // a page that cannot follow what is held is dropped, and the next read starts over
  const gap = mergeKeyframePage(first,{...reading,keyframes:[second(9)],keyframes_revision:1,keyframes_from:8,keyframe_count:9});
  assert.deepEqual(gap.keyframes,[]);
  assert.deepEqual(keyframeCursor(gap),{revision:1,from:0});
  const otherScan = mergeKeyframePage(first,{...reading,work_id:"scan-2",keyframes:[second(4)],keyframes_revision:1,keyframes_from:3,keyframe_count:4});
  assert.deepEqual(otherScan.keyframes,[]);
  // a backend without pages sends the whole list each time
  const whole = mergeKeyframePage(first,{...reading,keyframes:seconds(0,2)});
  assert.deepEqual(whole.keyframes,seconds(0,2));
  assert.equal(keyframeCursor(whole),undefined);
});

test("the rest of a long list is read after the scan ends, but never the same page forever", () => {
  const ready = {...pending,status:"ready" as const,keyframes_revision:1,keyframe_count:10};
  const firstPage = mergeKeyframePage(null,{...ready,keyframes:seconds(0,4),keyframes_from:0});
  assert.equal(moreKeyframesToRead(null,firstPage),true);
  const secondPage = mergeKeyframePage(firstPage,{...ready,keyframes:seconds(4,8),keyframes_from:4});
  assert.equal(moreKeyframesToRead(firstPage,secondPage),true);
  const last = mergeKeyframePage(secondPage,{...ready,keyframes:seconds(8,10),keyframes_from:8});
  assert.equal(moreKeyframesToRead(secondPage,last),false);
  // a cursor that never reaches the backend brings back the first page again
  const repeated = mergeKeyframePage(firstPage,{...ready,keyframes:seconds(0,4),keyframes_from:0});
  assert.equal(moreKeyframesToRead(firstPage,repeated),false);
});
