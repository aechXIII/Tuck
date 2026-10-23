import type { BackendClient } from "../../backend/types.ts";
import { isCutPlanPayload, keyframeCursor, mergeKeyframePage, moreKeyframesToRead, type CutPlanRequest, type CutPlanPreview } from "../../backend/cutting-types.ts";
import type { EditorClip } from "../editor/types.ts";
import type { EditorSession } from "../editor/session.ts";
import { formatBytes, formatTimeToHundredths } from "../editor/format.ts";
import { toast } from "../editor/toast.ts";
import { isQueueActive, queuedVideoLabel } from "../queue/queue-view.ts";
import { swapLabel } from "../../ui/motion.ts";
import { createCutState, cutSegmentStatus, cutStartUnchecked, cutTime, cutTrackSummary, encodedSeconds, mediaSeconds, reduceCutState, shownSegment } from "./cut-state.ts";

interface CutControlsDeps {
  session: EditorSession;
  client: () => BackendClient;
  request: (clip: EditorClip) => CutPlanRequest;
  selectSegment: (index: number, time: number) => void;
  moveStarts: (clip: EditorClip, plan: CutPlanPreview) => boolean;
  pollQueue: () => void | Promise<void>;
  paintTimeline: () => void;
}

export function installCutControls(deps: CutControlsDeps) {
  const {session,client} = deps;
  const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing #${id}`);
    return node as T;
  };
  const state = (clip: EditorClip) => clip.cutState ??= createCutState();
  const selected = () => session.selPath ? session.clips[session.selPath] : undefined;
  let active = false;
  let busy = false;
  let refreshDeferred = false;
  let ticket = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning: {clip:EditorClip;workId:string} | null = null;
  let pendingPath: string | null = null;
  // settles whenever the pending plan does, so an export clicked meanwhile can wait for it
  let settled = Promise.resolve();
  let settle = () => {};
  let waiting = false;
  const main = element("main");
  const playerBar = element("player-bar");
  // on narrow windows the Inspector opens over the stage; in the cut task it stops above the
  // player bar, so the cut points and keyframe steps stay in reach while it is open
  const measureWorkspace = () => {
    const bar = playerBar.getBoundingClientRect();
    const top = bar.height > 0 ? bar.top : main.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty("--cut-workspace-bottom",`${window.innerHeight-top}px`);
  };
  const workspace = new ResizeObserver(measureWorkspace);
  workspace.observe(main);
  workspace.observe(playerBar);
  measureWorkspace();

  function syncRequest(clip: EditorClip): CutPlanRequest {
    const request = deps.request(clip);
    clip.cutState = reduceCutState(state(clip),{type:"request",key:JSON.stringify(request)});
    return request;
  }

  function ready(clip: EditorClip): boolean {
    const current = state(clip);
    return !!current.plan && !current.plan.issues.length && !current.error
      && current.requestKey === JSON.stringify(deps.request(clip));
  }

  function setPending(path: string | null): void {
    settle();
    pendingPath = path;
    if (path) settled = new Promise(resolve => { settle = resolve; });
  }

  // a changed request is being planned from keyframes already read, and the plan on screen
  // could export; the button stays usable and an export waits for the new plan
  function replanning(clip: EditorClip): boolean {
    const current = state(clip);
    return pendingPath === clip.path && current.analysis?.status === "ready" && !current.error
      && !!current.shown && !current.shown.issues.length;
  }

  function exportable(clip: EditorClip): boolean {
    return (ready(clip) || replanning(clip)) && !exporting(clip);
  }

  // a cut already waiting or running in the queue can't be exported again until it finishes
  function exporting(clip: EditorClip): boolean {
    return isQueueActive(clip._queueState);
  }

  function stopScan(): void {
    if (scanning) void client().cancelCutWork(scanning.workId);
    scanning = null;
  }

  function setActive(value: boolean): void {
    active = value;
    // nothing to coalesce when the task opens, so keyframes start reading straight away
    if (value) refresh(0);
    else {
      if (!busy) {
        ticket += 1;
        clearTimeout(timer);
        stopScan();
        setPending(null);
      }
      deps.paintTimeline();
    }
  }

  // drags are coalesced; a switch flip is planned straight away
  function refresh(delay = 180): void {
    if (!active) return;
    if (busy) { refreshDeferred = true; return; }
    refreshDeferred = false;
    const clip = selected();
    const currentTicket = ++ticket;
    clearTimeout(timer);
    if (scanning && scanning.clip !== clip) stopScan();
    setPending(clip?.probed ? clip.path : null);
    if (!clip?.probed) { render(); return; }
    syncRequest(clip);
    render();
    // generation checks also discard already-running previews
    timer = setTimeout(() => {
      void prepare(clip,() => active && ticket === currentTicket && session.clips[clip.path] === clip)
        .finally(() => {
          if (ticket === currentTicket) { setPending(null); render(); }
        });
    },delay);
  }

  async function prepare(clip: EditorClip, current: () => boolean): Promise<CutPlanPreview | null> {
    try {
      // each status read sends only the keyframes this clip doesn't hold yet
      let held = state(clip).analysis;
      let result = await client().getCutAnalysis(clip.path,keyframeCursor(held));
      if (!current()) return null;
      if (!result.ok) throw new Error(result.error.message);
      if (["missing","cancelled","failed"].includes(result.value.status)) {
        const workId = crypto.randomUUID();
        scanning = {clip,workId};
        clip.cutState = reduceCutState(state(clip),{type:"scan",workId});
        result = await client().analyzeCut(clip.path,workId);
      }
      while (current()) {
        if (!result.ok) throw new Error(result.error.message);
        const analysis = mergeKeyframePage(held,result.value);
        const more = moreKeyframesToRead(held,analysis);
        held = analysis;
        const previous = state(clip).analysis;
        if (analysis.status === "ready" && (previous?.status !== "ready" || previous.work_id !== analysis.work_id) && selected() === clip) {
          element("cut-announcement").textContent = "Keyframes read.";
        }
        clip.cutState = reduceCutState(state(clip),{type:"analysis",generation:state(clip).generation,analysis});
        if (selected() === clip) render();
        if (analysis.status === "ready") {
          if (!more) break;
        } else if (!["reading","pending"].includes(analysis.status)) {
          throw new Error(analysis.issue?.message ?? "Keyframes could not be read. Read them again to retry.");
        } else {
          scanning = {clip,workId:analysis.work_id};
          // a status read is cheap, and a short video is often read in well under a second
          await new Promise(resolve => setTimeout(resolve,150));
          if (!current()) return null;
        }
        result = await client().getCutAnalysis(clip.path,keyframeCursor(held));
      }
      if (!current()) return null;
      if (scanning?.clip === clip) scanning = null;
      const request = syncRequest(clip);
      const generation = state(clip).generation;
      const response = await client().createPlan(request);
      if (!current() || generation !== state(clip).generation || JSON.stringify(deps.request(clip)) !== JSON.stringify(request)) return null;
      if (!response.ok) throw new Error(response.error.message);
      clip.cutState = reduceCutState(state(clip),{type:"plan",generation,plan:response.value.data});
      return response.value.data;
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : "The cut could not be prepared. Read keyframes again to retry.";
        clip.cutState = reduceCutState(state(clip),{type:"failed",message,plan:null});
      }
      return null;
    }
  }

  function render(): void {
    if (!active) return;
    const clip = selected();
    const current = clip ? state(clip) : null;
    const plan = current?.plan;
    // while a changed request is planned the last plan stays on screen; export waits for the new one
    const shown = plan ?? (current?.error ? null : current?.shown ?? null);
    const pending = !!clip && pendingPath === clip.path;
    const reading = pending && current?.analysis?.status !== "ready";
    const request = clip ? deps.request(clip) : null;
    const issue = shown?.issues.find(issue => issue.code !== "segment_collapsed");
    const message = !clip ? "Choose a video to cut."
      : !clip.probed ? clip.error || "Reading video details…" : current?.error || issue?.message || "";
    element("cut-message").textContent = message;
    element("cut-message").hidden = !message;
    element("cut-reread").hidden = !clip?.probed || !current?.error;
    const precision = current?.precision ?? "keyframes";
    const exactAvailable = current?.exactAvailable ?? false;
    // only give a reason once the backend has said why; while reading keyframes it is unknown
    const exactReason = shown?.exact_reason || current?.analysis?.analysis?.exact_reason || "";
    const keyframesOption = element<HTMLInputElement>("cut-keyframes");
    const exactOption = element<HTMLInputElement>("cut-exact");
    keyframesOption.checked = precision === "keyframes";
    exactOption.checked = precision === "exact";
    keyframesOption.disabled = busy;
    exactOption.disabled = !exactAvailable && precision !== "exact" || busy;
    // an unavailable Exact explains why in place of what it does
    element("cut-exact-note").textContent = !exactAvailable && exactReason && precision !== "exact"
      ? exactReason : "Cuts on any frame. Re-encodes only from each cut to its nearest keyframe.";
    const ranges = request?.segments ?? [];
    element("cuts-title").textContent = ranges.length ? `Segments · ${ranges.length} kept` : "Segments";
    const list = element<HTMLOListElement>("cut-list");
    const count = message ? 0 : ranges.length;
    while (list.children.length > count) list.lastElementChild?.remove();
    for (let index = 0; index < count; index++) {
      let row = list.children[index];
      if (!row) {
        row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cut-row-btn";
        button.dataset.cutIndex = String(index);
        for (const name of ["cut-n","cut-range","cut-dur","cut-status"]) {
          const span = document.createElement("span"); span.className = name; button.append(span);
        }
        row.append(button); list.append(row);
      }
      row.className = `cut-row${index === clip?.activeSegment ? " active" : ""}`;
      const button = row.querySelector("button")!;
      const range = ranges[index]!;
      const segment = plan ? plan.segments[index] : shownSegment(shown,index,range);
      const planned = shown?.precision ?? precision;
      const status = !segment ? "Checking keyframes…"
        : `${cutSegmentStatus(segment, planned)}${shown && cutStartUnchecked(shown, segment) ? " · Start not checked" : ""}`;
      const rangeText = `${formatTimeToHundredths(mediaSeconds(range.start))} – ${formatTimeToHundredths(mediaSeconds(range.end))}`;
      button.children[0]!.textContent = String(index+1);
      button.children[1]!.textContent = rangeText;
      button.children[2]!.textContent = segment ? formatTimeToHundredths(mediaSeconds(segment.resolved.end)-mediaSeconds(segment.resolved.start)) : "";
      const kind = !segment ? "pending" : segment.start_kind === "collapsed" ? "collapsed" : encodedSeconds(segment, planned) > 0 ? "exact" : segment.start_kind === "moved" ? "moved" : "ok";
      // a clean start needs no note; a few frames off the end stay in the tooltip
      const quiet = kind === "ok" && !status.includes("Start not checked");
      button.children[3]!.textContent = status;
      button.children[3]!.className = `cut-status ${kind}`;
      (button.children[3] as HTMLElement).hidden = quiet;
      if (quiet) button.dataset.tip = status;
      else delete button.dataset.tip;
      button.setAttribute("aria-label",`Segment ${index+1}, ${rangeText}. ${status}`);
      button.setAttribute("aria-pressed",String(index === clip?.activeSegment));
    }
    element("snap-all").hidden = !shown?.segments.some(segment => segment.start_kind === "moved");
    element<HTMLButtonElement>("snap-all").disabled = pending || busy || !!plan?.issues.length;
    element("cut-scan").hidden = !reading || !!current?.error;
    const progress = current?.analysis?.progress;
    element("cut-scan-text").textContent = `Reading keyframes…${typeof progress === "number" ? ` ${Math.round(progress*100)}%` : ""}`;
    const bar = element<HTMLProgressElement>("cut-scan-bar");
    if (typeof progress === "number") bar.value = progress*100;
    else bar.removeAttribute("value");
    element("out-name").textContent = shown?.output_path.split(/[\\/]/).pop() || "Output appears when the cut is ready.";
    element("out-name").title = shown?.output_path ?? "";
    const videoCodec = clip?.probeData?.video_codec === "h264" ? "H.264" : clip?.probeData?.video_codec?.toUpperCase() || "Video";
    const audioCodec = clip?.probeData?.audio_codec?.toUpperCase() || "Audio";
    element("out-meta").textContent = shown ? `${shown.container.toUpperCase()} · ${videoCodec}${shown.include_audio ? ` + ${audioCodec}` : ""} · ${cutTime(mediaSeconds(shown.exported_duration))} · about ${formatBytes(shown.estimated_bytes)}` : "";
    const tracks = shown ? cutTrackSummary(shown) : {kept:"",dropped:[]};
    element("out-tracks").textContent = tracks.kept;
    element("out-tracks").hidden = !tracks.kept;
    element("cut-dropped").textContent = tracks.dropped.join(" ");
    element("cut-dropped").hidden = !tracks.dropped.length;
    const notes = shown?.unverified ?? [];
    element("cut-unchecked").hidden = !notes.length;
    element("cut-unchecked-list").replaceChildren(...notes.map(note => {
      const item = document.createElement("li"); item.textContent = note.message; return item;
    }));
    element<HTMLInputElement>("cut-audio").checked = request?.include_audio === true;
    element<HTMLInputElement>("cut-audio").disabled = !clip?.probed || clip.probeData?.has_audio === false || busy;
    const one = element<HTMLButtonElement>("btn-one");
    // a cut already in the queue shows its export, and the button opens it in Exports
    const queued = !busy && !!clip && exporting(clip);
    const label = busy ? "Exporting…"
      : queued ? queuedVideoLabel(clip._queueState, clip._statusText, clip._progress, clip._progressIndeterminate)
      : reading ? "Reading keyframes…" : "Export cut";
    swapLabel(one, label);
    one.disabled = queued ? false : !clip || !exportable(clip) || busy || waiting;
    if (queued) {
      one.dataset.queued = "true";
      one.dataset.tip = "Show in Exports";
      one.setAttribute("aria-label", `${label}. Show in Exports`);
    } else if (one.dataset.queued === "true") {
      delete one.dataset.queued;
      delete one.dataset.tip;
      one.removeAttribute("aria-label");
    }
    const clips = Object.values(session.clips);
    const all = element<HTMLButtonElement>("btn-all");
    all.textContent = `Export all cuts${clips.length ? ` (${clips.length})` : ""}`;
    all.disabled = !clips.length || busy || waiting || clips.some(item => !exportable(item));
    const note = element("btn-all-note");
    note.textContent = all.disabled && clips.length > 1 ? "Every video needs its cuts ready first." : "";
    note.hidden = !note.textContent;
    deps.paintTimeline();
  }

  function focusRow(index: number): void {
    render();
    const row = element("cut-list").querySelector<HTMLButtonElement>(`[data-cut-index="${index}"]`);
    // the compact Inspector can be closed; the timeline keeps focus then
    if (row && row.getClientRects().length) row.focus();
  }

  async function exportCuts(all: boolean): Promise<void> {
    if (busy || waiting) return;
    waiting = true;
    try {
      while (pendingPath) await settled;
    } finally {
      waiting = false;
    }
    if (busy) return;
    const clips = all ? session.clipOrder.map(path => session.clips[path]).filter((clip): clip is EditorClip => !!clip) : selected() ? [selected()!] : [];
    if (!clips.length || clips.some(clip => !ready(clip) || exporting(clip))) return;
    const reviewed = clips.map(clip => ({clip,fingerprint:state(clip).plan!.fingerprint,requestKey:state(clip).requestKey}));
    busy = true; const exportTicket = ++ticket; clearTimeout(timer); render();
    try {
      for (const {clip,fingerprint,requestKey} of reviewed) {
        if (session.clips[clip.path] !== clip || JSON.stringify(deps.request(clip)) !== requestKey) {
          toast("The cuts changed. Review them before exporting.","err"); break;
        }
        const current = () => session.clips[clip.path] === clip && ticket === exportTicket;
        const plan = await prepare(clip,current);
        if (!plan || !current()) {
          toast(state(clip).error || "The cuts changed. Review them before exporting.","err");
          break;
        }
        if (plan.fingerprint !== fingerprint || plan.issues.length) {
          const message = "The cut plan changed. Review the current cuts before exporting.";
          clip.cutState = reduceCutState(state(clip),{type:"failed",message});
          toast(`${clip.name}: ${message}`,"err"); break;
        }
        const request = syncRequest(clip);
        const response = await client().enqueueWithOptions({...request,plan_fingerprint:fingerprint});
        if (!response.ok) {
          const latest = response.error.details?.current_plan;
          const payload = {data:latest};
          clip.cutState = reduceCutState(state(clip),{type:"failed",message:response.error.message,plan:isCutPlanPayload(payload) ? payload.data : undefined});
          toast(`${clip.name}: ${response.error.message}`,"err"); break;
        }
        clip._queueState = "pending";
        if (typeof response.value.item_id === "string") clip._queueItemId = response.value.item_id;
        await deps.pollQueue();
      }
    } finally {
      busy = false;
      const clip = selected();
      const deferred = refreshDeferred;
      refreshDeferred = false;
      // keep export errors visible until the user retries or changes the request
      if (active && deferred && (!clip || !state(clip).error || state(clip).requestKey !== JSON.stringify(deps.request(clip)))) refresh();
      else render();
    }
  }

  element("cut-list").addEventListener("click",event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-cut-index]") : null;
    const clip = selected();
    if (!button || !clip) return;
    const index = Number(button.dataset.cutIndex);
    const range = state(clip).plan?.segments[index]?.resolved ?? deps.request(clip).segments[index];
    if (range) deps.selectSegment(index,mediaSeconds(range.start));
    render();
  });
  element("snap-all").addEventListener("click",() => {
    const clip = selected(); const plan = clip && state(clip).plan;
    if (clip && plan && ready(clip) && deps.moveStarts(clip,plan)) refresh();
  });
  element("cut-precision").addEventListener("change",event => {
    const clip = selected();
    const value = event.target instanceof HTMLInputElement ? event.target.value : "";
    if (!clip || value !== "keyframes" && value !== "exact" || state(clip).precision === value) return;
    clip.cutState = reduceCutState(state(clip),{type:"precision",value}); refresh(0);
  });
  element<HTMLInputElement>("cut-audio").addEventListener("change",event => {
    const clip = selected(); if (!clip) return;
    clip.cutState = reduceCutState(state(clip),{type:"audio",value:(event.currentTarget as HTMLInputElement).checked}); refresh(0);
  });
  element("cut-reread").addEventListener("click",() => {
    const clip = selected(); if (clip) { clip.cutState = reduceCutState(state(clip),{type:"retry"}); refresh(); }
  });
  return {setActive,refresh,render,exportCuts,focusRow};
}
