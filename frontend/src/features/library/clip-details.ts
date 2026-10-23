export interface ClipDetailsElement {
  className: string;
  textContent: string | null;
  type?: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  appendChild(child: ClipDetailsElement): ClipDetailsElement;
  replaceChildren(...children: ClipDetailsElement[]): void;
}

export interface ClipDetailsDocument {
  createElement(tagName: string): ClipDetailsElement;
}

// the Inspector header carries a readable file's details; this card only explains a file
// Tuck could not read and offers to try again
export type ClipDetailsView =
  | { state: "empty" }
  | { state: "error"; path: string; error: unknown };

export interface SourceSummaryValues {
  resolution: string;
  frameRate: string;
  duration: string;
  size: string;
}

function createElement<T extends ClipDetailsElement>(
  documentRef: { createElement(tagName: string): T },
  tagName: string,
  className?: string,
  text?: unknown,
): T {
  const element = documentRef.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

export function render<T extends ClipDetailsElement>(
  documentRef: { createElement(tagName: string): T },
  host: T,
  view: ClipDetailsView | null | undefined,
  retry: (path: string) => void,
): void {
  host.replaceChildren();
  if (!view || view.state === "empty") return;
  const error = createElement(documentRef, "div", "cd-probe-error");
  error.setAttribute("role", "alert");
  error.appendChild(
    createElement(documentRef, "strong", "", "Couldn’t read clip details"),
  );
  error.appendChild(
    createElement(
      documentRef,
      "span",
      "",
      "You may still be able to play this video, but Tuck needs its details to edit or export it.",
    ),
  );
  error.appendChild(
    createElement(documentRef, "span", "cd-probe-message", view.error),
  );
  const button = createElement(
    documentRef,
    "button",
    "btn2 cd-probe-retry",
    "Retry",
  );
  button.type = "button";
  const path = view.path;
  button.addEventListener("click", () => {
    retry(path);
  });
  error.appendChild(button);
  host.appendChild(error);
}

// 1920×1080 · 30 fps · 0:12 · 14.3 MB, leaving out whatever the probe did not report
export function sourceSummary(values: SourceSummaryValues): string {
  return [values.resolution, values.frameRate, values.duration, values.size].filter(Boolean).join(" · ");
}

export interface FrameRateLabel {
  readonly text: string;
  readonly note: string;
}

// phones and screen recorders change frame rate as they go; their nominal rate can read
// 1000 fps, so say "variable" and give the average instead
export function frameRateLabel(fps: number, variable: boolean, averageFps: number): FrameRateLabel {
  const round = (value: number): number => Math.round(value * 100) / 100;
  if (variable) {
    const average = averageFps > 0 ? averageFps : fps;
    return {
      text: "variable fps",
      note: average > 0 ? "Variable frame rate, about " + round(average) + " fps on average" : "Variable frame rate",
    };
  }
  return { text: fps > 0 ? round(fps) + " fps" : "", note: "" };
}
