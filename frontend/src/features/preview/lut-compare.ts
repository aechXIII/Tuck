import { NO_PICTURE, pictureRect, type PictureRect } from "../../platform/native-surface.ts";

/** The part of a 2D transform that turns, flips and scales: `matrix(a, b, c, d, …)` in CSS. */
export interface TurnMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

const KEY_STEP = 0.05;

/**
 * Where the picture shows on screen: the whole media box when crop and turn transforms stretch the
 * picture over it, or the part `object-fit: contain` draws into, clipped to what the viewport shows.
 */
export function shownPicture(
  box: DOMRectReadOnly,
  fit: string,
  videoWidth: number,
  videoHeight: number,
  viewport: DOMRectReadOnly,
): PictureRect {
  if (fit !== "fill") return pictureRect(box, videoWidth, videoHeight, viewport);
  const left = Math.max(box.left, viewport.left);
  const top = Math.max(box.top, viewport.top);
  const right = Math.min(box.right, viewport.right);
  const bottom = Math.min(box.bottom, viewport.bottom);
  if (right - left < 1 || bottom - top < 1) return NO_PICTURE;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The `clip-path` that keeps the LUT layer only right of the split. `share` is how much of the
 * media box's width on screen lies left of it. A turned or flipped box runs another of its own
 * edges across the screen, so the inset goes on that edge.
 */
export function lutInset(matrix: TurnMatrix | null, share: number): string {
  const percent = `${Math.round(Math.min(1, Math.max(0, share)) * 10000) / 100}%`;
  const { a, c } = matrix ?? { a: 1, c: 0 };
  // screen x follows the box's own x where |a| wins, its own y where |c| does
  if (Math.abs(a) >= Math.abs(c)) return a >= 0 ? `inset(0 0 0 ${percent})` : `inset(0 ${percent} 0 0)`;
  return c >= 0 ? `inset(${percent} 0 0 0)` : `inset(0 0 ${percent} 0)`;
}

/** The split after a drag: it keeps its distance from the grab point, inside the picture. */
export function draggedSplit(origin: number, deltaX: number, width: number): number {
  if (!(width > 0)) return origin;
  return Math.min(1, Math.max(0, origin + deltaX / width));
}

/** The split after a key press on the divider, or null for a key it doesn't use. */
export function keyedSplit(split: number, key: string): number | null {
  if (key === "ArrowLeft" || key === "ArrowDown") return Math.max(0, split - KEY_STEP);
  if (key === "ArrowRight" || key === "ArrowUp") return Math.min(1, split + KEY_STEP);
  if (key === "Home") return 0;
  if (key === "End") return 1;
  return null;
}

/** Where the given media element's picture shows on screen, measured from the page. */
export function mediaPicture(video: HTMLVideoElement, viewport: Element): PictureRect {
  const width = video.videoWidth || Number(video.dataset.pictureWidth) || 0;
  const height = video.videoHeight || Number(video.dataset.pictureHeight) || 0;
  return shownPicture(
    video.getBoundingClientRect(),
    getComputedStyle(video).objectFit,
    width,
    height,
    viewport.getBoundingClientRect(),
  );
}

/** The element's own turn and flip, or null when it has no transform. */
export function turnOf(element: Element): TurnMatrix | null {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return null;
  const matrix = new DOMMatrixReadOnly(transform);
  return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d };
}

export interface LutCompareHost {
  readonly document: Document;
  readonly video: HTMLVideoElement;
  /** the person moved the divider */
  readonly onSplit: (split: number) => void;
}

export interface LutCompare {
  /** shows the divider at `split`, with the LUT's name on its side */
  show(split: number, name: string): void;
  hide(): void;
}

/**
 * The divider over the preview while the LUT is compared. It only reports where the person puts
 * it; whoever draws the picture shows the LUT right of that.
 */
export function installLutCompare(host: LutCompareHost): LutCompare {
  const doc = host.document;
  const root = doc.getElementById("lut-compare");
  const divider = doc.getElementById("lut-compare-divider");
  const name = doc.getElementById("lut-compare-name");
  const stage = doc.getElementById("stage");
  const viewport = doc.getElementById("media-viewport");
  let shown = false;
  let split = 0.5;
  let width = 0;
  let placedX = -1;
  let frame = 0;
  let drag: { pointerId: number; startX: number; origin: number } | null = null;

  function placeDivider(): void {
    if (!divider) return;
    const x = Math.round(split * width);
    if (x === placedX) return;
    placedX = x;
    divider.style.transform = `translateX(${x}px)`;
    const percent = Math.round(split * 100);
    divider.setAttribute("aria-valuenow", String(percent));
    divider.setAttribute("aria-valuetext", `${percent}% original`);
  }

  function relayout(): void {
    frame = 0;
    if (!shown || !root || !stage || !viewport) return;
    const picture = mediaPicture(host.video, viewport);
    const area = stage.getBoundingClientRect();
    root.hidden = picture.width < 1;
    root.style.left = `${picture.x - area.left - stage.clientLeft}px`;
    root.style.top = `${picture.y - area.top - stage.clientTop}px`;
    root.style.width = `${picture.width}px`;
    root.style.height = `${picture.height}px`;
    width = picture.width;
    placedX = -1;
    placeDivider();
  }

  function schedule(): void {
    if (shown && !frame) frame = requestAnimationFrame(relayout);
  }

  function move(next: number): void {
    if (next === split) return;
    split = next;
    placeDivider();
    host.onSplit(split);
  }

  divider?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startX: event.clientX, origin: split };
    divider.setPointerCapture(event.pointerId);
    divider.focus({ preventScroll: true });
  });
  divider?.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    move(draggedSplit(drag.origin, event.clientX - drag.startX, width));
  });
  const endDrag = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    if (divider?.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  };
  divider?.addEventListener("pointerup", endDrag);
  divider?.addEventListener("pointercancel", endDrag);
  divider?.addEventListener("keydown", (event) => {
    const next = keyedSplit(split, event.key);
    if (next == null) return;
    // the divider's own keys must not also step or seek the video
    event.preventDefault();
    event.stopPropagation();
    move(next);
  });

  const resized = new ResizeObserver(schedule);
  for (const element of [stage, viewport, host.video]) if (element) resized.observe(element);
  // crop, turn and zoom transforms and showing another video all change the media's style
  new MutationObserver(schedule).observe(host.video, {
    attributes: true,
    attributeFilter: ["style", "class", "data-picture-width", "data-picture-height"],
  });
  host.video.addEventListener("loadedmetadata", schedule);
  doc.defaultView?.addEventListener("resize", schedule);

  return {
    show(next, label) {
      if (name && name.textContent !== label) name.textContent = label;
      split = next;
      if (!shown) {
        shown = true;
        if (root) root.hidden = false;
      }
      relayout();
    },
    hide() {
      if (!shown) return;
      shown = false;
      drag = null;
      if (root) root.hidden = true;
    },
  };
}
