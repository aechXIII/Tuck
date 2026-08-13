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
      size.height,
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
    if (rotation === 180)
      return { x: crop.width - localX, y: crop.height - localY };
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
      x: ((point.x - input.x) * frame.width) / input.width,
      y: ((point.y - input.y) * frame.height) / input.height,
    };
  }

  function paintTransformPreview(clip, size) {
    var stage = document.getElementById("stage");
    var viewport = document.getElementById("media-viewport");
    if (!stage || !viewport) return;
    var planned = clip.planData || null;
    var transform =
      planned && planned.transform
        ? planned.transform
        : cropTransformForRequest(clip);
    var plannedGeometry = planned && planned.transform_geometry;
    var preview = plannedGeometry
      ? {
          selected:
            transform.crop ||
            root.TuckCropGeometry.fullCrop(size.width, size.height),
          orientedWidth: plannedGeometry.oriented_width,
          orientedHeight: plannedGeometry.oriented_height,
          fillCrop: plannedGeometry.fill_crop,
          output: {
            width: plannedGeometry.output_width,
            height: plannedGeometry.output_height,
          },
        }
      : root.TuckCropGeometry.previewTransformGeometry(
          transform,
          size.width,
          size.height,
        );
    var frame = root.TuckCropGeometry.containedRect(
      stage.clientWidth,
      stage.clientHeight,
      preview.output.width,
      preview.output.height,
    );
    setBox(viewport, frame.left, frame.top, frame.width, frame.height);
    var p0 = previewPoint(0, 0, transform, preview, frame);
    var px = previewPoint(1, 0, transform, preview, frame);
    var py = previewPoint(0, 1, transform, preview, frame);
    var matrix =
      "matrix(" +
      [px.x - p0.x, px.y - p0.y, py.x - p0.x, py.y - p0.y, p0.x, p0.y].join(
        ",",
      ) +
      ")";
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
    var crop = root.TuckCropGeometry.selectionCrop(
      clip.crop,
      size.width,
      size.height,
    );
    var shown = root.TuckCropGeometry.sourceRectToDisplay(
      crop,
      content,
      size.width,
      size.height,
    );
    setBox(selection, shown.left, shown.top, shown.width, shown.height);

    setBox(
      document.getElementById("crop-dim-top"),
      content.left,
      content.top,
      content.width,
      shown.top - content.top,
    );
    setBox(
      document.getElementById("crop-dim-bottom"),
      content.left,
      shown.top + shown.height,
      content.width,
      content.top + content.height - shown.top - shown.height,
    );
    setBox(
      document.getElementById("crop-dim-left"),
      content.left,
      shown.top,
      shown.left - content.left,
      shown.height,
    );
    setBox(
      document.getElementById("crop-dim-right"),
      shown.left + shown.width,
      shown.top,
      content.left + content.width - shown.left - shown.width,
      shown.height,
    );

    var label = document.getElementById("crop-label");
    var reset = document.getElementById("btn-crop-reset");
    if (label) {
      var aspect =
        clip.cropAspect && clip.cropAspect !== "free"
          ? " · " + clip.cropAspect
          : "";
      var rotation = clip.rotation ? " · " + clip.rotation + "°" : "";
      var flip =
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
        "show",
        !!clip.crop || (clip.cropAspect || "free") !== "free",
      );
  }

  function eventSourcePoint(event, size, content) {
    var stageRect = document.getElementById("stage").getBoundingClientRect();
    return root.TuckCropGeometry.displayPointToSource(
      event.clientX - stageRect.left,
      event.clientY - stageRect.top,
      content,
      size.width,
      size.height,
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
      clip.cropAspect || "free",
    );
    clip.crop = root.TuckCropGeometry.isFullCrop(next, size.width, size.height)
      ? null
      : next;
    clip.planData = null;
    paintCropOverlay();
  }

  function onCropPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || !size) return;
    var content = currentContent(size);
    var handle =
      event.target && event.target.dataset ? event.target.dataset.handle : "";
    drag = {
      clip: clip,
      handle: handle || "move",
      content: content,
      origin: root.TuckCropGeometry.selectionCrop(
        clip.crop,
        size.width,
        size.height,
      ),
      start: eventSourcePoint(event, size, content),
      pointerId: event.pointerId,
    };
    var stage = document.getElementById("stage");
    try {
      stage.setPointerCapture(event.pointerId);
    } catch (error) {}
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
    try {
      stage.releasePointerCapture(drag.pointerId);
    } catch (error) {}
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
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function cropTransformForRequest(clip) {
    if (!clip) return null;
    var transform = {
      crop: clip.crop
        ? {
            x: clip.crop.x,
            y: clip.crop.y,
            width: clip.crop.width,
            height: clip.crop.height,
          }
        : null,
      crop_aspect: clip.cropAspect || "free",
      rotation: clip.rotation || 0,
      flip_horizontal: !!clip.flipHorizontal,
      flip_vertical: !!clip.flipVertical,
      sizing_mode: clip.sizingMode || "fit",
    };
    return transform;
  }

  function setCropAspect(aspect) {
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || !size) return;
    clip.cropAspect = aspect;
    if (aspect !== "free") {
      var current = root.TuckCropGeometry.selectionCrop(
        clip.crop,
        size.width,
        size.height,
      );
      var next = root.TuckCropGeometry.cropForAspect(
        current,
        aspect,
        size.width,
        size.height,
      );
      clip.crop = root.TuckCropGeometry.isFullCrop(
        next,
        size.width,
        size.height,
      )
        ? null
        : next;
    }
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function setVideoRotation(rotation) {
    var clip = selectedClip();
    if (!clip) return;
    clip.rotation = rotation;
    clip.planData = null;
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
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function setSizingMode(mode) {
    var clip = selectedClip();
    if (!clip) return;
    clip.sizingMode = mode;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function syncTransformControls() {
    var clip = selectedClip();
    if (!clip) return;
    var aspect = clip.cropAspect || "free";
    var aspectButtons = document.querySelectorAll("[data-aspect]");
    for (var a = 0; a < aspectButtons.length; a++) {
      aspectButtons[a].classList.toggle(
        "on",
        aspectButtons[a].dataset.aspect === aspect,
      );
    }
    var rotation = clip.rotation || 0;
    var rotationButtons = document.querySelectorAll("[data-rotation]");
    for (var i = 0; i < rotationButtons.length; i++) {
      rotationButtons[i].classList.toggle(
        "on",
        parseInt(rotationButtons[i].dataset.rotation, 10) === rotation,
      );
    }
    var flipH = document.getElementById("flip-horizontal");
    var flipV = document.getElementById("flip-vertical");
    if (flipH) flipH.classList.toggle("on", !!clip.flipHorizontal);
    if (flipV) flipV.classList.toggle("on", !!clip.flipVertical);
    var sizing = clip.sizingMode || "fit";
    var sizingButtons = document.querySelectorAll("[data-sizing]");
    for (var j = 0; j < sizingButtons.length; j++) {
      sizingButtons[j].classList.toggle(
        "on",
        sizingButtons[j].dataset.sizing === sizing,
      );
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
