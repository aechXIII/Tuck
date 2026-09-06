export type Workflow = "compression" | "upscale";
export type SpeedId = "fast" | "balanced" | "best";
export type RateControlDisplay = "CRF" | "CQ" | "CBR" | "VBR";

const ENCODER_LABELS: Readonly<Record<string, string>> = {
  auto_compression: "Auto (best compression)",
  auto_fast: "Auto (fastest available)",
  auto: "Auto (fastest available)",
  libx264: "H.264 · Software",
  libx265: "H.265 · Software",
  h264_nvenc: "NVIDIA H.264 · Hardware",
  hevc_nvenc: "NVIDIA H.265 · Hardware",
  h264_amf: "AMD H.264 · Hardware",
  hevc_amf: "AMD H.265 · Hardware",
};

const ALL_ENCODERS: readonly string[] = [
  "auto_compression",
  "auto_fast",
  "libx264",
  "libx265",
  "h264_nvenc",
  "hevc_nvenc",
  "h264_amf",
  "hevc_amf",
];

export function encoderLabel(id: string): string {
  return ENCODER_LABELS[id] ?? id;
}

export function isAutoEncoder(encoder: string): boolean {
  return encoder === "auto" || encoder === "auto_compression" || encoder === "auto_fast";
}

export function isCpuEncoder(encoder: string): boolean {
  return encoder === "libx264" || encoder === "libx265" || isAutoEncoder(encoder);
}

export function encoderIds(available: readonly string[], current: string): string[] {
  const avail = available.length ? available : ALL_ENCODERS.slice(2);
  return ALL_ENCODERS.filter(
    (id) =>
      id === "auto_compression" ||
      id === "auto_fast" ||
      avail.indexOf(id) >= 0 ||
      id === current,
  );
}

export function encoderUnavailable(available: readonly string[], id: string): boolean {
  return !isAutoEncoder(id) && available.length > 0 && available.indexOf(id) < 0;
}

export function tunesForEncoder(encoder: string): string[] {
  return encoder === "libx265"
    ? ["none", "psnr", "ssim", "grain", "zerolatency", "fastdecode", "animation"]
    : ["none", "film", "animation", "grain", "stillimage", "fastdecode", "zerolatency"];
}

export function nativePresets(encoder: string): string[] {
  if (isCpuEncoder(encoder))
    return [
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "fast",
      "medium",
      "slow",
      "slower",
      "veryslow",
    ];
  if (encoder.indexOf("nvenc") >= 0) return ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  return ["speed", "balanced", "quality"];
}

export function nativePresetForSpeed(speed: string, encoder: string): string {
  if (isCpuEncoder(encoder)) {
    const map: Record<string, string> = { fast: "veryfast", balanced: "medium", best: "slow" };
    return map[speed] ?? "medium";
  }
  if (encoder.indexOf("nvenc") >= 0) {
    const map: Record<string, string> = { fast: "p2", balanced: "p5", best: "p7" };
    return map[speed] ?? "p5";
  }
  const map: Record<string, string> = { fast: "speed", balanced: "balanced", best: "quality" };
  return map[speed] ?? "balanced";
}

export function speedForNativePreset(preset: string): SpeedId {
  if (["ultrafast", "superfast", "veryfast", "faster", "p1", "p2", "p3", "speed"].indexOf(preset) >= 0)
    return "fast";
  if (["slow", "slower", "veryslow", "p6", "p7", "quality"].indexOf(preset) >= 0) return "best";
  return "balanced";
}

export function rateControlOptions(workflow: Workflow, encoder: string): RateControlDisplay[] {
  return workflow === "upscale"
    ? isCpuEncoder(encoder)
      ? ["CRF", "CBR"]
      : ["CQ", "CBR", "VBR"]
    : isCpuEncoder(encoder)
      ? ["CBR"]
      : ["CBR", "VBR"];
}

export function defaultRateControl(workflow: Workflow, encoder: string): RateControlDisplay {
  return workflow === "upscale"
    ? isCpuEncoder(encoder)
      ? "CRF"
      : "CQ"
    : isCpuEncoder(encoder)
      ? "CBR"
      : "VBR";
}

export function twoPassEligible(workflow: Workflow, encoder: string): boolean {
  return (
    workflow === "compression" &&
    (encoder === "libx264" || encoder === "libx265" || encoder === "auto_compression")
  );
}

export function encoderDisplaySummary(encoders: readonly string[]): string {
  const labels: string[] = [];
  if (encoders.some((x) => x.indexOf("nvenc") >= 0)) labels.push("NVIDIA");
  if (encoders.some((x) => x.indexOf("amf") >= 0)) labels.push("AMD");
  if (encoders.some((x) => x.indexOf("qsv") >= 0)) labels.push("Intel");
  if (encoders.some((x) => x.indexOf("libx") === 0)) labels.push("CPU");
  return labels.join(" · ") || "None detected";
}
