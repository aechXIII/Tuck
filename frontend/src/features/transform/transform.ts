import type { EditorClip } from "../editor/types.ts";
import * as CropGeometry from "./crop-geometry.ts";
import type {
  ContainedRect,
  CropRect,
  TransformPreviewGeometry,
  TransformPreviewInput,
} from "./crop-geometry.ts";

export interface Size2D {
  width: number;
  height: number;
}

export interface CropTransform extends TransformPreviewInput {
  crop: CropRect | null;
  crop_aspect: string;
  rotation: number;
  flip_horizontal: boolean;
  flip_vertical: boolean;
  sizing_mode: string;
}

export interface PlannedTransformGeometry {
  oriented_width: number;
  oriented_height: number;
  fill_crop: CropRect | null | undefined;
  output_width: number;
  output_height: number;
}

export interface TransformClipValues {
  cropAspect: string;
  crop: CropRect | null;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  sizingMode: string;
}

export interface TransformHost {
  document: Document;
  window?: Window & typeof globalThis;
  clips: () => Readonly<Record<string, EditorClip>>;
  selPath: () => string | null;
  History?: { begin: (path: string | null) => void; commit: () => void };
  renderClips?: () => void;
  reqPreview?: () => void;
  clock?: {
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame: (id: number) => void;
    setTimeout: (handler: () => void, timeout?: number) => number;
    clearTimeout: (id: number) => void;
  };
}

export interface TransformApi {
  paintCropOverlay: () => void;
  syncTransformControls: () => void;
  setCropAspect: (aspect: string) => void;
  setVideoRotation: (rotation: number) => void;
  toggleVideoFlip: (axis: "horizontal" | "vertical") => void;
  setSizingMode: (mode: string) => void;
  clearCrop: () => void;
  resetVideoTransform: () => void;
  resetVideoTransformValues: (clip: TransformClipValues) => void;
  cropTransformForRequest: (clip: EditorClip | null | undefined) => CropTransform | null;
  dispose: () => void;
}

interface PreviewMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface EditorGeometry {
  transform: CropTransform;
  preview: TransformPreviewGeometry;
  frame: ContainedRect;
  matrix: PreviewMatrix;
}

interface CropDragState {
  clip: EditorClip;
  handle: string;
  editor: EditorGeometry;
  origin: CropRect;
  start: { x: number; y: number };
  pointerId: number;
}

interface PlannedGeometryView {
  orientedWidth: number;
  orientedHeight: number;
  fillCrop: CropRect | null | undefined;
  output: Size2D;
}

let active: TransformApi | null = null;

function requireActive(): TransformApi {
  if (!active) throw new Error("installTransform() must be called first");
  return active;
}

function defaultClock(windowRef: Window & typeof globalThis) {
  return {
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      windowRef.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => {
      windowRef.cancelAnimationFrame(id);
    },
    setTimeout: (handler: () => void, timeout?: number) =>
      windowRef.setTimeout(handler, timeout) as unknown as number,
    clearTimeout: (id: number) => {
      windowRef.clearTimeout(id);
    },
  };
}

export function resetVideoTransformValues(clip: TransformClipValues): void {
  clip.cropAspect = "off";
  clip.crop = null;
  clip.rotation = 0;
  clip.flipHorizontal = false;
  clip.flipVertical = false;
  clip.sizingMode = "fit";
}

export function cropTransformForRequest(
  clip: EditorClip | null | undefined,
): CropTransform | null {
  if (!clip) return null;
  return {
    crop: clip.crop
      ? {
          x: clip.crop.x,
          y: clip.crop.y,
          width: clip.crop.width,
          height: clip.crop.height,
        }
      : null,
    crop_aspect: clip.cropAspect === "off" ? "free" : clip.cropAspect || "free",
    rotation: clip.rotation || 0,
    flip_horizontal: !!clip.flipHorizontal,
    flip_vertical: !!clip.flipVertical,
    sizing_mode: clip.sizingMode || "fit",
  };
}

export function installTransform(host: TransformHost): TransformApi {
  const doc = host.document;
  const windowRef = host.window ?? (typeof window !== "undefined" ? window : undefined);
  const clock =
    host.clock ??
    (windowRef
      ? defaultClock(windowRef)
      : {
          requestAnimationFrame: (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
          },
          cancelAnimationFrame: () => {},
          setTimeout: (handler: () => void) => {
            handler();
            return 0;
          },
          clearTimeout: () => {},
        });

  let drag: CropDragState | null = null;
  let moveEvent: PointerEvent | null = null;
  let moveRaf = 0;
  let tooltipTimer = 0;
  let tooltipTarget: HTMLElement | null = null;
  let tooltipPointerActive = false;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  function selectedClip(): EditorClip | null {
    const path = host.selPath();
    return path && host.clips()[path] ? host.clips()[path]! : null;
  }

  function sourceSize(clip: EditorClip | null): Size2D | null {
    const data = clip?.probeData;
    return data && typeof data.width === "number" && typeof data.height === "number" &&
      data.width > 0 &&
      data.height > 0
      ? { width: data.width, height: data.height }
      : null;
  }

  function setBox(
    element: HTMLElement | null,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!element) return;
    element.style.left = left + "px";
    element.style.top = top + "px";
    element.style.width = Math.max(0, width) + "px";
    element.style.height = Math.max(0, height) + "px";
  }

  function mediaElements(): HTMLElement[] {
    return [doc.getElementById("vid"), doc.getElementById("thumb")].filter(
      (element): element is HTMLElement => element != null,
    );
  }

  function orientedPoint(
    x: number,
    y: number,
    crop: CropRect,
    rotation: number,
  ): { x: number; y: number } {
    const localX = x - crop.x;
    const localY = y - crop.y;
    if (rotation === 90) return { x: crop.height - localY, y: localX };
    if (rotation === 180) return { x: crop.width - localX, y: crop.height - localY };
    if (rotation === 270) return { x: localY, y: crop.width - localX };
    return { x: localX, y: localY };
  }

  function previewPoint(
    x: number,
    y: number,
    transform: CropTransform,
    preview: TransformPreviewGeometry | (PlannedGeometryView & { selected: CropRect }),
    frame: ContainedRect,
  ): { x: number; y: number } {
    const point = orientedPoint(x, y, preview.selected, transform.rotation);
    if (transform.flip_horizontal) point.x = preview.orientedWidth - point.x;
    if (transform.flip_vertical) point.y = preview.orientedHeight - point.y;
    const input = preview.fillCrop || {
      x: 0,
      y: 0,
      width: preview.orientedWidth,
      height: preview.orientedHeight,
    };
    return {
      x: ((point.x - input.x) * frame.width) / input.width,
      y: ((point.y - input.y) * frame.height) / input.height,
    };
  }

  function previewMatrix(
    transform: CropTransform,
    preview: TransformPreviewGeometry | (PlannedGeometryView & { selected: CropRect }),
    frame: ContainedRect,
  ): PreviewMatrix {
    const p0 = previewPoint(0, 0, transform, preview, frame);
    const px = previewPoint(1, 0, transform, preview, frame);
    const py = previewPoint(0, 1, transform, preview, frame);
    return {
      a: px.x - p0.x,
      b: px.y - p0.y,
      c: py.x - p0.x,
      d: py.y - p0.y,
      e: p0.x,
      f: p0.y,
    };
  }

  function matrixCss(matrix: PreviewMatrix): string {
    return (
      "matrix(" +
      [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].join(",") +
      ")"
    );
  }

  function paintMediaFrame(size: Size2D, frame: ContainedRect, matrix: PreviewMatrix): void {
    const viewport = doc.getElementById("media-viewport");
    if (!viewport) return;
    setBox(viewport, frame.left, frame.top, frame.width, frame.height);
    const media = mediaElements();
    for (const element of media) {
      element.style.width = size.width + "px";
      element.style.height = size.height + "px";
      element.style.objectFit = "fill";
      element.style.transform = matrixCss(matrix);
    }
  }

  function paintTransformPreview(clip: EditorClip, size: Size2D): void {
    const stage = doc.getElementById("stage");
    const viewport = doc.getElementById("media-viewport");
    if (!stage || !viewport) return;
    const planned = clip.planData || null;
    const plannedTransform =
      planned && typeof planned === "object" && "transform" in planned
        ? (planned.transform as CropTransform | undefined)
        : undefined;
    const transform = plannedTransform ?? cropTransformForRequest(clip);
    if (!transform) return;
    const plannedGeometry =
      planned && typeof planned === "object" && "transform_geometry" in planned
        ? (planned.transform_geometry as PlannedTransformGeometry | undefined)
        : undefined;
    const preview: TransformPreviewGeometry | (PlannedGeometryView & { selected: CropRect }) =
      plannedGeometry
        ? {
            selected:
              transform.crop || CropGeometry.fullCrop(size.width, size.height),
            orientedWidth: plannedGeometry.oriented_width,
            orientedHeight: plannedGeometry.oriented_height,
            fillCrop: plannedGeometry.fill_crop ?? null,
            output: {
              width: plannedGeometry.output_width,
              height: plannedGeometry.output_height,
            },
          }
        : CropGeometry.previewTransformGeometry(transform, size.width, size.height);
    const frame = CropGeometry.containedRect(
      stage.clientWidth,
      stage.clientHeight,
      preview.output.width,
      preview.output.height,
    );
    paintMediaFrame(size, frame, previewMatrix(transform, preview, frame));
  }

  function cropEditorGeometry(clip: EditorClip, size: Size2D): EditorGeometry {
    const stage = doc.getElementById("stage");
    if (!stage) {
      return {
        transform: cropTransformForRequest(clip)!,
        preview: CropGeometry.previewTransformGeometry(
          cropTransformForRequest(clip)!,
          size.width,
          size.height,
        ),
        frame: { left: 0, top: 0, width: 0, height: 0, scale: 0 },
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      };
    }
    const transform = cropTransformForRequest(clip)!;
    transform.crop = null;
    const quarterTurn = transform.rotation === 90 || transform.rotation === 270;
    const preview: TransformPreviewGeometry = {
      selected: CropGeometry.fullCrop(size.width, size.height),
      orientedWidth: quarterTurn ? size.height : size.width,
      orientedHeight: quarterTurn ? size.width : size.height,
      fillCrop: null,
      output: {
        width: quarterTurn ? size.height : size.width,
        height: quarterTurn ? size.width : size.height,
      },
    };
    const frame = CropGeometry.containedRect(
      stage.clientWidth,
      stage.clientHeight,
      preview.orientedWidth,
      preview.orientedHeight,
    );
    return {
      transform,
      preview,
      frame,
      matrix: previewMatrix(transform, preview, frame),
    };
  }

  function editorPointToDisplay(
    x: number,
    y: number,
    editor: EditorGeometry,
  ): { x: number; y: number } {
    const point = previewPoint(x, y, editor.transform, editor.preview, editor.frame);
    return {
      x: editor.frame.left + point.x,
      y: editor.frame.top + point.y,
    };
  }

  function editorCropToDisplay(
    crop: CropRect,
    editor: EditorGeometry,
  ): { left: number; top: number; width: number; height: number } {
    const points = [
      editorPointToDisplay(crop.x, crop.y, editor),
      editorPointToDisplay(crop.x + crop.width, crop.y, editor),
      editorPointToDisplay(crop.x, crop.y + crop.height, editor),
      editorPointToDisplay(crop.x + crop.width, crop.y + crop.height, editor),
    ];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
      left,
      top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
    };
  }

  function editorDisplayToSource(
    x: number,
    y: number,
    editor: EditorGeometry,
    size: Size2D,
  ): { x: number; y: number } {
    const matrix = editor.matrix;
    const localX = x - editor.frame.left - matrix.e;
    const localY = y - editor.frame.top - matrix.f;
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    return {
      x: Math.max(
        0,
        Math.min(size.width, (matrix.d * localX - matrix.c * localY) / determinant),
      ),
      y: Math.max(
        0,
        Math.min(size.height, (-matrix.b * localX + matrix.a * localY) / determinant),
      ),
    };
  }

  function sourceHandleForDisplay(
    displayHandle: string,
    crop: CropRect,
    editor: EditorGeometry,
  ): string {
    const positions: Record<string, [number, number]> = {
      nw: [0, 0],
      n: [0.5, 0],
      ne: [1, 0],
      e: [1, 0.5],
      se: [1, 1],
      s: [0.5, 1],
      sw: [0, 1],
      w: [0, 0.5],
    };
    const shown = editorCropToDisplay(crop, editor);
    const wanted = positions[displayHandle] ?? [0, 0];
    const targetX = shown.left + wanted[0] * shown.width;
    const targetY = shown.top + wanted[1] * shown.height;
    let closest = displayHandle;
    let closestDistance = Infinity;
    for (const sourceHandle of Object.keys(positions)) {
      const position = positions[sourceHandle]!;
      const point = editorPointToDisplay(
        crop.x + position[0] * crop.width,
        crop.y + position[1] * crop.height,
        editor,
      );
      const distance =
        Math.pow(point.x - targetX, 2) + Math.pow(point.y - targetY, 2);
      if (distance < closestDistance) {
        closest = sourceHandle;
        closestDistance = distance;
      }
    }
    return closest;
  }

  function paintCropOverlay(): void {
    const ui = doc.getElementById("crop-ui");
    const selection = doc.getElementById("crop-selection");
    const clip = selectedClip();
    const size = sourceSize(clip);
    if (!ui || !selection || !clip || !size) {
      if (ui) ui.classList.remove("on");
      return;
    }

    if ((clip.cropAspect || "off") === "off") {
      ui.classList.remove("on");
      paintTransformPreview(clip, size);
      const offLabel = doc.getElementById("crop-label");
      const offReset = doc.getElementById("btn-crop-reset");
      if (offLabel) {
        offLabel.textContent = "Full frame";
        offLabel.classList.remove("active");
      }
      if (offReset) offReset.classList.add("hid");
      return;
    }

    const editor = cropEditorGeometry(clip, size);
    const content = editor.frame;
    if (content.width <= 0 || content.height <= 0) {
      ui.classList.remove("on");
      return;
    }
    paintMediaFrame(size, content, editor.matrix);
    ui.classList.add("on");
    const crop = CropGeometry.selectionCrop(clip.crop, size.width, size.height);
    const shown = editorCropToDisplay(crop, editor);
    setBox(selection, shown.left, shown.top, shown.width, shown.height);

    setBox(
      doc.getElementById("crop-dim-top"),
      content.left,
      content.top,
      content.width,
      shown.top - content.top,
    );
    setBox(
      doc.getElementById("crop-dim-bottom"),
      content.left,
      shown.top + shown.height,
      content.width,
      content.top + content.height - shown.top - shown.height,
    );
    setBox(
      doc.getElementById("crop-dim-left"),
      content.left,
      shown.top,
      shown.left - content.left,
      shown.height,
    );
    setBox(
      doc.getElementById("crop-dim-right"),
      shown.left + shown.width,
      shown.top,
      content.left + content.width - shown.left - shown.width,
      shown.height,
    );

    const label = doc.getElementById("crop-label");
    const reset = doc.getElementById("btn-crop-reset");
    if (label) {
      const aspect =
        clip.cropAspect && clip.cropAspect !== "free" && clip.cropAspect !== "off"
          ? " · " + clip.cropAspect
          : "";
      const rotation = clip.rotation ? " · " + clip.rotation + "°" : "";
      const flip =
        clip.flipHorizontal || clip.flipVertical
          ? " · flip " +
            (clip.flipHorizontal && clip.flipVertical
              ? "H+V"
              : clip.flipHorizontal
                ? "H"
                : "V")
          : "";
      label.textContent =
        (clip.crop ? "Crop " + crop.width + "×" + crop.height : "Full frame") +
        aspect +
        rotation +
        flip;
      label.classList.toggle(
        "active",
        !!clip.crop || !!aspect || !!rotation || !!flip,
      );
    }
    if (reset)
      reset.classList.toggle(
        "hid",
        !(!!clip.crop || (clip.cropAspect || "off") !== "off"),
      );
  }

  function eventSourcePoint(
    event: PointerEvent,
    size: Size2D,
    editor: EditorGeometry,
  ): { x: number; y: number } {
    const stage = doc.getElementById("stage");
    if (!stage) return { x: 0, y: 0 };
    const stageRect = stage.getBoundingClientRect();
    return editorDisplayToSource(
      event.clientX - stageRect.left,
      event.clientY - stageRect.top,
      editor,
      size,
    );
  }

  function processCropMove(event: PointerEvent): void {
    if (!drag) return;
    const clip = selectedClip();
    const size = sourceSize(clip);
    if (!clip || clip !== drag.clip || !size) return;
    const point = eventSourcePoint(event, size, drag.editor);
    const next = CropGeometry.resizeCrop(
      drag.origin,
      drag.handle,
      point.x - drag.start.x,
      point.y - drag.start.y,
      size.width,
      size.height,
      clip.cropAspect === "off" ? "free" : clip.cropAspect || "free",
      clip.rotation || 0,
    );
    clip.crop = CropGeometry.isFullCrop(next, size.width, size.height) ? null : next;
    clip.transformOverride = true;
    clip.planData = null;
    paintCropOverlay();
  }

  function onCropPointerDown(event: PointerEvent): void {
    if (event.button != null && event.button !== 0) return;
    const clip = selectedClip();
    const size = sourceSize(clip);
    if (!clip || !size) return;
    const editor = cropEditorGeometry(clip, size);
    const target = event.target as HTMLElement | null;
    const displayHandle = target?.dataset?.handle || "";
    const origin = CropGeometry.selectionCrop(clip.crop, size.width, size.height);
    drag = {
      clip,
      handle: displayHandle
        ? sourceHandleForDisplay(displayHandle, origin, editor)
        : "move",
      editor,
      origin,
      start: eventSourcePoint(event, size, editor),
      pointerId: event.pointerId,
    };
    const stage = doc.getElementById("stage");
    try {
      stage?.setPointerCapture(event.pointerId);
    } catch {
      /* capture optional */
    }
    doc.body.classList.add("crop-dragging");
    host.History?.begin(host.selPath());
    event.preventDefault();
    event.stopPropagation();
  }

  function onCropPointerMove(event: PointerEvent): void {
    if (!drag) return;
    moveEvent = event;
    if (!moveRaf) {
      moveRaf = clock.requestAnimationFrame(() => {
        moveRaf = 0;
        const pending = moveEvent;
        moveEvent = null;
        if (pending) processCropMove(pending);
      });
    }
    event.preventDefault();
  }

  function onCropPointerUp(event: PointerEvent): void {
    if (!drag) return;
    if (moveRaf) {
      clock.cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    if (moveEvent) {
      processCropMove(moveEvent);
      moveEvent = null;
    }
    const stage = doc.getElementById("stage");
    try {
      stage?.releasePointerCapture(drag.pointerId);
    } catch {
      /* release optional */
    }
    drag = null;
    doc.body.classList.remove("crop-dragging");
    host.History?.commit();
    host.renderClips?.();
    host.reqPreview?.();
    event.preventDefault();
  }

  function clearCrop(): void {
    const clip = selectedClip();
    if (!clip) return;
    clip.crop = CropGeometry.resetCrop();
    clip.cropAspect = "off";
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    host.renderClips?.();
    host.reqPreview?.();
  }

  function resetVideoTransform(): void {
    const clip = selectedClip();
    if (!clip) return;
    resetVideoTransformValues(clip);
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    host.renderClips?.();
    host.reqPreview?.();
  }

  function setCropAspect(aspect: string): void {
    const clip = selectedClip();
    const size = sourceSize(clip);
    if (!clip || !size) return;
    clip.cropAspect = aspect;
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    if (aspect === "off") {
      clip.crop = null;
    } else if (aspect !== "free") {
      const current = CropGeometry.selectionCrop(clip.crop, size.width, size.height);
      const next = CropGeometry.cropForAspect(
        current,
        aspect,
        size.width,
        size.height,
        clip.rotation || 0,
      );
      clip.crop = CropGeometry.isFullCrop(next, size.width, size.height) ? null : next;
    }
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    host.renderClips?.();
    host.reqPreview?.();
  }

  function setVideoRotation(rotation: number): void {
    const clip = selectedClip();
    if (!clip) return;
    clip.rotation = rotation;
    const size = sourceSize(clip);
    const rotationAspect = clip.cropAspect || "off";
    if (size && rotationAspect !== "free" && rotationAspect !== "off") {
      const current = CropGeometry.selectionCrop(clip.crop, size.width, size.height);
      const next = CropGeometry.cropForAspect(
        current,
        clip.cropAspect,
        size.width,
        size.height,
        rotation,
      );
      clip.crop = CropGeometry.isFullCrop(next, size.width, size.height) ? null : next;
    }
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    host.renderClips?.();
    host.reqPreview?.();
  }

  function toggleVideoFlip(axis: "horizontal" | "vertical"): void {
    const clip = selectedClip();
    if (!clip) return;
    if (axis === "horizontal") clip.flipHorizontal = !clip.flipHorizontal;
    if (axis === "vertical") clip.flipVertical = !clip.flipVertical;
    clip.transformOverride = true;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    host.renderClips?.();
    host.reqPreview?.();
  }

  function setSizingMode(mode: string): void {
    const clip = selectedClip();
    if (!clip) return;
    clip.sizingMode = mode;
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    host.reqPreview?.();
  }

  function syncTransformControls(): void {
    const clip = selectedClip();
    const fields = doc.getElementById("transform-fields");
    const controls = doc.querySelectorAll("#transform-fields button");
    const unavailable = !(clip && clip.probed);
    if (fields) {
      fields.classList.toggle("disabled", unavailable);
      fields.setAttribute("aria-disabled", String(unavailable));
    }
    for (let c = 0; c < controls.length; c++) {
      const button = controls[c] as HTMLButtonElement | null;
      if (button) button.disabled = unavailable;
    }
    if (unavailable) return;

    function setToggleState(button: Element, pressed: boolean): void {
      button.classList.toggle("on", pressed);
      button.setAttribute("aria-pressed", String(pressed));
    }

    const aspect = clip.cropAspect || "off";
    const aspectButtons = doc.querySelectorAll("[data-aspect]");
    for (let a = 0; a < aspectButtons.length; a++) {
      const button = aspectButtons[a] as HTMLElement | undefined;
      if (!button) continue;
      setToggleState(button, button.dataset.aspect === aspect);
    }
    const rotation = clip.rotation || 0;
    const rotationButtons = doc.querySelectorAll("[data-rotation]");
    for (let i = 0; i < rotationButtons.length; i++) {
      const button = rotationButtons[i] as HTMLElement | undefined;
      if (!button) continue;
      setToggleState(button, parseInt(button.dataset.rotation || "", 10) === rotation);
    }
    const flipH = doc.getElementById("flip-horizontal");
    const flipV = doc.getElementById("flip-vertical");
    if (flipH) setToggleState(flipH, !!clip.flipHorizontal);
    if (flipV) setToggleState(flipV, !!clip.flipVertical);
    const sizing = clip.sizingMode || "fit";
    const sizingButtons = doc.querySelectorAll("[data-sizing]");
    for (let j = 0; j < sizingButtons.length; j++) {
      const button = sizingButtons[j] as HTMLElement | undefined;
      if (!button) continue;
      setToggleState(button, button.dataset.sizing === sizing);
    }
  }

  function hideTransformTooltip(): void {
    if (tooltipTimer) {
      clock.clearTimeout(tooltipTimer);
      tooltipTimer = 0;
    }
    tooltipTarget = null;
    const tooltip = doc.getElementById("transform-tooltip");
    if (tooltip) tooltip.classList.remove("show");
  }

  function positionTransformTooltip(target: HTMLElement, tooltip: HTMLElement): void {
    const targetRect = target.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) {
      hideTransformTooltip();
      return;
    }
    const toolbar = target.closest(".transform-controls");
    const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : targetRect;
    tooltip.style.left = "0";
    tooltip.style.top = "0";
    const tooltipRect = tooltip.getBoundingClientRect();
    const edge = 8;
    const gap = 7;
    let left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
    left = Math.max(
      edge,
      Math.min(left, doc.documentElement.clientWidth - tooltipRect.width - edge),
    );
    let top = toolbarRect.top - tooltipRect.height - gap;
    if (top < edge) top = toolbarRect.bottom + gap;
    tooltip.style.left = Math.round(left) + "px";
    tooltip.style.top = Math.round(top) + "px";
  }

  function showTransformTooltip(target: HTMLElement): void {
    hideTransformTooltip();
    if (tooltipPointerActive) return;
    tooltipTarget = target;
    tooltipTimer = clock.setTimeout(() => {
      if (tooltipTarget !== target || !target.isConnected) {
        hideTransformTooltip();
        return;
      }
      const tooltip = doc.getElementById("transform-tooltip");
      if (!tooltip) return;
      tooltip.textContent = target.dataset.tip || "";
      tooltip.classList.add("show");
      positionTransformTooltip(target, tooltip);
      tooltipTimer = 0;
    }, 350);
  }

  function tipTarget(event: Event): HTMLElement | null {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) return null;
    return eventTarget.closest("[data-tip]");
  }

  function initTransformTooltips(): void {
    if (!doc.createElement || !doc.body) return;
    const tooltip = doc.createElement("div");
    tooltip.id = "transform-tooltip";
    tooltip.setAttribute("role", "tooltip");
    doc.body.appendChild(tooltip);

    const onMouseOver = (event: Event): void => {
      const target = tipTarget(event);
      if (!target || target === tooltipTarget) return;
      showTransformTooltip(target);
    };
    const onMouseOut = (event: MouseEvent): void => {
      const target = tipTarget(event);
      if (!target) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      hideTransformTooltip();
    };
    const onFocusIn = (event: Event): void => {
      const target = tipTarget(event);
      if (target) showTransformTooltip(target);
    };
    const onFocusOut = (event: Event): void => {
      if (tipTarget(event)) hideTransformTooltip();
    };
    const onPointerDown = (): void => {
      tooltipPointerActive = true;
      hideTransformTooltip();
    };
    const endTooltipPointerGesture = (): void => {
      hideTransformTooltip();
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (!tooltipPointerActive || event.buttons !== 0) return;
      tooltipPointerActive = false;
      hideTransformTooltip();
    };

    doc.addEventListener("mouseover", onMouseOver);
    doc.addEventListener("mouseout", onMouseOut);
    doc.addEventListener("focusin", onFocusIn);
    doc.addEventListener("focusout", onFocusOut);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointerup", endTooltipPointerGesture, true);
    doc.addEventListener("pointercancel", endTooltipPointerGesture, true);
    doc.addEventListener("mousemove", onMouseMove, true);
    cleanups.push(() => {
      doc.removeEventListener("mouseover", onMouseOver);
      doc.removeEventListener("mouseout", onMouseOut);
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("focusout", onFocusOut);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointerup", endTooltipPointerGesture, true);
      doc.removeEventListener("pointercancel", endTooltipPointerGesture, true);
      doc.removeEventListener("mousemove", onMouseMove, true);
      tooltip.remove();
    });

    if (windowRef) {
      const hide = (): void => {
        hideTransformTooltip();
      };
      windowRef.addEventListener("resize", hide);
      windowRef.addEventListener("scroll", hide, true);
      cleanups.push(() => {
        windowRef.removeEventListener("resize", hide);
        windowRef.removeEventListener("scroll", hide, true);
      });
    }
  }

  syncTransformControls();
  initTransformTooltips();

  const selection = doc.getElementById("crop-selection");
  const stage = doc.getElementById("stage");
  let resizeObserver: ResizeObserver | null = null;
  if (selection && stage) {
    selection.addEventListener("pointerdown", onCropPointerDown);
    stage.addEventListener("pointermove", onCropPointerMove);
    stage.addEventListener("pointerup", onCropPointerUp);
    stage.addEventListener("pointercancel", onCropPointerUp);
    cleanups.push(() => {
      selection.removeEventListener("pointerdown", onCropPointerDown);
      stage.removeEventListener("pointermove", onCropPointerMove);
      stage.removeEventListener("pointerup", onCropPointerUp);
      stage.removeEventListener("pointercancel", onCropPointerUp);
    });
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(paintCropOverlay);
      resizeObserver.observe(stage);
      cleanups.push(() => {
        resizeObserver?.disconnect();
      });
    }
    const video = doc.getElementById("vid");
    if (video) {
      video.addEventListener("loadedmetadata", paintCropOverlay);
      cleanups.push(() => {
        video.removeEventListener("loadedmetadata", paintCropOverlay);
      });
    }
  }

  const api: TransformApi = {
    paintCropOverlay,
    syncTransformControls,
    setCropAspect,
    setVideoRotation,
    toggleVideoFlip,
    setSizingMode,
    clearCrop,
    resetVideoTransform,
    resetVideoTransformValues,
    cropTransformForRequest,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      hideTransformTooltip();
      if (moveRaf) {
        clock.cancelAnimationFrame(moveRaf);
        moveRaf = 0;
      }
      for (const cleanup of cleanups) cleanup();
      if (active === api) active = null;
    },
  };

  active = api;
  return api;
}

export function paintCropOverlay(): void {
  requireActive().paintCropOverlay();
}
export function syncTransformControls(): void {
  requireActive().syncTransformControls();
}
export function setCropAspect(aspect: string): void {
  requireActive().setCropAspect(aspect);
}
export function setVideoRotation(rotation: number): void {
  requireActive().setVideoRotation(rotation);
}
export function toggleVideoFlip(axis: "horizontal" | "vertical"): void {
  requireActive().toggleVideoFlip(axis);
}
export function setSizingMode(mode: string): void {
  requireActive().setSizingMode(mode);
}
export function clearCrop(): void {
  requireActive().clearCrop();
}
export function resetVideoTransform(): void {
  requireActive().resetVideoTransform();
}
