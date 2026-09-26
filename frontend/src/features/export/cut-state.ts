import type { CutAnalysisPayload, CutPlanPreview, CutSegment, MediaTime } from "../../backend/cutting-types.ts";

export interface CutClipState {
  generation: number;
  requestKey: string;
  plan: CutPlanPreview | null;
  analysis: CutAnalysisPayload | null;
  precision: "keyframes" | "exact";
  includeAudio: boolean;
  withoutEdits: boolean;
  workId: string | null;
  error: string;
}

type CutEvent =
  | {type:"request"; key:string}
  | {type:"plan"; generation:number; plan:CutPlanPreview}
  | {type:"analysis"; generation:number; analysis:CutAnalysisPayload}
  | {type:"precision"; value:"keyframes" | "exact"}
  | {type:"audio" | "withoutEdits"; value:boolean};

export function createCutState(): CutClipState {
  return {generation:0,requestKey:"",plan:null,analysis:null,precision:"keyframes",includeAudio:true,withoutEdits:false,workId:null,error:""};
}

export function reduceCutState(state: CutClipState, event: CutEvent): CutClipState {
  if (event.type === "plan" || event.type === "analysis") {
    if (event.generation !== state.generation) return state;
    return event.type === "plan" ? {...state,plan:event.plan,error:""} : {...state,analysis:event.analysis,workId:event.analysis.work_id};
  }
  if (event.type === "request" && event.key === state.requestKey) return state;
  const change = event.type === "request" ? {requestKey:event.key}
    : event.type === "precision" ? {precision:event.value}
    : event.type === "audio" ? {includeAudio:event.value} : {withoutEdits:event.value};
  return {...state,...change,generation:state.generation+1,plan:null,error:""};
}

export function mediaSeconds(time: MediaTime): number {
  return Number(time.ticks) * time.time_base_num / time.time_base_den;
}

export function cutTime(seconds: number): string {
  const tenths = Math.round(Math.max(0,seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const secondsText = String(Math.floor(tenths / 10) % 60).padStart(2,"0");
  const fraction = tenths % 10 ? `.${tenths % 10}` : "";
  return minutes >= 60 ? `${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")}:${secondsText}${fraction}` : `${minutes}:${secondsText}${fraction}`;
}

export function cutSegmentStatus(segment: CutSegment): string {
  if (segment.start_kind === "collapsed") return "Too short: no keyframe inside";
  const delta = mediaSeconds(segment.resolved.start) - mediaSeconds(segment.requested.start);
  const start = segment.start_kind === "moved"
    ? `Starts ${Number(delta.toFixed(3))} s later, at ${cutTime(mediaSeconds(segment.resolved.start))}`
    : segment.start_kind === "at_start" ? "Starts at the beginning" : "Starts on a keyframe";
  const frames = segment.end_frames_moved;
  return frames ? `${start} · Ends ${frames} frame${frames === 1 ? "" : "s"} early` : start;
}
