(function (root) {
  "use strict";

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function containedRect(
    containerWidth,
    containerHeight,
    sourceWidth,
    sourceHeight,
  ) {
    if (
      containerWidth <= 0 ||
      containerHeight <= 0 ||
      sourceWidth <= 0 ||
      sourceHeight <= 0
    ) {
      return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
    }
    var scale = Math.min(
      containerWidth / sourceWidth,
      containerHeight / sourceHeight,
    );
    var width = sourceWidth * scale;
    var height = sourceHeight * scale;
    return {
      left: (containerWidth - width) / 2,
      top: (containerHeight - height) / 2,
      width: width,
      height: height,
      scale: scale,
    };
  }

  function fullCrop(sourceWidth, sourceHeight) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }

  function selectionCrop(storedCrop, sourceWidth, sourceHeight) {
    return storedCrop || fullCrop(sourceWidth, sourceHeight);
  }

  function resetCrop() {
    return null;
  }

  function sourceRectToDisplay(crop, content, sourceWidth, sourceHeight) {
    crop = crop || fullCrop(sourceWidth, sourceHeight);
    return {
      left: content.left + (crop.x / sourceWidth) * content.width,
      top: content.top + (crop.y / sourceHeight) * content.height,
      width: (crop.width / sourceWidth) * content.width,
      height: (crop.height / sourceHeight) * content.height,
    };
  }

  function displayPointToSource(x, y, content, sourceWidth, sourceHeight) {
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

  function evenSize(value, maximum) {
    var maxEven = Math.floor(maximum / 2) * 2;
    if (maxEven < 2) return 0;
    return clamp(Math.round(value / 2) * 2, 2, maxEven);
  }

  function aspectParts(aspect, rotation) {
    if (!aspect || aspect === "free") return null;
    var parts = String(aspect).split(":");
    var width = parseInt(parts[0], 10);
    var height = parseInt(parts[1], 10);
    if (!(width > 0 && height > 0)) return null;
    return rotation === 90 || rotation === 270
      ? { width: height, height: width }
      : { width: width, height: height };
  }

  function cropForAspect(
    current,
    aspect,
    sourceWidth,
    sourceHeight,
    rotation,
  ) {
    var ratio = aspectParts(aspect, rotation);
    var base = current || fullCrop(sourceWidth, sourceHeight);
    if (!ratio)
      return { x: base.x, y: base.y, width: base.width, height: base.height };
    var centerX = base.x + base.width / 2;
    var centerY = base.y + base.height / 2;
    var centeredWidth = 2 * Math.min(centerX, sourceWidth - centerX);
    var centeredHeight = 2 * Math.min(centerY, sourceHeight - centerY);
    var maximumUnit = Math.floor(
      Math.min(centeredWidth / ratio.width, centeredHeight / ratio.height) / 2,
    ) * 2;
    var containingUnit = Math.ceil(
      Math.max(base.width / ratio.width, base.height / ratio.height) / 2,
    ) * 2;
    var unit = Math.min(containingUnit, maximumUnit);
    if (unit < 2)
      return { x: base.x, y: base.y, width: base.width, height: base.height };
    var width = ratio.width * unit;
    var height = ratio.height * unit;
    return {
      x: clamp(Math.round(centerX - width / 2), 0, sourceWidth - width),
      y: clamp(Math.round(centerY - height / 2), 0, sourceHeight - height),
      width: width,
      height: height,
    };
  }

  function lockedSize(desired, useWidth, maximumWidth, maximumHeight, ratio) {
    var maxUnit = Math.floor(
      Math.min(maximumWidth / ratio.width, maximumHeight / ratio.height),
    );
    maxUnit = Math.floor(maxUnit / 2) * 2;
    if (maxUnit < 2) return null;
    var unit = useWidth ? desired / ratio.width : desired / ratio.height;
    unit = clamp(Math.round(unit / 2) * 2, 2, maxUnit);
    return { width: ratio.width * unit, height: ratio.height * unit };
  }

  function resizeLockedCrop(
    origin,
    handle,
    deltaX,
    deltaY,
    sourceWidth,
    sourceHeight,
    ratio,
  ) {
    var right = origin.x + origin.width;
    var bottom = origin.y + origin.height;
    var centerX = origin.x + origin.width / 2;
    var centerY = origin.y + origin.height / 2;
    var useWidth =
      handle === "e" ||
      handle === "w" ||
      (handle.length === 2 &&
        Math.abs(deltaX / origin.width) >= Math.abs(deltaY / origin.height));
    var desiredWidth =
      origin.width + (handle.indexOf("w") >= 0 ? -deltaX : deltaX);
    var desiredHeight =
      origin.height + (handle.indexOf("n") >= 0 ? -deltaY : deltaY);
    var maximumWidth;
    var maximumHeight;
    var x;
    var y;

    if (handle === "e" || handle === "w") {
      maximumWidth = handle === "e" ? sourceWidth - origin.x : right;
      maximumHeight = 2 * Math.min(centerY, sourceHeight - centerY);
      var horizontal = lockedSize(
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
      var vertical = lockedSize(
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

    var west = handle.indexOf("w") >= 0;
    var north = handle.indexOf("n") >= 0;
    var anchorX = west ? right : origin.x;
    var anchorY = north ? bottom : origin.y;
    maximumWidth = west ? anchorX : sourceWidth - anchorX;
    maximumHeight = north ? anchorY : sourceHeight - anchorY;
    var corner = lockedSize(
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

  function resizeCrop(
    origin,
    handle,
    deltaX,
    deltaY,
    sourceWidth,
    sourceHeight,
    aspect,
    rotation,
  ) {
    var result = {
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

    var ratio = aspectParts(aspect, rotation);
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

    var right = origin.x + origin.width;
    var bottom = origin.y + origin.height;
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

  function isFullCrop(crop, sourceWidth, sourceHeight) {
    return (
      crop.x === 0 &&
      crop.y === 0 &&
      crop.width === sourceWidth &&
      crop.height === sourceHeight
    );
  }

  function fitPreviewDimensions(
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
  ) {
    var scale = Math.min(
      outputWidth / sourceWidth,
      outputHeight / sourceHeight,
    );
    return { width: sourceWidth * scale, height: sourceHeight * scale };
  }

  function fillPreviewCrop(
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
  ) {
    var sourceRatio = sourceWidth / sourceHeight;
    var outputRatio = outputWidth / outputHeight;
    if (Math.abs(sourceRatio - outputRatio) < 0.000000001) return null;
    if (sourceRatio > outputRatio) {
      var width = sourceHeight * outputRatio;
      return {
        x: (sourceWidth - width) / 2,
        y: 0,
        width: width,
        height: sourceHeight,
      };
    }
    var height = sourceWidth / outputRatio;
    return {
      x: 0,
      y: (sourceHeight - height) / 2,
      width: sourceWidth,
      height: height,
    };
  }

  function previewTransformGeometry(transform, sourceWidth, sourceHeight) {
    var selected = transform.crop || fullCrop(sourceWidth, sourceHeight);
    var quarterTurn = transform.rotation === 90 || transform.rotation === 270;
    var orientedWidth = quarterTurn ? selected.height : selected.width;
    var orientedHeight = quarterTurn ? selected.width : selected.height;
    var requested = transform.output || {
      width: orientedWidth,
      height: orientedHeight,
    };
    var fillCrop = null;
    var output = { width: requested.width, height: requested.height };
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

  var geometry = {
    aspectParts: aspectParts,
    containedRect: containedRect,
    cropForAspect: cropForAspect,
    displayPointToSource: displayPointToSource,
    fullCrop: fullCrop,
    isFullCrop: isFullCrop,
    resetCrop: resetCrop,
    resizeCrop: resizeCrop,
    selectionCrop: selectionCrop,
    sourceRectToDisplay: sourceRectToDisplay,
    previewTransformGeometry: previewTransformGeometry,
  };
  root.TuckCropGeometry = geometry;
  if (typeof module !== "undefined" && module.exports)
    module.exports = geometry;
})(typeof globalThis !== "undefined" ? globalThis : this);
