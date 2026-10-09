/** A full-window message shown while Tuck starts, closes, or cannot continue. */
export interface StatusScreen {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** "alert" interrupts assistive technology; "status" is announced politely */
  readonly tone: "status" | "alert";
  readonly actions?: readonly StatusAction[];
}

export interface StatusAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly run: (button: HTMLButtonElement, note: HTMLElement) => void;
}

const SCREEN_CLASS = "backend-unavailable";
let blockedElements: HTMLElement[] = [];

/** Replaces any status screen with this one and keeps the editor behind it out of reach. */
export function showStatusScreen(doc: Document, screen: StatusScreen): HTMLElement {
  hideStatusScreens(doc);

  const section = doc.createElement("section");
  section.id = screen.id;
  section.className = SCREEN_CLASS;
  section.setAttribute("role", screen.tone);
  section.setAttribute("aria-live", screen.tone === "alert" ? "assertive" : "polite");

  const content = doc.createElement("div");
  content.className = `${SCREEN_CLASS}__content`;
  const heading = doc.createElement("h1");
  heading.textContent = screen.title;
  const detail = doc.createElement("p");
  detail.textContent = screen.detail;
  content.append(heading, detail);

  if (screen.actions?.length) {
    const note = doc.createElement("p");
    note.className = `${SCREEN_CLASS}__note`;
    note.setAttribute("role", "status");
    const row = doc.createElement("div");
    row.className = `${SCREEN_CLASS}__actions`;
    for (const action of screen.actions) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = action.primary ? "btn1" : "btn2";
      button.textContent = action.label;
      button.addEventListener("click", () => action.run(button, note));
      row.append(button);
    }
    content.append(row, note);
  }

  section.append(content);
  doc.body.append(section);
  blockedElements = blockingTargets(doc, section);
  blockedElements.forEach((element) => {
    element.inert = true;
  });
  section.querySelector<HTMLButtonElement>(".btn1")?.focus();
  return section;
}

export function hideStatusScreens(doc: Document): void {
  doc.querySelectorAll(`.${SCREEN_CLASS}`).forEach((element) => element.remove());
  blockedElements.forEach((element) => {
    element.inert = false;
  });
  blockedElements = [];
}

// everything but the screen goes inert, except the window's own title bar controls, so the
// window can still be moved, resized and closed
function blockingTargets(doc: Document, screen: HTMLElement): HTMLElement[] {
  const bar = doc.getElementById("tb");
  const candidates = [
    ...Array.from(doc.body.children).filter((element) => element !== screen && element !== bar),
    ...Array.from(bar?.querySelectorAll(".tb-editor") ?? []),
  ];
  return candidates.filter(
    (element): element is HTMLElement => element instanceof HTMLElement && !element.inert,
  );
}
