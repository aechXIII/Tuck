import type { EditorClip } from "../editor/types.ts";
import type { SegmentRange } from "../timeline/segments.ts";
import { playbackTarget as defaultPlaybackTarget } from "../timeline/segments.ts";

type Segment = SegmentRange;

export interface PlayerClock {
  setTimeout: (handler: () => void, timeout?: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
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
  AudioTimeline?: { applyPreviewVolume: () => void };
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
  document?: Document;
  clock?: PlayerClock;
}

export interface PlayerApi {
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
  /** one step slower (-1) or faster (1) through the playback speeds */
  changeSpeed: (direction: number) => void;
  resetSpeed: () => void;
  dispose: () => void;
}

export const PLAYBACK_SPEEDS: readonly number[] = [0.25, 0.5, 1, 1.5, 2, 4];

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

function defaultClock(): PlayerClock {
  return {
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

export function installPlayer(host: PlayerHost): PlayerApi {
  const clock = host.clock ?? defaultClock();
  const doc = host.document ?? document;

  let looping = false;
  let previewSec: number | null = null;
  let seekWanted: number | null = null;
  let seekBusy = false;
  let seekRaf = 0;
  let cancelActiveSeek: (() => void) | null = null;
  let disposed = false;

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

  function togglePlay(): void {
    const v = byId<HTMLVideoElement>("vid");
    if (!v) return;
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
    const v = byId<HTMLVideoElement>("vid");
    if (!v) return;
    if (v.duration)
      v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + seconds));
  }

  function stepFrame(direction: number): void {
    const v = byId<HTMLVideoElement>("vid");
    if (!v || !Number.isFinite(v.duration)) return;
    const path = host.selPath();
    const clip = path ? host.clips()[path] : undefined;
    const fps = clip?.probeData?.fps || 30;
    if (!v.paused) v.pause();
    seekPreview(v.currentTime + direction * (1 / fps));
  }

  function toggleFullscreen(): void {
    const center = byId("center");
    if (!center) return;
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else if (center.requestFullscreen) void center.requestFullscreen();
  }

  function continuePlaybackAt(target: number | null | undefined): void {
    if (looping || target == null) return;
    const v = byId<HTMLVideoElement>("vid");
    if (!v) return;
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
    if (!loopEnabled()) return;
    const segments = host.playbackSegments();
    const first = segments[0];
    if (first) continuePlaybackAt(first.start);
  }

  function updateTime(): void {
    if (host.Timeline?.isDragging() && previewSec != null) {
      host.setPlayheadUI(previewSec, host.videoDuration());
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
    const clamped = Math.max(0, Math.min(full, sec));
    host.setPlayheadUI(clamped, full);
    if (!v.paused) {
      try {
        v.pause();
      } catch {
        /* ignore pause failures during seek */
      }
    }
    seekWanted = clamped;
    if (!seekRaf) {
      seekRaf = clock.requestAnimationFrame(() => {
        seekRaf = 0;
        flushVideoSeek();
      });
    }
  }

  function flushVideoSeek(): void {
    const v = byId<HTMLVideoElement>("vid");
    if (disposed || !v || seekWanted == null || seekBusy) return;
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

  function resetSeek(): void {
    seekWanted = null;
    cancelActiveSeek?.();
    if (seekRaf) clock.cancelAnimationFrame(seekRaf);
    seekRaf = 0;
  }

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

  function onPlay(): void {
    const btn = byId("btn-play");
    if (btn) btn.classList.add("playing");
  }

  function onPause(): void {
    const btn = byId("btn-play");
    if (btn) btn.classList.remove("playing");
  }

  function onDurationOrMeta(): void {
    updateTime();
    host.syncTimelineUI?.();
  }

  function setSpeed(rate: number): void {
    const v = byId<HTMLVideoElement>("vid");
    if (v) {
      v.playbackRate = rate;
      // a newly loaded video keeps the chosen speed
      v.defaultPlaybackRate = rate;
    }
    const badge = byId<HTMLButtonElement>("btn-speed");
    if (badge) {
      badge.hidden = rate === 1;
      badge.textContent = `${rate}×`;
      badge.setAttribute("aria-label", `Playing at ${rate}×. Back to normal speed`);
      badge.dataset.tip = "Back to normal speed";
    }
  }

  function changeSpeed(direction: number): void {
    const v = byId<HTMLVideoElement>("vid");
    setSpeed(nextPlaybackSpeed(v?.playbackRate || 1, direction));
  }

  function resetSpeed(): void {
    setSpeed(1);
  }

  const vid = byId<HTMLVideoElement>("vid");
  if (vid) {
    vid.addEventListener("emptied", resetSeek);
    vid.addEventListener("error", resetSeek);
    vid.addEventListener("play", onPlay);
    vid.addEventListener("pause", onPause);
    vid.addEventListener("timeupdate", updateTime);
    vid.addEventListener("durationchange", onDurationOrMeta);
    vid.addEventListener("loadedmetadata", onDurationOrMeta);
    vid.addEventListener("ended", loopPlayback);
  }
  updateMuteIcon();

  const api: PlayerApi = {
    togglePlay,
    seekBy,
    stepFrame,
    toggleFullscreen,
    updateTime,
    seekPreview,
    seekToRatio,
    toggleMute,
    setVol,
    updateMuteIcon,
    continuePlaybackAt,
    changeSpeed,
    resetSpeed,
    setPreviewSec: (sec) => {
      previewSec = sec;
    },
    getPreviewSec: () => previewSec,
    flushVideoSeek,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (vid) {
        vid.removeEventListener("emptied", resetSeek);
        vid.removeEventListener("error", resetSeek);
        vid.removeEventListener("play", onPlay);
        vid.removeEventListener("pause", onPause);
        vid.removeEventListener("timeupdate", updateTime);
        vid.removeEventListener("durationchange", onDurationOrMeta);
        vid.removeEventListener("loadedmetadata", onDurationOrMeta);
        vid.removeEventListener("ended", loopPlayback);
      }
      resetSeek();
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
