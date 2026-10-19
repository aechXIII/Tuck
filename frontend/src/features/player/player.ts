import type { EditorClip } from "../editor/types.ts";
import type { StageFullscreen } from "./stage-fullscreen.ts";
import type { SegmentRange } from "../timeline/segments.ts";
import {
  hasPlacement,
  sourceTimeAt,
  timelineTimeAt,
  playbackTarget as defaultPlaybackTarget,
} from "../timeline/segments.ts";

type Segment = SegmentRange;

export interface PlayerClock {
  setTimeout: (handler: () => void, timeout?: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
  /** milliseconds on a monotonic clock */
  now?: () => number;
}

export interface PlayerHost {
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  clips: () => Readonly<Record<string, EditorClip>>;
  selPath: () => string | null;
  getMuted: () => boolean;
  setMuted: (value: boolean) => void;
  getVolBefore: () => number;
  setVolBefore: (value: number) => void;
  playbackSegments: () => readonly Segment[];
  clipSegments: (
    clip: EditorClip | null | undefined,
    duration: number,
  ) => readonly Segment[];
  videoDuration: () => number;
  setPlayheadUI: (seconds: number, full: number) => void;
  Timeline?: { isDragging: () => boolean };
  AudioTimeline?: { applyPreviewVolume: () => void; syncPreview?: () => void };
  setPreviewGap?: (gap: boolean) => void;
  SegmentEditing?: {
    playbackTarget: (
      segments: readonly Segment[],
      time: number,
      tolerance?: number,
    ) => number | null;
  };
  syncTimelineUI?: () => void;
  /** whether playback starts again from the first segment after the last one ends */
  loopPlayback?: () => boolean;
  stageFullscreen?: StageFullscreen;
  document?: Document;
  clock?: PlayerClock;
}

export interface PlayerApi {
  isPlaying: () => boolean;
  /** project position for placed segments, source position for legacy segments */
  timelineTime: () => number;
  /** no source frame exists in a project gap */
  sourceTime: () => number | null;
  togglePlay: () => void;
  seekBy: (seconds: number) => void;
  stepFrame: (direction: number) => void;
  toggleFullscreen: () => void;
  updateTime: () => void;
  seekPreview: (sec: number) => void;
  seekToRatio: (ratio: number) => void;
  toggleMute: () => void;
  setVol: (value: string | number) => void;
  updateMuteIcon: () => void;
  continuePlaybackAt: (target: number | null | undefined) => void;
  setPreviewSec: (sec: number | null) => void;
  getPreviewSec: () => number | null;
  flushVideoSeek: () => void;
  captureFrameTime: () => number;
  /** one step slower (-1) or faster (1) through the playback speeds */
  changeSpeed: (direction: number) => void;
  resetSpeed: () => void;
  dispose: () => void;
}

export const PLAYBACK_SPEEDS: readonly number[] = [0.25, 0.5, 1, 1.5, 2, 4];

/** Shows the playback speed on the player bar's badge, which only appears away from normal speed. */
export function showPlaybackSpeed(badge: HTMLButtonElement | null, rate: number): void {
  if (!badge) return;
  badge.hidden = rate === 1;
  badge.textContent = `${rate}×`;
  badge.setAttribute("aria-label", `Playing at ${rate}×. Back to normal speed`);
  badge.dataset.tip = "Back to normal speed";
}

/** The speed one step away from `current` in `direction`, staying within the list. */
export function nextPlaybackSpeed(current: number, direction: number): number {
  const distance = (speed: number): number => Math.abs(speed - current);
  let index = 0;
  PLAYBACK_SPEEDS.forEach((speed, at) => {
    if (distance(speed) < distance(PLAYBACK_SPEEDS[index] ?? 1)) index = at;
  });
  const next = Math.max(0, Math.min(PLAYBACK_SPEEDS.length - 1, index + Math.sign(direction)));
  return PLAYBACK_SPEEDS[next] ?? 1;
}

const ICON_VOL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h3.5L14 19V5l-5.5 4H5zm11 1.2v3.6c.9-.5 1.5-1.4 1.5-2.5S16.9 10.7 16 10.2z"/></svg>';
const ICON_MUTE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h3.5L14 19V5l-5.5 4H5z m11.1 1.1-1.1 1.1 1.9 1.9-1.9 1.9 1.1 1.1 1.9-1.9 1.9 1.9 1.1-1.1-1.9-1.9 1.9-1.9-1.1-1.1-1.9 1.9-1.9-1.9z"/></svg>';

let active: PlayerApi | null = null;

export function defaultClock(): PlayerClock {
  return {
    now: () => window.performance.now(),
    setTimeout: (handler, timeout) =>
      window.setTimeout(handler, timeout) as unknown as number,
    clearTimeout: (id) => {
      window.clearTimeout(id);
    },
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => {
      window.cancelAnimationFrame(id);
    },
  };
}

function requireActive(): PlayerApi {
  if (!active) throw new Error("installPlayer() must be called first");
  return active;
}

/** The mute button and the volume slider, the same for every player. */
export function installVolumeControls(
  host: PlayerHost,
): Pick<PlayerApi, "toggleMute" | "setVol" | "updateMuteIcon"> {
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => host.byId<T>(id);

  function updateMuteIcon(): void {
    const btn = byId("btn-mute");
    if (!btn) return;
    const vbar = byId<HTMLInputElement>("vbar");
    const isMuted = host.getMuted() || (vbar != null && Number(vbar.value) === 0);
    btn.innerHTML = isMuted ? ICON_MUTE : ICON_VOL;
    const label = isMuted ? "Unmute preview" : "Mute preview";
    // Tuck's own tooltip reads data-tip; a native title would show a second, different one
    btn.dataset.tip = label;
    btn.removeAttribute("title");
    btn.setAttribute("aria-label", label);
  }

  function toggleMute(): void {
    const vbar = byId<HTMLInputElement>("vbar");
    const vidEl = byId<HTMLVideoElement>("vid");
    if (!vbar) return;
    if (host.getMuted() || Number(vbar.value) === 0) {
      vbar.value = String(host.getVolBefore());
      host.setMuted(false);
    } else {
      host.setVolBefore(parseInt(vbar.value, 10) || 80);
      vbar.value = "0";
      host.setMuted(true);
    }
    if (host.AudioTimeline) host.AudioTimeline.applyPreviewVolume();
    else if (vidEl) vidEl.volume = host.getMuted() ? 0 : host.getVolBefore() / 100;
    updateMuteIcon();
  }

  function setVol(value: string | number): void {
    const numeric = typeof value === "number" ? value : Number(value);
    host.setMuted(numeric === 0);
    if (!host.getMuted())
      host.setVolBefore(parseInt(String(value), 10) || host.getVolBefore());
    const vidEl = byId<HTMLVideoElement>("vid");
    if (host.AudioTimeline) host.AudioTimeline.applyPreviewVolume();
    else if (vidEl) vidEl.volume = numeric / 100;
    updateMuteIcon();
  }

  return { toggleMute, setVol, updateMuteIcon };
}

export function installPlayer(host: PlayerHost): PlayerApi {
  const clock = host.clock ?? defaultClock();
  const volume = installVolumeControls(host);

  let looping = false;
  let previewSec: number | null = null;
  let seekWanted: number | null = null;
  let seekBusy = false;
  let seekRaf = 0;
  let cancelActiveSeek: (() => void) | null = null;
  let disposed = false;
  let projectPosition: number | null = null;
  let projectPlaying = false;
  let projectSegment = -1;
  let previewGap = false;
  let lastFrameTime: number | null = null;
  let playAttempt = 0;
  let playbackRanges = copyPlaybackRanges();
  let sourcePositionPending = true;
  let awaitingMetadata = host.byId<HTMLVideoElement>("vid")?.readyState === 0;

  function copyPlaybackRanges(): Segment[] {
    return host.playbackSegments().map(({ start, end, sourceStart }) => ({
      start, end, ...(sourceStart == null ? {} : { sourceStart }),
    }));
  }

  function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return host.byId<T>(id);
  }

  function playbackTarget(
    segments: readonly Segment[],
    time: number,
    tolerance?: number,
  ): number | null {
    const mutable = segments as Segment[];
    if (host.SegmentEditing?.playbackTarget)
      return host.SegmentEditing.playbackTarget(mutable, time, tolerance);
    return defaultPlaybackTarget(mutable, time, tolerance);
  }

  function placed(): boolean {
    return hasPlacement(host.playbackSegments());
  }

  function syncPlaybackRanges(): void {
    if (disposed || awaitingMetadata) return;
    const segments = host.playbackSegments();
    if (segments.length === playbackRanges.length && segments.every((segment, index) => {
      const previous = playbackRanges[index];
      return previous && previous.start === segment.start && previous.end === segment.end && previous.sourceStart === segment.sourceStart;
    })) return;
    const previousRanges = playbackRanges;
    playbackRanges = copyPlaybackRanges();
    const wasPlaced = hasPlacement(previousRanges);
    const nowPlaced = hasPlacement(segments);
    if (!wasPlaced && !nowPlaced) return;
    const video = byId<HTMLVideoElement>("vid");
    if (!video) return;
    const playing = wasPlaced ? projectPlaying : !video.paused;
    const wasGap = previewGap;
    let time = wasPlaced ? projectPosition ?? previewSec ?? 0 : video.currentTime;
    const previous = previousRanges[projectSegment];
    if (wasPlaced && playing && !wasGap && previous) {
      time = previous.start + video.currentTime - (previous.sourceStart ?? previous.start);
    }
    // undo can change the source mapping without changing the media element's source
    const source = nowPlaced ? sourceTimeAt(segments, time) : null;
    if (playing || source == null) resetSeek();
    playAttempt++;
    lastFrameTime = null;
    projectSegment = -1;
    projectPlaying = nowPlaced && playing;
    if (nowPlaced) {
      setProjectPosition(time, playing);
      if (!playing && source != null) queueVideoSeek(source);
      if (playing) startFrameLoop(video);
    } else {
      projectPosition = null;
      setGap(false);
      if (wasGap) video.currentTime = time;
      previewSec = video.currentTime;
      byId("btn-play")?.classList.toggle("playing", playing);
      if (playing && video.paused) playVideo(video);
      if (!playing) stopFrameLoop();
      host.AudioTimeline?.syncPreview?.();
    }
  }

  function timelineTime(): number {
    syncPlaybackRanges();
    const video = byId<HTMLVideoElement>("vid");
    if (!placed()) return video?.currentTime ?? 0;
    if (projectPosition == null) {
      projectPosition = previewSec ?? (awaitingMetadata ? 0 : timelineTimeAt(host.playbackSegments(), video?.currentTime ?? 0));
    }
    if (projectPlaying && !previewGap && projectSegment >= 0 && video) {
      const segment = host.playbackSegments()[projectSegment];
      if (segment) {
        const time = segment.start + video.currentTime - (segment.sourceStart ?? segment.start);
        return Math.min(segment.end, Math.max(segment.start, time));
      }
    }
    return projectPosition;
  }

  function sourceTime(): number | null {
    syncPlaybackRanges();
    if (placed()) return sourceTimeAt(host.playbackSegments(), timelineTime());
    return byId<HTMLVideoElement>("vid")?.currentTime ?? 0;
  }

  function isPlaying(): boolean {
    if (!disposed) syncPlaybackRanges();
    return !disposed && (placed() ? projectPlaying : !(byId<HTMLVideoElement>("vid")?.paused ?? true));
  }

  function setGap(gap: boolean): void {
    if (previewGap === gap) return;
    previewGap = gap;
    host.setPreviewGap?.(gap);
  }

  function syncProjectUI(): void {
    host.setPlayheadUI(projectPosition ?? 0, host.videoDuration());
    host.AudioTimeline?.syncPreview?.();
  }

  function setPlaying(playing: boolean): void {
    projectPlaying = playing;
    byId("btn-play")?.classList.toggle("playing", playing);
    if (!playing) {
      playAttempt++;
      stopFrameLoop();
    }
    host.AudioTimeline?.syncPreview?.();
  }

  function playVideo(video: HTMLVideoElement): void {
    const attempt = ++playAttempt;
    try {
      const result = video.play();
      if (result && typeof result.catch === "function") {
        result.catch(() => {
          if (!disposed && attempt === playAttempt) setPlaying(false);
        });
      }
    } catch {
      if (attempt === playAttempt) setPlaying(false);
    }
  }

  function setProjectPosition(time: number, play: boolean): void {
    const video = byId<HTMLVideoElement>("vid");
    if (!video) return;
    const segments = host.playbackSegments();
    projectPosition = time;
    projectSegment = segments.findIndex(segment => time >= segment.start && time < segment.end);
    const source = sourceTimeAt(segments, time);
    setGap(source == null);
    if (source == null) {
      // pausing at a gap can abort an earlier play promise without stopping the project
      playAttempt++;
      if (!video.paused) video.pause();
    } else if (play) {
      video.currentTime = source;
      playVideo(video);
    }
    syncProjectUI();
  }

  function finishProject(): void {
    const segments = host.playbackSegments();
    const end = segments.at(-1)?.end ?? 0;
    if (loopEnabled() && end > 0) {
      setProjectPosition(0, true);
      return;
    }
    projectPosition = end;
    setPlaying(false);
    byId<HTMLVideoElement>("vid")?.pause();
    syncProjectUI();
  }

  function updateProject(): void {
    const video = byId<HTMLVideoElement>("vid");
    if (!video) return;
    const segments = host.playbackSegments();
    const segment = segments[projectSegment];
    if (projectPlaying && !previewGap && segment) {
      projectPosition = segment.start + video.currentTime - (segment.sourceStart ?? segment.start);
    }
    const time = projectPosition ?? timelineTime();
    if (projectPlaying && time >= (segments.at(-1)?.end ?? 0)) {
      finishProject();
      return;
    }
    const index = segments.findIndex(item => time >= item.start && time < item.end);
    if (projectPlaying && (index !== projectSegment || (index < 0) !== previewGap)) {
      setProjectPosition(time, true);
    } else {
      syncProjectUI();
    }
  }

  function togglePlay(): void {
    if (disposed) return;
    if (awaitingMetadata && placed()) return;
    syncPlaybackRanges();
    const v = byId<HTMLVideoElement>("vid");
    if (!v) return;
    if (placed()) {
      if (projectPlaying) {
        projectPosition = timelineTime();
        setPlaying(false);
        v.pause();
      } else {
        resetSeek();
        let time = timelineTime();
        if (time >= (host.playbackSegments().at(-1)?.end ?? 0)) time = 0;
        lastFrameTime = null;
        setPlaying(true);
        setProjectPosition(time, true);
        if (projectPlaying) startFrameLoop(v);
      }
      return;
    }
    if (v.paused) {
      const target = playbackTarget(host.playbackSegments(), v.currentTime, 0.04);
      if (target != null) v.currentTime = target;
      // a switch to another video aborts this, and the stage already says when a preview can't play
      const playResult = v.play();
      if (playResult && typeof playResult.catch === "function") playResult.catch(() => {});
    } else {
      v.pause();
    }
  }

  function seekBy(seconds: number): void {
    syncPlaybackRanges();
    const v = byId<HTMLVideoElement>("vid");
    if (!v) return;
    if (placed()) {
      seekPreview(timelineTime() + seconds);
      return;
    }
    if (v.duration)
      v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + seconds));
  }

  function stepFrame(direction: number): void {
    syncPlaybackRanges();
    const v = byId<HTMLVideoElement>("vid");
    if (!v || !Number.isFinite(v.duration)) return;
    const path = host.selPath();
    const clip = path ? host.clips()[path] : undefined;
    const fps = clip?.probeData?.fps || 30;
    if (!v.paused) v.pause();
    seekPreview((placed() ? timelineTime() : v.currentTime) + direction * (1 / fps));
  }

  function continuePlaybackAt(target: number | null | undefined): void {
    if (disposed || looping || target == null) return;
    if (awaitingMetadata && placed()) return;
    syncPlaybackRanges();
    const v = byId<HTMLVideoElement>("vid");
    if (!v) return;
    if (placed()) {
      lastFrameTime = null;
      setPlaying(true);
      setProjectPosition(target, true);
      if (projectPlaying) startFrameLoop(v);
      return;
    }
    looping = true;
    try {
      v.currentTime = target;
      const playResult = v.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => {});
      }
    } finally {
      clock.setTimeout(() => {
        looping = false;
      }, 80);
    }
  }

  function loopEnabled(): boolean {
    return host.loopPlayback?.() ?? true;
  }

  function loopPlayback(): void {
    if (placed()) {
      if (!projectPlaying) return;
      const segment = host.playbackSegments()[projectSegment];
      if (segment) projectPosition = segment.end;
      updateProject();
      return;
    }
    if (!loopEnabled()) return;
    const segments = host.playbackSegments();
    const first = segments[0];
    if (first) continuePlaybackAt(first.start);
  }

  function updateTime(): void {
    if (disposed) return;
    syncPlaybackRanges();
    if (host.Timeline?.isDragging() && previewSec != null) {
      host.setPlayheadUI(previewSec, host.videoDuration());
      return;
    }
    if (placed()) {
      updateProject();
      return;
    }
    const v = byId<HTMLVideoElement>("vid");
    const full = host.videoDuration();
    const time = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
    host.setPlayheadUI(time, full);
    const path = host.selPath();
    const clip = path ? host.clips()[path] : undefined;
    if (v && !v.paused && !looping && path && clip && full > 0) {
      const target = playbackTarget(host.clipSegments(clip, full), time, 0.04);
      // a target behind the playhead means the last segment has ended
      if (target != null && target < time && !loopEnabled()) v.pause();
      else if (target != null) continuePlaybackAt(target);
    }
  }

  function seekToRatio(ratio: number): void {
    const full = host.videoDuration();
    if (!full || !Number.isFinite(full)) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    seekPreview(clamped * full);
  }

  function seekPreview(sec: number): void {
    const v = byId<HTMLVideoElement>("vid");
    const full = host.videoDuration();
    if (disposed || !v || !full || !Number.isFinite(full) || !Number.isFinite(sec)) return;
    syncPlaybackRanges();
    const clamped = Math.max(0, Math.min(full, sec));
    host.setPlayheadUI(clamped, full);
    let source = clamped;
    if (placed()) {
      setPlaying(false);
      setProjectPosition(clamped, false);
      const target = sourceTimeAt(host.playbackSegments(), clamped);
      if (target == null) {
        resetSeek();
        v.pause();
        return;
      }
      source = target;
    }
    if (!v.paused) {
      try {
        v.pause();
      } catch {
        /* ignore pause failures during seek */
      }
    }
    queueVideoSeek(source);
  }

  function queueVideoSeek(source: number): void {
    seekWanted = source;
    if (awaitingMetadata && placed()) return;
    if (!seekRaf) {
      seekRaf = clock.requestAnimationFrame(() => {
        seekRaf = 0;
        flushVideoSeek();
      });
    }
  }

  function flushVideoSeek(): void {
    const v = byId<HTMLVideoElement>("vid");
    if (disposed || (awaitingMetadata && placed()) || !v || seekWanted == null || seekBusy) return;
    const sec = seekWanted;
    seekWanted = null;
    if (Math.abs((v.currentTime || 0) - sec) < 0.002) return;
    seekBusy = true;
    const cleanup = (): void => {
      v.removeEventListener("seeked", done);
      cancelActiveSeek = null;
      seekBusy = false;
    };
    const done = (): void => {
      cleanup();
      if (seekWanted != null) flushVideoSeek();
    };
    cancelActiveSeek = cleanup;
    v.addEventListener("seeked", done);
    // restarting an unfinished seek can starve slow decoders while scrubbing
    try {
      v.currentTime = sec;
    } catch {
      done();
    }
  }

  function captureFrameTime(): number {
    syncPlaybackRanges();
    const video = byId<HTMLVideoElement>("vid");
    if (placed()) {
      const source = sourceTime();
      if (source == null) throw new Error("There is no video frame in this timeline gap. Move the playhead onto a video segment.");
      projectPosition = timelineTime();
      setPlaying(false);
      video?.pause();
      flushVideoSeek();
      return source;
    }
    const time = seekWanted ?? (video && !video.paused ? video.currentTime : previewSec ?? video?.currentTime ?? 0);
    video?.pause();
    flushVideoSeek();
    return time;
  }

  function resetSeek(): void {
    seekWanted = null;
    cancelActiveSeek?.();
    if (seekRaf) clock.cancelAnimationFrame(seekRaf);
    seekRaf = 0;
  }

  // while playing, the playhead and the segment-end check follow every display frame;
  // timeupdate alone fires only about four times a second, so the playhead stepped and could
  // run past a segment's end by that much. Video frame callbacks are not used here because
  // WebKitGTK drawing in software can offer them without ever calling them
  let frameLoop: number | null = null;

  function stopFrameLoop(): void {
    if (frameLoop === null) return;
    clock.cancelAnimationFrame(frameLoop);
    frameLoop = null;
  }

  function startFrameLoop(video: HTMLVideoElement): void {
    if (frameLoop !== null) return;
    const tick = (timestamp: number): void => {
      if (disposed || (placed() ? !projectPlaying : video.paused || video.ended)) {
        frameLoop = null;
        return;
      }
      if (placed()) {
        if (previewGap && lastFrameTime != null) {
          // native time owns video segments; only black gaps need a separate clock
          const elapsed = Math.max(0, timestamp - lastFrameTime) / 1000;
          projectPosition = (projectPosition ?? 0) + elapsed * (video.playbackRate || 1);
        }
        lastFrameTime = timestamp;
      }
      updateTime();
      if (placed() && !projectPlaying) frameLoop = null;
      else frameLoop = clock.requestAnimationFrame(tick);
    };
    frameLoop = clock.requestAnimationFrame(tick);
  }

  function onPlay(): void {
    if (disposed) return;
    if (placed()) {
      setPlaying(true);
      if (projectSegment < 0 && !previewGap) {
        const time = timelineTime();
        projectSegment = host.playbackSegments().findIndex(segment => time >= segment.start && time < segment.end);
      }
    }
    const btn = byId("btn-play");
    if (btn) btn.classList.add("playing");
    const video = byId<HTMLVideoElement>("vid");
    if (video) startFrameLoop(video);
  }

  function onPause(): void {
    if (placed()) {
      const video = byId<HTMLVideoElement>("vid");
      if (!video?.paused || (projectPlaying && (previewGap || video.ended))) return;
      projectPosition = timelineTime();
      setPlaying(false);
      return;
    }
    const btn = byId("btn-play");
    if (btn) btn.classList.remove("playing");
    stopFrameLoop();
  }

  function onDurationOrMeta(): void {
    updateTime();
    host.syncTimelineUI?.();
  }

  function onLoadedMetadata(): void {
    if (disposed) return;
    awaitingMetadata = false;
    syncPlaybackRanges();
    if (sourcePositionPending && placed()) {
      // a newly loaded source is at source zero even when its project starts elsewhere
      const time = projectPosition ?? previewSec ?? 0;
      setProjectPosition(time, false);
      const source = sourceTimeAt(host.playbackSegments(), time);
      if (source != null) queueVideoSeek(source);
    } else if (seekWanted != null) queueVideoSeek(seekWanted);
    sourcePositionPending = false;
    onDurationOrMeta();
  }

  function setSpeed(rate: number): void {
    const v = byId<HTMLVideoElement>("vid");
    if (v) {
      v.playbackRate = rate;
      // a newly loaded video keeps the chosen speed
      v.defaultPlaybackRate = rate;
    }
    showPlaybackSpeed(byId<HTMLButtonElement>("btn-speed"), rate);
  }

  function changeSpeed(direction: number): void {
    const v = byId<HTMLVideoElement>("vid");
    setSpeed(nextPlaybackSpeed(v?.playbackRate || 1, direction));
  }

  function resetSpeed(): void {
    setSpeed(1);
  }

  function resetSource(event?: Event): void {
    awaitingMetadata = event?.type === "emptied";
    sourcePositionPending = true;
    playbackRanges = copyPlaybackRanges();
    resetSeek();
    stopFrameLoop();
    projectPosition = null;
    projectSegment = -1;
    previewSec = null;
    lastFrameTime = null;
    setPlaying(false);
    setGap(false);
  }

  const vid = byId<HTMLVideoElement>("vid");
  if (vid) {
    vid.addEventListener("emptied", resetSource);
    vid.addEventListener("error", resetSource);
    vid.addEventListener("play", onPlay);
    vid.addEventListener("pause", onPause);
    vid.addEventListener("timeupdate", updateTime);
    vid.addEventListener("durationchange", onDurationOrMeta);
    vid.addEventListener("loadedmetadata", onLoadedMetadata);
    vid.addEventListener("ended", loopPlayback);
  }
  volume.updateMuteIcon();

  const api: PlayerApi = {
    ...volume,
    isPlaying,
    timelineTime,
    sourceTime,
    togglePlay,
    seekBy,
    stepFrame,
    toggleFullscreen: () => host.stageFullscreen?.toggle(),
    updateTime,
    seekPreview,
    seekToRatio,
    continuePlaybackAt,
    changeSpeed,
    resetSpeed,
    setPreviewSec: (sec) => {
      previewSec = sec;
    },
    getPreviewSec: () => previewSec,
    flushVideoSeek,
    captureFrameTime,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      resetSource();
      if (vid) {
        vid.removeEventListener("emptied", resetSource);
        vid.removeEventListener("error", resetSource);
        vid.removeEventListener("play", onPlay);
        vid.removeEventListener("pause", onPause);
        vid.removeEventListener("timeupdate", updateTime);
        vid.removeEventListener("durationchange", onDurationOrMeta);
        vid.removeEventListener("loadedmetadata", onLoadedMetadata);
        vid.removeEventListener("ended", loopPlayback);
      }
      if (active === api) active = null;
    },
  };

  active = api;
  return api;
}

export function togglePlay(): void {
  requireActive().togglePlay();
}
export function seekBy(seconds: number): void {
  requireActive().seekBy(seconds);
}
export function stepFrame(direction: number): void {
  requireActive().stepFrame(direction);
}
export function toggleFullscreen(): void {
  requireActive().toggleFullscreen();
}
export function updateTime(): void {
  requireActive().updateTime();
}
export function seekPreview(sec: number): void {
  requireActive().seekPreview(sec);
}
export function seekToRatio(ratio: number): void {
  requireActive().seekToRatio(ratio);
}
export function toggleMute(): void {
  requireActive().toggleMute();
}
export function setVol(value: string | number): void {
  requireActive().setVol(value);
}
export function updateMuteIcon(): void {
  requireActive().updateMuteIcon();
}
export function continuePlaybackAt(target: number | null | undefined): void {
  requireActive().continuePlaybackAt(target);
}
