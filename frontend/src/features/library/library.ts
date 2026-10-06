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
import { createPreviewController, type PreviewController } from "../preview/preview-controller.ts";
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
  retryQueueItem?: (itemId: string) => void | Promise<void>;
  pollQueue?: () => void | Promise<void>;
  setInspectorTab?: (tab: string, persist?: boolean) => void;
  // every Library change ends in a render, so this sees each new list of videos
  libraryChanged?: (paths: readonly string[]) => void;
}

export interface LibraryAudioHooks {
  selectVideo?: (clip: EditorClip | null) => void;
  disposeClip?: (clip: EditorClip) => void;
  onProbe?: (clip: EditorClip) => void;
}

export interface LibraryHistoryHooks {
  forgetClip?: (path: string) => void;
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
  renderClips(): void;
  browse(): Promise<void>;
  retryProbeClip(path: string): Promise<void>;
  moveSelection(delta: number, event?: Event): void;
  isReordering(): boolean;
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
    const vid = byId("vid");
    if (vid) vid.style.display = "none";
    return thumb;
  }

  function removeThumbnail(): void {
    byId("thumb")?.remove();
  }

  const preview = createPreviewController({
    clip: (path) => session.clips[path],
    selectedPath: () => session.selPath,
    media: {
      showUrl(url) {
        const video = asHTMLVideoElement(byId("vid"));
        if (!video) return;
        video.src = url;
        video.load();
        video.style.display = "block";
        removeThumbnail();
        video.onerror = () => {
          if (session.selPath) void loadThumb(session.selPath);
        };
      },
      showThumbnail(source) {
        showThumbnail(source);
      },
      clear() {
        const video = asHTMLVideoElement(byId("vid"));
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
        removeThumbnail();
      },
      seek(seconds) {
        const video = asHTMLVideoElement(byId("vid"));
        if (video) video.currentTime = seconds;
      },
    },
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

  function errorSummary(error: unknown, limit = 140): string {
    const text = String(error || "Unknown error")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > limit ? `${text.substring(0, limit)}…` : text;
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
    // the reason sits on the status line's tooltip; an unreadable file has no details to show
    if (clip.error) return { text: "" };
    if (!clip.probed) return { text: "…" };
    const data = clip.probeData;
    const first: string[] = [];
    const duration = clipDuration(clip);
    if (duration) first.push(duration);
    if (data?.width && data.height) first.push(`${data.width}×${data.height}`);
    const encoding =
      clip._queueState === "running" || clip._queueState === "processing";
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
    if (!plan || plan.workflow === "upscale" || !Number.isFinite(estimateMb) || estimateMb <= 0) {
      return size ? { from: size } : null;
    }
    const target = Number(plan.target_size_mb);
    const over = Number.isFinite(target) && target > 0 && estimateMb > target + 0.1;
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
    session.clipOrder = order;
    clipReorder.moved = false;
    renderClips();
    await syncPendingQueueToClipOrder();
  }

  async function syncPendingQueueToClipOrder(): Promise<void> {
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
    try {
      for (let index = 0; index < desired.length; index++) {
        await api.moveItem(desired[index]!, index);
      }
    } catch {
      // queue reorder is best-effort
    }
    await host.pollQueue?.();
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
      retry: (itemId) => {
        if (itemId) void host.retryQueueItem?.(itemId);
      },
      retryProbe: (probePath) => {
        void retryProbeClip(probePath);
      },
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
    const models: ClipCardModel[] = keys.map((path) => {
      const clip = session.clips[path]!;
      let statusLabel = clip._queueState === "failed" ? "" : clip._statusText || "";
      if (!statusLabel && clip._queueState === "completed") statusLabel = "Completed";
      if (!statusLabel && clip._queueState === "pending") statusLabel = "Pending";
      if (!statusLabel && clip._queueState === "running") statusLabel = "Encoding";
      if (!statusLabel && clip._queueState === "failed") statusLabel = "Export failed";
      if (!statusLabel && clip._queueState === "cancelled") statusLabel = "Cancelled";
      if (!statusLabel && clip.error) statusLabel = "Can't read file";
      const detail = clip._queueState === "failed" && clip._queueError
        ? errorSummary(clip._queueError)
        : clip.error ? errorSummary(clip.error) : "";
      const full = clip.probed ? clip.probeData?.duration || 0 : 0;
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
        fileSize: clip._fileSize || 0,
        meta: metaStr(clip),
        thumbnail: clip.error ? "" : clip._thumbnail || "",
        duration: full ? formatTime(full) : "",
        result: clipResult(clip),
        resultSize: clip._queueState === "completed" && clip._resultSize ? formatBytes(clip._resultSize) : "",
      };
    });
    const nextModels = JSON.stringify(models);
    // keep hover transitions and keyboard focus intact when polling changes nothing
    if (nextModels === renderedClipModels) {
      host.updateActionButtons?.();
      return;
    }
    renderedClipModels = nextModels;
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
    updateLibrarySummary(models);
    host.updateActionButtons?.();
  }

  async function loadThumb(path: string): Promise<void> {
    if (!hasBackendClient() || session.selPath !== path) return;
    try {
      const response = await legacyBackendResult(getBackendClient().getThumbnail(path));
      if (session.selPath !== path) return;
      if (response.ok && typeof response.thumbnail === "string" && response.thumbnail) {
        showThumbnail(response.thumbnail);
      }
    } catch {
      // thumbnail fallback remains empty
    }
  }

  function selectClip(path: string): void {
    preview.select(path);
    session.selPath = path;
    renderClips();
    const empty = byId("empty");
    const stage = byId("stage");
    const playerBar = byId("player-bar");
    if (empty) empty.style.display = "none";
    if (stage) stage.style.display = "block";
    playerBar?.classList.add("on");
    removeThumbnail();
    const vid = byId("vid");
    if (vid) vid.style.display = "block";
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

  function removeClip(path: string): void {
    const clip = session.clips[path];
    if (clip) host.audio?.disposeClip?.(clip);
    if (clip?.mediaToken && hasBackendClient()) {
      void getBackendClient().releaseMediaToken(clip.mediaToken);
      clip.mediaToken = null;
    }
    host.history?.forgetClip?.(path);
    void probe.dispose(path);
    delete session.clips[path];
    session.clipOrder = session.clipOrder.filter((value) => value !== path);
    if (session.selPath === path) {
      session.selPath = null;
      const empty = byId("empty");
      const stage = byId("stage");
      const playerBar = byId("player-bar");
      if (empty) empty.style.display = "flex";
      if (stage) stage.style.display = "none";
      playerBar?.classList.remove("on");
      preview.select(null);
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

  function doRemoveAllClips(): void {
    for (const path of Object.keys(session.clips)) {
      const clip = session.clips[path];
      if (clip) host.audio?.disposeClip?.(clip);
      if (clip?.mediaToken && hasBackendClient()) {
        void getBackendClient().releaseMediaToken(clip.mediaToken);
        clip.mediaToken = null;
      }
      host.history?.forgetClip?.(path);
      void probe.dispose(path);
    }
    session.clips = {};
    session.clipOrder = [];
    session.selPath = null;
    const empty = byId("empty");
    const stage = byId("stage");
    const playerBar = byId("player-bar");
    if (empty) empty.style.display = "flex";
    if (stage) stage.style.display = "none";
    playerBar?.classList.remove("on");
    preview.select(null);
    host.audio?.selectVideo?.(null);
    host.syncTimelineUI?.();
    host.syncTransformControls?.();
    host.renderClipDetails?.();
    renderClips();
  }

  function removeAllClips(): void {
    const keys = Object.keys(session.clips);
    if (!keys.length) return;
    let hasActive = false;
    for (const path of keys) {
      const st = session.clips[path]?._queueState || "";
      if (st === "running" || st === "processing" || st === "pending") {
        hasActive = true;
        break;
      }
    }
    if (hasActive) {
      confirmToast("Some files are still processing. Remove all anyway?", doRemoveAllClips);
    } else {
      doRemoveAllClips();
    }
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
    if (rej && added) {
      toast(
        `Added ${added} file${added === 1 ? "" : "s"}; skipped ${rej} unsupported.`,
        "err",
      );
    } else if (rej && !added) {
      toast(`No supported video files in drop (${rej} skipped).`, "err");
    } else if (added > 1) {
      toast(`Added ${added} files.`, "ok");
    }
  }

  async function browse(): Promise<void> {
    if (!hasBackendClient()) return;
    try {
      const response = await legacyBackendResult(getBackendClient().pickFiles());
      if (response.ok && Array.isArray(response.files) && response.files.length) {
        addFiles(response.files);
      } else if (!response.ok) {
        toast(`Could not add files: ${response.error || "Unknown error"}`, "err");
      }
    } catch {
      toast("Could not add files.", "err");
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
    renderClips,
    browse,
    retryProbeClip,
    moveSelection,
    isReordering,
    orderedClipKeys,
    metaStr,
    probe,
    preview,
  };
}

export function installLibrary(host: LibraryHost): LibraryApi {
  return createLibrary(host);
}
