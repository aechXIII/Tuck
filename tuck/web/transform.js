(function (root) {
  "use strict";

  if (typeof document === "undefined") return;

  var drag = null;
  var moveEvent = null;
  var moveRaf = 0;
  var tooltipTimer = 0;
  var tooltipTarget = null;
  var tooltipPointerActive = false;

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

  function mediaElements() {
    return [document.getElementById("vid"), document.getElementById("thumb")].filter(Boolean);
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

  function previewMatrix(transform, preview, frame) {
    var p0 = previewPoint(0, 0, transform, preview, frame);
    var px = previewPoint(1, 0, transform, preview, frame);
    var py = previewPoint(0, 1, transform, preview, frame);
    return {
      a: px.x - p0.x,
      b: px.y - p0.y,
      c: py.x - p0.x,
      d: py.y - p0.y,
      e: p0.x,
      f: p0.y,
    };
  }

  function matrixCss(matrix) {
    return (
      "matrix(" +
      [
        matrix.a,
        matrix.b,
        matrix.c,
        matrix.d,
        matrix.e,
        matrix.f,
      ].join(",") +
      ")"
    );
  }

  function paintMediaFrame(size, frame, matrix) {
    var viewport = document.getElementById("media-viewport");
    if (!viewport) return;
    setBox(viewport, frame.left, frame.top, frame.width, frame.height);
    var media = mediaElements();
    for (var i = 0; i < media.length; i++) {
      if (!media[i]) continue;
      media[i].style.width = size.width + "px";
      media[i].style.height = size.height + "px";
      media[i].style.objectFit = "fill";
      media[i].style.transform = matrixCss(matrix);
    }
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
    paintMediaFrame(size, frame, previewMatrix(transform, preview, frame));
  }

  function cropEditorGeometry(clip, size) {
    var stage = document.getElementById("stage");
    var transform = cropTransformForRequest(clip);
    transform.crop = null;
    var quarterTurn = transform.rotation === 90 || transform.rotation === 270;
    var preview = {
      selected: root.TuckCropGeometry.fullCrop(size.width, size.height),
      orientedWidth: quarterTurn ? size.height : size.width,
      orientedHeight: quarterTurn ? size.width : size.height,
      fillCrop: null,
    };
    var frame = root.TuckCropGeometry.containedRect(
      stage.clientWidth,
      stage.clientHeight,
      preview.orientedWidth,
      preview.orientedHeight,
    );
    return {
      transform: transform,
      preview: preview,
      frame: frame,
      matrix: previewMatrix(transform, preview, frame),
    };
  }

  function editorPointToDisplay(x, y, editor) {
    var point = previewPoint(
      x,
      y,
      editor.transform,
      editor.preview,
      editor.frame,
    );
    return {
      x: editor.frame.left + point.x,
      y: editor.frame.top + point.y,
    };
  }

  function editorCropToDisplay(crop, editor) {
    var points = [
      editorPointToDisplay(crop.x, crop.y, editor),
      editorPointToDisplay(crop.x + crop.width, crop.y, editor),
      editorPointToDisplay(crop.x, crop.y + crop.height, editor),
      editorPointToDisplay(
        crop.x + crop.width,
        crop.y + crop.height,
        editor,
      ),
    ];
    var xs = points.map(function (point) {
      return point.x;
    });
    var ys = points.map(function (point) {
      return point.y;
    });
    var left = Math.min.apply(null, xs);
    var top = Math.min.apply(null, ys);
    return {
      left: left,
      top: top,
      width: Math.max.apply(null, xs) - left,
      height: Math.max.apply(null, ys) - top,
    };
  }

  function editorDisplayToSource(x, y, editor, size) {
    var matrix = editor.matrix;
    var localX = x - editor.frame.left - matrix.e;
    var localY = y - editor.frame.top - matrix.f;
    var determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    return {
      x: Math.max(
        0,
        Math.min(
          size.width,
          (matrix.d * localX - matrix.c * localY) / determinant,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          size.height,
          (-matrix.b * localX + matrix.a * localY) / determinant,
        ),
      ),
    };
  }

  function sourceHandleForDisplay(displayHandle, crop, editor) {
    var positions = {
      nw: [0, 0],
      n: [0.5, 0],
      ne: [1, 0],
      e: [1, 0.5],
      se: [1, 1],
      s: [0.5, 1],
      sw: [0, 1],
      w: [0, 0.5],
    };
    var shown = editorCropToDisplay(crop, editor);
    var wanted = positions[displayHandle];
    var targetX = shown.left + wanted[0] * shown.width;
    var targetY = shown.top + wanted[1] * shown.height;
    var closest = displayHandle;
    var closestDistance = Infinity;
    Object.keys(positions).forEach(function (sourceHandle) {
      var position = positions[sourceHandle];
      var point = editorPointToDisplay(
        crop.x + position[0] * crop.width,
        crop.y + position[1] * crop.height,
        editor,
      );
      var distance =
        Math.pow(point.x - targetX, 2) + Math.pow(point.y - targetY, 2);
      if (distance < closestDistance) {
        closest = sourceHandle;
        closestDistance = distance;
      }
    });
    return closest;
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

    if ((clip.cropAspect || "off") === "off") {
      ui.classList.remove("on");
      paintTransformPreview(clip, size);
      var offLabel = document.getElementById("crop-label");
      var offReset = document.getElementById("btn-crop-reset");
      if (offLabel) {
        offLabel.textContent = "Full frame";
        offLabel.classList.remove("active");
      }
      if (offReset) offReset.classList.add("hid");
      return;
    }

    var editor = cropEditorGeometry(clip, size);
    var content = editor.frame;
    if (content.width <= 0 || content.height <= 0) {
      ui.classList.remove("on");
      return;
    }
    paintMediaFrame(size, content, editor.matrix);
    ui.classList.add("on");
    var crop = root.TuckCropGeometry.selectionCrop(
      clip.crop,
      size.width,
      size.height,
    );
    var shown = editorCropToDisplay(crop, editor);
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
        clip.cropAspect && clip.cropAspect !== "free" && clip.cropAspect !== "off"
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
        "hid",
        !(!!clip.crop || (clip.cropAspect || "off") !== "off"),
      );
  }

  function eventSourcePoint(event, size, editor) {
    var stageRect = document.getElementById("stage").getBoundingClientRect();
    return editorDisplayToSource(
      event.clientX - stageRect.left,
      event.clientY - stageRect.top,
      editor,
      size,
    );
  }

  function processCropMove(event) {
    if (!drag) return;
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || clip !== drag.clip || !size) return;
    var point = eventSourcePoint(event, size, drag.editor);
    var next = root.TuckCropGeometry.resizeCrop(
      drag.origin,
      drag.handle,
      point.x - drag.start.x,
      point.y - drag.start.y,
      size.width,
      size.height,
      clip.cropAspect === "off" ? "free" : clip.cropAspect || "free",
      clip.rotation || 0,
    );
    clip.crop = root.TuckCropGeometry.isFullCrop(next, size.width, size.height)
      ? null
      : next;
    clip.transformOverride = true;
    clip.planData = null;
    paintCropOverlay();
  }

  function onCropPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    var clip = selectedClip();
    var size = sourceSize(clip);
    if (!clip || !size) return;
    var editor = cropEditorGeometry(clip, size);
    var displayHandle =
      event.target && event.target.dataset ? event.target.dataset.handle : "";
    var origin = root.TuckCropGeometry.selectionCrop(
      clip.crop,
      size.width,
      size.height,
    );
    drag = {
      clip: clip,
      handle: displayHandle
        ? sourceHandleForDisplay(displayHandle, origin, editor)
        : "move",
      editor: editor,
      origin: origin,
      start: eventSourcePoint(event, size, editor),
      pointerId: event.pointerId,
    };
    var stage = document.getElementById("stage");
    try {
      stage.setPointerCapture(event.pointerId);
    } catch (error) {}
    document.body.classList.add("crop-dragging");
    if (root.History) root.History.begin(root.selPath);
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
    if (root.History) root.History.commit();
    if (typeof root.renderClips === "function") root.renderClips();
    if (typeof root.reqPreview === "function") root.reqPreview();
    event.preventDefault();
  }

  function clearCrop() {
    var clip = selectedClip();
    if (!clip) return;
    clip.crop = root.TuckCropGeometry.resetCrop();
    clip.cropAspect = "off";
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
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
      crop_aspect: clip.cropAspect === "off" ? "free" : clip.cropAspect || "free",
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
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    if (aspect === "off") {
      clip.crop = null;
    } else if (aspect !== "free") {
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
        clip.rotation || 0,
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
    var size = sourceSize(clip);
    var rotationAspect = clip.cropAspect || "off";
    if (size && rotationAspect !== "free" && rotationAspect !== "off") {
      var current = root.TuckCropGeometry.selectionCrop(
        clip.crop,
        size.width,
        size.height,
      );
      var next = root.TuckCropGeometry.cropForAspect(
        current,
        clip.cropAspect,
        size.width,
        size.height,
        rotation,
      );
      clip.crop = root.TuckCropGeometry.isFullCrop(
        next,
        size.width,
        size.height,
      )
        ? null
        : next;
    }
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
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
    clip.transformOverride = true;
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
    clip.transformOverride = true;
    clip.transformIntentTouched = true;
    clip.planData = null;
    syncTransformControls();
    paintCropOverlay();
    if (typeof root.reqPreview === "function") root.reqPreview();
  }

  function syncTransformControls() {
    var clip = selectedClip();
    var fields = document.getElementById("transform-fields");
    var controls = document.querySelectorAll("#transform-fields button");
    var unavailable = !(clip && clip.probed);
    if (fields) {
      fields.classList.toggle("disabled", unavailable);
      fields.setAttribute("aria-disabled", String(unavailable));
    }
    for (var c = 0; c < controls.length; c++) controls[c].disabled = unavailable;
    if (unavailable) return;

    function setToggleState(button, active) {
      button.classList.toggle("on", active);
      button.setAttribute("aria-pressed", String(active));
    }

    var aspect = clip.cropAspect || "off";
    var aspectButtons = document.querySelectorAll("[data-aspect]");
    for (var a = 0; a < aspectButtons.length; a++) {
      setToggleState(aspectButtons[a], aspectButtons[a].dataset.aspect === aspect);
    }
    var rotation = clip.rotation || 0;
    var rotationButtons = document.querySelectorAll("[data-rotation]");
    for (var i = 0; i < rotationButtons.length; i++) {
      setToggleState(
        rotationButtons[i],
        parseInt(rotationButtons[i].dataset.rotation, 10) === rotation,
      );
    }
    var flipH = document.getElementById("flip-horizontal");
    var flipV = document.getElementById("flip-vertical");
    if (flipH) setToggleState(flipH, !!clip.flipHorizontal);
    if (flipV) setToggleState(flipV, !!clip.flipVertical);
    var sizing = clip.sizingMode || "fit";
    var sizingButtons = document.querySelectorAll("[data-sizing]");
    for (var j = 0; j < sizingButtons.length; j++) {
      setToggleState(sizingButtons[j], sizingButtons[j].dataset.sizing === sizing);
    }
  }

  function hideTransformTooltip() {
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = 0;
    }
    tooltipTarget = null;
    var tooltip = document.getElementById("transform-tooltip");
    if (tooltip) tooltip.classList.remove("show");
  }

  function positionTransformTooltip(target, tooltip) {
    var targetRect = target.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) {
      hideTransformTooltip();
      return;
    }
    var toolbar = target.closest ? target.closest(".transform-controls") : null;
    var toolbarRect = toolbar ? toolbar.getBoundingClientRect() : targetRect;
    tooltip.style.left = "0";
    tooltip.style.top = "0";
    var tooltipRect = tooltip.getBoundingClientRect();
    var edge = 8;
    var gap = 7;
    var left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
    left = Math.max(
      edge,
      Math.min(
        left,
        document.documentElement.clientWidth - tooltipRect.width - edge,
      ),
    );
    var top = toolbarRect.top - tooltipRect.height - gap;
    if (top < edge) top = toolbarRect.bottom + gap;
    tooltip.style.left = Math.round(left) + "px";
    tooltip.style.top = Math.round(top) + "px";
  }

  function showTransformTooltip(target) {
    hideTransformTooltip();
    if (tooltipPointerActive) return;
    tooltipTarget = target;
    tooltipTimer = setTimeout(function () {
      if (tooltipTarget !== target || !target.isConnected) {
        hideTransformTooltip();
        return;
      }
      var tooltip = document.getElementById("transform-tooltip");
      if (!tooltip) return;
      tooltip.textContent = target.dataset.tip;
      tooltip.classList.add("show");
      positionTransformTooltip(target, tooltip);
      tooltipTimer = 0;
    }, 350);
  }

  function tipTarget(event) {
    return event.target && event.target.closest
      ? event.target.closest("[data-tip]")
      : null;
  }

  // Include clips added after page load
  function initTransformTooltips() {
    if (!document.createElement || !document.body) return;
    var tooltip = document.createElement("div");
    tooltip.id = "transform-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    document.addEventListener("mouseover", function (event) {
      var target = tipTarget(event);
      if (!target || target === tooltipTarget) return;
      showTransformTooltip(target);
    });
    document.addEventListener("mouseout", function (event) {
      var target = tipTarget(event);
      if (!target) return;
      var related = event.relatedTarget;
      if (related && target.contains(related)) return;
      hideTransformTooltip();
    });
    document.addEventListener("focusin", function (event) {
      var target = tipTarget(event);
      if (target) showTransformTooltip(target);
    });
    document.addEventListener("focusout", function (event) {
      if (tipTarget(event)) hideTransformTooltip();
    });
    document.addEventListener(
      "pointerdown",
      function () {
        tooltipPointerActive = true;
        hideTransformTooltip();
      },
      true,
    );
    function endTooltipPointerGesture() {
      hideTransformTooltip();
    }
    document.addEventListener("pointerup", endTooltipPointerGesture, true);
    document.addEventListener("pointercancel", endTooltipPointerGesture, true);
    document.addEventListener(
      "mousemove",
      function (event) {
        if (!tooltipPointerActive || event.buttons !== 0) return;
        tooltipPointerActive = false;
        hideTransformTooltip();
      },
      true,
    );
    if (root.addEventListener) {
      root.addEventListener("resize", hideTransformTooltip);
      root.addEventListener("scroll", hideTransformTooltip, true);
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

  syncTransformControls();
  initTransformTooltips();

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
