// The player card takes the shape of the picture it shows, so there are never bars around the
// video. Width the picture does not need goes to the open side panels (or the card narrows when
// none is docked); height it does not need shortens the card. The timeline takes spare height
// first, in timeline.ts.

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

export interface PanelState {
  readonly docked: boolean;
  readonly libraryOpen: boolean;
  readonly inspectorOpen: boolean;
}

export interface PlayerFit {
  readonly libraryExtra: number;
  readonly inspectorExtra: number;
  readonly shrinkX: number;
  readonly shrinkY: number;
}

export const NO_FIT: PlayerFit = { libraryExtra: 0, inspectorExtra: 0, shrinkX: 0, shrinkY: 0 };

const VARS = {
  libraryExtra: "--fit-library-extra",
  inspectorExtra: "--fit-inspector-extra",
  shrinkX: "--fit-center-shrink-x",
  shrinkY: "--fit-center-shrink-y",
} as const;

/**
 * Splits the space around a picture of `aspect` (width / height) inside a stage of `base` size.
 * The card never narrows the stage below `minStageWidth`, the width its controls need.
 */
export function playerFit(base: StageSize, aspect: number | null, panels: PanelState, minStageWidth = 0): PlayerFit {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0 || base.width <= 0 || base.height <= 0) return NO_FIT;
  const spareWidth = Math.floor(base.width - base.height * aspect);
  const spareHeight = Math.floor(base.height - base.width / aspect);
  if (spareWidth > 0) {
    if (panels.docked && (panels.libraryOpen || panels.inspectorOpen)) {
      const toLibrary = panels.libraryOpen ? (panels.inspectorOpen ? Math.floor(spareWidth / 2) : spareWidth) : 0;
      return { ...NO_FIT, libraryExtra: toLibrary, inspectorExtra: spareWidth - toLibrary };
    }
    return { ...NO_FIT, shrinkX: Math.max(0, Math.min(spareWidth, Math.floor(base.width - minStageWidth))) };
  }
  if (spareHeight > 0) return { ...NO_FIT, shrinkY: spareHeight };
  return NO_FIT;
}

function readVar(doc: Document, name: string): number {
  return parseFloat(doc.body.style.getPropertyValue(name)) || 0;
}

function currentFit(doc: Document): PlayerFit {
  return {
    libraryExtra: readVar(doc, VARS.libraryExtra),
    inspectorExtra: readVar(doc, VARS.inspectorExtra),
    shrinkX: readVar(doc, VARS.shrinkX),
    shrinkY: readVar(doc, VARS.shrinkY),
  };
}

/**
 * The stage as it would be without any fit applied, so layout decisions never feed back on
 * themselves. Null while no video is showing.
 */
export function stageBaseSize(doc: Document): StageSize | null {
  const stage = doc.getElementById("stage");
  if (!stage || stage.offsetParent === null) return null;
  const box = stage.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const fit = currentFit(doc);
  const panels = panelState(doc);
  // extra panel width only came out of the stage while that panel sits beside it
  const lent = panels.docked
    ? (panels.libraryOpen ? fit.libraryExtra : 0) + (panels.inspectorOpen ? fit.inspectorExtra : 0)
    : 0;
  return { width: box.width + lent + fit.shrinkX, height: box.height + fit.shrinkY };
}

// the card's own minimum width, less its padding, is the narrowest the stage can go
function minStageWidth(doc: Document): number {
  const center = doc.getElementById("center");
  if (!center) return 0;
  const style = getComputedStyle(center);
  return (parseFloat(style.minWidth) || 0) - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

// the shape on screen: the painted transform frame (crop and rotation included) once the preview
// has drawn it, otherwise the video's own size
export function displayAspect(doc: Document): number | null {
  const viewport = doc.getElementById("media-viewport");
  const width = parseFloat(viewport?.style.width ?? "");
  const height = parseFloat(viewport?.style.height ?? "");
  if (width > 0 && height > 0) return width / height;
  const video = doc.getElementById("vid");
  if (video instanceof HTMLVideoElement && video.videoWidth > 0 && video.videoHeight > 0) {
    return video.videoWidth / video.videoHeight;
  }
  return null;
}

function panelState(doc: Document): PanelState {
  const body = doc.body.classList;
  return {
    docked: !body.contains("workspace-overlay"),
    libraryOpen: body.contains("library-panel-open"),
    inspectorOpen: body.contains("inspector-panel-open"),
  };
}

/** Measures the stage and the picture and sizes the card around it. Returns whether anything moved. */
export function applyPlayerFit(doc: Document): boolean {
  const base = stageBaseSize(doc);
  const fit =
    base && !doc.fullscreenElement
      ? playerFit(base, displayAspect(doc), panelState(doc), minStageWidth(doc))
      : NO_FIT;
  const before = currentFit(doc);
  let changed = false;
  for (const key of Object.keys(VARS) as (keyof PlayerFit)[]) {
    if (before[key] === fit[key]) continue;
    changed = true;
    if (fit[key]) doc.body.style.setProperty(VARS[key], fit[key] + "px");
    else doc.body.style.removeProperty(VARS[key]);
  }
  return changed;
}
