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
  | { mode: "custom"; width: number; height: number }
  | { mode: "custom" };

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

export function resolutionChoices(
  sourceWidth: number,
  sourceHeight: number,
): ChoiceOption[] {
  const width = Math.max(0, Math.round(Number(sourceWidth) || 0));
  const height = Math.max(0, Math.round(Number(sourceHeight) || 0));
  const shortSide = Math.min(width, height) || 1080;
  const presets = [480, 720, 1080, 1440, 2160].map(size => {
    const w = Math.max(2, Math.round(width * size / shortSide / 2) * 2);
    const h = Math.max(2, Math.round(height * size / shortSide / 2) * 2);
    return {value: `${w}x${h}`, label: `${w} × ${h}`};
  });
  return [
    { value: "source", label: `Source · ${width} × ${height}` },
    ...presets,
    { value: "custom", label: "Custom…" },
  ];
}

export function resolutionDecision(value: string | null | undefined): ResolutionDecision {
  if (value === "source") return { mode: "source" };
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
    { value: "source", label: `Source · ${fps} FPS` },
    ...[24, 30, 60, 120].map(value => ({value: String(value), label: `${value} FPS`})),
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
