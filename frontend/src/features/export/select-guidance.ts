const encoder: Readonly<Record<string, string>> = {
  auto_compression: "Choose an encoder for smaller files",
  auto_fast: "Choose the fastest available encoder",
  auto: "Choose the fastest available encoder",
  libx264: "Widely compatible playback",
  libx265: "Smaller files; needs H.265 playback support",
  h264_nvenc: "Fast H.264 encoding on an NVIDIA GPU",
  hevc_nvenc: "Fast H.265 encoding on an NVIDIA GPU",
  h264_amf: "Fast H.264 encoding on an AMD GPU",
  hevc_amf: "Fast H.265 encoding on an AMD GPU",
};

const scaler: Readonly<Record<string, string>> = {
  bilinear: "Fast resizing with softer edges",
  bicubic: "Smooth resizing with balanced detail",
  lanczos: "Sharper detail in resized frames",
  point: "Keep hard pixel edges",
  neighbor: "Nearest-neighbor sampling",
};

const speed: Readonly<Record<string, string>> = {
  fast: "Finish sooner",
  balanced: "A balance of size and speed",
  best: "Smaller files, longer encoding",
};

const sizing: Readonly<Record<string, string>> = {
  fit: "Keep the whole frame within the output dimensions; no padding",
  fill: "Fill the frame; crop edges if needed",
  stretch: "Match the output dimensions exactly",
};

const rate: Readonly<Record<string, string>> = {
  CRF: "Set quality; file size varies with the video",
  CQ: "Set quality; file size varies with the video",
  CBR: "Keep a constant target bitrate",
  VBR: "Vary bitrate with the video’s complexity",
};

export function selectGuidance(id: string, value: string): string {
  if (["enc-sel", "pe-enc"].includes(id)) return encoder[value] ?? "";
  if (["scaler-sel", "pe-scaler", "set-ds"].includes(id)) return scaler[value.toLowerCase()] ?? "";
  if (["speed-sel", "pe-speed"].includes(id)) return speed[value] ?? "";
  if (id === "pe-sizing") return sizing[value] ?? "";
  if (["rc-sel", "pe-rc"].includes(id)) return rate[value] ?? "";
  return "";
}
