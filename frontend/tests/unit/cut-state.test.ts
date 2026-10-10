import assert from "node:assert/strict";
import test from "node:test";
import { createCutState, reduceCutState, cutSegmentStatus, cutStartUnchecked, cutTrackSummary, encodedSeconds, mediaSeconds, shownSegment } from "../../src/features/export/cut-state.ts";
import { buildCutRequest } from "../../src/features/export/plan-request.ts";
import { createEditorClip } from "../../src/features/editor/types.ts";
import type { CutPlanPreview } from "../../src/backend/cutting-types.ts";

const time = (ticks: number) => ({ticks: String(ticks), time_base_num: 1, time_base_den: 10});
const plan: CutPlanPreview = {
  operation:"cut", precision:"keyframes", container:"mp4", include_audio:true,
  output_path:"/videos/ride_cut.mp4", exported_duration:time(1063), estimated_bytes:1000,
  fingerprint:"a".repeat(64), issues:[], exact_available:false, exact_reason:"Exact is not available yet.", unverified:[], tracks:[], chapter_count:0,
  source_identity:{path:"/videos/ride.mp4",size:1200,mtime_ns:"1",signature:"b".repeat(64)},
  segments:[{requested:{start:time(424),end:time(1200)},resolved:{start:time(440),end:time(1200)},start_kind:"moved",end_frames_moved:3,audio_source:null,audio_output:null,audio_packet_count:0,copied:null}],
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

test("precision and audio choices invalidate the plan without changing other clips", () => {
  for (const event of [{type:"precision",value:"exact"}, {type:"audio",value:false}] as const) {
    const state = {...createCutState(),plan};
    const next = reduceCutState(state,event);
    assert.equal(next.plan,null);
    assert.equal(state.plan,plan);
    assert.equal(next.generation,state.generation+1);
  }
});

test("the last plan stays shown while a changed request is planned, until a retry", () => {
  const ready = reduceCutState(createCutState(),{type:"plan",generation:0,plan});
  assert.equal(ready.shown,plan);
  const flipped = reduceCutState(ready,{type:"precision",value:"exact"});
  assert.equal(flipped.plan,null);
  assert.equal(flipped.shown,plan);
  assert.equal(reduceCutState(flipped,{type:"failed",message:"Could not plan."}).shown,plan);
  assert.equal(reduceCutState(flipped,{type:"retry"}).shown,null);
});

test("a shown plan segment only describes a row that starts in the same place", () => {
  const segment = plan.segments[0]!;
  assert.equal(shownSegment(plan,0,{start:segment.requested.start}),segment);
  assert.equal(shownSegment(plan,0,{start:{ticks:"999",time_base_num:1,time_base_den:10}}),undefined);
  assert.equal(shownSegment(plan,1,{start:segment.requested.start}),undefined);
  assert.equal(shownSegment(null,0,{start:segment.requested.start}),undefined);
});

test("cut request contains only cut intent and preserves fractional frame boundaries", () => {
  const clip = createEditorClip("/videos/ride.mp4");
  clip.probeData = {duration:120,has_audio:true};
  clip.segments = [{start:1001/30000,end:120}];
  const request = buildCutRequest({clip,state:createCutState(),frameDuration:{ticks:"1001",time_base_num:1,time_base_den:30000}});
  assert.equal(request.operation,"cut");
  assert.equal(request.source,clip.path);
  assert.deepEqual(request.segments[0]?.start,{ticks:"1001",time_base_num:1,time_base_den:30000});
  assert.equal(request.include_audio,true);
  assert.equal("video_encoder" in request,false);
  assert.equal("profile_id" in request,false);
  const before = JSON.stringify(clip);
  buildCutRequest({clip,state:createCutState()});
  assert.equal(JSON.stringify(clip),before);
});

test("a cut takes only the kept segments and leaves the clip's other edits for Compress", () => {
  const clip = createEditorClip("/videos/ride.mp4");
  clip.probeData = {duration:12,width:1920,height:1080,has_audio:true};
  clip.crop = {x:100,y:0,width:1200,height:1080};
  clip.rotation = 90;
  clip.flipHorizontal = true;
  clip.segments = [{start:0,end:4,muted:true},{start:6,end:12}];
  clip.audioTimeline = {
    enabled:false,sourceMuted:true,sourceGainDb:-6,sourceWaveformUrl:"",sourceWaveformToken:"",sourceWaveformLoading:false,
    tracks:[{id:"music",sourceDuration:20,muted:true,clips:[{id:"a",timelineStart:0,timelineDuration:5,sourceIn:0,sourceOut:5,fadeIn:1,fadeOut:0,loop:false,muted:true}]}],
  };
  const before = JSON.stringify(clip);
  const request = buildCutRequest({clip,state:createCutState()});
  assert.deepEqual(Object.keys(request).sort(),["include_audio","operation","precision","segments","source"]);
  assert.deepEqual(request.segments.map(range => [mediaSeconds(range.start),mediaSeconds(range.end)]),[[0,4],[6,12]]);
  assert.ok(request.segments.every(range => Object.keys(range).sort().join() === "end,start"));
  // the audio timeline's mutes and Include in export don't reach the cut; its own switch does
  assert.equal(request.include_audio,true);
  assert.equal(buildCutRequest({clip,state:{...createCutState(),includeAudio:false}}).include_audio,false);
  clip.probeData = {...clip.probeData,has_audio:false};
  assert.equal(buildCutRequest({clip,state:createCutState()}).include_audio,false);
  clip.probeData = {...clip.probeData,has_audio:true};
  assert.equal(JSON.stringify(clip),before);
});

test("a selection reaching the source end uses the measured video duration", () => {
  const clip = createEditorClip("/videos/ride.mp4");
  clip.probeData = {duration:12.032,has_audio:true};
  const duration = {ticks:"12",time_base_num:1,time_base_den:1};
  const context = {clip,state:createCutState(),duration};
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

test("exact rows name how much is re-encoded", () => {
  const time = (seconds: number) => ({ticks:String(Math.round(seconds*30)),time_base_num:1,time_base_den:30});
  const segment = (copied: [number, number] | null, kind: "exact" | "keyframe" = "exact") => ({
    requested:{start:time(42.4),end:time(120)},resolved:{start:time(42.4),end:time(120)},start_kind:kind,end_frames_moved:0,
    audio_source:null,audio_output:null,audio_packet_count:0,copied:copied && {start:time(copied[0]),end:time(copied[1])},
  });
  assert.equal(cutSegmentStatus(segment([44,119.9]),"exact"),"Exact · 1.7 s re-encoded");
  assert.equal(cutSegmentStatus(segment(null),"exact"),"This segment is re-encoded");
  assert.equal(cutSegmentStatus(segment([42.4,120],"keyframe"),"exact"),"Starts on a keyframe");
  assert.equal(encodedSeconds(segment([44,119.9]),"keyframes"),0);
  assert.equal(cutSegmentStatus({...segment(null),start_kind:"collapsed"},"exact"),"Too short: under one frame");
});

test("track summary names extra kept tracks and each reason for leaving one out", () => {
  const track = (index: number, kind: string, keep: boolean, reason = "") => ({index, kind, codec:"x", keep, reason});
  const rich: CutPlanPreview = {...plan, chapter_count:2, tracks:[
    track(1,"audio",true), track(2,"audio",true), track(3,"subtitle",true), track(4,"attachment",true),
    track(5,"data",false,"Timecode and data tracks are not kept."), track(6,"data",false,"Timecode and data tracks are not kept."),
  ]};
  assert.deepEqual(cutTrackSummary(rich), {
    kept:"Also keeps 2 audio tracks, 1 subtitle track, 1 attachment, 2 chapters",
    dropped:["Timecode and data tracks are not kept."],
  });
  const silent = {...plan, include_audio:false, tracks:[track(1,"audio",false,"Include audio is off.")]};
  assert.deepEqual(cutTrackSummary(silent), {kept:"", dropped:[]});
});

test("only copied starts are marked when keyframes could not be confirmed", () => {
  const segment = plan.segments[0]!;
  const unchecked = {...plan, unverified:[{code:"unverified_start", message:"Not confirmed.", field:null}]};
  assert.equal(cutStartUnchecked(plan, segment), false);
  assert.equal(cutStartUnchecked(unchecked, segment), true);
  assert.equal(cutStartUnchecked(unchecked, {...segment, start_kind:"at_start"}), false);
  assert.equal(cutStartUnchecked({...unchecked, precision:"exact"}, segment), false);
  assert.equal(cutStartUnchecked({...unchecked, precision:"exact"}, {...segment, copied:segment.resolved}), true);
});

test("failures, retries and scans change only this clip's cut state", () => {
  const ready = reduceCutState(createCutState(), {type:"plan", generation:0, plan:{...plan, exact_available:true}});
  assert.equal(ready.exactAvailable, true);
  // the Exact answer survives while the next plan is prepared
  const pending = reduceCutState(ready, {type:"request", key:"next"});
  assert.equal(pending.plan, null);
  assert.equal(pending.exactAvailable, true);
  const failed = reduceCutState(ready, {type:"failed", message:"The video changed."});
  assert.equal(failed.plan, ready.plan);
  assert.equal(failed.error, "The video changed.");
  const newer = {...plan, fingerprint:"c".repeat(64), exact_available:false};
  const replaced = reduceCutState(ready, {type:"failed", message:"Review the cuts.", plan:newer});
  assert.equal(replaced.plan, newer);
  assert.equal(replaced.exactAvailable, false);
  const retried = reduceCutState(failed, {type:"retry"});
  assert.deepEqual([retried.plan, retried.error, retried.generation], [null, "", failed.generation]);
  assert.equal(reduceCutState(retried, {type:"scan", workId:"scan-2"}).workId, "scan-2");
});
