import {
  defaultRateControl,
  encoderIds,
  encoderLabel,
  encoderUnavailable,
  nativePresetForSpeed,
  nativePresets,
  rateControlOptions,
  tunesForEncoder,
  type Workflow,
} from "./encoder-options.ts";

function option(value: string, label: string, disabled = false): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  if (disabled) element.disabled = true;
  return element;
}

export function populateEncoderSelect(
  select: HTMLSelectElement,
  available: readonly string[],
): void {
  let current = select.value || "auto_compression";
  const ids = encoderIds(available, current);
  select.replaceChildren();
  for (const id of ids) {
    const unavailable = encoderUnavailable(available, id);
    select.appendChild(
      option(id, encoderLabel(id) + (unavailable ? " (unavailable)" : ""), unavailable),
    );
  }
  if (!select.options.length) select.appendChild(option("libx264", encoderLabel("libx264")));
  if (ids.indexOf(current) < 0) current = ids[0] ?? "libx264";
  select.value = current;
}

export function populatePresetSelect(
  select: HTMLSelectElement,
  encoder: string,
  speed: string,
): void {
  const current = select.value;
  const presets = nativePresets(encoder);
  select.replaceChildren();
  for (const preset of presets) select.appendChild(option(preset, preset));
  select.value =
    presets.indexOf(current) >= 0 ? current : nativePresetForSpeed(speed || "balanced", encoder);
}

export function populateTuneSelect(select: HTMLSelectElement, encoder: string): void {
  const current = select.value;
  const tunes = tunesForEncoder(encoder);
  select.replaceChildren();
  for (const tune of tunes) select.appendChild(option(tune, tune));
  select.value = tunes.indexOf(current) >= 0 ? current : "none";
}

export function populateRateControlSelect(
  select: HTMLSelectElement,
  workflow: Workflow,
  encoder: string,
): void {
  const current = select.value;
  const options = rateControlOptions(workflow, encoder);
  select.replaceChildren();
  for (const value of options) select.appendChild(option(value, value));
  select.value =
    (options as string[]).indexOf(current) >= 0
      ? current
      : defaultRateControl(workflow, encoder);
}
