// Tuck's own Animations setting; interface motion ignores the OS reduced-motion preference on purpose
export function motionEnabled(doc: Document = document): boolean {
  return doc.documentElement.dataset.motion !== "off";
}

// matches --ease-out, for motion run from script
export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Sets a button's label. A new phrase, such as "Adding to Exports…" after "Compress this video",
 * rises in over a short moment; a changing number inside the same phrase ("Exporting · 41%") just
 * updates, so a running export doesn't twitch on every poll.
 */
export function swapLabel(button: HTMLElement, text: string): void {
  const doc = button.ownerDocument;
  let label = button.querySelector<HTMLElement>(":scope > .label-swap");
  const previous = label?.textContent ?? button.textContent ?? "";
  if (previous === text && label) return;
  // the first label replaces the page's starting text without any motion
  const first = !label;
  if (!label) {
    label = doc.createElement("span");
    label.className = "label-swap";
    button.replaceChildren(label);
  }
  label.textContent = text;
  const phrase = (value: string): string => value.split(" · ")[0] ?? value;
  if (first || !previous || phrase(previous) === phrase(text) || !motionEnabled(doc) || typeof label.animate !== "function") {
    return;
  }
  label.animate(
    [{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
    { duration: 120, easing: EASE_OUT },
  );
}
