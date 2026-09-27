import type { CutPlanPreview } from "../../backend/cutting-types.ts";
import { mediaSeconds } from "../export/cut-state.ts";
import { normalizeSegments, segmentsForClip, SegmentTooShortError, type ClipSegmentSource, type SegmentRange } from "./segments.ts";

export type MovedStarts =
  | { ok: true; segments: SegmentRange[] }
  | { ok: false; message: string };

// the clip's segments with each start moved to where its lossless cut really begins
export function segmentsAtExportedStarts(
  clip: ClipSegmentSource,
  plan: CutPlanPreview,
  duration: number,
): MovedStarts {
  try {
    const segments = segmentsForClip(clip, duration).map((segment, index) => {
      const planned = plan.segments[index];
      if (!planned) throw new Error("the cut plan does not match the timeline");
      return { ...segment, start: mediaSeconds(planned.resolved.start) };
    });
    return { ok: true, segments: normalizeSegments(segments, duration) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof SegmentTooShortError
        ? "A moved segment would be too short for the timeline. You can still export these cuts as shown, or widen the segment first."
        : "The cut points could not be moved. Your timeline is unchanged.",
    };
  }
}
