(function (root) {
  "use strict";

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function containedRect(containerWidth, containerHeight, sourceWidth, sourceHeight) {
    if (containerWidth <= 0 || containerHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
      return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
    }
    var scale = Math.min(containerWidth / sourceWidth, containerHeight / sourceHeight);
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
      x: clamp(((x - content.left) / content.width) * sourceWidth, 0, sourceWidth),
      y: clamp(((y - content.top) / content.height) * sourceHeight, 0, sourceHeight),
    };
  }

  function evenSize(value, maximum) {
    var maxEven = Math.floor(maximum / 2) * 2;
    if (maxEven < 2) return 0;
    return clamp(Math.round(value / 2) * 2, 2, maxEven);
  }

  function aspectParts(aspect) {
    if (!aspect || aspect === "free") return null;
    var parts = String(aspect).split(":");
    var width = parseInt(parts[0], 10);
    var height = parseInt(parts[1], 10);
    return width > 0 && height > 0 ? { width: width, height: height } : null;
  }

  function cropForAspect(current, aspect, sourceWidth, sourceHeight) {
    var ratio = aspectParts(aspect);
    var base = current || fullCrop(sourceWidth, sourceHeight);
    if (!ratio) return { x: base.x, y: base.y, width: base.width, height: base.height };
    var unit = Math.floor(Math.min(base.width / ratio.width, base.height / ratio.height));
    unit = Math.floor(unit / 2) * 2;
    if (unit < 2) return { x: base.x, y: base.y, width: base.width, height: base.height };
    var width = ratio.width * unit;
    var height = ratio.height * unit;
    var centerX = base.x + base.width / 2;
    var centerY = base.y + base.height / 2;
    return {
      x: clamp(Math.round(centerX - width / 2), 0, sourceWidth - width),
      y: clamp(Math.round(centerY - height / 2), 0, sourceHeight - height),
      width: width,
      height: height,
    };
  }

  function lockedSize(desired, useWidth, maximumWidth, maximumHeight, ratio) {
    var maxUnit = Math.floor(Math.min(maximumWidth / ratio.width, maximumHeight / ratio.height));
    maxUnit = Math.floor(maxUnit / 2) * 2;
    if (maxUnit < 2) return null;
    var unit = useWidth ? desired / ratio.width : desired / ratio.height;
    unit = clamp(Math.round(unit / 2) * 2, 2, maxUnit);
    return { width: ratio.width * unit, height: ratio.height * unit };
  }

  function resizeLockedCrop(origin, handle, deltaX, deltaY, sourceWidth, sourceHeight, ratio) {
    var right = origin.x + origin.width;
    var bottom = origin.y + origin.height;
    var centerX = origin.x + origin.width / 2;
    var centerY = origin.y + origin.height / 2;
    var useWidth = handle === "e" || handle === "w" ||
      (handle.length === 2 && Math.abs(deltaX / origin.width) >= Math.abs(deltaY / origin.height));
    var desiredWidth = origin.width + (handle.indexOf("w") >= 0 ? -deltaX : deltaX);
    var desiredHeight = origin.height + (handle.indexOf("n") >= 0 ? -deltaY : deltaY);
    var maximumWidth;
    var maximumHeight;
    var x;
    var y;

    if (handle === "e" || handle === "w") {
      maximumWidth = handle === "e" ? sourceWidth - origin.x : right;
      maximumHeight = 2 * Math.min(centerY, sourceHeight - centerY);
      var horizontal = lockedSize(desiredWidth, true, maximumWidth, maximumHeight, ratio);
      if (!horizontal) return origin;
      x = handle === "e" ? origin.x : right - horizontal.width;
      y = Math.round(centerY - horizontal.height / 2);
      return { x: x, y: y, width: horizontal.width, height: horizontal.height };
    }

    if (handle === "n" || handle === "s") {
      maximumWidth = 2 * Math.min(centerX, sourceWidth - centerX);
      maximumHeight = handle === "s" ? sourceHeight - origin.y : bottom;
      var vertical = lockedSize(desiredHeight, false, maximumWidth, maximumHeight, ratio);
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
      ratio
    );
    if (!corner) return origin;
    x = west ? anchorX - corner.width : anchorX;
    y = north ? anchorY - corner.height : anchorY;
    return { x: x, y: y, width: corner.width, height: corner.height };
  }

  function resizeCrop(origin, handle, deltaX, deltaY, sourceWidth, sourceHeight, aspect) {
    var result = {
      x: origin.x,
      y: origin.y,
      width: origin.width,
      height: origin.height,
    };

    if (handle === "move") {
      result.x = clamp(Math.round(origin.x + deltaX), 0, sourceWidth - origin.width);
      result.y = clamp(Math.round(origin.y + deltaY), 0, sourceHeight - origin.height);
      return result;
    }

    var ratio = aspectParts(aspect);
    if (ratio) {
      return resizeLockedCrop(
        origin,
        handle,
        deltaX,
        deltaY,
        sourceWidth,
        sourceHeight,
        ratio
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

  function fitPreviewDimensions(sourceWidth, sourceHeight, outputWidth, outputHeight) {
    var scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
    return { width: sourceWidth * scale, height: sourceHeight * scale };
  }

  function fillPreviewCrop(sourceWidth, sourceHeight, outputWidth, outputHeight) {
    var sourceRatio = sourceWidth / sourceHeight;
    var outputRatio = outputWidth / outputHeight;
    if (Math.abs(sourceRatio - outputRatio) < 0.000000001) return null;
    if (sourceRatio > outputRatio) {
      var width = sourceHeight * outputRatio;
      return { x: (sourceWidth - width) / 2, y: 0, width: width, height: sourceHeight };
    }
    var height = sourceWidth / outputRatio;
    return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height: height };
  }

  function previewTransformGeometry(transform, sourceWidth, sourceHeight) {
    var selected = transform.crop || fullCrop(sourceWidth, sourceHeight);
    var quarterTurn = transform.rotation === 90 || transform.rotation === 270;
    var orientedWidth = quarterTurn ? selected.height : selected.width;
    var orientedHeight = quarterTurn ? selected.width : selected.height;
    var requested = transform.output || { width: orientedWidth, height: orientedHeight };
    var fillCrop = null;
    var output = { width: requested.width, height: requested.height };
    if (transform.sizing_mode === "fit") {
      output = fitPreviewDimensions(orientedWidth, orientedHeight, requested.width, requested.height);
    } else if (transform.sizing_mode === "fill") {
      fillCrop = fillPreviewCrop(orientedWidth, orientedHeight, requested.width, requested.height);
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
  if (typeof module !== "undefined" && module.exports) module.exports = geometry;
})(typeof globalThis !== "undefined" ? globalThis : this);

(function (root) {
  "use strict";

  if (typeof document === "undefined") return;

  var drag = null;
  var moveEvent = null;
  var moveRaf = 0;

  function selectedClip() {
    return root.selPath && root.clips ? root.clips[root.selPath] : null;
  }

  function sourceSize(clip) {
    var data = clip && clip.probeData;
    return data && data.width > 0 && data.height > 0
      ? { width: data.width, height: data.height }
      : null;
  }

  function setBox(element, left, top, width, height) {
    element.style.left = left + "px";
    element.style.top = top + "px";
    element.style.width = Math.max(0, width) + "px";
    element.style.height = Math.max(0, height) + "px";
  }

  function currentContent(size) {
    var stage = document.getElementById("stage");
    return root.TuckCropGeometry.containedRect(
      stage.clientWidth,
      stage.clientHeight,
      size.width,
      size.height
    );
  }

  function mediaElements() {
    return [document.getElementById("vid"), document.getElementById("thumb")];
  }

  function resetMediaPreview() {
    var viewport = document.getElementById("media-viewport");
    if (!viewport) return;
    viewport.style.left = "0";
    viewport.style.top = "0";
    viewport.style.width = "100%";
    viewport.style.height = "100%";
    var media = mediaElements();
    for (var i = 0; i < media.length; i++) {
      if (!media[i]) continue;
      media[i].style.width = "100%";
      media[i].style.height = "100%";
      media[i].style.objectFit = "contain";
      media[i].style.transform = "none";
    }
  }

  function orientedPoint(x, y, crop, rotation) {
    var localX = x - crop.x;
    var localY = y - crop.y;
    if (rotation === 90) return { x: crop.height - localY, y: localX };
    if (rotation === 180) return { x: crop.width - localX, y: crop.height - localY };
    if (rotation === 270) return { x: localY, y: crop.width - localX };
    return { x: localX, y: localY };
  }

  function previewPoint(x, y, transform, preview, frame) {
    var point = orientedPoint(x, y, preview.selected, transform.rotation);
    if (transform.flip_horizontal) point.x = preview.orientedWidth - point.x;
    if (transform.flip_vertical) point.y = preview.orientedHeight - point.y;
    var input = preview.fillCrop || {
      x: 0,
      y: 0,
      width: preview.orientedWidth,
      height: preview.orientedHeight,
    };
    return {
      x: (point.x - input.x) * frame.width / input.width,
      y: (point.y - input.y) * frame.height / input.height,
    };
  }

  function paintTransformPreview(clip, size) {
    var stage = document.getElementById("stage");
    var viewport = document.getElementById("media-viewport");
    if (!stage || !viewport) return;
    var transform = cropTransformForRequest(clip);
    var preview = root.TuckCropGeometry.previewTransformGeometry(
      transform,
      size.width,
      size.height
    );
    var frame = root.TuckCropGeometry.containedRect(
      stage.clientWidth,
      stage.clientHeight,
      preview.output.width,
      preview.output.height
    );
    setBox(viewport, frame.left, frame.top, frame.width, frame.height);
    var p0 = previewPoint(0, 0, transform, preview, frame);
    var px = previewPoint(1, 0, transform, preview, frame);
    var py = previewPoint(0, 1, transform, preview, frame);
    var matrix = "matrix(" + [
      px.x - p0.x,
      px.y - p0.y,
      py.x - p0.x,
      py.y - p0.y,
      p0.x,
      p0.y,
    ].join(",") + ")";
    var media = mediaElements();
    for (var i = 0; i < media.length; i++) {
      if (!media[i]) continue;
      media[i].style.width = size.width + "px";
      media[i].style.height = size.height + "px";
      media[i].style.objectFit = "fill";
      media[i].style.transform = matrix;
    }
  }

  function paintCropOverlay() {
    var ui = document.getElementById("crop-ui");
    var selection = document.getElementById("crop-selection");
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!ui || !selection || !clip || !size) {
      if (ui) ui.classList.remove("on");
      return;
    }

    var toolbar = document.getElementById("transform-toolbar");
    if (toolbar && !toolbar.open) {
      ui.classList.remove("on");
      paintTransformPreview(clip, size);
      return;
    }

    resetMediaPreview();

    var content = currentContent(size);
    if (content.width <= 0 || content.height <= 0) {
      ui.classList.remove("on");
      return;
    }
    ui.classList.add("on");
    var crop = root.TuckCropGeometry.selectionCrop(clip.crop, size.width, size.height);
    var shown = root.TuckCropGeometry.sourceRectToDisplay(
      crop,
      content,
      size.width,
      size.height
    );
    setBox(selection, shown.left, shown.top, shown.width, shown.height);

    setBox(document.getElementById("crop-dim-top"), content.left, content.top, content.width, shown.top - content.top);
    setBox(document.getElementById("crop-dim-bottom"), content.left, shown.top + shown.height, content.width, content.top + content.height - shown.top - shown.height);
    setBox(document.getElementById("crop-dim-left"), content.left, shown.top, shown.left - content.left, shown.height);
    setBox(document.getElementById("crop-dim-right"), shown.left + shown.width, shown.top, content.left + content.width - shown.left - shown.width, shown.height);

    var label = document.getElementById("crop-label");
    var reset = document.getElementById("btn-crop-reset");
    if (label) {
      var aspect = clip.cropAspect && clip.cropAspect !== "free" ? " · " + clip.cropAspect : "";
      var rotation = clip.rotation ? " · " + clip.rotation + "°" : "";
      var flip = clip.flipHorizontal || clip.flipVertical
        ? " · flip " + (clip.flipHorizontal && clip.flipVertical ? "H+V" : (clip.flipHorizontal ? "H" : "V"))
        : "";
      label.textContent = (clip.crop ? "Crop " + crop.width + "×" + crop.height : "Full frame") + aspect + rotation + flip;
      label.classList.toggle("active", !!clip.crop || !!aspect || !!rotation || !!flip);
    }
    if (reset) reset.classList.toggle("show", !!clip.crop || (clip.cropAspect || "free") !== "free");
  }

  function eventSourcePoint(event, size, content) {
    var stageRect = document.getElementById("stage").getBoundingClientRect();
    return root.TuckCropGeometry.displayPointToSource(
      event.clientX - stageRect.left,
      event.clientY - stageRect.top,
      content,
      size.width,
      size.height
    );
  }

  function processCropMove(event) {
    if (!drag) return;
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || clip !== drag.clip || !size) return;
    var point = eventSourcePoint(event, size, drag.content);
    var next = root.TuckCropGeometry.resizeCrop(
      drag.origin,
      drag.handle,
      point.x - drag.start.x,
      point.y - drag.start.y,
      size.width,
      size.height,
      clip.cropAspect || "free"
    );
    clip.crop = root.TuckCropGeometry.isFullCrop(next, size.width, size.height) ? null : next;
    paintCropOverlay();
  }

  function onCropPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || !size) return;
    var content = currentContent(size);
    var handle = event.target && event.target.dataset ? event.target.dataset.handle : "";
    drag = {
      clip: clip,
      handle: handle || "move",
      content: content,
      origin: root.TuckCropGeometry.selectionCrop(clip.crop, size.width, size.height),
      start: eventSourcePoint(event, size, content),
      pointerId: event.pointerId,
    };
    var stage = document.getElementById("stage");
    try { stage.setPointerCapture(event.pointerId); } catch (error) {}
    document.body.classList.add("crop-dragging");
    event.preventDefault();
    event.stopPropagation();
  }

  function onCropPointerMove(event) {
    if (!drag) return;
    moveEvent = event;
    if (!moveRaf) {
      moveRaf = requestAnimationFrame(function () {
        moveRaf = 0;
        var pending = moveEvent;
        moveEvent = null;
        if (pending) processCropMove(pending);
      });
    }
    event.preventDefault();
  }

  function onCropPointerUp(event) {
    if (!drag) return;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    if (moveEvent) {
      processCropMove(moveEvent);
      moveEvent = null;
    }
    var stage = document.getElementById("stage");
    try { stage.releasePointerCapture(drag.pointerId); } catch (error) {}
    drag = null;
    document.body.classList.remove("crop-dragging");
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
    event.preventDefault();
  }

  function clearCrop() {
    var clip = selectedClip();
    if (!clip) return;
    clip.crop = root.TuckCropGeometry.resetCrop();
    clip.cropAspect = "free";
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function cropTransformForRequest(clip) {
    if (!clip) return null;
    var transform = {
      crop: clip.crop ? {
        x: clip.crop.x,
        y: clip.crop.y,
        width: clip.crop.width,
        height: clip.crop.height,
      } : null,
      crop_aspect: clip.cropAspect || "free",
      rotation: clip.rotation || 0,
      flip_horizontal: !!clip.flipHorizontal,
      flip_vertical: !!clip.flipVertical,
      sizing_mode: clip.sizingMode || "fit",
    };
    var mode = document.getElementById("res-mode");
    if (mode && mode.value === "custom") {
      transform.output = {
        width: parseInt(document.getElementById("res-w").value, 10),
        height: parseInt(document.getElementById("res-h").value, 10),
      };
    } else if (clip.probeData && clip.probeData.width > 0 && clip.probeData.height > 0) {
      var quarterTurn = transform.rotation === 90 || transform.rotation === 270;
      transform.output = {
        width: quarterTurn ? clip.probeData.height : clip.probeData.width,
        height: quarterTurn ? clip.probeData.width : clip.probeData.height,
      };
    }
    return transform;
  }

  function setCropAspect(aspect) {
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || !size) return;
    clip.cropAspect = aspect;
    if (aspect !== "free") {
      var current = root.TuckCropGeometry.selectionCrop(clip.crop, size.width, size.height);
      var next = root.TuckCropGeometry.cropForAspect(current, aspect, size.width, size.height);
      clip.crop = root.TuckCropGeometry.isFullCrop(next, size.width, size.height) ? null : next;
    }
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function setVideoRotation(rotation) {
    var clip = selectedClip();
    if (!clip) return;
    clip.rotation = rotation;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function toggleVideoFlip(axis) {
    var clip = selectedClip();
    if (!clip) return;
    if (axis === "horizontal") clip.flipHorizontal = !clip.flipHorizontal;
    if (axis === "vertical") clip.flipVertical = !clip.flipVertical;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function setSizingMode(mode) {
    var clip = selectedClip();
    if (!clip) return;
    clip.sizingMode = mode;
    syncTransformControls();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function syncTransformControls() {
    var clip = selectedClip();
    var aspect = document.getElementById("crop-aspect");
    if (!clip) return;
    if (aspect) aspect.value = clip.cropAspect || "free";
    var rotation = clip.rotation || 0;
    var rotationButtons = document.querySelectorAll("[data-rotation]");
    for (var i = 0; i < rotationButtons.length; i++) {
      rotationButtons[i].classList.toggle(
        "on",
        parseInt(rotationButtons[i].dataset.rotation, 10) === rotation
      );
    }
    var flipH = document.getElementById("flip-horizontal");
    var flipV = document.getElementById("flip-vertical");
    if (flipH) flipH.classList.toggle("on", !!clip.flipHorizontal);
    if (flipV) flipV.classList.toggle("on", !!clip.flipVertical);
    var sizing = clip.sizingMode || "fit";
    var sizingButtons = document.querySelectorAll("[data-sizing]");
    for (var j = 0; j < sizingButtons.length; j++) {
      sizingButtons[j].classList.toggle("on", sizingButtons[j].dataset.sizing === sizing);
    }
  }

  root.paintCropOverlay = paintCropOverlay;
  root.clearCrop = clearCrop;
  root.cropTransformForRequest = cropTransformForRequest;
  root.setCropAspect = setCropAspect;
  root.setSizingMode = setSizingMode;
  root.setVideoRotation = setVideoRotation;
  root.syncTransformControls = syncTransformControls;
  root.toggleVideoFlip = toggleVideoFlip;

  var selection = document.getElementById("crop-selection");
  var stage = document.getElementById("stage");
  if (selection && stage) {
    selection.addEventListener("pointerdown", onCropPointerDown);
    stage.addEventListener("pointermove", onCropPointerMove);
    stage.addEventListener("pointerup", onCropPointerUp);
    stage.addEventListener("pointercancel", onCropPointerUp);
    new ResizeObserver(paintCropOverlay).observe(stage);
    var video = document.getElementById("vid");
    if (video) video.addEventListener("loadedmetadata", paintCropOverlay);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
