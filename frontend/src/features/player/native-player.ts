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
import {
  defaultClock,
  installVolumeControls,
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
  let openedDuration = 0;
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

  // moved clips can end past the source, and the engine clock runs in timeline time
  function neededDuration(): number {
    return Math.max(host.videoDuration(), placed() ? projectEnd() : 0);
  }

  function position(): number {
    if (target != null) return target;
    if (!status) return previewSec ?? 0;
    let time = status.positionSeconds;
    if (!status.paused && !status.seekPending) time += Math.max(0, now() - statusAt) / 1000;
    return Math.min(status.durationSeconds, time);
  }

  function sourcePosition(): number | null {
    const time = position();
    return placed() ? sourceTimeAt(segments(), time) : time;
  }

  function enqueue(step: Step): void {
    if (disposed) return;
    // the newest seek or level replaces one still waiting, so scrubbing never builds a backlog
    const last = steps.at(-1);
    if ((step.kind === "seek" || step.kind === "volume") && last?.kind === step.kind) steps[steps.length - 1] = step;
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
    if (target != null && !seekQueued && next.confirmedSeekRequestId === sentSeekId) target = null;
    host.byId("btn-play")?.classList.toggle("playing", !next.paused);
    if (next.video?.failed && reportedFailure !== epoch) {
      reportedFailure = epoch;
      console.error("The native player stopped", next.video.error);
    }
    if (next.video?.softwareReason && reportedSoftware !== epoch) {
      reportedSoftware = epoch;
      console.info("The native player decodes in software", next.video.decoder, next.video.softwareReason);
    }
    if (next.ended && wantPlaying) {
      finish();
      return;
    }
    if (!next.paused) startFrameLoop();
    else if (target == null) {
      updateTime();
      mirror(sourcePosition());
    }
    if (wasPaused !== next.paused) host.AudioTimeline?.syncPreview?.();
    schedulePoll();
  }

  function refuse(step: Step, error: BackendError): void {
    console.error(`The native player could not ${step.kind}`, error);
    if (step.kind === "open") opened = false;
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

  function seekTo(seconds: number): void {
    const clamped = Math.max(0, Math.min(neededDuration(), seconds));
    target = clamped;
    // a project that grew past the engine's length needs an engine long enough for it
    if (clamped > openedDuration) open();
    enqueue({ kind: "seek", seconds: clamped });
  }

  function play(): void {
    wantPlaying = true;
    enqueue({ kind: "play" });
    startFrameLoop();
  }

  function pause(): void {
    wantPlaying = false;
    stopFrameLoop();
    enqueue({ kind: "pause" });
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
      seekTo(end);
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
    const full = host.videoDuration();
    if (host.Timeline?.isDragging() && previewSec != null) {
      host.setPlayheadUI(previewSec, full);
      return;
    }
    const time = position();
    if (placed()) {
      setGap(sourceTimeAt(segments(), time) == null);
      host.setPlayheadUI(time, full);
      if (wantPlaying && target == null && time >= projectEnd()) finish();
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

  function open(): void {
    const duration = neededDuration() || (video && Number.isFinite(video.duration) ? video.duration : 0);
    if (!(duration > 0)) return;
    opened = true;
    openedDuration = duration;
    enqueue({ kind: "open", duration, path: host.selPath() });
    // a newly opened video plays at full level until told otherwise
    sentVolume = 1;
    syncVolume();
  }

  function resetSource(): void {
    epoch++;
    steps.length = 0;
    opened = false;
    openedDuration = 0;
    status = null;
    target = null;
    seekWanted = null;
    previewSec = null;
    wantPlaying = false;
    mirrorBusy = false;
    mirrorWanted = null;
    if (seekFrame) clock.cancelAnimationFrame(seekFrame);
    seekFrame = 0;
    stopFrameLoop();
    stopPoll();
    host.byId("btn-play")?.classList.remove("playing");
    setGap(false);
  }

  function onLoadedMetadata(): void {
    if (disposed) return;
    // moved clips keep the painted playhead; a plain video starts where its element is
    const restore = placed() ? previewSec : video?.currentTime ?? 0;
    resetSource();
    open();
    if (opened && restore != null && restore > 0) seekTo(restore);
    updateTime();
    host.syncTimelineUI?.();
  }

  function onDurationChange(): void {
    updateTime();
    host.syncTimelineUI?.();
  }

  function togglePlay(): void {
    if (disposed || !opened) return;
    if (wantPlaying) {
      pause();
      return;
    }
    const time = position();
    if (placed()) {
      if (time >= projectEnd()) seekTo(0);
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
    if (disposed || !opened || seekWanted == null) return;
    const seconds = seekWanted;
    seekWanted = null;
    seekTo(seconds);
  }

  function seekPreview(sec: number): void {
    const full = host.videoDuration();
    if (disposed || !full || !Number.isFinite(full) || !Number.isFinite(sec)) return;
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
    if (disposed || !opened) return;
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
    video.addEventListener("emptied", resetSource);
    video.addEventListener("error", resetSource);
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
    updateTime,
    seekPreview,
    seekToRatio,
    continuePlaybackAt,
    setPreviewSec: (sec) => {
      previewSec = sec;
    },
    getPreviewSec: () => previewSec,
    flushVideoSeek,
    captureFrameTime,
    // the native clock has no speed control yet, so playback stays at normal speed
    changeSpeed: () => {},
    resetSpeed: () => {},
    dispose: () => {
      if (disposed) return;
      resetSource();
      disposed = true;
      if (video) {
        video.removeEventListener("emptied", resetSource);
        video.removeEventListener("error", resetSource);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("durationchange", onDurationChange);
        video.removeEventListener("volumechange", syncVolume);
        video.removeEventListener(LUT_CHANGE_EVENT, onLut);
      }
    },
  };
}
