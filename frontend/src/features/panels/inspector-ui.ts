export interface InspectorAudioState {
  audioEnabled?: boolean;
  keepAudio?: boolean;
  audioBitrateKbps?: number;
}

export interface InspectorEncoderState {
  videoEncoder?: string;
  speed?: string;
}

export interface InspectorExportState extends InspectorAudioState, InspectorEncoderState {
  workflow?: string;
  targetSizeMb?: number;
  width?: number;
  height?: number;
  fps?: number;
}

export interface ChoiceOption {
  value: string;
  label: string;
}

export type ResolutionDecision =
  | { mode: "source" }
  | { mode: "short_side"; shortSide: number }
  | { mode: "custom"; width: number; height: number }
  | { mode: "custom" };

export interface ResolutionState {
  mode: string;
  shortSide: number;
  width: number;
  height: number;
}

// the presets size the shorter side, so a vertical video stays vertical
const SHORT_SIDES = [480, 720, 1080, 1440, 2160];

// stored scaler names; Python reads older names as one of these two
export const SCALING_CHOICES: readonly ChoiceOption[] = [
  { value: "lanczos", label: "Smooth" },
  { value: "neighbor", label: "Sharp pixels" },
];

export const SCALING_NOTE =
  "Smooth keeps detail when the size changes. Sharp pixels keeps hard edges, for pixel-art games.";

export function scalingChoice(value: unknown): string {
  return value === "neighbor" ? "neighbor" : "lanczos";
}

function videoCodec(encoder: string | null | undefined): string {
  const id = String(encoder || "").toLowerCase();
  if (id.indexOf("265") >= 0 || id.indexOf("hevc") >= 0) return "H.265";
  if (id.indexOf("av1") >= 0) return "AV1";
  if (id.indexOf("vp9") >= 0) return "VP9";
  return "H.264";
}

export function audioSummary(state: InspectorAudioState): string {
  if (state.audioEnabled === false) return "No audio";
  if (state.keepAudio) return "Copy when possible";
  const audio = Math.max(0, Math.round(Number(state.audioBitrateKbps) || 0));
  return audio ? "AAC " + audio + "k" : "No audio";
}

export function encoderSummary(state: InspectorEncoderState): string {
  const speeds: Record<string, string> = {
    fast: "Fast",
    balanced: "Balanced",
    best: "Best compression",
  };
  return videoCodec(state.videoEncoder) + " · " + (speeds[state.speed ?? ""] || "Balanced");
}

export function encoderPanelSummary(state: InspectorEncoderState): string {
  const id = String(state.videoEncoder || "").toLowerCase();
  let family = videoCodec(id);
  if (id.indexOf("nvenc") >= 0) family = "NVENC";
  else if (id.indexOf("qsv") >= 0) family = "Quick Sync";
  else if (id.indexOf("amf") >= 0) family = "AMF";
  else if (id.indexOf("videotoolbox") >= 0) family = "VideoToolbox";
  const speeds: Record<string, string> = {
    fast: "Fast",
    balanced: "Balanced",
    best: "Best compression",
  };
  return family + " · " + (speeds[state.speed ?? ""] || "Balanced");
}

export function exportSummary(state: InspectorExportState): {
  title: string;
  detail: string;
} {
  const width = Math.max(0, Math.round(Number(state.width) || 0));
  const height = Math.max(0, Math.round(Number(state.height) || 0));
  const fps = Math.max(0, Number(Number(state.fps || 0).toFixed(3)));
  return {
    title:
      state.workflow === "upscale"
        ? "Upscale output"
        : Math.max(0, Math.round(Number(state.targetSizeMb) || 0)) + " MB",
    detail:
      width +
      "×" +
      height +
      " · " +
      fps +
      " fps · " +
      videoCodec(state.videoEncoder) +
      " · " +
      audioSummary(state),
  };
}

export function sizePresets(): number[] {
  return [20, 50, 200, 500];
}

// the video scaled so its shorter side is shortSide, in even numbers; the planner rounds the same way
export function shortSideSize(
  sourceWidth: number,
  sourceHeight: number,
  shortSide: number,
): { width: number; height: number } {
  const width = Math.max(0, Math.round(Number(sourceWidth) || 0));
  const height = Math.max(0, Math.round(Number(sourceHeight) || 0));
  const shorter = Math.min(width, height) || 1080;
  return {
    width: Math.max(2, Math.round(width * shortSide / shorter / 2) * 2),
    height: Math.max(2, Math.round(height * shortSide / shorter / 2) * 2),
  };
}

export function resolutionChoices(
  sourceWidth: number,
  sourceHeight: number,
): ChoiceOption[] {
  const width = Math.max(0, Math.round(Number(sourceWidth) || 0));
  const height = Math.max(0, Math.round(Number(sourceHeight) || 0));
  const presets = SHORT_SIDES.map(size => {
    const output = shortSideSize(width, height, size);
    return {value: `${size}p`, label: `${output.width} × ${output.height}`};
  });
  return [
    { value: "source", label: `Source · ${width} × ${height}` },
    ...presets,
    { value: "custom", label: "Custom…" },
  ];
}

// the menu entry for the current resolution; a custom size that matches a preset shows as it
export function resolutionChoiceValue(
  sourceWidth: number,
  sourceHeight: number,
  state: ResolutionState,
): string {
  if (state.mode === "source") return "source";
  if (state.mode === "short_side") {
    return SHORT_SIDES.includes(state.shortSide) ? `${state.shortSide}p` : "custom";
  }
  const preset = SHORT_SIDES.find(size => {
    const output = shortSideSize(sourceWidth, sourceHeight, size);
    return output.width === state.width && output.height === state.height;
  });
  return preset === undefined ? "custom" : `${preset}p`;
}

export function resolutionDecision(value: string | null | undefined): ResolutionDecision {
  if (value === "source") return { mode: "source" };
  const preset = /^(\d+)p$/.exec(String(value || ""));
  if (preset?.[1]) return { mode: "short_side", shortSide: Number(preset[1]) };
  const match = /^(\d+)x(\d+)$/.exec(String(value || ""));
  if (!match) return { mode: "custom" };
  const widthRaw = match[1];
  const heightRaw = match[2];
  if (widthRaw === undefined || heightRaw === undefined) return { mode: "custom" };
  return {
    mode: "custom",
    width: Number(widthRaw),
    height: Number(heightRaw),
  };
}

export function frameRateChoices(sourceFps: number): ChoiceOption[] {
  const fps = Math.max(0.1, Math.round((Number(sourceFps) || 30) * 1000) / 1000);
  return [
    { value: "source", label: `Source · ${fps} fps` },
    ...[24, 30, 60, 120].map(value => ({value: String(value), label: `${value} fps`})),
    { value: "custom", label: "Custom…" },
  ];
}

export function startupTab(
  preference: string | null | undefined,
  lastPanel: string | null | undefined,
): string {
  if (preference === "video") return "edit";
  if (preference === "audio" || preference === "export") return preference;
  if (preference === "last") {
    if (lastPanel === "video") return "edit";
    if (lastPanel === "audio" || lastPanel === "export") return lastPanel;
  }
  return "export";
}
