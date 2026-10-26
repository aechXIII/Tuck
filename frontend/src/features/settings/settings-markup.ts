/**
 * Builders for the Settings pages. They create DOM nodes and set every value as text or as an
 * attribute, so page code can hand over paths, profile names, and other untrusted text as-is.
 */

const svg = (paths: string, viewBox = "0 0 24 24", className = "set-icon"): string =>
  `<svg class="${className}" viewBox="${viewBox}" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  compress: svg('<path d="M6.5 2v4.5H2"></path><path d="M6.5 6.5 2 2"></path><path d="M9.5 14V9.5H14"></path><path d="M9.5 9.5 14 14"></path>', "0 0 16 16"),
  upscale: svg('<path d="M2 6.5V2h4.5"></path><path d="M2 2l4.5 4.5"></path><path d="M14 9.5V14H9.5"></path><path d="M14 14 9.5 9.5"></path>', "0 0 16 16"),
  cut: svg('<circle cx="4.2" cy="12" r="2.2"></circle><circle cx="11.8" cy="12" r="2.2"></circle><path d="M5.6 10.3 11.5 2"></path><path d="M10.4 10.3 4.5 2"></path>', "0 0 16 16"),
  folder: svg('<path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7l-2-2.5H5a2 2 0 0 0-2 2.5Z"></path>'),
  refresh: svg('<path d="M19 12a7 7 0 1 1-2.1-5"></path><path d="M19 4.5v4h-4"></path>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"></path>'),
  close: svg('<path d="m7 7 10 10M17 7 7 17"></path>'),
  caret: svg('<path d="M2.5 4.5 6 8l3.5-3.5"></path>', "0 0 12 12", "set-icon set-caret"),
  reset: svg('<path d="M5 12a7 7 0 1 0 2.1-5"></path><path d="M5 4.5v4h4"></path>'),
  braces: svg('<path d="M9 4.5c-2 0-2.5 1-2.5 2.5v2.5c0 1.2-.8 2.5-2 2.5 1.2 0 2 1.3 2 2.5V17c0 1.5.5 2.5 2.5 2.5M15 4.5c2 0 2.5 1 2.5 2.5v2.5c0 1.2.8 2.5 2 2.5-1.2 0-2 1.3-2 2.5V17c0 1.5-.5 2.5-2.5 2.5"></path>'),
  warn: svg('<path d="M12 4 2.8 19.5h18.4Z"></path><path d="M12 10v4.5M12 17.3v.2"></path>'),
  check: svg('<path d="m5.5 12.5 4 4 9-9"></path>'),
  search: svg('<circle cx="11" cy="11" r="6"></circle><path d="m15.5 15.5 4 4"></path>'),
  chevron: svg('<path d="m10 7 5 5-5 5"></path>', "0 0 24 24", "set-icon set-chevron"),
  play: '<svg viewBox="0 0 16 16"><path d="M6 4.5v7l5.5-3.5Z"></path></svg>',
  logo: `<svg class="set-logo-mark" viewBox="112 119.5 800 800" aria-hidden="true"><path fill="#7d39fc" d="M392 402H246c-68.5 0-124 55.5-124 124v96c0 68.5 55.5 124 124 124h146c13.3 0 24-10.7 24-24V426c0-13.3-10.7-24-24-24Z"></path><path fill="#7d39fc" d="M632 402h146c68.5 0 124 55.5 124 124v96c0 68.5-55.5 124-124 124H632c-13.3 0-24-10.7-24-24V426c0-13.3 10.7-24 24-24Z"></path><path fill="#bfa4ff" d="M480 358h64v407c0 17.7-14.3 32-32 32s-32-14.3-32-32V358Z"></path><path fill="#bfa4ff" d="M480 242h64c17.7 0 32 14.3 32 32v64l-64 60-64-60v-64c0-17.7 14.3-32 32-32Z"></path></svg>`,
} as const;

export type IconName = keyof typeof ICONS;

export type Attributes = Readonly<Record<string, string | boolean | undefined>>;
/** what a builder can hold: nodes, plain text, nothing, or a list of those */
export type Content = Node | string | false | null | undefined | readonly Content[];

function append(parent: Node, content: Content): void {
  if (content === false || content === null || content === undefined || content === "") return;
  if (typeof content === "string") parent.appendChild(document.createTextNode(content));
  else if (content instanceof Node) parent.appendChild(content);
  else for (const item of content) append(parent, item);
}

/** An element with attributes and children; `true` sets an empty attribute, false or undefined leaves it out. */
export function h(tag: string, attributes: Attributes = {}, ...children: readonly Content[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : value);
  }
  append(element, children);
  return element;
}

export function fragment(...children: readonly Content[]): DocumentFragment {
  const node = document.createDocumentFragment();
  append(node, children);
  return node;
}

const iconSources = new Map<IconName, Element>();

export function icon(name: IconName): Node {
  let source = iconSources.get(name);
  if (!source) {
    const template = document.createElement("template");
    // only the fixed markup in ICONS is parsed here, never outside text
    template.innerHTML = ICONS[name];
    const parsed = template.content.firstElementChild;
    if (!parsed) throw new Error(`Icon ${name} has no markup`);
    source = parsed;
    iconSources.set(name, source);
  }
  return source.cloneNode(true);
}

export interface RowOptions {
  /** search anchor; matches an entry in the settings index */
  readonly setting: string;
  readonly label: string;
  /** id of the control the label names, when it is a single native control */
  readonly labelFor?: string;
  readonly description?: string;
  readonly descriptionMono?: boolean;
  /** extra description content placed after the text */
  readonly descriptionExtra?: Content;
  readonly icon?: IconName;
  readonly control: Content;
  readonly sub?: boolean;
  readonly hidden?: boolean;
}

function rowText(
  id: string,
  label: string,
  labelFor: string | undefined,
  description: string,
  descriptionExtra: Content,
  mono: boolean,
  iconName?: IconName,
  descriptionId = `${id}-desc`,
): HTMLElement {
  const name = labelFor
    ? h("label", { class: "set-label", id: `${id}-label`, for: labelFor }, label)
    : h("span", { class: "set-label", id: `${id}-label` }, label);
  const detail = description || descriptionExtra
    ? h("span", { class: `set-desc${mono ? " mono" : ""}`, id: descriptionId }, description, descriptionExtra)
    : null;
  return h("span", { class: "set-row-text" }, iconName && icon(iconName), h("span", { class: "set-row-words" }, name, detail));
}

export function row(options: RowOptions): HTMLElement {
  const id = `set-row-${options.setting}`;
  return h(
    "div",
    {
      class: `set-row${options.sub ? " sub" : ""}${options.icon ? " has-icon" : ""}`,
      "data-setting": options.setting,
      hidden: options.hidden,
    },
    rowText(id, options.label, options.labelFor, options.description ?? "", options.descriptionExtra, !!options.descriptionMono, options.icon),
    h("span", { class: "set-row-control" }, options.control),
  );
}

export interface SwitchOptions {
  readonly setting: string;
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** an id the description must keep because other code shows or hides it */
  readonly descriptionId?: string;
  readonly attributes?: Attributes;
}

/** A whole row that toggles a switch; the label names it and the description describes it. */
export function switchRow(options: SwitchOptions): HTMLElement {
  const id = `set-row-${options.setting}`;
  const descriptionId = options.descriptionId ?? `${id}-desc`;
  const described = options.description ? descriptionId : undefined;
  return h(
    "label",
    { class: `set-row toggle-row${options.icon ? " has-icon" : ""}`, "data-setting": options.setting },
    rowText(id, options.label, undefined, options.description ?? "", null, false, options.icon, descriptionId),
    h("input", {
      type: "checkbox",
      role: "switch",
      id: options.id,
      "aria-labelledby": `${id}-label`,
      "aria-describedby": described,
      checked: options.checked,
      disabled: options.disabled,
      ...options.attributes,
    }),
    h("span", { class: "toggle-track", "aria-hidden": "true" }),
  );
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly mono?: boolean;
}

/** Pill-shaped single choice built from radio inputs, so arrow keys move between options. */
export function choiceGroup(
  name: string,
  label: string,
  options: readonly ChoiceOption[],
  value: string,
  attributes: Attributes = {},
): HTMLElement {
  const items = options.map((option) =>
    h(
      "label",
      { class: "set-choice-option" },
      h("input", { type: "radio", name, value: option.value, checked: option.value === value, ...attributes }),
      h("span", { class: option.mono ? "mono" : undefined }, option.label),
    ));
  return h("span", { class: "set-choice", role: "radiogroup", "aria-label": label }, items);
}

export function select(
  id: string,
  options: readonly (readonly [string, string])[],
  value: string,
  attributes: Attributes = {},
): HTMLElement {
  const items = options.map(([optionValue, text]) => h("option", { value: optionValue, selected: optionValue === value }, text));
  return h("select", { id, class: "set-select", ...attributes }, items);
}

export interface ButtonOptions {
  readonly action: string;
  readonly value?: string;
  readonly kind?: "primary" | "quiet" | "danger";
  readonly icon?: IconName;
  readonly label?: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

export function button(text: string, options: ButtonOptions): HTMLElement {
  const kind = options.kind ? ` ${options.kind}` : "";
  return h(
    "button",
    {
      type: "button",
      class: `set-btn${kind}`,
      id: options.id,
      "data-settings-click": options.action,
      "data-settings-value": options.value,
      "aria-label": options.label,
      disabled: options.disabled,
    },
    options.icon && icon(options.icon),
    text,
  );
}

export function textInput(
  id: string,
  value: string,
  label: string,
  options: { readonly mono?: boolean; readonly width?: number; readonly unit?: string; readonly extra?: Content; readonly attributes?: Attributes } = {},
): HTMLElement {
  return h(
    "span",
    {
      class: `set-input${options.mono ? " mono" : ""}`,
      style: options.width ? `width:${Math.round(options.width)}px` : undefined,
    },
    h("input", {
      id,
      value,
      "aria-label": label,
      spellcheck: "false",
      autocomplete: "off",
      ...options.attributes,
    }),
    options.unit && h("span", { class: "set-input-unit", "aria-hidden": "true" }, options.unit),
    options.extra,
  );
}

export function card(...rows: readonly Content[]): HTMLElement {
  return h("div", { class: "set-card" }, rows);
}

export interface SectionOptions {
  readonly description?: string;
  readonly aside?: Content;
  readonly id?: string;
}

export function section(title: string, body: Content, options: SectionOptions = {}): HTMLElement {
  return h(
    "section",
    { class: "set-section", id: options.id },
    h(
      "header",
      { class: "set-section-head" },
      h("span", {}, h("h3", {}, title), options.description && h("p", { class: "set-section-desc" }, options.description)),
      options.aside && h("span", { class: "set-section-aside" }, options.aside),
    ),
    body,
  );
}

export function toolbar(...items: readonly Content[]): HTMLElement {
  return h("div", { class: "set-toolbar" }, items);
}
