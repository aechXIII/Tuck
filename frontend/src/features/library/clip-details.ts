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

export type ClipDetailsView =
  | { state: "empty" }
  | { state: "loading" }
  | { state: "error"; path: string; error: unknown }
  | { state: "ready"; rows: Array<[string, string]> };

export interface SourceFileRowValues {
  duration: string;
  resolution: string;
  frameRate: string;
  format: string;
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
  if (view.state === "loading") {
    const loading = createElement(
      documentRef,
      "div",
      "cd-empty",
      "Reading clip details…",
    );
    loading.setAttribute("role", "status");
    host.appendChild(loading);
    return;
  }
  if (view.state === "error") {
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
    return;
  }
  view.rows.forEach((row) => {
    const line = createElement(documentRef, "div", "cd-row");
    line.appendChild(createElement(documentRef, "span", "cd-k", row[0]));
    line.appendChild(createElement(documentRef, "span", "cd-v", row[1]));
    host.appendChild(line);
  });
}

export function sourceFileRows(
  values: SourceFileRowValues,
): Array<[string, string]> {
  return [
    ["Duration", values.duration],
    ["Resolution", values.resolution],
    ["Frame rate", values.frameRate],
    ["Format", values.format],
    ["Size", values.size],
  ];
}
