export interface FrameBlendingSettings {
  enabled: boolean;
  amount: number;
  curve: string;
  sigma: number;
  peak: number;
  power: number;
  custom_weights: number[];
  linear_light: boolean;
}

export function parseCustomWeights(value: string): number[] {
  return value.trim() ? value.trim().split(/[\s,]+/).map(Number) : [];
}

// illustrative density only; Python computes actual contributions from source timestamps
export function weightPreview(settings: FrameBlendingSettings, source = 0, output = 0): number[] {
  const bins = 32;
  if (settings.amount === 0) return Array.from({length: bins}, (_, i) => i === 15 ? 1 : 0);
  let weights = settings.custom_weights;
  if (weights.length > 64) return Array(bins).fill(0);
  if (!weights.length && settings.curve === "vegas") {
    const factor = source / output * settings.amount;
    // show the characteristic curve before a source is selected
    const count = Number.isFinite(factor) && factor > 0 ? Math.min(255, Math.floor(factor)) : 4;
    weights = count <= 1 ? [1] : count % 2 ? Array(count).fill(1) : [1, ...Array(count - 1).fill(2), 1];
  }
  const values = Array.from({length: bins}, (_, i) => {
    const x = (i + .5) / bins;
    if (weights.length) {
      // average over each visual bin so narrow custom peaks stay visible
      return weights.reduce((total, weight, j) => total + weight * Math.max(0,
        Math.min((i + 1) / bins, (j + 1) / weights.length) - Math.max(i / bins, j / weights.length)), 0) * bins;
    }
    if (settings.curve === "gaussian") return Math.exp(-.5 * ((x - .5) / settings.sigma) ** 2);
    if (settings.curve === "triangular") return x < settings.peak ? x / settings.peak : (1 - x) / (1 - settings.peak);
    if (settings.curve === "ascending") return x ** settings.power;
    if (settings.curve === "descending") return (1 - x) ** settings.power;
    return 1;
  }).map(value => Number.isFinite(value) && value > 0 ? value : 0);
  const max = Math.max(...values);
  return values.map(value => max ? value / max : 0);
}

export function installFrameBlending(
  root: HTMLElement,
  changed: () => void,
  rates: () => { source: number; output: number },
) {
  const field = (id: string): HTMLInputElement => {
    const node = root.querySelector<HTMLInputElement>(`#blend-${id}`);
    if (!node) throw new Error(`Missing frame blending control: ${id}`);
    return node;
  };
  const curve = root.querySelector<HTMLSelectElement>("#blend-curve")!;
  const options = root.querySelector<HTMLFieldSetElement>("#blend-options")!;
  const rawRead = (): FrameBlendingSettings => ({
    enabled: field("enabled").checked,
    amount: field("amount").valueAsNumber,
    curve: curve.value,
    sigma: field("sigma").valueAsNumber,
    peak: field("peak").valueAsNumber,
    power: field("power").valueAsNumber,
    custom_weights: parseCustomWeights(field("weights").value),
    linear_light: field("linear").checked,
  });
  let backendError = "";
  const read = (): FrameBlendingSettings => {
    const value = rawRead();
    if (!value.enabled) {
      for (const [name, fallback] of [["amount", 1], ["sigma", .25], ["peak", .5], ["power", 1]] as const) {
        if (!Number.isFinite(value[name]) || value[name] < Number(field(name).min) || value[name] > Number(field(name).max)) value[name] = fallback;
      }
      if (value.custom_weights.length > 64 || value.custom_weights.some(w => !Number.isFinite(w) || w < 0 || w > 1000)
        || (value.custom_weights.length > 0 && !value.custom_weights.some(w => w > 0))) value.custom_weights = [];
    }
    return value;
  };
  function sync(): void {
    const value = rawRead();
    options.disabled = !value.enabled;
    for (const name of ["sigma", "peak", "power"]) {
      const active = !value.custom_weights.length && (name === "sigma" ? value.curve === "gaussian"
        : name === "peak" ? value.curve === "triangular"
        : ["ascending", "descending"].includes(value.curve));
      field(name).closest<HTMLElement>(".blend-curve-setting")!.hidden = !active;
      if (!active && !field(name).validity.valid) {
        field(name).value = String(name === "sigma" ? .25 : name === "peak" ? .5 : 1);
      }
    }
    const weights = value.custom_weights;
    const error = weights.length > 64 || weights.some(w => !Number.isFinite(w) || w < 0 || w > 1000)
      ? "Use up to 64 weights, each from 0 to 1000."
      : weights.length && !weights.some(w => w > 0) ? "Include at least one positive weight." : "";
    field("weights").setCustomValidity(error);
    const invalid = value.enabled && !Array.from(options.querySelectorAll<HTMLInputElement>("input"))
      .every(node => node.validity.valid);
    const errorNode = root.querySelector<HTMLElement>("#blend-error")!;
    errorNode.textContent = invalid ? error || "Use a value within the displayed range." : value.enabled ? backendError : "";
    errorNode.hidden = !errorNode.textContent;
    field("weights").setAttribute("aria-invalid", String(!!error));
    root.querySelector<HTMLElement>("#blend-summary")!.textContent = value.enabled
      ? `${Number.isFinite(value.amount) ? value.amount : "—"}× blur` : "Off";
    const chart = root.querySelector<SVGElement>("#blend-chart")!;
    const rate = rates();
    chart.replaceChildren(...weightPreview(value, rate.source, rate.output).map((weight, index) => {
      const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bar.setAttribute("x", String(index * 250 / 31));
      bar.setAttribute("y", String(46 - weight * 42));
      bar.setAttribute("width", "6");
      bar.setAttribute("height", String(weight * 42));
      bar.setAttribute("rx", "1");
      return bar;
    }));
    chart.setAttribute("aria-label", `Weight preview: ${value.custom_weights.length ? "custom" : value.curve}, earlier to later`);
    chart.dataset.disabled = String(!value.enabled);

  }
  function apply(raw: unknown): void {
    const data = raw && typeof raw === "object" ? raw as Partial<FrameBlendingSettings> : {};
    field("enabled").checked = data.enabled === true;
    field("linear").checked = data.linear_light === true;
    for (const [name, value] of Object.entries({amount: data.amount ?? 1, sigma: data.sigma ?? .25,
      peak: data.peak ?? .5, power: data.power ?? 1})) field(name).value = String(value);
    curve.value = data.curve ?? "equal";
    field("weights").value = Array.isArray(data.custom_weights) ? data.custom_weights.join(", ") : "";
    sync();
  }
  const valid = (): boolean => !field("enabled").checked ||
    Array.from(options.querySelectorAll<HTMLInputElement>("input")).every(node => node.validity.valid);
  const reportValidity = (): boolean => {
    if (valid()) return true;
    (root as HTMLDetailsElement).open = true;
    const advanced = root.querySelector<HTMLDetailsElement>(".blend-advanced")!;
    advanced.open = true;
    options.querySelector<HTMLInputElement>("input:invalid")?.reportValidity();
    return false;
  };
  let previous = "";
  const onEdit = () => {
    backendError = "";
    sync();
    const signature = JSON.stringify(read());
    if (signature !== previous) { previous = signature; changed(); }
  };
  root.addEventListener("input", onEdit);
  root.addEventListener("change", onEdit);
  sync();
  return { read, sync, apply, valid, reportValidity, setBackendError: (error: string) => { backendError = error; sync(); } };
}
