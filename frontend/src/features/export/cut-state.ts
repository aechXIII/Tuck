import type { CutAnalysisPayload, CutPlanPreview, CutSegment, MediaTime } from "../../backend/cutting-types.ts";

export interface CutClipState {
  generation: number;
  requestKey: string;
  plan: CutPlanPreview | null;
  // the last plan, kept on screen while a changed request is planned so the Inspector does not jump
  shown: CutPlanPreview | null;
  analysis: CutAnalysisPayload | null;
  precision: "keyframes" | "exact";
  includeAudio: boolean;
  workId: string | null;
  error: string;
  // the last answer on Exact, kept while a new plan is prepared so the control does not flicker
  exactAvailable: boolean;
}

export type CutEvent =
  | {type:"request"; key:string}
  | {type:"plan"; generation:number; plan:CutPlanPreview}
  | {type:"analysis"; generation:number; analysis:CutAnalysisPayload}
  | {type:"scan"; workId:string}
  // a failure keeps the current plan unless the backend sent a newer one
  | {type:"failed"; message:string; plan?:CutPlanPreview | null | undefined}
  | {type:"retry"}
  | {type:"precision"; value:"keyframes" | "exact"}
  | {type:"audio"; value:boolean};

export function createCutState(): CutClipState {
  return {generation:0,requestKey:"",plan:null,shown:null,analysis:null,precision:"keyframes",includeAudio:true,workId:null,error:"",exactAvailable:false};
}

export function reduceCutState(state: CutClipState, event: CutEvent): CutClipState {
  if (event.type === "plan" || event.type === "analysis") {
    if (event.generation !== state.generation) return state;
    return event.type === "plan"
      ? {...state,plan:event.plan,shown:event.plan,error:"",exactAvailable:event.plan.exact_available}
      : {...state,analysis:event.analysis,workId:event.analysis.work_id};
  }
  if (event.type === "scan") return {...state,workId:event.workId};
  if (event.type === "failed") {
    const plan = event.plan === undefined ? state.plan : event.plan;
    return {...state,plan,shown:plan ?? state.shown,error:event.message,exactAvailable:plan ? plan.exact_available : state.exactAvailable};
  }
  if (event.type === "retry") return {...state,plan:null,shown:null,error:""};
  if (event.type === "request" && event.key === state.requestKey) return state;
  const change = event.type === "request" ? {requestKey:event.key}
    : event.type === "precision" ? {precision:event.value}
    : {includeAudio:event.value};
  return {...state,...change,generation:state.generation+1,plan:null,error:""};
}

// an older plan segment still describes a row that starts in the same place. Ends are not
// compared: the plan's last end is the analysed stream duration, not the probed one.
export function shownSegment(plan: CutPlanPreview | null | undefined, index: number, range: {start: MediaTime}): CutSegment | undefined {
  const segment = plan?.segments[index];
  if (!segment) return undefined;
  return Math.abs(mediaSeconds(segment.requested.start) - mediaSeconds(range.start)) <= 0.0005 ? segment : undefined;
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

// what the cut makes, said once under the file name: several kept segments become one file
export function cutOutputLine(segmentCount: number, size: string): string {
  const made = segmentCount > 1 ? "Kept segments are joined into this one file" : "The kept segment is saved as this file";
  return size ? `${made} · about ${size}` : made;
}

export type NotReadyReason = "details" | "keyframes" | "exporting" | "unreadable" | "problem";

const NOT_READY_LABELS: Record<NotReadyReason, string> = {
  details: "Reading video details",
  keyframes: "Waiting for keyframes",
  exporting: "Already exporting",
  unreadable: "Can't be read",
  problem: "Can't be cut yet",
};

// names the videos Export all cuts is waiting for, grouped by why, a few names per group
export function notReadyNote(videos: readonly {name: string; reason: NotReadyReason}[], shown = 3): string {
  const groups = new Map<NotReadyReason, string[]>();
  for (const video of videos) groups.set(video.reason, [...groups.get(video.reason) ?? [], video.name]);
  return [...groups].map(([reason, names]) => {
    const listed = names.slice(0, shown).join(", ");
    const more = names.length - shown;
    return `${NOT_READY_LABELS[reason]}: ${listed}${more > 0 ? ` and ${more} more` : ""}.`;
  }).join(" ");
}
