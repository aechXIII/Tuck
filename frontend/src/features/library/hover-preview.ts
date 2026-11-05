import type { EditorClip } from "../editor/types.ts";
import type { FrameSprite } from "../timeline/frames.ts";

// how long the pointer rests on a row before its card shows
export const HOVER_DELAY_MS = 400;
// after a card goes, the next row's comes at once for this long, the way tooltips stay warm
const WARM_MS = 300;
// pictures across the whole video; one request, the most the backend makes at once
export const PREVIEW_COUNT = 32;
// videos whose pictures are kept; older ones give their media token back
const KEEP = 8;
const TILE_WIDTH = 150;

/** Which of the pictures sits under the pointer, from its share of the row's width. */
export function previewTile(share: number, count: number = PREVIEW_COUNT): number {
  if (!Number.isFinite(share)) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(share * count)));
}

/** Pictures from the middle of each slot, so the first isn't a black opening frame. */
export function previewRequest(duration: number, count: number = PREVIEW_COUNT): { start: number; step: number } | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const step = duration / count;
  return { start: step / 2, step };
}

/**
 * Where the card goes: beside the Library, level with the row, kept inside the window. A Library
 * at the right edge of a narrow window puts the card on its left instead.
 */
export function previewPlacement(
  row: { top: number; height: number },
  panel: { left: number; right: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  gap = 8,
): { left: number; top: number } {
  let left = panel.right + gap;
  if (left + card.width > view.width - gap) left = Math.max(gap, panel.left - gap - card.width);
  const top = Math.max(gap, Math.min(row.top + row.height / 2 - card.height / 2, view.height - gap - card.height));
  return { left: Math.round(left), top: Math.round(top) };
}

export interface HoverPreviewHost {
  document: Document;
  window: Window & typeof globalThis;
  clip: (path: string) => EditorClip | undefined;
  selectedPath: () => string | null;
  // a row drag or an open menu: no card then
  busy: () => boolean;
  frames: (path: string, start: number, step: number, count: number) => Promise<FrameSprite | null>;
  release: (token: string) => void;
  formatTime: (seconds: number) => string;
}

type Pictures = { state: "loading" } | { state: "ready"; sprite: FrameSprite } | { state: "failed" };

export function installHoverPreview(host: HoverPreviewHost): { hide: () => void } {
  const doc = host.document;
  const win = host.window;
  const list = doc.getElementById("clips");
  const pictures = new Map<string, Pictures>();
  let card: HTMLElement | null = null;
  let picture: HTMLElement | null = null;
  let fill: HTMLElement | null = null;
  let now: HTMLElement | null = null;
  let total: HTMLElement | null = null;
  let shownPath: string | null = null;
  // the row whose own tooltip waits while the pointer is on it and a card is due. WebKitGTK draws
  // that tooltip over the card, and takes its text when the pointer moves, so it goes on arrival
  let quietRow: HTMLElement | null = null;
  let waitingPath: string | null = null;
  let timer: number | null = null;
  let hiddenAt = 0;
  let lastShare = 0;
  let loading = false;

  function ensureCard(): HTMLElement {
    if (card) return card;
    const element = doc.createElement("div");
    element.id = "hover-preview";
    element.className = "hover-preview";
    element.setAttribute("aria-hidden", "true");
    element.hidden = true;
    picture = doc.createElement("div");
    picture.className = "hover-preview-picture";
    const track = doc.createElement("div");
    track.className = "hover-preview-track";
    fill = doc.createElement("div");
    fill.className = "hover-preview-fill";
    track.append(fill);
    const time = doc.createElement("div");
    time.className = "hover-preview-time";
    now = doc.createElement("span");
    now.className = "hover-preview-now";
    total = doc.createElement("span");
    time.append(now, total);
    element.append(picture, track, time);
    doc.body.append(element);
    card = element;
    return element;
  }

  function cancelTimer(): void {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    waitingPath = null;
  }

  function quiet(row: HTMLElement | null): void {
    if (quietRow === row) return;
    if (quietRow) {
      const title = quietRow.dataset.hoverTitle;
      delete quietRow.dataset.hoverTitle;
      // a row redrawn meanwhile has its own title already
      if (title && !quietRow.hasAttribute("title")) quietRow.setAttribute("title", title);
    }
    quietRow = row;
    const title = row?.getAttribute("title");
    if (row && title) {
      row.dataset.hoverTitle = title;
      row.removeAttribute("title");
    }
  }

  // warm: the next row's card may come at once, as when the pointer moves between rows. A scroll,
  // press or menu ends that, or a scrolling list would show every row that passes the pointer
  function hide(warm = true): void {
    cancelTimer();
    quiet(null);
    if (!warm) hiddenAt = 0;
    if (!card || card.hidden) return;
    card.hidden = true;
    card.classList.remove("showing");
    shownPath = null;
    if (warm) hiddenAt = Date.now();
  }
  const hideCold = () => hide(false);

  function remember(path: string, entry: Pictures): void {
    pictures.delete(path);
    pictures.set(path, entry);
    for (const [old, kept] of pictures) {
      if (pictures.size <= KEEP) break;
      if (old === shownPath || kept.state === "loading") continue;
      if (kept.state === "ready") host.release(kept.sprite.token);
      pictures.delete(old);
    }
  }

  function preload(sprite: FrameSprite): Promise<boolean> {
    return new Promise((resolve) => {
      const image = new win.Image();
      image.onload = () => resolve(image.naturalWidth > 0);
      image.onerror = () => resolve(false);
      image.src = sprite.url;
    });
  }

  // one request at a time; when it ends, the video on show gets its turn if it still needs one
  function load(path: string): void {
    if (loading || pictures.has(path)) return;
    const clip = host.clip(path);
    const request = previewRequest(Number(clip?.probeData?.duration));
    if (!request) return;
    loading = true;
    pictures.set(path, { state: "loading" });
    void host.frames(path, request.start, request.step, PREVIEW_COUNT)
      .then(async (sprite) => (sprite && await preload(sprite) ? sprite : null), () => null)
      .then((sprite) => {
        loading = false;
        if (!host.clip(path)) {
          if (sprite) host.release(sprite.token);
          pictures.delete(path);
        } else {
          remember(path, sprite ? { state: "ready", sprite } : { state: "failed" });
        }
        if (shownPath === path) paint(lastShare);
        if (shownPath && shownPath !== path) load(shownPath);
      });
  }

  function paint(share: number): void {
    if (!shownPath || !picture || !fill || !now || !total) return;
    const clip = host.clip(shownPath);
    const duration = Number(clip?.probeData?.duration);
    if (!clip || !(duration > 0)) return;
    lastShare = share;
    const entry = pictures.get(shownPath);
    if (entry?.state === "ready") {
      const { sprite } = entry;
      const tile = previewTile(share, sprite.count);
      const image = `url(${JSON.stringify(sprite.url)})`;
      if (picture.style.backgroundImage !== image) {
        picture.style.backgroundImage = image;
        picture.style.backgroundSize = `${TILE_WIDTH * sprite.columns}px 100%`;
      }
      const position = -tile * TILE_WIDTH + "px 0";
      if (picture.style.backgroundPosition !== position) picture.style.backgroundPosition = position;
    } else {
      // the row's own picture holds the place, at the size the pictures will have
      const thumbnail = clip._thumbnail ? `url(${JSON.stringify(clip._thumbnail)})` : "none";
      if (picture.style.backgroundImage !== thumbnail) {
        picture.style.backgroundImage = thumbnail;
        picture.style.backgroundSize = "contain";
        picture.style.backgroundPosition = "center";
      }
    }
    const width = Math.round(Math.max(0, Math.min(1, share)) * 1000) / 10 + "%";
    if (fill.style.width !== width) fill.style.width = width;
    const at = host.formatTime(Math.max(0, Math.min(1, share)) * duration);
    if (now.textContent !== at) now.textContent = at;
    const length = host.formatTime(duration);
    if (total.textContent !== length) total.textContent = length;
  }

  function place(row: HTMLElement): void {
    if (!card) return;
    const panel = (doc.getElementById("left") ?? list ?? row).getBoundingClientRect();
    const size = card.getBoundingClientRect();
    const spot = previewPlacement(
      row.getBoundingClientRect(),
      panel,
      { width: size.width, height: size.height },
      { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight },
    );
    card.style.left = spot.left + "px";
    card.style.top = spot.top + "px";
  }

  function show(path: string, row: HTMLElement, share: number): void {
    const element = ensureCard();
    const fresh = element.hidden;
    shownPath = path;
    element.hidden = false;
    paint(share);
    place(row);
    // only a card that wasn't showing slides in; moving to the next row just moves it
    if (fresh) {
      element.classList.remove("showing");
      void element.offsetWidth;
      element.classList.add("showing");
    }
    load(path);
  }

  function rowAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>("#clips .clip[data-clip-path]") : null;
  }

  function shareOf(row: HTMLElement, x: number): number {
    const box = row.getBoundingClientRect();
    return box.width > 0 ? Math.max(0, Math.min(1, (x - box.left) / box.width)) : 0;
  }

  function wanted(path: string): boolean {
    const clip = host.clip(path);
    return !!clip?.probed && Number(clip.probeData?.duration) > 0 && path !== host.selectedPath() && !host.busy();
  }

  list?.addEventListener("pointermove", (event) => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    const row = rowAt(event.target);
    const path = row?.dataset.clipPath ?? null;
    if (!row || !path || !wanted(path)) {
      hide();
      return;
    }
    quiet(row);
    const share = shareOf(row, event.clientX);
    if (shownPath === path) {
      paint(share);
      return;
    }
    if (shownPath || Date.now() - hiddenAt < WARM_MS) {
      cancelTimer();
      show(path, row, share);
      return;
    }
    lastShare = share;
    if (waitingPath === path) return;
    cancelTimer();
    waitingPath = path;
    timer = win.setTimeout(() => {
      timer = null;
      waitingPath = null;
      if (row.isConnected && row.matches(":hover") && wanted(path)) show(path, row, lastShare);
    }, HOVER_DELAY_MS);
  });
  list?.addEventListener("pointerleave", () => hide());
  list?.addEventListener("pointerdown", hideCold);
  list?.addEventListener("scroll", hideCold, { passive: true });
  list?.addEventListener("contextmenu", hideCold);
  win.addEventListener("blur", hideCold);
  win.addEventListener("pagehide", () => {
    hideCold();
    for (const entry of pictures.values()) if (entry.state === "ready") host.release(entry.sprite.token);
    pictures.clear();
  }, { once: true });

  return { hide: hideCold };
}
