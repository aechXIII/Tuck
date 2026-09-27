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

// seconds of video an Exact plan encodes for this segment
export function encodedSeconds(segment: CutSegment, precision: "keyframes" | "exact"): number {
  if (precision !== "exact" || segment.start_kind === "collapsed") return 0;
  const start = mediaSeconds(segment.resolved.start), end = mediaSeconds(segment.resolved.end);
  if (!segment.copied) return end - start;
  return mediaSeconds(segment.copied.start) - start + end - mediaSeconds(segment.copied.end);
}

export function cutSegmentStatus(segment: CutSegment, precision: "keyframes" | "exact" = "keyframes"): string {
  if (segment.start_kind === "collapsed") {
    return precision === "exact" ? "Too short: under one frame" : "Too short: no keyframe inside";
  }
  if (precision === "exact") {
    const encoded = encodedSeconds(segment, precision);
    if (!segment.copied) return "This segment is re-encoded";
    if (encoded > 0) return `Exact · ${Number(encoded.toFixed(3))} s re-encoded`;
  }
  const delta = mediaSeconds(segment.resolved.start) - mediaSeconds(segment.requested.start);
  const start = segment.start_kind === "moved"
    ? `Starts ${Number(delta.toFixed(3))} s later, at ${cutTime(mediaSeconds(segment.resolved.start))}`
    : segment.start_kind === "at_start" ? "Starts at the beginning" : "Starts on a keyframe";
  const frames = segment.end_frames_moved;
  return frames ? `${start} · Ends ${frames} frame${frames === 1 ? "" : "s"} early` : start;
}

// cuts that copy from a keyframe the backend could not confirm as a clean start
export function cutStartUnchecked(plan: CutPlanPreview, segment: CutSegment): boolean {
  if (!plan.unverified.some(note => note.code === "unverified_start")) return false;
  if (segment.start_kind === "at_start" || segment.start_kind === "collapsed") return false;
  return plan.precision === "keyframes" || segment.copied !== null;
}

function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// what the output keeps besides the video and first audio track, and what it leaves out
export function cutTrackSummary(plan: CutPlanPreview): {kept: string; dropped: string[]} {
  const kept = plan.tracks.filter(track => track.keep);
  const count = (kind: string) => kept.filter(track => track.kind === kind).length;
  const audio = count("audio");
  const parts = [
    audio > 1 ? counted(audio, "audio track") : "",
    count("subtitle") ? counted(count("subtitle"), "subtitle track") : "",
    count("video") ? counted(count("video"), "cover image") : "",
    count("attachment") ? counted(count("attachment"), "attachment") : "",
    plan.chapter_count ? counted(plan.chapter_count, "chapter") : "",
  ].filter(Boolean);
  // the audio switch already says when audio is left out
  const reasons = plan.tracks
    .filter(track => !track.keep && track.reason && !(track.kind === "audio" && !plan.include_audio))
    .map(track => track.reason);
  return {kept: parts.length ? `Also keeps ${parts.join(", ")}` : "", dropped: [...new Set(reasons)]};
}
