export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface ContainedRect {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

export interface AspectParts {
  width: number;
  height: number;
}

export interface CropTransform {
  crop: CropRect | null;
  crop_aspect: string;
  rotation: number;
  flip_horizontal: boolean;
  flip_vertical: boolean;
  sizing_mode: string;
}

export interface TransformPreviewInput {
  crop?: CropRect | null;
  rotation: number;
  sizing_mode: string;
  output?: Size2D;
}

export interface TransformPreviewGeometry {
  selected: CropRect;
  orientedWidth: number;
  orientedHeight: number;
  fillCrop: CropRect | null;
  output: Size2D;
}

export type PreviewTransformGeometry = TransformPreviewGeometry;

export interface PlannedTransformGeometry {
  selected?: CropRect;
  orientedWidth: number;
  orientedHeight: number;
  fillCrop: CropRect | null;
  output: Size2D;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function containedRect(
  containerWidth: number,
  containerHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ContainedRect {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(
    containerWidth / sourceWidth,
    containerHeight / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width: width,
    height: height,
    scale: scale,
  };
}

export function fullCrop(sourceWidth: number, sourceHeight: number): CropRect {
  return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
}

export function selectionCrop(
  storedCrop: CropRect | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  return storedCrop || fullCrop(sourceWidth, sourceHeight);
}

export function resetCrop(): null {
  return null;
}

export function sourceRectToDisplay(
  crop: CropRect | null | undefined,
  content: ContainedRect,
  sourceWidth: number,
  sourceHeight: number,
): { left: number; top: number; width: number; height: number } {
  const resolved = crop || fullCrop(sourceWidth, sourceHeight);
  return {
    left: content.left + (resolved.x / sourceWidth) * content.width,
    top: content.top + (resolved.y / sourceHeight) * content.height,
    width: (resolved.width / sourceWidth) * content.width,
    height: (resolved.height / sourceHeight) * content.height,
  };
}

export function displayPointToSource(
  x: number,
  y: number,
  content: ContainedRect,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number } {
  return {
    x: clamp(
      ((x - content.left) / content.width) * sourceWidth,
      0,
      sourceWidth,
    ),
    y: clamp(
      ((y - content.top) / content.height) * sourceHeight,
      0,
      sourceHeight,
    ),
  };
}

function evenSize(value: number, maximum: number): number {
  const maxEven = Math.floor(maximum / 2) * 2;
  if (maxEven < 2) return 0;
  return clamp(Math.round(value / 2) * 2, 2, maxEven);
}

export function aspectParts(
  aspect: string | null | undefined,
  rotation?: number,
): AspectParts | null {
  if (!aspect || aspect === "free") return null;
  const parts = String(aspect).split(":");
  const width = parseInt(parts[0] ?? "", 10);
  const height = parseInt(parts[1] ?? "", 10);
  if (!(width > 0 && height > 0)) return null;
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width: width, height: height };
}

export function cropForAspect(
  current: CropRect | null | undefined,
  aspect: string | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
  rotation?: number,
): CropRect {
  const ratio = aspectParts(aspect, rotation);
  const base = current || fullCrop(sourceWidth, sourceHeight);
  if (!ratio)
    return { x: base.x, y: base.y, width: base.width, height: base.height };
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  const centeredWidth = 2 * Math.min(centerX, sourceWidth - centerX);
  const centeredHeight = 2 * Math.min(centerY, sourceHeight - centerY);
  const maximumUnit =
    Math.floor(
      Math.min(centeredWidth / ratio.width, centeredHeight / ratio.height) / 2,
    ) * 2;
  const containingUnit =
    Math.ceil(
      Math.max(base.width / ratio.width, base.height / ratio.height) / 2,
    ) * 2;
  const unit = Math.min(containingUnit, maximumUnit);
  if (unit < 2)
    return { x: base.x, y: base.y, width: base.width, height: base.height };
  const width = ratio.width * unit;
  const height = ratio.height * unit;
  return {
    x: clamp(Math.round(centerX - width / 2), 0, sourceWidth - width),
    y: clamp(Math.round(centerY - height / 2), 0, sourceHeight - height),
    width: width,
    height: height,
  };
}

function lockedSize(
  desired: number,
  useWidth: boolean,
  maximumWidth: number,
  maximumHeight: number,
  ratio: AspectParts,
): { width: number; height: number } | null {
  let maxUnit = Math.floor(
    Math.min(maximumWidth / ratio.width, maximumHeight / ratio.height),
  );
  maxUnit = Math.floor(maxUnit / 2) * 2;
  if (maxUnit < 2) return null;
  let unit = useWidth ? desired / ratio.width : desired / ratio.height;
  unit = clamp(Math.round(unit / 2) * 2, 2, maxUnit);
  return { width: ratio.width * unit, height: ratio.height * unit };
}

function resizeLockedCrop(
  origin: CropRect,
  handle: string,
  deltaX: number,
  deltaY: number,
  sourceWidth: number,
  sourceHeight: number,
  ratio: AspectParts,
): CropRect {
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;
  const centerX = origin.x + origin.width / 2;
  const centerY = origin.y + origin.height / 2;
  const useWidth =
    handle === "e" ||
    handle === "w" ||
    (handle.length === 2 &&
      Math.abs(deltaX / origin.width) >= Math.abs(deltaY / origin.height));
  const desiredWidth =
    origin.width + (handle.indexOf("w") >= 0 ? -deltaX : deltaX);
  const desiredHeight =
    origin.height + (handle.indexOf("n") >= 0 ? -deltaY : deltaY);
  let maximumWidth: number;
  let maximumHeight: number;
  let x: number;
  let y: number;

  if (handle === "e" || handle === "w") {
    maximumWidth = handle === "e" ? sourceWidth - origin.x : right;
    maximumHeight = 2 * Math.min(centerY, sourceHeight - centerY);
    const horizontal = lockedSize(
      desiredWidth,
      true,
      maximumWidth,
      maximumHeight,
      ratio,
    );
    if (!horizontal) return origin;
    x = handle === "e" ? origin.x : right - horizontal.width;
    y = Math.round(centerY - horizontal.height / 2);
    return { x: x, y: y, width: horizontal.width, height: horizontal.height };
  }

  if (handle === "n" || handle === "s") {
    maximumWidth = 2 * Math.min(centerX, sourceWidth - centerX);
    maximumHeight = handle === "s" ? sourceHeight - origin.y : bottom;
    const vertical = lockedSize(
      desiredHeight,
      false,
      maximumWidth,
      maximumHeight,
      ratio,
    );
    if (!vertical) return origin;
    x = Math.round(centerX - vertical.width / 2);
    y = handle === "s" ? origin.y : bottom - vertical.height;
    return { x: x, y: y, width: vertical.width, height: vertical.height };
  }

  const west = handle.indexOf("w") >= 0;
  const north = handle.indexOf("n") >= 0;
  const anchorX = west ? right : origin.x;
  const anchorY = north ? bottom : origin.y;
  maximumWidth = west ? anchorX : sourceWidth - anchorX;
  maximumHeight = north ? anchorY : sourceHeight - anchorY;
  const corner = lockedSize(
    useWidth ? desiredWidth : desiredHeight,
    useWidth,
    maximumWidth,
    maximumHeight,
    ratio,
  );
  if (!corner) return origin;
  x = west ? anchorX - corner.width : anchorX;
  y = north ? anchorY - corner.height : anchorY;
  return { x: x, y: y, width: corner.width, height: corner.height };
}

export function resizeCrop(
  origin: CropRect,
  handle: string,
  deltaX: number,
  deltaY: number,
  sourceWidth: number,
  sourceHeight: number,
  aspect?: string | null,
  rotation?: number,
): CropRect {
  const result: CropRect = {
    x: origin.x,
    y: origin.y,
    width: origin.width,
    height: origin.height,
  };

  if (handle === "move") {
    result.x = clamp(
      Math.round(origin.x + deltaX),
      0,
      sourceWidth - origin.width,
    );
    result.y = clamp(
      Math.round(origin.y + deltaY),
      0,
      sourceHeight - origin.height,
    );
    return result;
  }

  const ratio = aspectParts(aspect, rotation);
  if (ratio) {
    return resizeLockedCrop(
      origin,
      handle,
      deltaX,
      deltaY,
      sourceWidth,
      sourceHeight,
      ratio,
    );
  }

  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;
  if (handle.indexOf("e") >= 0) {
    result.width = evenSize(origin.width + deltaX, sourceWidth - origin.x);
  }
  if (handle.indexOf("s") >= 0) {
    result.height = evenSize(origin.height + deltaY, sourceHeight - origin.y);
  }
  if (handle.indexOf("w") >= 0) {
    result.width = evenSize(origin.width - deltaX, right);
    result.x = right - result.width;
  }
  if (handle.indexOf("n") >= 0) {
    result.height = evenSize(origin.height - deltaY, bottom);
    result.y = bottom - result.height;
  }
  return result;
}

export function isFullCrop(
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  return (
    crop.x === 0 &&
    crop.y === 0 &&
    crop.width === sourceWidth &&
    crop.height === sourceHeight
  );
}

function fitPreviewDimensions(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
): { width: number; height: number } {
  const scale = Math.min(
    outputWidth / sourceWidth,
    outputHeight / sourceHeight,
  );
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

function fillPreviewCrop(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
): CropRect | null {
  const sourceRatio = sourceWidth / sourceHeight;
  const outputRatio = outputWidth / outputHeight;
  if (Math.abs(sourceRatio - outputRatio) < 0.000000001) return null;
  if (sourceRatio > outputRatio) {
    const width = sourceHeight * outputRatio;
    return {
      x: (sourceWidth - width) / 2,
      y: 0,
      width: width,
      height: sourceHeight,
    };
  }
  const height = sourceWidth / outputRatio;
  return {
    x: 0,
    y: (sourceHeight - height) / 2,
    width: sourceWidth,
    height: height,
  };
}

export function previewTransformGeometry(
  transform: TransformPreviewInput,
  sourceWidth: number,
  sourceHeight: number,
): TransformPreviewGeometry {
  const selected = transform.crop || fullCrop(sourceWidth, sourceHeight);
  const quarterTurn = transform.rotation === 90 || transform.rotation === 270;
  const orientedWidth = quarterTurn ? selected.height : selected.width;
  const orientedHeight = quarterTurn ? selected.width : selected.height;
  const requested = transform.output || {
    width: orientedWidth,
    height: orientedHeight,
  };
  let fillCrop: CropRect | null = null;
  let output = { width: requested.width, height: requested.height };
  if (transform.sizing_mode === "fit") {
    output = fitPreviewDimensions(
      orientedWidth,
      orientedHeight,
      requested.width,
      requested.height,
    );
  } else if (transform.sizing_mode === "fill") {
    fillCrop = fillPreviewCrop(
      orientedWidth,
      orientedHeight,
      requested.width,
      requested.height,
    );
  }
  return {
    selected: selected,
    orientedWidth: orientedWidth,
    orientedHeight: orientedHeight,
    fillCrop: fillCrop,
    output: output,
  };
}
