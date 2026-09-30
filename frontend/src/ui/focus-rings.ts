// focus rings are for finding your way with Tab; a click, or a shortcut pressed after one, never shows them
export function installFocusRings(documentRef: Document): void {
  const root = documentRef.documentElement;
  const view = documentRef.defaultView;
  if (!view) return;
  // capture, so a dialog that traps Tab still turns the rings on
  view.addEventListener("keydown", (event) => {
    if (event.key === "Tab") root.dataset.focusRings = "";
  }, true);
  view.addEventListener("pointerdown", () => {
    delete root.dataset.focusRings;
  }, true);
}
