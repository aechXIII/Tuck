// keep panel edges aligned with either reserved or overlay scrollbars
export function installPanelScrollSpacing(documentRef: Document): void {
  const panels = ["right-scroll", "clips"]
    .map(id => documentRef.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
  const update = (panel: HTMLElement): void => {
    if (!panel.offsetWidth) return;
    const left = panel.clientLeft;
    const right = Math.max(0, panel.offsetWidth - panel.clientWidth - left);
    panel.style.setProperty("--scroll-gutter-left", `${left}px`);
    panel.style.setProperty("--scroll-gutter-right", `${right}px`);
  };
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) update(entry.target);
    }
  });
  for (const panel of panels) {
    update(panel);
    observer.observe(panel);
  }
}
