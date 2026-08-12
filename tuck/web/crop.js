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

  function resizeCrop(origin, handle, deltaX, deltaY, sourceWidth, sourceHeight) {
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

  var geometry = {
    containedRect: containedRect,
    displayPointToSource: displayPointToSource,
    fullCrop: fullCrop,
    isFullCrop: isFullCrop,
    resetCrop: resetCrop,
    resizeCrop: resizeCrop,
    selectionCrop: selectionCrop,
    sourceRectToDisplay: sourceRectToDisplay,
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

  function paintCropOverlay() {
    var ui = document.getElementById("crop-ui");
    var selection = document.getElementById("crop-selection");
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!ui || !selection || !clip || !size) {
      if (ui) ui.classList.remove("on");
      return;
    }

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
      label.textContent = clip.crop ? "Crop " + crop.width + "×" + crop.height : "Full frame";
      label.classList.toggle("active", !!clip.crop);
    }
    if (reset) reset.classList.toggle("show", !!clip.crop);
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
      size.height
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
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function cropTransformForRequest(clip) {
    if (!clip || !clip.crop) return null;
    return {
      crop: {
        x: clip.crop.x,
        y: clip.crop.y,
        width: clip.crop.width,
        height: clip.crop.height,
      },
    };
  }

  root.paintCropOverlay = paintCropOverlay;
  root.clearCrop = clearCrop;
  root.cropTransformForRequest = cropTransformForRequest;

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
