import { escapeHtml as esc } from "../../ui/dom.ts";

/**
 * Builders for the Settings pages. Every value passed in is escaped here, so
 * page code can hand over paths, profile names, and other untrusted text as-is.
 */

const svg = (paths: string, viewBox = "0 0 24 24", className = "set-icon"): string =>
  `<svg class="${className}" viewBox="${viewBox}" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  compress: svg('<path d="M6.5 2v4.5H2"></path><path d="M6.5 6.5 2 2"></path><path d="M9.5 14V9.5H14"></path><path d="M9.5 9.5 14 14"></path>', "0 0 16 16"),
  upscale: svg('<path d="M2 6.5V2h4.5"></path><path d="M2 2l4.5 4.5"></path><path d="M14 9.5V14H9.5"></path><path d="M14 14 9.5 9.5"></path>', "0 0 16 16"),
  cut: svg('<circle cx="4.2" cy="12" r="2.2"></circle><circle cx="11.8" cy="12" r="2.2"></circle><path d="M5.6 10.3 11.5 2"></path><path d="M10.4 10.3 4.5 2"></path>', "0 0 16 16"),
  folder: svg('<path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7l-2-2.5H5a2 2 0 0 0-2 2.5Z"></path>'),
  refresh: svg('<path d="M19 12a7 7 0 1 1-2.1-5"></path><path d="M19 4.5v4h-4"></path>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"></path>'),
  reset: svg('<path d="M5 12a7 7 0 1 0 2.1-5"></path><path d="M5 4.5v4h4"></path>'),
  braces: svg('<path d="M9 4.5c-2 0-2.5 1-2.5 2.5v2.5c0 1.2-.8 2.5-2 2.5 1.2 0 2 1.3 2 2.5V17c0 1.5.5 2.5 2.5 2.5M15 4.5c2 0 2.5 1 2.5 2.5v2.5c0 1.2.8 2.5 2 2.5-1.2 0-2 1.3-2 2.5V17c0 1.5-.5 2.5-2.5 2.5"></path>'),
  warn: svg('<path d="M12 4 2.8 19.5h18.4Z"></path><path d="M12 10v4.5M12 17.3v.2"></path>'),
  check: svg('<path d="m5.5 12.5 4 4 9-9"></path>'),
  search: svg('<circle cx="11" cy="11" r="6"></circle><path d="m15.5 15.5 4 4"></path>'),
  chevron: svg('<path d="m10 7 5 5-5 5"></path>', "0 0 24 24", "set-icon set-chevron"),
  logo: `<svg class="set-logo-mark" viewBox="112 119.5 800 800" aria-hidden="true"><path fill="#7d39fc" d="M392 402H246c-68.5 0-124 55.5-124 124v96c0 68.5 55.5 124 124 124h146c13.3 0 24-10.7 24-24V426c0-13.3-10.7-24-24-24Z"></path><path fill="#7d39fc" d="M632 402h146c68.5 0 124 55.5 124 124v96c0 68.5-55.5 124-124 124H632c-13.3 0-24-10.7-24-24V426c0-13.3 10.7-24 24-24Z"></path><path fill="#bfa4ff" d="M480 358h64v407c0 17.7-14.3 32-32 32s-32-14.3-32-32V358Z"></path><path fill="#bfa4ff" d="M480 242h64c17.7 0 32 14.3 32 32v64l-64 60-64-60v-64c0-17.7 14.3-32 32-32Z"></path></svg>`,
} as const;

export type IconName = keyof typeof ICONS;

function attrs(values: Readonly<Record<string, string | boolean | undefined>> = {}): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join("");
}

export interface RowOptions {
  /** search anchor; matches an entry in the settings index */
  readonly setting: string;
  readonly label: string;
  /** id of the control the label names, when it is a single native control */
  readonly labelFor?: string;
  readonly description?: string;
  readonly descriptionMono?: boolean;
  /** extra description markup, already safe, placed after the text */
  readonly descriptionHtml?: string;
  readonly icon?: IconName;
  readonly control: string;
  readonly sub?: boolean;
  readonly hidden?: boolean;
}

function rowText(
  id: string,
  label: string,
  labelFor: string | undefined,
  description: string,
  descriptionHtml: string,
  mono: boolean,
  icon?: IconName,
  descriptionId = `${id}-desc`,
): string {
  const name = labelFor
    ? `<label class="set-label" id="${esc(id)}-label" for="${esc(labelFor)}">${esc(label)}</label>`
    : `<span class="set-label" id="${esc(id)}-label">${esc(label)}</span>`;
  const detail = description || descriptionHtml
    ? `<span class="set-desc${mono ? " mono" : ""}" id="${esc(descriptionId)}">${esc(description)}${descriptionHtml}</span>`
    : "";
  return `<span class="set-row-text">${icon ? ICONS[icon] : ""}<span class="set-row-words">${name}${detail}</span></span>`;
}

export function row(options: RowOptions): string {
  const id = `set-row-${options.setting}`;
  return `<div class="set-row${options.sub ? " sub" : ""}${options.icon ? " has-icon" : ""}" data-setting="${esc(options.setting)}"${options.hidden ? " hidden" : ""}>`
    + rowText(id, options.label, options.labelFor, options.description ?? "", options.descriptionHtml ?? "", !!options.descriptionMono, options.icon)
    + `<span class="set-row-control">${options.control}</span></div>`;
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
  readonly attributes?: Readonly<Record<string, string | boolean | undefined>>;
}

/** A whole row that toggles a switch; the label names it and the description describes it. */
export function switchRow(options: SwitchOptions): string {
  const id = `set-row-${options.setting}`;
  const descriptionId = options.descriptionId ?? `${id}-desc`;
  const described = options.description ? descriptionId : undefined;
  return `<label class="set-row toggle-row${options.icon ? " has-icon" : ""}" data-setting="${esc(options.setting)}">`
    + rowText(id, options.label, undefined, options.description ?? "", "", false, options.icon, descriptionId)
    + `<input type="checkbox" role="switch"${attrs({
      id: options.id,
      "aria-labelledby": `${id}-label`,
      "aria-describedby": described,
      checked: options.checked,
      disabled: options.disabled,
      ...options.attributes,
    })}><span class="toggle-track" aria-hidden="true"></span></label>`;
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
  attributes: Readonly<Record<string, string | boolean | undefined>> = {},
): string {
  const items = options.map((option) =>
    `<label class="set-choice-option"><input type="radio"${attrs({
      name,
      value: option.value,
      checked: option.value === value,
      ...attributes,
    })}><span${option.mono ? ' class="mono"' : ""}>${esc(option.label)}</span></label>`).join("");
  return `<span class="set-choice" role="radiogroup" aria-label="${esc(label)}">${items}</span>`;
}

export function select(
  id: string,
  options: readonly (readonly [string, string])[],
  value: string,
  attributes: Readonly<Record<string, string | boolean | undefined>> = {},
): string {
  const items = options
    .map(([optionValue, text]) => `<option value="${esc(optionValue)}"${optionValue === value ? " selected" : ""}>${esc(text)}</option>`)
    .join("");
  return `<select${attrs({ id, class: "set-select", ...attributes })}>${items}</select>`;
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

export function button(text: string, options: ButtonOptions): string {
  const kind = options.kind ? ` ${options.kind}` : "";
  return `<button type="button" class="set-btn${kind}"${attrs({
    id: options.id,
    "data-settings-click": options.action,
    "data-settings-value": options.value,
    "aria-label": options.label,
    disabled: options.disabled,
  })}>${options.icon ? ICONS[options.icon] : ""}${esc(text)}</button>`;
}

export function textInput(
  id: string,
  value: string,
  label: string,
  options: { readonly mono?: boolean; readonly width?: number; readonly unit?: string; readonly extra?: string; readonly attributes?: Readonly<Record<string, string | boolean | undefined>> } = {},
): string {
  const unit = options.unit ? `<span class="set-input-unit" aria-hidden="true">${esc(options.unit)}</span>` : "";
  const style = options.width ? ` style="width:${Math.round(options.width)}px"` : "";
  return `<span class="set-input${options.mono ? " mono" : ""}"${style}><input${attrs({
    id,
    value,
    "aria-label": label,
    spellcheck: "false",
    autocomplete: "off",
    ...options.attributes,
  })}>${unit}${options.extra ?? ""}</span>`;
}

export function card(...rows: readonly string[]): string {
  return `<div class="set-card">${rows.join("")}</div>`;
}

export interface SectionOptions {
  readonly description?: string;
  readonly aside?: string;
  readonly id?: string;
}

export function section(title: string, body: string, options: SectionOptions = {}): string {
  const description = options.description ? `<p class="set-section-desc">${esc(options.description)}</p>` : "";
  const aside = options.aside ? `<span class="set-section-aside">${options.aside}</span>` : "";
  return `<section class="set-section"${attrs({ id: options.id })}><header class="set-section-head"><span><h3>${esc(title)}</h3>${description}</span>${aside}</header>${body}</section>`;
}

export function toolbar(...items: readonly string[]): string {
  return `<div class="set-toolbar">${items.join("")}</div>`;
}
