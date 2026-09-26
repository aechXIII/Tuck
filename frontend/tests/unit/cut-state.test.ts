import assert from "node:assert/strict";
import test from "node:test";
import { createCutState, reduceCutState, cutSegmentStatus, mediaSeconds } from "../../src/features/export/cut-state.ts";
import { buildCutRequest } from "../../src/features/export/plan-request.ts";
import { createEditorClip } from "../../src/features/editor/types.ts";
import type { CutPlanPreview } from "../../src/backend/cutting-types.ts";

const time = (ticks: number) => ({ticks: String(ticks), time_base_num: 1, time_base_den: 10});
const plan: CutPlanPreview = {
  operation:"cut", precision:"keyframes", container:"mp4", include_audio:true,
  output_path:"/videos/ride_cut.mp4", exported_duration:time(1063), estimated_bytes:1000,
  fingerprint:"a".repeat(64), issues:[], exact_available:false, exact_reason:"Exact is not available yet.",
  source_identity:{path:"/videos/ride.mp4",size:1200,mtime_ns:"1",signature:"b".repeat(64)},
  segments:[{requested:{start:time(424),end:time(1200)},resolved:{start:time(440),end:time(1200)},start_kind:"moved",end_frames_moved:3,audio_source:null,audio_output:null,audio_packet_count:0}],
};

test("cut state belongs to each clip and accepts only the current plan generation", () => {
  const a = createCutState();
  const b = createCutState();
  const pending = reduceCutState(a, {type:"request",key:"first"});
  const ready = reduceCutState(pending, {type:"plan",generation:pending.generation,plan});
  assert.equal(ready.plan, plan);
  assert.equal(b.plan, null);
  const changed = reduceCutState(ready, {type:"request",key:"second"});
  assert.equal(changed.plan, null);
  assert.equal(reduceCutState(changed, {type:"plan",generation:pending.generation,plan}), changed);
  assert.equal(reduceCutState(ready, {type:"request",key:"first"}), ready);
});

test("precision, audio and edit choices invalidate the plan without changing other clips", () => {
  for (const event of [{type:"precision",value:"exact"}, {type:"audio",value:false}, {type:"withoutEdits",value:true}] as const) {
    const state = {...createCutState(),plan};
    const next = reduceCutState(state,event);
    assert.equal(next.plan,null);
    assert.equal(state.plan,plan);
    assert.equal(next.generation,state.generation+1);
  }
});

test("cut request contains only cut intent and preserves fractional frame boundaries", () => {
  const clip = createEditorClip("/videos/ride.mp4");
  clip.probeData = {duration:120,has_audio:true};
  clip.segments = [{start:1001/30000,end:120}];
  const request = buildCutRequest({clip,state:createCutState(),edits:["crop"],frameDuration:{ticks:"1001",time_base_num:1,time_base_den:30000}});
  assert.equal(request.operation,"cut");
  assert.equal(request.source,clip.path);
  assert.deepEqual(request.segments[0]?.start,{ticks:"1001",time_base_num:1,time_base_den:30000});
  assert.deepEqual(request.edits,["crop"]);
  assert.equal(request.include_audio,true);
  assert.equal("video_encoder" in request,false);
  assert.equal("profile_id" in request,false);
  const before = JSON.stringify(clip);
  buildCutRequest({clip,state:createCutState(),edits:[]});
  assert.equal(JSON.stringify(clip),before);
});

test("muting all source audio disables inclusion while individual mutes remain an edit", () => {
  const clip = createEditorClip("/videos/ride.mp4");
  clip.probeData = {duration:12,has_audio:true};
  clip.audioTimeline = {enabled:true,sourceMuted:true,sourceGainDb:0,sourceWaveformUrl:"",sourceWaveformToken:"",sourceWaveformLoading:false,tracks:[]};
  assert.equal(buildCutRequest({clip,state:createCutState(),edits:[]}).include_audio,false);
  clip.audioTimeline.sourceMuted = false;
  clip.segments = [{start:0,end:4,muted:true},{start:6,end:12}];
  const request = buildCutRequest({clip,state:createCutState(),edits:[]});
  assert.equal(request.include_audio,true);
  assert.ok(request.edits?.includes("muted_segments"));
});

test("a selection reaching the source end uses the measured video duration", () => {
  const clip = createEditorClip("/videos/ride.mp4");
  clip.probeData = {duration:12.032,has_audio:true};
  const duration = {ticks:"12",time_base_num:1,time_base_den:1};
  const context = {clip,state:createCutState(),edits:[],duration};
  assert.deepEqual(buildCutRequest(context).segments[0]?.end,duration);
  clip.segments = [{start:4,end:12.032}];
  assert.deepEqual(buildCutRequest(context).segments[0]?.end,duration);
  clip.segments = [{start:4,end:11.5}];
  assert.equal(mediaSeconds(buildCutRequest(context).segments[0]!.end),11.5);
});

test("cut status reports the backend's movement and early end together", () => {
  assert.equal(mediaSeconds(time(424)),42.4);
  assert.equal(cutSegmentStatus(plan.segments[0]!),"Starts 1.6 s later, at 0:44 · Ends 3 frames early");
  assert.equal(cutSegmentStatus({...plan.segments[0]!,start_kind:"collapsed"}),"Too short: no keyframe inside");
});
