import type {
  NativePlayerStatus,
  PlayerEngine,
} from "../../backend/native-player.ts";
import type { BackendError, BackendResult } from "../../backend/types.ts";
import {
  hasPlacement,
  playbackTarget as defaultPlaybackTarget,
  sourceTimeAt,
} from "../timeline/segments.ts";
import type { SegmentRange } from "../timeline/segments.ts";
import { LUT_CHANGE_EVENT, LUT_REQUEST_EVENT, type LutChange } from "../preview/lut-preview.ts";
import { SOURCE_EVENT, SOURCE_FAILED_EVENT, SOURCE_READY_EVENT } from "../preview/preview-controller.ts";
import {
  defaultClock,
  installVolumeControls,
  nextPlaybackSpeed,
  showPlaybackSpeed,
  type PlayerApi,
  type PlayerHost,
} from "./player.ts";

// the engine is asked for its status this often while its clock runs; between replies the
// playhead follows the page's own monotonic clock, so nothing crosses the bridge per frame
const STATUS_INTERVAL_MS = 100;

type Step =
  | { readonly kind: "open"; readonly duration: number; readonly path: string | null }
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "seek"; readonly seconds: number }
  | { readonly kind: "volume"; readonly volume: number }
  | { readonly kind: "rate"; readonly rate: number }
  | { readonly kind: "status" };

/**
 * The editor's player driven by the native engine instead of the `<video>` element. The engine
 * owns the clock in timeline time; the page only asks it to play, pause and seek, and the hidden
 * `<video>` keeps the paused position for code that still reads it. Commands go one at a time in
 * order, so seek request IDs always go up and a late reply never moves the playhead back.
 */
export function installNativePlayer(host: PlayerHost, engine: PlayerEngine): PlayerApi {
  const clock = host.clock ?? defaultClock();
  const now = clock.now ?? (() => performance.now());
  const volume = installVolumeControls(host);
  const video = host.byId<HTMLVideoElement>("vid");

  let disposed = false;
  // each shown video gets a new epoch; replies that arrive for an older one are dropped
  let epoch = 0;
  let opened = false;
  // the video the stage shows, which the engine plays whether or not the webview can read it
  let shownPath: string | null = null;
  // the chosen playback speed, which every video opened after keeps
  let speed = 1;
  let status: NativePlayerStatus | null = null;
  let statusAt = 0;
  // what the user asked for; the play button shows what the engine confirmed
  let wantPlaying = false;
  // where the newest seek goes, shown until the engine confirms it
  let target: number | null = null;
  let seekWanted: number | null = null;
  let requestId = 0;
  let sentSeekId = 0;
  let previewSec: number | null = null;
  let previewGap = false;
  // the epoch whose decoder failure was already reported
  let reportedFailure = -1;
  let reportedSoftware = -1;
  let reportedReady = -1;
  const steps: Step[] = [];
  let busy = false;
  let pollTimer = 0;
  let frameLoop = 0;
  let seekFrame = 0;
  let mirrorBusy = false;
  let mirrorWanted: number | null = null;
  // the level last sent for the open video
  let sentVolume: number | null = null;
  // the LUT to send next (undefined when there is nothing new) and the table the engine has
  let lutWanted: LutChange | null | undefined;
  let lutSent: Float32Array | null = null;
  let lutBusy = false;
  // moved clips: the engine plays the file's own time inside one segment at a time, and between
  // segments the page keeps the timeline position itself, as the HTML player does
  let engineSegment = -1;
  let gapPosition: number | null = null;
  let gapAt = 0;
  let lastRanges: SegmentRange[] = [];

  function segments(): readonly SegmentRange[] {
    return host.playbackSegments();
  }

  function placed(): boolean {
    return hasPlacement(segments());
  }

  function projectEnd(): number {
    return segments().at(-1)?.end ?? 0;
  }

  function loopEnabled(): boolean {
    return host.loopPlayback?.() ?? true;
  }

  function playbackTarget(ranges: readonly SegmentRange[], time: number, tolerance?: number): number | null {
    const mutable = ranges as SegmentRange[];
    if (host.SegmentEditing?.playbackTarget) return host.SegmentEditing.playbackTarget(mutable, time, tolerance);
    return defaultPlaybackTarget(mutable, time, tolerance);
  }

  function segmentAt(ranges: readonly SegmentRange[], time: number): number {
    return ranges.findIndex((segment) => time >= segment.start && time < segment.end);
  }

  // where the engine is in the file, read between status replies
  function enginePosition(): number | null {
    if (!status) return null;
    let time = status.positionSeconds;
    if (!status.paused && !status.seekPending) time += (Math.max(0, now() - statusAt) / 1000) * status.rate;
    return Math.min(status.durationSeconds, time);
  }

  // the engine's file time on the timeline, through the segment it is playing
  function engineOnTimeline(ranges: readonly SegmentRange[], source: number): number {
    const segment = ranges[engineSegment];
    if (!segment) return source;
    const time = segment.start + source - (segment.sourceStart ?? segment.start);
    return Math.min(segment.end, Math.max(segment.start, time));
  }

  // the timeline position while no segment is under the playhead, moving while playing
  function gapTime(): number {
    if (gapPosition == null) return previewSec ?? 0;
    return wantPlaying ? gapPosition + ((now() - gapAt) / 1000) * speed : gapPosition;
  }

  function position(): number {
    if (target != null) return target;
    if (placed() && engineSegment < 0) return gapTime();
    const source = enginePosition();
    if (source == null) return previewSec ?? 0;
    return placed() ? engineOnTimeline(segments(), source) : source;
  }

  function copyRanges(ranges: readonly SegmentRange[]): SegmentRange[] {
    return ranges.map((segment) => ({ ...segment }));
  }

  function sameRanges(a: readonly SegmentRange[], b: readonly SegmentRange[]): boolean {
    return a.length === b.length && a.every((segment, index) => {
      const other = b[index];
      return other !== undefined && segment.start === other.start && segment.end === other.end
        && segment.sourceStart === other.sourceStart;
    });
  }

  // an edit, a slip or an undo can change which footage is under the playhead; the engine follows
  // so the picture is the one the timeline shows
  function syncRanges(): void {
    const ranges = segments();
    if (sameRanges(ranges, lastRanges)) return;
    const wasPlaced = hasPlacement(lastRanges);
    let time: number;
    if (target != null) time = target;
    else if (wasPlaced && engineSegment < 0) time = gapTime();
    else {
      const source = enginePosition();
      time = source == null ? previewSec ?? 0 : wasPlaced ? engineOnTimeline(lastRanges, source) : source;
    }
    lastRanges = copyRanges(ranges);
    if (!wasPlaced && !hasPlacement(ranges)) return;
    if (!opened) return;
    const playing = wantPlaying;
    seekTo(time);
    if (playing) play();
  }

  function sourcePosition(): number | null {
    const time = position();
    return placed() ? sourceTimeAt(segments(), time) : time;
  }

  function enqueue(step: Step): void {
    if (disposed) return;
    // the newest seek or level replaces one still waiting, so scrubbing never builds a backlog
    const last = steps.at(-1);
    if ((step.kind === "seek" || step.kind === "volume" || step.kind === "rate") && last?.kind === step.kind) steps[steps.length - 1] = step;
    else if (step.kind !== "status" || !steps.some((queued) => queued.kind === "status")) steps.push(step);
    void pump();
  }

  function send(step: Step): Promise<BackendResult<NativePlayerStatus>> {
    switch (step.kind) {
      case "open":
        requestId = 0;
        sentSeekId = 0;
        return engine.open({ durationSeconds: step.duration, path: step.path });
      case "seek":
        sentSeekId = ++requestId;
        return engine.command({ kind: "seek", requestId: sentSeekId, seconds: step.seconds });
      case "volume":
        return engine.command({ kind: "volume", volume: step.volume });
      case "rate":
        return engine.command({ kind: "rate", rate: step.rate });
      case "status":
        return engine.status();
      default:
        return engine.command({ kind: step.kind });
    }
  }

  async function pump(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (let step = steps.shift(); step && !disposed; step = steps.shift()) {
        const sentEpoch = epoch;
        const result = await send(step);
        if (disposed || sentEpoch !== epoch) continue;
        if (result.ok) accept(result.value);
        else refuse(step, result.error);
      }
    } finally {
      busy = false;
    }
  }

  function accept(next: NativePlayerStatus): void {
    const wasPaused = status?.paused ?? true;
    status = next;
    statusAt = now();
    const seekQueued = seekWanted != null || steps.some((step) => step.kind === "seek");
    const confirmed = target != null && !seekQueued && next.confirmedSeekRequestId === sentSeekId;
    if (confirmed) target = null;
    // in a gap the engine waits while the page plays on
    host.byId("btn-play")?.classList.toggle("playing", !next.paused || (wantPlaying && placed() && engineSegment < 0));
    if (next.video?.failed && reportedFailure !== epoch) {
      reportedFailure = epoch;
      console.error("The native player stopped", next.video.error);
      video?.dispatchEvent(new Event(SOURCE_FAILED_EVENT));
    } else if (!next.video?.failed && !next.seekPending && reportedReady !== epoch) {
      // the first frame of this video is showing
      reportedReady = epoch;
      video?.dispatchEvent(new Event(SOURCE_READY_EVENT));
    }
    if (next.video?.softwareReason && reportedSoftware !== epoch) {
      reportedSoftware = epoch;
      console.info("The native player decodes in software", next.video.decoder, next.video.softwareReason);
    }
    if (next.ended && wantPlaying) {
      // a segment can run to the end of the file while the timeline goes on
      const segment = placed() ? segments()[engineSegment] : undefined;
      if (segment && segment.end < projectEnd()) continuePlaybackAt(segment.end);
      else finish();
      return;
    }
    if (!next.paused) startFrameLoop();
    else if (target == null) {
      updateTime();
      mirror(sourcePosition());
    }
    // the source and imported audio follow this clock as they follow the HTML video's timeupdate
    if (wasPaused !== next.paused || !next.paused || confirmed) host.AudioTimeline?.syncPreview?.();
    schedulePoll();
  }

  function refuse(step: Step, error: BackendError): void {
    console.error(`The native player could not ${step.kind}`, error);
    if (step.kind === "open") {
      opened = false;
      // a file the engine refused isn't tried again until the stage shows a video anew
      shownPath = null;
      if (reportedFailure !== epoch) {
        reportedFailure = epoch;
        video?.dispatchEvent(new Event(SOURCE_FAILED_EVENT));
      }
    }
    if (step.kind === "seek") target = null;
    if (step.kind === "play") {
      wantPlaying = false;
      stopFrameLoop();
    }
    updateTime();
  }

  function schedulePoll(): void {
    const running = status != null && (!status.paused || status.seekPending);
    if (!running || pollTimer || disposed) return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = 0;
      enqueue({ kind: "status" });
    }, STATUS_INTERVAL_MS);
  }

  function stopPoll(): void {
    if (pollTimer) clock.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  // the hidden <video> keeps the paused position for the source audio preview and anything
  // else that reads it, without restarting a seek it is still working on
  function mirror(seconds: number | null): void {
    if (!video || seconds == null || disposed) return;
    mirrorWanted = seconds;
    if (mirrorBusy) return;
    const next = mirrorWanted;
    mirrorWanted = null;
    if (Math.abs((video.currentTime || 0) - next) < 0.002) return;
    mirrorBusy = true;
    const done = (): void => {
      mirrorBusy = false;
      if (mirrorWanted != null) mirror(mirrorWanted);
    };
    video.addEventListener("seeked", done, { once: true });
    try {
      video.currentTime = next;
    } catch {
      video.removeEventListener("seeked", done);
      done();
    }
  }

  // the editor gives the hidden <video> the source's level (mute, muted segments, gain) as it does
  // for the HTML player; the native player plays the sound, so it takes the same level
  function syncVolume(): void {
    if (!video || !opened || disposed) return;
    const level = Number.isFinite(video.volume) ? video.volume : 1;
    const volume = video.muted ? 0 : Math.max(0, Math.min(1, level));
    if (volume === sentVolume) return;
    sentVolume = volume;
    enqueue({ kind: "volume", volume });
  }

  // the export's LUT shows in the native picture too; after the first send of a table only its
  // strength travels, and the engine keeps it for every video opened after
  async function sendLut(): Promise<void> {
    if (lutBusy) return;
    lutBusy = true;
    try {
      while (lutWanted !== undefined && !disposed) {
        const next = lutWanted;
        lutWanted = undefined;
        const result = await engine.lut(next, next !== null && next.table === lutSent);
        if (result.ok) lutSent = next?.table ?? null;
        else {
          lutSent = null;
          console.error("The native player could not show the LUT", result.error);
        }
      }
    } finally {
      lutBusy = false;
    }
  }

  function onLut(event: Event): void {
    lutWanted = (event as CustomEvent<LutChange | null>).detail;
    void sendLut();
  }

  function setGap(gap: boolean): void {
    if (previewGap === gap) return;
    previewGap = gap;
    host.setPreviewGap?.(gap);
  }

  // between or after segments there is no frame to show: the engine waits and the page keeps
  // the time; finishing at the project's end keeps its last frame instead
  function enterGap(time: number, black = true): void {
    target = null;
    engineSegment = -1;
    gapPosition = time;
    gapAt = now();
    setGap(black);
    if (status && !status.paused) enqueue({ kind: "pause" });
  }

  // `seconds` is timeline time; the engine is asked for the file time under it
  function seekTo(seconds: number): void {
    const duration = host.videoDuration();
    if (!placed()) {
      engineSegment = -1;
      gapPosition = null;
      const clamped = Math.max(0, Math.min(duration, seconds));
      target = clamped;
      enqueue({ kind: "seek", seconds: clamped });
      return;
    }
    const ranges = segments();
    // the engine's position is read through the layout it was sent with
    lastRanges = copyRanges(ranges);
    // the timeline runs to the source's length or the last segment, whichever is later
    const time = Math.max(0, Math.min(Math.max(duration, projectEnd()), seconds));
    const index = segmentAt(ranges, time);
    const segment = ranges[index];
    if (!segment) {
      enterGap(time);
      return;
    }
    engineSegment = index;
    gapPosition = null;
    setGap(false);
    target = time;
    const source = (segment.sourceStart ?? segment.start) + time - segment.start;
    enqueue({ kind: "seek", seconds: Math.max(0, Math.min(duration, source)) });
  }

  function play(): void {
    wantPlaying = true;
    startFrameLoop();
    if (placed() && engineSegment < 0) {
      // the page's own clock carries the playhead through the gap
      gapAt = now();
      host.byId("btn-play")?.classList.toggle("playing", true);
      return;
    }
    enqueue({ kind: "play" });
  }

  function pause(): void {
    if (placed() && engineSegment < 0) gapPosition = gapTime();
    wantPlaying = false;
    stopFrameLoop();
    enqueue({ kind: "pause" });
    host.byId("btn-play")?.classList.remove("playing");
  }

  function finish(): void {
    wantPlaying = false;
    stopFrameLoop();
    if (placed()) {
      const end = projectEnd();
      if (loopEnabled() && end > 0) {
        continuePlaybackAt(0);
        return;
      }
      enqueue({ kind: "pause" });
      enterGap(end, false);
    } else if (loopEnabled()) {
      const first = segments()[0];
      if (first) {
        continuePlaybackAt(first.start);
        return;
      }
    }
    updateTime();
    host.AudioTimeline?.syncPreview?.();
  }

  function stopFrameLoop(): void {
    if (frameLoop) clock.cancelAnimationFrame(frameLoop);
    frameLoop = 0;
  }

  function startFrameLoop(): void {
    if (frameLoop || disposed) return;
    const tick = (): void => {
      frameLoop = 0;
      if (disposed || !wantPlaying) return;
      updateTime();
      if (wantPlaying && !frameLoop) frameLoop = clock.requestAnimationFrame(tick);
    };
    frameLoop = clock.requestAnimationFrame(tick);
  }

  function updateTime(): void {
    if (disposed) return;
    syncRanges();
    const full = host.videoDuration();
    if (host.Timeline?.isDragging() && previewSec != null) {
      host.setPlayheadUI(previewSec, full);
      return;
    }
    const time = position();
    if (placed()) {
      host.setPlayheadUI(time, full);
      if (!wantPlaying || target != null) return;
      if (time >= projectEnd()) {
        finish();
        return;
      }
      const segment = segments()[engineSegment];
      // at the end of a segment the next one, or the gap after it, takes over; in a gap the
      // engine starts again where the next segment begins
      if (segment ? time >= segment.end : segmentAt(segments(), time) >= 0) continuePlaybackAt(segment ? segment.end : time);
      return;
    }
    setGap(false);
    host.setPlayheadUI(time, full);
    const path = host.selPath();
    const clip = path ? host.clips()[path] : undefined;
    if (wantPlaying && target == null && clip && full > 0) {
      const next = playbackTarget(host.clipSegments(clip, full), time, 0.04);
      // a target behind the playhead means the last segment has ended
      if (next != null && next < time && !loopEnabled()) pause();
      else if (next != null) continuePlaybackAt(next);
    }
  }

  // opens the shown video once its length is known: the probe usually knows it before the
  // webview has read the file, and a file the webview can't read still plays here
  function ensureOpen(): boolean {
    if (!opened && !disposed && shownPath && shownPath === host.selPath()) open();
    return opened;
  }

  function open(): void {
    // the engine plays the file; moved clips are mapped onto it here
    const duration = host.videoDuration() || (video && Number.isFinite(video.duration) ? video.duration : 0);
    if (!(duration > 0)) return;
    opened = true;
    enqueue({ kind: "open", duration, path: host.selPath() });
    // a newly opened video plays at full level and normal speed until told otherwise
    sentVolume = 1;
    syncVolume();
    if (speed !== 1) enqueue({ kind: "rate", rate: speed });
    lastRanges = copyRanges(segments());
    // the start of a moved clip is somewhere else in the file
    if (placed()) seekTo(previewSec ?? 0);
  }

  function resetSource(): void {
    epoch++;
    steps.length = 0;
    opened = false;
    status = null;
    target = null;
    seekWanted = null;
    previewSec = null;
    wantPlaying = false;
    mirrorBusy = false;
    mirrorWanted = null;
    engineSegment = -1;
    gapPosition = null;
    if (seekFrame) clock.cancelAnimationFrame(seekFrame);
    seekFrame = 0;
    stopFrameLoop();
    stopPoll();
    host.byId("btn-play")?.classList.remove("playing");
    setGap(false);
  }

  function onSource(event: Event): void {
    if (disposed) return;
    const path = (event as CustomEvent<string | null>).detail;
    resetSource();
    shownPath = path;
    if (!ensureOpen()) return;
    updateTime();
    host.syncTimelineUI?.();
  }

  function onLoadedMetadata(): void {
    if (disposed) return;
    if (opened) {
      updateTime();
      host.syncTimelineUI?.();
      return;
    }
    // moved clips keep the painted playhead; a plain video starts where its element is
    const restore = placed() ? previewSec : video?.currentTime ?? 0;
    resetSource();
    shownPath = host.selPath();
    open();
    if (opened && restore != null && restore > 0) seekTo(restore);
    updateTime();
    host.syncTimelineUI?.();
  }

  function onDurationChange(): void {
    updateTime();
    host.syncTimelineUI?.();
  }

  function setSpeed(rate: number): void {
    if (disposed) return;
    speed = rate;
    // the hidden video keeps the speed too, for the code that reads it there
    if (video) {
      video.playbackRate = rate;
      video.defaultPlaybackRate = rate;
    }
    showPlaybackSpeed(host.byId<HTMLButtonElement>("btn-speed"), rate);
    if (opened) enqueue({ kind: "rate", rate });
  }

  function togglePlay(): void {
    if (disposed || !ensureOpen()) return;
    syncRanges();
    if (wantPlaying) {
      pause();
      return;
    }
    const time = position();
    if (placed()) {
      if (time >= projectEnd()) seekTo(0);
      else if (engineSegment < 0 && gapPosition == null) seekTo(time);
    } else {
      const next = playbackTarget(segments(), time, 0.04);
      if (next != null) seekTo(next);
    }
    play();
  }

  function continuePlaybackAt(seconds: number | null | undefined): void {
    if (disposed || !opened || seconds == null) return;
    seekTo(seconds);
    play();
  }

  function flushVideoSeek(): void {
    if (seekFrame) clock.cancelAnimationFrame(seekFrame);
    seekFrame = 0;
    if (disposed || !ensureOpen() || seekWanted == null) return;
    const seconds = seekWanted;
    seekWanted = null;
    seekTo(seconds);
  }

  function seekPreview(sec: number): void {
    const full = host.videoDuration();
    if (disposed || !full || !Number.isFinite(full) || !Number.isFinite(sec)) return;
    syncRanges();
    const clamped = Math.max(0, Math.min(full, sec));
    host.setPlayheadUI(clamped, full);
    if (placed()) setGap(sourceTimeAt(segments(), clamped) == null);
    if (wantPlaying) pause();
    target = clamped;
    seekWanted = clamped;
    if (!seekFrame) {
      seekFrame = clock.requestAnimationFrame(() => {
        seekFrame = 0;
        flushVideoSeek();
      });
    }
  }

  function stepFrame(direction: number): void {
    if (disposed || !ensureOpen()) return;
    const path = host.selPath();
    const clip = path ? host.clips()[path] : undefined;
    const fps = clip?.probeData?.fps || 30;
    if (wantPlaying) pause();
    seekPreview(position() + direction * (1 / fps));
  }

  function seekToRatio(ratio: number): void {
    const full = host.videoDuration();
    if (!full || !Number.isFinite(full)) return;
    seekPreview(Math.max(0, Math.min(1, ratio)) * full);
  }

  function captureFrameTime(): number {
    const source = sourcePosition();
    if (source == null) throw new Error("There is no video frame in this timeline gap. Move the playhead onto a video segment.");
    if (wantPlaying) pause();
    flushVideoSeek();
    return source;
  }

  if (video) {
    // the library's source event, not the webview's own media events, says when the video
    // changes: an error reading the file in the webview doesn't stop the engine
    video.addEventListener(SOURCE_EVENT, onSource);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("volumechange", syncVolume);
    video.addEventListener(LUT_CHANGE_EVENT, onLut);
    // the LUT may have been chosen before the native player took over
    video.dispatchEvent(new Event(LUT_REQUEST_EVENT));
    // the engine replaces the HTML player, which may already have a video showing
    if (!video.paused) video.pause();
    if (video.readyState >= 1) onLoadedMetadata();
  }
  volume.updateMuteIcon();

  return {
    ...volume,
    isPlaying: () => !disposed && wantPlaying,
    timelineTime: position,
    sourceTime: sourcePosition,
    togglePlay,
    seekBy: (seconds) => seekPreview(position() + seconds),
    stepFrame,
    toggleFullscreen: () => host.stageFullscreen?.toggle(),
    // the editor asks for this when the timeline changes, such as when a probe brings the length
    updateTime: () => {
      ensureOpen();
      updateTime();
    },
    seekPreview,
    seekToRatio,
    continuePlaybackAt,
    setPreviewSec: (sec) => {
      previewSec = sec;
    },
    getPreviewSec: () => previewSec,
    flushVideoSeek,
    captureFrameTime,
    changeSpeed: (direction) => setSpeed(nextPlaybackSpeed(speed, direction)),
    resetSpeed: () => setSpeed(1),
    dispose: () => {
      if (disposed) return;
      resetSource();
      disposed = true;
      if (video) {
        video.removeEventListener(SOURCE_EVENT, onSource);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("durationchange", onDurationChange);
        video.removeEventListener("volumechange", syncVolume);
        video.removeEventListener(LUT_CHANGE_EVENT, onLut);
      }
    },
  };
}
