import { getBackendClient, hasBackendClient } from "../../backend/client.ts";
import { legacyBackendResult } from "../editor/backend-compat.ts";
import {
  byId,
  createEditorClip,
  formatBytes,
  formatTime,
  type EditorClip,
  type EditorSession,
} from "../editor/session.ts";
import { confirmToast, toast } from "../editor/toast.ts";
import { formatTarget, withReason } from "../editor/format.ts";
import { EASE_OUT, motionEnabled } from "../../ui/motion.ts";
import type { DetachedHistory } from "../history/history.ts";
import {
  createPreviewController,
  missingPictureMessage,
  SOURCE_EVENT,
  SOURCE_READY_EVENT,
  type PreviewController,
} from "../preview/preview-controller.ts";
import { fetchPlatformCapabilities } from "../../platform/capabilities.ts";
import { alignToQueueOrder, isQueueActive } from "../queue/queue-view.ts";
import { mediaToolsMessage, missingMediaTools } from "../../state/settings-state.ts";
import { SegmentEditing } from "../timeline/segments.ts";
import {
  createClipCard,
  groupClipModels,
  groupHeading,
  groupedClipPaths,
  librarySummary,
  type ClipCardDocument,
  type ClipCardElement,
  type ClipCardEvent,
  type ClipCardModel,
  type ClipResult,
} from "./clip-card.ts";
import { createClipLoader } from "./clip-loader.ts";
import { createProbeCoordinator, type ProbeCoordinator } from "./probe-coordinator.ts";

export interface LibraryEncodingHooks {
  applyProfile?: (force?: boolean) => void;
  applySelectedProfileTransform?: (clip: EditorClip, force: boolean) => void;
  reqPreview?: () => void;
  // plans the videos that are not selected, so each row can say what it becomes
  planLibrary?: () => void;
  // the export task the Library describes each video for
  task?: () => "compression" | "upscale" | "cut";
  updateActionButtons?: () => void;
  syncFpsToClip?: (forceSourceValue?: boolean) => void;
  syncResolutionToClip?: (forceSourceValue?: boolean) => void;
  syncExportSummary?: () => void;
  syncTransformControls?: () => void;
  paintCropOverlay?: () => void;
  renderClipDetails?: () => void;
  syncTimelineUI?: () => void;
  togglePlay?: () => void;
  openResult?: (path: string) => void;
  // a finished export's file: copied to the clipboard, or dragged out of the window
  copyResult?: (itemId: string) => void;
  copyResultState?: (itemId: string, path: string) => { disabled: boolean; label: string };
  dragExportOut?: (itemId: string) => void;
  canDragExportOut?: () => boolean;
  retryQueueItem?: (itemId: string) => void | Promise<void>;
  pollQueue?: () => void | Promise<void>;
  setInspectorTab?: (tab: string, persist?: boolean) => void;
  // every Library change ends in a render, so this sees each new list of videos
  libraryChanged?: (paths: readonly string[]) => void;
  // Settings at its media tools, where FFmpeg and FFprobe are chosen
  openMediaSettings?: () => void;
  // the editor picks the player for a video before its preview loads
  choosePlayer?: (path: string) => void;
}

export interface LibraryAudioHooks {
  selectVideo?: (clip: EditorClip | null) => void;
  disposeClip?: (clip: EditorClip) => void;
  onProbe?: (clip: EditorClip) => void;
}

export interface LibraryHistoryHooks {
  // Undo follows the selected video, so its buttons change with the selection
  updateButtons?: () => void;
  detachClip?: (path: string) => DetachedHistory;
  restoreClip?: (detached: DetachedHistory) => void;
  hasEdits?: (path: string) => boolean;
}

// a removed video waits here, edits and all, until its Undo is no longer offered
interface RemovedClip {
  readonly clip: EditorClip;
  readonly index: number;
  readonly selected: boolean;
  readonly history: DetachedHistory | null;
}

export interface LibraryHost extends LibraryEncodingHooks {
  session: EditorSession;
  documentRef?: Document;
  windowRef?: Window & typeof globalThis;
  audio?: LibraryAudioHooks;
  history?: LibraryHistoryHooks;
}

export interface LibraryApi {
  addFiles(paths: unknown, rejected?: unknown): void;
  removeClip(path: string): void;
  removeAllClips(): void;
  selectClip(path: string): void;
  // loads the selected video's preview again, as Retry does, such as for another player
  reloadPreview(): void;
  renderClips(): void;
  browse(): Promise<void>;
  retryProbeClip(path: string): Promise<void>;
  moveSelection(delta: number, event?: Event): void;
  isReordering(): boolean;
  // says once, while it lasts, that FFmpeg or FFprobe can't be used
  noticeMissingTools(): void;
  orderedClipKeys(): string[];
  metaStr(clip: EditorClip): { text: string };
  probe: ProbeCoordinator;
  preview: PreviewController;
}

interface ClipReorderState {
  active: boolean;
  moved: boolean;
  fromPath: string | null;
  overPath: string | null;
  position: "before" | "after";
  startX: number;
  startY: number;
  el: HTMLElement | null;
  pointerId: number | null;
}

function asHTMLVideoElement(el: HTMLElement | null): HTMLVideoElement | null {
  return el instanceof HTMLVideoElement ? el : null;
}

export function createLibrary(host: LibraryHost): LibraryApi {
  const session = host.session;
  const documentRef = host.documentRef ?? document;
  const windowRef = host.windowRef ?? window;

  const clipReorder: ClipReorderState = {
    active: false,
    moved: false,
    fromPath: null,
    overPath: null,
    position: "before",
    startX: 0,
    startY: 0,
    el: null,
    pointerId: null,
  };

  function showThumbnail(source: string): HTMLImageElement | undefined {
    if (!source) {
      removeThumbnail();
      return;
    }
    let thumb = byId("thumb") as HTMLImageElement | null;
    if (!thumb) {
      thumb = documentRef.createElement("img");
      thumb.id = "thumb";
      thumb.alt = "";
      byId("media-viewport")?.appendChild(thumb);
    }
    thumb.src = source;
    thumb.style.display = "block";
    // the native picture is placed by the video element's box, so it stays laid out there
    const vid = byId("vid");
    if (vid && !nativePicture()) vid.style.display = "none";
    return thumb;
  }

  function removeThumbnail(): void {
    byId("thumb")?.remove();
  }

  // with the native preview the desktop shell draws the picture and says whether it can, so the
  // webview's own success or failure reading the file doesn't decide what the stage shows
  function nativePicture(): boolean {
    return documentRef.documentElement.classList.contains("native-preview");
  }

  // the probed picture size places the native picture when the webview can't read the file
  function syncPictureSize(video: HTMLVideoElement, path: string | null): void {
    const data = path ? session.clips[path]?.probeData : null;
    const width = data?.width ?? 0;
    const height = data?.height ?? 0;
    if (width > 0 && height > 0) {
      video.dataset.pictureWidth = String(width);
      video.dataset.pictureHeight = String(height);
    } else {
      delete video.dataset.pictureWidth;
      delete video.dataset.pictureHeight;
    }
  }

  function announceSource(video: HTMLVideoElement, path: string | null): void {
    syncPictureSize(video, path);
    video.dispatchEvent(new CustomEvent(SOURCE_EVENT, { detail: path }));
  }

  // the stylesheet's animation switch can't reach script-driven animations, so it is checked here
  function motionOn(): boolean {
    return motionEnabled(documentRef);
  }

  // a short wait, so a preview that arrives quickly never flashes the loading note
  const PREVIEW_LOADING_DELAY_MS = 250;
  let previewLoadingTimer: ReturnType<typeof setTimeout> | null = null;
  // counts media handed to the stage, so a late frame or error from an older video is ignored
  let stageMedia = 0;

  function previewStatus(): HTMLElement | null {
    const existing = byId("preview-status");
    if (existing) return existing;
    const stage = byId("stage");
    if (!stage) return null;
    const status = documentRef.createElement("div");
    status.id = "preview-status";
    status.className = "preview-status";
    status.hidden = true;
    const loading = documentRef.createElement("span");
    loading.className = "preview-status-loading";
    loading.textContent = "Loading preview…";
    // exists before it has anything to say, so a failure is announced when it arrives
    const message = documentRef.createElement("span");
    message.className = "preview-status-message";
    message.setAttribute("role", "status");
    const retry = documentRef.createElement("button");
    retry.type = "button";
    retry.className = "preview-status-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      if (session.selPath) preview.select(session.selPath);
    });
    status.append(loading, message, retry);
    stage.append(status);
    return status;
  }

  function setPreviewStatus(
    state: "ready" | "loading" | "unavailable",
    hasPicture = false,
    reason = "",
  ): void {
    if (previewLoadingTimer !== null) {
      clearTimeout(previewLoadingTimer);
      previewLoadingTimer = null;
    }
    const status = previewStatus();
    if (!status) return;
    const loading = status.querySelector<HTMLElement>(".preview-status-loading");
    const message = status.querySelector<HTMLElement>(".preview-status-message");
    const retry = status.querySelector<HTMLElement>(".preview-status-retry");
    if (state === "ready") {
      status.hidden = true;
      if (message) message.textContent = "";
      return;
    }
    if (state === "unavailable") {
      if (loading) loading.hidden = true;
      if (message) {
        message.textContent = reason || (hasPicture
          ? "Preview unavailable"
          : "Can’t show a preview of this video.");
      }
      if (retry) retry.hidden = false;
      status.hidden = false;
      return;
    }
    status.hidden = true;
    if (message) message.textContent = "";
    previewLoadingTimer = setTimeout(() => {
      previewLoadingTimer = null;
      if (loading) loading.hidden = false;
      if (retry) retry.hidden = true;
      status.hidden = false;
      if (motionOn() && typeof status.animate === "function") {
        status.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 120,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        });
      }
    }, PREVIEW_LOADING_DELAY_MS);
  }

  // the first decoded frame takes over from the picture shown while it loaded
  function revealVideo(): void {
    setPreviewStatus("ready");
    const still = byId("thumb");
    if (!still) return;
    if (!motionOn() || typeof still.animate !== "function") {
      still.remove();
      return;
    }
    still
      .animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 120,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      })
      .finished.then(() => still.remove(), () => still.remove());
    // a window that isn't drawing may never finish the fade; the picture still has to go
    setTimeout(() => still.remove(), 200);
  }

  const preview = createPreviewController({
    clip: (path) => session.clips[path],
    selectedPath: () => session.selPath,
    media: {
      showLoading(picture) {
        stageMedia += 1;
        const video = asHTMLVideoElement(byId("vid"));
        if (video) {
          video.onerror = null;
          video.onloadeddata = null;
          video.pause();
          video.removeAttribute("src");
          video.load();
          announceSource(video, null);
        }
        if (picture) showThumbnail(picture);
        else removeThumbnail();
        if (video) video.style.display = "block";
        setPreviewStatus("loading");
      },
      showUrl(url) {
        const video = asHTMLVideoElement(byId("vid"));
        if (!video) return;
        const shown = (stageMedia += 1);
        video.src = url;
        video.load();
        announceSource(video, session.selPath);
        video.style.display = "block";
        if (nativePicture()) {
          video.onloadeddata = null;
          video.onerror = null;
          return;
        }
        // the loading picture stays on top until this video has a frame to show
        video.onloadeddata = () => {
          if (shown !== stageMedia) return;
          if (video.videoWidth) {
            revealVideo();
            return;
          }
          const path = session.selPath;
          if (!path) return;
          const codec = session.clips[path]?.probeData?.video_codec;
          void fetchPlatformCapabilities().then((caps) => {
            if (shown === stageMedia) void loadThumb(path, missingPictureMessage(codec, caps.platform));
          });
        };
        video.onerror = () => {
          if (shown === stageMedia && session.selPath) void loadThumb(session.selPath);
        };
      },
      showThumbnail(source) {
        showThumbnail(source);
      },
      showUnavailable(hasPicture) {
        // the native player reads the file itself, so a preview link the backend couldn't make
        // doesn't stop it; its own answer decides the stage
        const video = asHTMLVideoElement(byId("vid"));
        if (nativePicture() && video && session.selPath) {
          announceSource(video, session.selPath);
          setPreviewStatus("loading");
          return;
        }
        setPreviewStatus("unavailable", hasPicture);
      },
      clear() {
        stageMedia += 1;
        const video = asHTMLVideoElement(byId("vid"));
        if (video) {
          video.onerror = null;
          video.onloadeddata = null;
          video.pause();
          video.removeAttribute("src");
          video.load();
          announceSource(video, null);
        }
        removeThumbnail();
        setPreviewStatus("ready");
      },
      seek(seconds) {
        const video = asHTMLVideoElement(byId("vid"));
        if (video) video.currentTime = seconds;
      },
    },
  });

  const stageVideo = asHTMLVideoElement(byId("vid"));
  stageVideo?.addEventListener(SOURCE_READY_EVENT, () => {
    if (nativePicture()) revealVideo();
  });

  const probe = createProbeCoordinator({
    clip: (path) => session.clips[path],
    onProbeStarted() {
      renderClips();
      if (typeof host.renderClipDetails === "function") host.renderClipDetails();
    },
    onProbeFinished(path, clip, succeeded) {
      if (succeeded) {
        const duration =
          typeof clip.probeData?.duration === "number" ? clip.probeData.duration : 0;
        if (!Array.isArray(clip.segments) || !clip.segments.length) {
          clip.segments = SegmentEditing.fullSegment(duration);
        }
        const segments = clip.segments ?? [];
        clip.activeSegment = Math.max(
          0,
          Math.min(segments.length - 1, clip.activeSegment || 0),
        );
        host.audio?.onProbe?.(clip);
        host.applySelectedProfileTransform?.(clip, false);
      }
      renderClips();
      if (session.selPath === path) {
        const video = asHTMLVideoElement(byId("vid"));
        if (video) syncPictureSize(video, path);
        host.syncFpsToClip?.();
        host.syncResolutionToClip?.();
        host.syncTimelineUI?.();
        host.syncTransformControls?.();
        host.paintCropOverlay?.();
        host.renderClipDetails?.();
        host.reqPreview?.();
      } else if (succeeded) {
        host.planLibrary?.();
      }
    },
  });

  const thumbnailsLoading = new Set<string>();

  async function loadThumbnail(path: string): Promise<void> {
    const clip = session.clips[path];
    if (!clip || clip._thumbnail !== undefined || thumbnailsLoading.has(path)) return;
    if (!hasBackendClient()) return;
    thumbnailsLoading.add(path);
    let thumbnail = "";
    try {
      const response = await legacyBackendResult(getBackendClient().getThumbnail(path));
      if (response.ok && typeof response.thumbnail === "string") thumbnail = response.thumbnail;
    } catch {
      // a video without a picture still lists fine
    } finally {
      thumbnailsLoading.delete(path);
    }
    if (session.clips[path] !== clip) return;
    clip._thumbnail = thumbnail;
    renderClips();
  }

  // pictures take a few milliseconds and probes far longer, so each has its own queue and a
  // large batch shows every picture before its details; two of each leaves backend workers
  // free for the selected video's preview and plan
  const thumbnails = createClipLoader(loadThumbnail, 2);
  const probes = createClipLoader((path) => probe.probe(path), 2);

  function orderedClipKeys(): string[] {
    session.clipOrder = session.clipOrder.filter((path) => !!session.clips[path]);
    for (const key of Object.keys(session.clips)) {
      if (!session.clipOrder.includes(key)) session.clipOrder.push(key);
    }
    return session.clipOrder.slice();
  }

  // the whole reason stays on the card's tooltip and description; the row itself stays short
  function fullReason(error: unknown): string {
    return String(error || "").replace(/\s+/g, " ").trim();
  }

  let toolsNoticeShown = false;

  function noticeMissingTools(): void {
    const missing = missingMediaTools(session.appSettings);
    if (!missing.length) {
      toolsNoticeShown = false;
      return;
    }
    if (toolsNoticeShown) return;
    toolsNoticeShown = true;
    const open = host.openMediaSettings;
    toast(mediaToolsMessage(missing), "err", open ? { label: "Open settings", run: open } : undefined);
  }

  // an unreadable video is most likely down to a missing FFprobe, so its card says so
  function readToolMissing(): boolean {
    return missingMediaTools(session.appSettings).includes("FFprobe");
  }

  function clipDuration(clip: EditorClip): string {
    if (!clip.probed || !clip.probeData || !clip.probeData.duration) return "";
    const full = clip.probeData.duration;
    const segments = SegmentEditing.segmentsForClip(clip, full);
    const selected = SegmentEditing.selectedDuration(segments);
    if (segments.length > 1) {
      return `${formatTime(selected)} · ${segments.length} segments`;
    }
    if (!SegmentEditing.isFullSource(segments, full) && segments[0]) {
      return `${formatTime(segments[0].start)}–${formatTime(segments[0].end)}`;
    }
    return formatTime(selected);
  }

  function metaStr(clip: EditorClip): { text: string } {
    // the reason sits under the status line; an unreadable file has no details to show
    if (clip.error) return { text: "" };
    if (!clip.probed) return { text: "…" };
    const data = clip.probeData;
    const first: string[] = [];
    const duration = clipDuration(clip);
    if (duration) first.push(duration);
    if (data?.width && data.height) first.push(`${data.width}×${data.height}`);
    const encoding = clip._queueState === "running";
    if (!encoding && clip.crop) {
      first.push(`crop ${clip.crop.width}×${clip.crop.height}`);
    }
    if (!encoding && clip.rotation) first.push(`${clip.rotation}°`);
    if (!encoding && (clip.flipHorizontal || clip.flipVertical)) {
      first.push(
        clip.flipHorizontal && clip.flipVertical
          ? "flip H+V"
          : clip.flipHorizontal
            ? "flip H"
            : "flip V",
      );
    }
    let second = !encoding && clip._fileSize ? formatBytes(clip._fileSize) : "";
    if (clip._resultSize && clip._queueState === "completed") {
      second += ` → ${formatBytes(clip._resultSize)}`;
    }
    if (second) first.push(second);
    return { text: first.join(" · ") };
  }

  // short names for common heights, so a row reads "1080p → 4K"
  function resolutionLabel(width: number, height: number): string {
    const names: Record<number, string> = { 2160: "4K", 1440: "1440p", 1080: "1080p", 720: "720p", 480: "480p" };
    const short = Math.min(width, height);
    return names[short] ?? `${width}×${height}`;
  }

  // what the current task makes of a ready video, from its plan when one is ready
  function clipResult(clip: EditorClip): ClipResult | null {
    if (!clip.probed || clip.error) return null;
    const task = host.task?.() ?? "compression";
    if (task === "cut") {
      const full = clip.probeData?.duration || 0;
      if (!full) return null;
      const segments = SegmentEditing.segmentsForClip(clip, full);
      if (SegmentEditing.isFullSource(segments, full)) return { to: "Whole video" };
      return { to: `Keeps ${formatTime(SegmentEditing.selectedDuration(segments))} of ${formatTime(full)}` };
    }
    const plan = clip.planData;
    const width = clip.probeData?.width || 0;
    const height = clip.probeData?.height || 0;
    if (task === "upscale") {
      const source = width && height ? resolutionLabel(width, height) : "";
      const targetWidth = Number(plan?.target_width) || 0;
      const targetHeight = Number(plan?.target_height) || 0;
      if (!plan || !targetWidth || !targetHeight) return source ? { from: source } : null;
      const target = resolutionLabel(targetWidth, targetHeight);
      return target === source ? { to: `Stays ${target}` } : { from: source, to: target };
    }
    const size = clip._fileSize ? formatBytes(clip._fileSize) : "";
    const estimateMb = plan ? Number(plan.estimated_size_mb) : NaN;
    if (!plan && clip._hadEstimate) {
      // an estimate for the old settings would be wrong, so it goes; the row keeps its shape
      // with a placeholder until the new plan lands
      return { from: size, pending: true };
    }
    if (!plan || plan.workflow === "upscale" || !Number.isFinite(estimateMb) || estimateMb <= 0) {
      return size ? { from: size } : null;
    }
    const target = Number(plan.target_size_mb);
    const over = Number.isFinite(target) && target > 0 && estimateMb > target + 0.1;
    clip._hadEstimate = true;
    return { from: size, to: formatBytes(estimateMb * 1024 * 1024), over };
  }

  function updateLibrarySummary(models: ClipCardModel[]): void {
    const summary = librarySummary(models);
    const count = byId("library-summary-count");
    const size = byId("library-summary-size");
    if (count) count.textContent = summary.countLabel;
    if (size) size.textContent = summary.sizeLabel;
    const summaryElement = byId("library-summary");
    if (summaryElement) summaryElement.hidden = models.length === 0;
  }

  function clearDropTargets(): void {
    const nodes = byId("clips")?.querySelectorAll<HTMLElement>("[data-drop-position]") ?? [];
    for (const node of nodes) delete node.dataset.dropPosition;
  }

  function beginClipReorder(
    event: ClipCardEvent | PointerEvent,
    path: string,
    card: ClipCardElement | HTMLElement,
  ): void {
    const pointer = event as PointerEvent;
    if (!path || (typeof pointer.button === "number" && pointer.button !== 0)) return;
    if (orderedClipKeys().length < 2) return;
    event.stopPropagation?.();
    const el = card as HTMLElement;
    clipReorder.active = true;
    clipReorder.moved = false;
    clipReorder.fromPath = path;
    clipReorder.overPath = null;
    clipReorder.startX = pointer.clientX || 0;
    clipReorder.startY = pointer.clientY || 0;
    clipReorder.el = el;
    clipReorder.pointerId = pointer.pointerId ?? null;
    try {
      if (pointer.pointerId != null) el.setPointerCapture(pointer.pointerId);
    } catch {
      // pointer capture is best-effort
    }
    windowRef.addEventListener("pointermove", onClipReorderMove, true);
    windowRef.addEventListener("pointerup", onClipReorderEnd, true);
    windowRef.addEventListener("pointercancel", onClipReorderEnd, true);
  }

  // a press on a finished export's picture becomes a file drag once it moves as far as a reorder would
  function beginExportDrag(event: ClipCardEvent | PointerEvent, itemId: string): void {
    const pointer = event as PointerEvent;
    if (clipReorder.active || (typeof pointer.button === "number" && pointer.button !== 0)) return;
    const startX = pointer.clientX || 0;
    const startY = pointer.clientY || 0;
    const stop = (): void => {
      windowRef.removeEventListener("pointermove", move, true);
      windowRef.removeEventListener("pointerup", stop, true);
      windowRef.removeEventListener("pointercancel", stop, true);
    };
    const move = (moved: Event): void => {
      if (!(moved instanceof PointerEvent)) return;
      if ((moved.buttons & 1) === 0) {
        stop();
        return;
      }
      const dx = moved.clientX - startX;
      const dy = moved.clientY - startY;
      if (dx * dx + dy * dy < 16) return;
      stop();
      host.dragExportOut?.(itemId);
    };
    windowRef.addEventListener("pointermove", move, true);
    windowRef.addEventListener("pointerup", stop, true);
    windowRef.addEventListener("pointercancel", stop, true);
  }

  function onClipReorderMove(event: Event): void {
    if (!(event instanceof PointerEvent) || !clipReorder.active) return;
    const dx = event.clientX - clipReorder.startX;
    const dy = event.clientY - clipReorder.startY;
    if (!clipReorder.moved && dx * dx + dy * dy < 16) return;
    if (!clipReorder.moved) {
      clipReorder.moved = true;
      clipReorder.el?.classList.add("dragging");
    }
    event.preventDefault();
    const under = documentRef.elementFromPoint(event.clientX, event.clientY);
    const card =
      under && "closest" in under
        ? (under as Element).closest(".clip[data-clip-path]")
        : null;
    clearDropTargets();
    if (
      card instanceof HTMLElement &&
      card.dataset.clipPath &&
      card.dataset.clipPath !== clipReorder.fromPath
    ) {
      const bounds = card.getBoundingClientRect();
      clipReorder.position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      card.dataset.dropPosition = clipReorder.position;
      clipReorder.overPath = card.dataset.clipPath;
    } else {
      clipReorder.overPath = null;
    }
  }

  async function onClipReorderEnd(event: Event): Promise<void> {
    if (!clipReorder.active) return;
    windowRef.removeEventListener("pointermove", onClipReorderMove, true);
    windowRef.removeEventListener("pointerup", onClipReorderEnd, true);
    windowRef.removeEventListener("pointercancel", onClipReorderEnd, true);
    const fromPath = clipReorder.fromPath;
    const overPath = clipReorder.overPath;
    const el = clipReorder.el;
    const moved = clipReorder.moved;
    if (el) {
      try {
        if (clipReorder.pointerId != null) el.releasePointerCapture(clipReorder.pointerId);
      } catch {
        // ignore release failures
      }
      el.classList.remove("dragging");
    }
    clearDropTargets();
    clipReorder.active = false;
    clipReorder.fromPath = null;
    clipReorder.overPath = null;
    clipReorder.el = null;
    clipReorder.pointerId = null;
    if (event.type === "pointercancel" || !moved || !fromPath || !overPath || fromPath === overPath) {
      clipReorder.moved = false;
      renderClips();
      return;
    }
    const order = orderedClipKeys();
    const fromIdx = order.indexOf(fromPath);
    const toIdx = order.indexOf(overPath);
    if (fromIdx < 0 || toIdx < 0) {
      clipReorder.moved = false;
      renderClips();
      return;
    }
    order.splice(fromIdx, 1);
    const insertion = order.indexOf(overPath) + (clipReorder.position === "after" ? 1 : 0);
    order.splice(insertion, 0, fromPath);
    const before = cardTops();
    session.clipOrder = order;
    clipReorder.moved = false;
    renderClips();
    settleCards(before);
    await syncPendingQueueToClipOrder();
  }

  // what each card showed last time, so only real changes move: a video that just arrived, a
  // picture that just loaded, or an export that just finished
  let cardsShown = new Map<string, { queueState: string; thumbnail: string }>();

  function animateCardChanges(models: readonly ClipCardModel[]): void {
    const before = cardsShown;
    cardsShown = new Map(models.map((model) => [
      model.path,
      { queueState: model.queueState || "", thumbnail: model.thumbnail || "" },
    ]));
    if (!motionOn()) return;
    let entering = 0;
    for (const card of byId("clips")?.querySelectorAll<HTMLElement>(".clip[data-clip-path]") ?? []) {
      const path = card.dataset.clipPath;
      if (!path || typeof card.animate !== "function") continue;
      const was = before.get(path);
      const now = cardsShown.get(path);
      if (!was) {
        // new videos fade up one after another; past the sixth they simply appear
        if (entering < 6) {
          card.animate(
            [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
            { duration: 160, easing: EASE_OUT, delay: entering * 30, fill: "backwards" },
          );
        }
        entering += 1;
        continue;
      }
      if (!was.thumbnail && now?.thumbnail) {
        card.querySelector(".c-thumb img")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE_OUT });
      }
      const wasActive = was.queueState === "running" || was.queueState === "pending";
      if (wasActive && now?.queueState === "completed") {
        card.querySelector(".c-line")?.animate(
          [{ opacity: 0, transform: "translateY(2px)" }, { opacity: 1, transform: "none" }],
          { duration: 160, easing: EASE_OUT },
        );
      }
    }
  }

  function cardTops(): Map<string, number> {
    const tops = new Map<string, number>();
    for (const card of byId("clips")?.querySelectorAll<HTMLElement>(".clip[data-clip-path]") ?? []) {
      if (card.dataset.clipPath) tops.set(card.dataset.clipPath, card.getBoundingClientRect().top);
    }
    return tops;
  }

  // the new order is already in place; cards only slide from where they were, so the moved video can be followed
  function settleCards(before: ReadonlyMap<string, number>): void {
    if (!motionOn()) return;
    for (const card of byId("clips")?.querySelectorAll<HTMLElement>(".clip[data-clip-path]") ?? []) {
      const was = card.dataset.clipPath ? before.get(card.dataset.clipPath) : undefined;
      if (was == null || typeof card.animate !== "function") continue;
      const shift = was - card.getBoundingClientRect().top;
      if (Math.abs(shift) < 1) continue;
      // matches --workspace-motion
      card.animate(
        [{ transform: `translateY(${shift}px)` }, { transform: "none" }],
        { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }

  // a drag that ends while the queue is still being reordered waits its turn, so moves never interleave
  let queueOrderSync: Promise<void> = Promise.resolve();

  function syncPendingQueueToClipOrder(): Promise<void> {
    queueOrderSync = queueOrderSync.then(applyClipOrderToQueue, applyClipOrderToQueue);
    return queueOrderSync;
  }

  async function applyClipOrderToQueue(): Promise<void> {
    if (!hasBackendClient()) return;
    const api = getBackendClient();
    const desired: string[] = [];
    for (const path of session.clipOrder) {
      const clip = session.clips[path];
      if (clip && clip._queueState === "pending" && clip._queueItemId) {
        desired.push(clip._queueItemId);
      }
    }
    if (desired.length < 2) return;
    let moved = true;
    try {
      for (let index = 0; index < desired.length && moved; index++) {
        moved = (await api.moveItem(desired[index]!, index)).ok;
      }
    } catch {
      moved = false;
    }
    // usually an export started before its move arrived; the Library must not promise an order the queue won't run
    if (!moved) await alignLibraryToQueue();
    await host.pollQueue?.();
  }

  async function alignLibraryToQueue(): Promise<void> {
    let waitingIds: string[] | null = null;
    try {
      const state = await getBackendClient().getQueueState();
      const ids = state.ok ? state.value.pending_ids : null;
      if (Array.isArray(ids)) waitingIds = ids.filter((id): id is string => typeof id === "string");
    } catch {
      // handled below: without the queue's own order there is nothing reliable to show
    }
    if (!waitingIds) {
      toast("Couldn’t reorder exports. They may run in a different order than the Library shows.", "err");
      return;
    }
    const pathById = new Map<string, string>();
    for (const path of session.clipOrder) {
      const id = session.clips[path]?._queueItemId;
      if (id) pathById.set(id, path);
    }
    const waitingPaths = waitingIds.map((id) => pathById.get(id)).filter((path): path is string => !!path);
    const before = cardTops();
    session.clipOrder = alignToQueueOrder(session.clipOrder, waitingPaths);
    renderClips();
    settleCards(before);
    toast("Exports couldn’t follow that order, so the Library now shows the order they will run in.", "info");
  }

  function appendLibraryClip(container: HTMLElement, model: ClipCardModel): void {
    const path = model.path;
    const div = createClipCard(documentRef as unknown as ClipCardDocument, model, {
      select() {
        if (clipReorder.moved) {
          clipReorder.moved = false;
          return;
        }
        selectClip(path);
      },
      togglePlay() {
        selectClip(path);
        host.togglePlay?.();
      },
      remove: removeClip,
      openResult: (resultPath) => {
        if (resultPath) void host.openResult?.(resultPath);
      },
      copyResult: (itemId) => host.copyResult?.(itemId),
      beginDragOut: beginExportDrag,
      retry: (itemId) => {
        if (itemId) void host.retryQueueItem?.(itemId);
      },
      retryProbe: (probePath) => {
        void retryProbeClip(probePath);
      },
      openToolSettings: () => host.openMediaSettings?.(),
      beginReorder: beginClipReorder,
    });
    container.appendChild(div as unknown as Node);
  }

  let renderedClipModels: string | null = null;

  function renderClips(): void {
    if (clipReorder.active) return;
    const keys = orderedClipKeys();
    host.libraryChanged?.(keys);
    const cdiv = byId("clips");
    const el = byId("drop-z");
    if (!cdiv || !el) return;
    const removeAll = byId("btn-rmall");
    if (removeAll) removeAll.style.display = keys.length ? "block" : "none";
    if (!keys.length) {
      renderedClipModels = null;
      cdiv.replaceChildren(el);
      el.classList.add("show");
      updateLibrarySummary([]);
      host.updateActionButtons?.();
      return;
    }
    el.classList.remove("show");
    const toolMissing = readToolMissing();
    const dragOut = host.canDragExportOut?.() === true;
    const models: ClipCardModel[] = keys.map((path) => {
      const clip = session.clips[path]!;
      const needsTool = !!clip.error && toolMissing && !clip._queueState;
      let statusLabel = clip._queueState === "failed" ? "" : clip._statusText || "";
      if (!statusLabel && clip._queueState === "completed") statusLabel = "Completed";
      if (!statusLabel && clip._queueState === "pending") statusLabel = "Waiting";
      if (!statusLabel && clip._queueState === "running") statusLabel = "Encoding";
      if (!statusLabel && clip._queueState === "failed") statusLabel = "Export failed";
      if (!statusLabel && clip._queueState === "cancelled") statusLabel = "Canceled";
      if (!statusLabel && needsTool) statusLabel = "No FFprobe";
      if (!statusLabel && clip.error) statusLabel = "Can't read file";
      const detail = clip._queueState === "failed" && clip._queueError
        ? fullReason(clip._queueError)
        : needsTool
          ? "Tuck can’t read videos without FFprobe. Choose it in Settings > Media tools."
          : clip.error ? fullReason(clip.error) : "";
      const full = clip.probed ? clip.probeData?.duration || 0 : 0;
      const itemId = clip._queueItemId || "";
      const resultPath = clip._resultPath || "";
      const finished = clip._queueState === "completed" && !!resultPath && !!itemId;
      const copy = finished ? host.copyResultState?.(itemId, resultPath) : undefined;
      return {
        path,
        name: clip.name,
        selected: session.selPath === path,
        queueItemId: clip._queueItemId || "",
        queueState: clip._queueState || "",
        resultPath: clip._resultPath || "",
        statusLabel,
        detail,
        progress: clip._progress || 0,
        progressIndeterminate: clip._progressIndeterminate === true,
        probeError: !!clip.error,
        setupTool: needsTool ? "FFprobe" : "",
        fileSize: clip._fileSize || 0,
        meta: metaStr(clip),
        thumbnail: clip.error ? "" : clip._thumbnail || "",
        duration: full ? formatTime(full) : "",
        result: clipResult(clip),
        resultSize: clip._queueState === "completed" && clip._resultSize ? formatBytes(clip._resultSize) : "",
        resultTarget: clip._queueState === "completed" && clip._resultTarget ? formatTarget(clip._resultTarget) : "",
        resultFits: clip._resultFits === true,
        resultNote: clip._queueState === "completed" ? clip._resultNote || "" : "",
        resultNoteDetail: clip._queueState === "completed" ? clip._resultNoteDetail || "" : "",
        copyLabel: copy?.label ?? "",
        // one copy runs at a time, so every row's Copy file waits while it does
        copyPending: copy?.disabled === true,
        canDragOut: finished && dragOut,
      };
    });
    const nextModels = JSON.stringify(models);
    // keep hover transitions and keyboard focus intact when polling changes nothing
    if (nextModels === renderedClipModels) {
      host.updateActionButtons?.();
      return;
    }
    renderedClipModels = nextModels;
    // a changed row is drawn again; whatever had focus in the list keeps it
    const active = documentRef.activeElement;
    const focused = active instanceof HTMLElement && cdiv.contains(active)
      ? { path: active.closest<HTMLElement>("[data-clip-path]")?.dataset.clipPath ?? "", action: active.dataset.clipAction ?? "" }
      : null;
    cdiv.replaceChildren(el);
    const groups = groupClipModels(models);
    for (const group of groups) {
      const section = documentRef.createElement("section");
      section.className = `lib-group lib-group-${group.key}`;
      section.dataset.libraryGroup = group.key;
      // a single list needs no heading; one only appears once there is something to tell apart
      if (groups.length > 1) {
        const headingId = `library-group-label-${group.key}`;
        section.setAttribute("aria-labelledby", headingId);
        const heading = documentRef.createElement("div");
        heading.className = "lib-section-heading";
        const label = documentRef.createElement("span");
        label.id = headingId;
        label.textContent = groupHeading(group);
        heading.appendChild(label);
        section.appendChild(heading);
      } else {
        section.setAttribute("aria-label", group.label);
      }
      for (const item of group.items) appendLibraryClip(section, item);
      cdiv.appendChild(section);
    }
    if (focused?.path) restoreListFocus(cdiv, focused.path, focused.action);
    animateCardChanges(models);
    updateLibrarySummary(models);
    host.updateActionButtons?.();
  }

  // a preview that failed to play falls back to the video's picture and says so
  async function loadThumb(path: string, reason = ""): Promise<void> {
    if (!hasBackendClient() || session.selPath !== path) return;
    let shown = false;
    try {
      const response = await legacyBackendResult(getBackendClient().getThumbnail(path));
      if (session.selPath !== path) return;
      if (response.ok && typeof response.thumbnail === "string" && response.thumbnail) {
        showThumbnail(response.thumbnail);
        shown = true;
      }
    } catch {
      if (session.selPath !== path) return;
    }
    setPreviewStatus("unavailable", shown, reason);
  }

  function selectClip(path: string): void {
    host.choosePlayer?.(path);
    preview.select(path);
    session.selPath = path;
    host.history?.updateButtons?.();
    renderClips();
    const empty = byId("empty");
    const stage = byId("stage");
    const playerBar = byId("player-bar");
    if (empty) empty.style.display = "none";
    if (stage) stage.style.display = "block";
    playerBar?.classList.add("on");
    const play = byId("btn-play");
    if (play) play.classList.remove("playing");
    const clip = session.clips[path];
    if (!clip) return;
    host.audio?.selectVideo?.(clip);
    host.syncTimelineUI?.();
    host.syncTransformControls?.();
    host.paintCropOverlay?.();
    host.renderClipDetails?.();
    if (clip._thumbnail === undefined) thumbnails.prioritize(path);
    if (!clip.probed && !clip.error) probes.prioritize(path);
    else if (clip.probed) {
      host.syncFpsToClip?.();
      host.syncResolutionToClip?.();
      host.syncExportSummary?.();
      host.reqPreview?.();
    }
  }

  let removedClips: RemovedClip[] = [];

  // takes a video out of the Library but keeps what Undo needs to put it back as it was
  function takeClip(path: string): RemovedClip | null {
    const clip = session.clips[path];
    if (!clip) return null;
    const index = orderedClipKeys().indexOf(path);
    // the preview asks for a new media link if the video comes back
    if (clip.mediaToken && hasBackendClient()) {
      void getBackendClient().releaseMediaToken(clip.mediaToken);
      clip.mediaToken = null;
    }
    const history = host.history?.detachClip?.(path) ?? null;
    delete session.clips[path];
    session.clipOrder = session.clipOrder.filter((value) => value !== path);
    return { clip, index, selected: session.selPath === path, history };
  }

  function clearStage(): void {
    session.selPath = null;
    host.history?.updateButtons?.();
    const empty = byId("empty");
    const stage = byId("stage");
    const playerBar = byId("player-bar");
    if (empty) empty.style.display = "flex";
    if (stage) stage.style.display = "none";
    playerBar?.classList.remove("on");
    preview.select(null);
  }

  function afterRemoval(removedSelected: boolean): void {
    if (removedSelected) {
      clearStage();
      if (session.clipOrder.length) selectClip(session.clipOrder[0]!);
      else {
        host.audio?.selectVideo?.(null);
        host.syncTimelineUI?.();
        host.syncTransformControls?.();
        host.renderClipDetails?.();
      }
    }
    renderClips();
  }

  // one message covers removals made while it is up, and its Undo brings them all back
  function offerUndo(): void {
    const first = removedClips[0];
    if (!first) return;
    const message = removedClips.length === 1
      ? `Removed “${first.clip.name}”.`
      : `Removed ${removedClips.length} videos.`;
    toast(message, "info", { label: "Undo", run: undoRemoval }, {
      key: "library-removed",
      onDismiss: releaseRemovedClips,
    });
  }

  // Undo is gone, so the removed videos' audio and probe state can be let go
  function releaseRemovedClips(): void {
    const released = removedClips;
    removedClips = [];
    for (const { clip } of released) {
      host.audio?.disposeClip?.(clip);
      if (!session.clips[clip.path]) void probe.dispose(clip.path);
    }
  }

  function undoRemoval(): void {
    // the cards around a returning video slide over to make room
    const before = cardTops();
    const restoring = removedClips;
    removedClips = [];
    let reselect: string | null = null;
    // later removals go back first, so each earlier position is right again
    for (const entry of [...restoring].reverse()) {
      const { clip } = entry;
      // the same file was added again meanwhile; keep that one
      if (session.clips[clip.path]) continue;
      session.clips[clip.path] = clip;
      session.clipOrder.splice(Math.max(0, Math.min(entry.index, session.clipOrder.length)), 0, clip.path);
      if (entry.history) host.history?.restoreClip?.(entry.history);
      // a read or picture still in flight when it was removed was dropped, so ask again
      clip.probing = false;
      if (entry.selected) reselect = clip.path;
    }
    const target = reselect ?? (session.selPath ? null : session.clipOrder[0] ?? null);
    if (target) selectClip(target);
    else renderClips();
    settleCards(before);
    const order = orderedClipKeys();
    thumbnails.add(order.filter((path) => session.clips[path]?._thumbnail === undefined));
    probes.add(order.filter((path) => {
      const clip = session.clips[path];
      return !!clip && !clip.probed && !clip.probing && !clip.error;
    }));
    // the Undo button has gone, so focus moves to the video that came back
    const active = documentRef.activeElement;
    if (!active || active === documentRef.body) focusCard(target ?? restoring[0]?.clip.path ?? "");
  }

  function restoreListFocus(list: HTMLElement, path: string, action: string): void {
    const card = Array.from(list.querySelectorAll<HTMLElement>("[data-clip-path]")).find(
      (element) => element.dataset.clipPath === path,
    );
    if (!card) return;
    const button = action
      ? Array.from(card.querySelectorAll<HTMLElement>("[data-clip-action]")).find(
        (element) => element.dataset.clipAction === action,
      )
      : null;
    // rows redraw on every export progress poll, so scrolling the focused row back into view
    // would pull the list away from wherever the user scrolled
    (button ?? card).focus({ preventScroll: true });
  }

  function focusCard(path: string): void {
    for (const card of byId("clips")?.querySelectorAll<HTMLElement>(".clip[data-clip-path]") ?? []) {
      if (card.dataset.clipPath === path) {
        card.focus();
        return;
      }
    }
  }

  function removeClip(path: string): void {
    // the cards below a removed video slide up into its place instead of jumping
    const before = cardTops();
    const removed = takeClip(path);
    if (!removed) return;
    removedClips.push(removed);
    afterRemoval(removed.selected);
    settleCards(before);
    offerUndo();
  }

  function doRemoveAllClips(): void {
    let removedSelected = false;
    for (const path of orderedClipKeys()) {
      const removed = takeClip(path);
      if (!removed) continue;
      removedClips.push(removed);
      removedSelected ||= removed.selected;
    }
    if (removedSelected || session.selPath) clearStage();
    host.audio?.selectVideo?.(null);
    host.syncTimelineUI?.();
    host.syncTransformControls?.();
    host.renderClipDetails?.();
    renderClips();
    offerUndo();
  }

  function removeAllClips(): void {
    const keys = orderedClipKeys();
    if (!keys.length) return;
    const exporting = keys.some((path) => isQueueActive(session.clips[path]?._queueState));
    const edited = keys.filter((path) => host.history?.hasEdits?.(path)).length;
    if (!exporting && !edited) {
      doRemoveAllClips();
      return;
    }
    const notes: string[] = [];
    if (edited) notes.push(edited === 1 ? "Edits to 1 video go with it." : `Edits to ${edited} videos go with them.`);
    if (exporting) notes.push("Exports already waiting or running keep going.");
    confirmToast(notes.join(" "), doRemoveAllClips, {
      title: keys.length === 1 ? "Remove the video?" : `Remove all ${keys.length} videos?`,
      confirmLabel: "Remove all",
      cancelLabel: "Keep videos",
      danger: true,
    });
  }

  function addFiles(paths: unknown, rejected?: unknown): void {
    if (!Array.isArray(paths)) return;
    let added = 0;
    let firstAdded: string | null = null;
    for (const entry of paths) {
      if (typeof entry !== "string") continue;
      const path = entry;
      if (session.clips[path]) continue;
      const clip = createEditorClip(path);
      session.clips[path] = clip;
      host.applySelectedProfileTransform?.(clip, true);
      if (!session.clipOrder.includes(path)) session.clipOrder.push(path);
      if (!firstAdded) firstAdded = path;
      added += 1;
    }
    renderClips();
    const order = orderedClipKeys();
    thumbnails.add(order.filter((path) => session.clips[path]?._thumbnail === undefined));
    probes.add(
      order.filter((path) => {
        const clip = session.clips[path];
        return !!clip && !clip.probed && !clip.probing;
      }),
    );
    if (added && !session.selPath) {
      selectClip(firstAdded || session.clipOrder[0] || Object.keys(session.clips)[0] || "");
    }
    const rej = Array.isArray(rejected) ? rejected.length : 0;
    const videos = (count: number): string => `${count} ${count === 1 ? "video" : "videos"}`;
    const files = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;
    // some videos went in, so skipped files are worth knowing about but are not an error
    if (rej && added) {
      toast(`Added ${videos(added)}. Skipped ${files(rej)} Tuck can’t open.`, "info");
    } else if (rej && !added) {
      toast(`No videos added. Tuck can’t open ${rej === 1 ? "that file" : `those ${files(rej)}`}.`, "err");
    } else if (added > 1) {
      toast(`Added ${videos(added)}.`, "ok");
    }
  }

  async function browse(): Promise<void> {
    if (!hasBackendClient()) return;
    try {
      const response = await legacyBackendResult(getBackendClient().pickFiles());
      if (response.ok && Array.isArray(response.files) && response.files.length) {
        addFiles(response.files);
      } else if (!response.ok) {
        toast(withReason("Couldn’t add videos.", response.error), "err");
      }
    } catch {
      toast("Couldn’t add videos. Try again.", "err");
    }
  }

  async function retryProbeClip(path: string): Promise<void> {
    const clip = session.clips[path];
    // a file that could not be read earlier may have a picture now
    if (clip && !clip._thumbnail) delete clip._thumbnail;
    await Promise.all([probe.retry(path), loadThumbnail(path)]);
  }

  function libraryClipTarget(event: Event | undefined): HTMLElement | null {
    const target = event?.target;
    if (!(target instanceof Element) || typeof target.closest !== "function") return null;
    return target.closest("#clips .clip[data-clip-path]");
  }

  function moveSelection(delta: number, event?: Event): void {
    const keys = groupedClipPaths(
      orderedClipKeys().map((path) => ({
        path,
        name: session.clips[path]?.name || path,
        queueState: session.clips[path]?._queueState || "",
        probeError: !!session.clips[path]?.error,
      })),
    );
    if (!keys.length) return;
    const focusedClip = libraryClipTarget(event);
    const currentPath = focusedClip?.dataset.clipPath || session.selPath;
    let index = currentPath ? keys.indexOf(currentPath) : 0;
    index = Math.max(0, Math.min(keys.length - 1, index + delta));
    const nextPath = keys[index];
    if (!nextPath) return;
    selectClip(nextPath);
    const clipsRoot = byId("clips");
    if (!clipsRoot) return;
    for (const clip of clipsRoot.querySelectorAll(".clip[data-clip-path]")) {
      if (!(clip instanceof HTMLElement)) continue;
      if (clip.dataset.clipPath !== nextPath) continue;
      clip.focus();
      break;
    }
  }

  function isReordering(): boolean {
    return clipReorder.active;
  }

  return {
    addFiles,
    removeClip,
    removeAllClips,
    selectClip,
    reloadPreview: () => {
      if (session.selPath) preview.select(session.selPath);
    },
    renderClips,
    browse,
    retryProbeClip,
    moveSelection,
    isReordering,
    noticeMissingTools,
    orderedClipKeys,
    metaStr,
    probe,
    preview,
  };
}

export function installLibrary(host: LibraryHost): LibraryApi {
  return createLibrary(host);
}
