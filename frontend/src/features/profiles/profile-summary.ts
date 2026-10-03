// the short lines the Export profile card shows: what a profile does, and what was changed from it

export interface ProfileFields {
  readonly workflow?: unknown;
  readonly target_size_bytes?: unknown;
  readonly resolution_mode?: unknown;
  readonly custom_width?: unknown;
  readonly custom_height?: unknown;
  readonly max_width?: unknown;
  readonly max_height?: unknown;
  readonly fps_mode?: unknown;
  readonly custom_fps?: unknown;
  readonly max_fps?: unknown;
  readonly rate_control?: unknown;
  readonly explicit_bitrate?: unknown;
  readonly explicit_bitrate_kbps?: unknown;
}

const MB = 1024 * 1024;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimmed(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function sizeLabel(profile: ProfileFields): string {
  const width = num(profile.custom_width) || num(profile.max_width);
  const height = num(profile.custom_height) || num(profile.max_height);
  if (profile.resolution_mode === "source" || !width || !height) return "";
  const names: Record<number, string> = { 2160: "4K", 1440: "1440p", 1080: "1080p", 720: "720p", 480: "480p" };
  const name = width > height && names[height] ? names[height] : `${width}×${height}`;
  return profile.resolution_mode === "limit" ? `up to ${name}` : name;
}

function fpsLabel(profile: ProfileFields): string {
  const fps = num(profile.custom_fps) || num(profile.max_fps);
  if (profile.fps_mode === "source" || !fps) return "";
  return profile.fps_mode === "limit" ? `up to ${trimmed(fps)} fps` : `${trimmed(fps)} fps`;
}

// e.g. "Target 10 MB · source size and frame rate", "Target 16 MB · 720p · 30 fps"
export function profileSummary(profile: ProfileFields, { includeTargetSize = true } = {}): string {
  const parts: string[] = [];
  const upscale = profile.workflow === "upscale";
  if (includeTargetSize && !upscale && num(profile.target_size_bytes) > 0) {
    parts.push(`Target ${trimmed(num(profile.target_size_bytes) / MB)} MB`);
  } else if (upscale && profile.rate_control === "explicit_bitrate") {
    const kbps = num(profile.explicit_bitrate_kbps) || num(profile.explicit_bitrate) / 1000;
    if (kbps) parts.push(`${trimmed(kbps / 1000)} Mbps`);
  }
  const size = sizeLabel(profile);
  const fps = fpsLabel(profile);
  if (!size && !fps) parts.push("source size and frame rate");
  else {
    parts.push(size || "source size");
    parts.push(fps || "source frame rate");
  }
  return parts.join(" · ");
}

// the settings a change can touch, in the words the card uses for them
const CHANGE_NAMES: Record<string, string> = {
  size: "target size",
  rm: "resolution",
  rw: "resolution",
  rh: "resolution",
  sc: "scaling",
  fps: "frame rate",
  blending: "frame blending",
  lut: "color LUT",
  ka: "audio",
  abr: "audio",
  tp: "encoder",
  pre: "encoder",
  enc: "encoder",
  rc: "encoder",
  q: "encoder",
  br: "encoder",
  tu: "encoder",
  aspect: "transform",
  rotation: "transform",
  sizing: "transform",
};

/**
 * Says what differs from the saved profile. A lone target size change reads
 * "Target 20 MB, was 10 MB"; anything else names up to two settings.
 */
export function profileChangeSummary(
  saved: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): string {
  const names: string[] = [];
  for (const [key, name] of Object.entries(CHANGE_NAMES)) {
    if (saved[key] !== current[key] && !names.includes(name)) names.push(name);
  }
  if (!names.length) return "";
  if (names.length === 1 && names[0] === "target size") {
    return `Target ${String(current.size)} MB, was ${String(saved.size)} MB`;
  }
  if (names.length === 1) return `Changed ${names[0]}`;
  if (names.length === 2) return `Changed ${names[0]} and ${names[1]}`;
  return `Changed ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
