import assert from "node:assert/strict";
import test from "node:test";
import { createTauriBackendClient } from "../../src/backend/tauri.ts";
import type { CutPlanPreview } from "../../src/backend/cutting-types.ts";

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
    fingerprint:"a".repeat(64),issues:[],exact_available:false,exact_reason:"Not available in this build.",
    source_identity:{path:"clip.mp4",size:1000,mtime_ns:"1234567890123456789",signature:"b".repeat(64)},
    segments:[{requested:{start:zero,end},resolved:{start:zero,end},start_kind:"at_start",end_frames_moved:0,audio_source:null,audio_output:null,audio_packet_count:0}],
  };
  const client = createTauriBackendClient(async () => ({data:plan,_request_id:4}));
  const result = await client.createPlan({operation:"cut",source:"clip.mp4",segments:[{start:zero,end}]});
  assert.ok(result.ok);
  assert.equal(result.value.data.segments[0]?.requested.end.ticks,end.ticks);
  assert.equal(result.value._request_id,4);
});
