"""Save as GIF: the timeline's picture written as an animated GIF with a palette made for it."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from ..models import EncodePlan, OutputGeometry, Segment, calculate_transform_geometry
from ..models.gif import DITHER_OFF, DITHER_PATTERN, PALETTE_FRAME, GifSettings
from .command import placed_source_video_graph
from .filters import build_plan_video_filters, join_video_filters

# when a size limit is set: lower the frame rate through these first, then the width
LIMIT_FRAME_RATES = (24.0, 20.0, 15.0, 12.0, 10.0)
LIMIT_WIDTH_STEP = 0.9
LIMIT_MIN_WIDTH = 160
# measured on game recordings: a GIF's size follows its frame rate and a little less than its
# picture's area, so a lowered setting is tried only once it is predicted to fit
_AREA_POWER = 0.85
_PREDICT_MARGIN = 0.97

# runs one FFmpeg command whose output plays for the given number of seconds
RunCommand = Callable[[list[str], float], None]


@dataclass(frozen=True)
class GifResult:
    path: Path
    size: int
    width: int
    height: int
    fps: float
    frames: int
    # a size limit lowered the frame rate or the width
    lowered: bool
    # False when even the smallest setting stays over the size limit
    fits: bool


def _even(value: float) -> int:
    return max(2, round(value / 2) * 2)


def gif_dimensions(plan: EncodePlan, width: int) -> tuple[int, int]:
    """The GIF's size: its width, and the height that keeps the export's picture shape."""
    base_width, base_height = plan.target_width, plan.target_height
    if base_width <= 0 or base_height <= 0:
        raise ValueError("The video's size is unknown")
    width = _even(min(width, base_width))
    return width, _even(width * base_height / base_width)


def gif_picture_filters(plan: EncodePlan, width: int, height: int, *, sharp: bool) -> list[str]:
    """Crop, rotation, flips, sizing, HDR and LUT as an export does them, scaled to the GIF."""
    if plan.source_info is None:
        raise ValueError("The video has not been read yet")
    transform = replace(plan.transform, output=OutputGeometry(width, height))
    geometry = calculate_transform_geometry(
        transform, plan.source_info.width, plan.source_info.height
    )
    sized = replace(
        plan,
        transform=transform,
        target_width=width,
        target_height=height,
        apply_scale=True,
        apply_fps_filter=False,
        scaler="nearest" if sharp else "lanczos",
    )
    return build_plan_video_filters(sized, geometry=geometry)


def _loop_value(plays: int) -> str:
    # GIF counts the plays after the first, and -1 asks for no repeat at all
    if plays == 0:
        return "0"
    if plays == 1:
        return "-1"
    return str(plays - 1)


def gif_output_seconds(plan: EncodePlan, settings: GifSettings) -> float:
    seconds = plan.effective_duration / settings.speed
    return seconds * 2 if settings.back_and_forth else seconds


def build_gif_command(
    ffmpeg: str,
    plan: EncodePlan,
    settings: GifSettings,
    output: Path,
    *,
    width: int,
    fps: float,
) -> list[str]:
    width, height = gif_dimensions(plan, width)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:2"]
    parts: list[str] = []
    segments = plan.effective_segments
    if not segments:
        raise ValueError("The timeline is empty")
    # sampled on the GIF's own clock, before the speed change
    source_rate = fps * settings.speed
    if segments[0].timeline_start is not None:
        # gaps stay in the GIF as black, as they do in a video export
        cmd += ["-i", plan.source]
        parts.extend(placed_source_video_graph(plan, [], source_rate))
        joined = "[vout]"
    else:
        # each segment is its own input, so FFmpeg seeks to it instead of decoding up to it
        for index, segment in enumerate(segments):
            cmd += ["-ss", f"{segment.start:.6f}", "-t", f"{segment.duration:.6f}"]
            cmd += ["-i", plan.source]
            parts.append(f"[{index}:v]setpts=PTS-STARTPTS[seg{index}]")
        if len(segments) > 1:
            parts.append(
                "".join(f"[seg{i}]" for i in range(len(segments)))
                + f"concat=n={len(segments)}:v=1:a=0[joined]"
            )
            joined = "[joined]"
        else:
            joined = "[seg0]"

    chain: list[str] = []
    if settings.speed != 1:
        chain.append(f"setpts=PTS/{settings.speed:g}")
    # the frame rate first, so only the frames the GIF keeps are cropped and scaled
    chain.append(f"fps={fps:g}")
    chain.extend(gif_picture_filters(plan, width, height, sharp=settings.sharp_pixels))
    if settings.drop_repeated_frames:
        chain.append("mpdecimate")
    parts.append(f"{joined}{join_video_filters(chain)}[picture]")
    picture = "[picture]"
    if settings.back_and_forth:
        parts.append(f"{picture}split[forward][backward]")
        parts.append("[backward]reverse[reversed]")
        parts.append("[forward][reversed]concat=n=2:v=1:a=0[bounced]")
        picture = "[bounced]"

    per_frame = settings.palette == PALETTE_FRAME
    stats = "single" if per_frame else "diff"
    if settings.dither == DITHER_PATTERN:
        dither = "bayer"
    elif settings.dither == DITHER_OFF:
        dither = "none"
    else:
        dither = "sierra2_4a"
    parts.append(f"{picture}split[frames][counted]")
    parts.append(f"[counted]palettegen=max_colors={settings.colors}:stats_mode={stats}[palette]")
    parts.append(
        f"[frames][palette]paletteuse=dither={dither}:diff_mode=rectangle"
        + (":new=1" if per_frame else "")
        + "[gif]"
    )
    cmd += ["-filter_complex", ";".join(parts), "-map", "[gif]", "-an"]
    cmd += ["-loop", _loop_value(settings.plays), "-f", "gif", "-y", str(output)]
    return cmd


def read_gif_frames(path: Path) -> tuple[int, int, int]:
    """Width, height and frame count of a GIF file, read from its blocks."""
    data = path.read_bytes()
    if len(data) < 13 or data[:6] not in (b"GIF87a", b"GIF89a"):
        raise ValueError("Not a GIF file")
    width = int.from_bytes(data[6:8], "little")
    height = int.from_bytes(data[8:10], "little")
    position = 13
    if data[10] & 0x80:
        position += 3 * (2 << (data[10] & 0x07))
    frames = 0

    def skip_sub_blocks(at: int) -> int:
        while at < len(data):
            size = data[at]
            at += 1
            if size == 0:
                return at
            at += size
        raise ValueError("The GIF ends early")

    while position < len(data):
        block = data[position]
        if block == 0x3B:
            break
        if block == 0x21:
            position = skip_sub_blocks(position + 2)
        elif block == 0x2C:
            frames += 1
            flags = data[position + 9]
            position += 10
            if flags & 0x80:
                position += 3 * (2 << (flags & 0x07))
            position = skip_sub_blocks(position + 1)
        else:
            raise ValueError("The GIF has an unknown block")
    return width, height, frames


def _limit_steps(fps: float, width: int, height_ratio: float) -> list[tuple[float, int]]:
    steps = [(rate, width) for rate in LIMIT_FRAME_RATES if rate < fps]
    rate = steps[-1][0] if steps else fps
    step_width = width
    while True:
        step_width = _even(step_width * LIMIT_WIDTH_STEP)
        if step_width < LIMIT_MIN_WIDTH or step_width * height_ratio < 2:
            break
        steps.append((rate, step_width))
    return steps


def make_gif(
    ffmpeg: str,
    plan: EncodePlan,
    output: Path,
    run: RunCommand,
    *,
    size_scale: float = 1.0,
) -> GifResult:
    """Writes the plan's GIF to `output`, lowering its settings until it meets the size limit.

    `size_scale` turns the file's size into the size it stands for, when the plan is a few
    pieces of a longer timeline.
    """
    settings = plan.gif
    if settings is None:
        raise ValueError("This export isn't a GIF")
    seconds = gif_output_seconds(plan, settings)
    height_ratio = plan.target_height / plan.target_width if plan.target_width else 0.0
    start_width, _ = gif_dimensions(plan, settings.width)
    steps = [(settings.fps, start_width), *_limit_steps(settings.fps, start_width, height_ratio)]
    # each step writes its own file, so the best one that fits is kept without making it again
    made: dict[int, tuple[Path, int]] = {}

    def attempt(index: int) -> int:
        rate, width = steps[index]
        path = output.with_name(f"{output.stem}.step{index}{output.suffix}")
        run(build_gif_command(ffmpeg, plan, settings, path, width=width, fps=rate), seconds)
        size = round(path.stat().st_size * size_scale)
        made[index] = (path, size)
        return size

    limit = settings.size_limit
    try:
        best = 0
        if limit and attempt(0) > limit:
            best = -1
            measured = 0
            for index in range(1, len(steps)):
                rate, width = steps[index]
                base_rate, base_width = steps[measured]
                area = width * _even(width * height_ratio)
                base_area = base_width * _even(base_width * height_ratio)
                predicted = (
                    made[measured][1] * (rate / base_rate) * (area / base_area) ** _AREA_POWER
                )
                if predicted > limit * _PREDICT_MARGIN:
                    continue
                if attempt(index) <= limit:
                    best = index
                    break
                measured = index
            if best < 0:
                # nothing fits: the smallest setting is the closest it gets
                best = len(steps) - 1
                if best not in made:
                    attempt(best)
            else:
                # the prediction can be too careful, so a bigger step it skipped may fit as well
                bigger = best - 1
                while bigger > 0 and bigger not in made and made[best][1] < limit * 0.9:
                    if attempt(bigger) > limit:
                        break
                    best = bigger
                    bigger -= 1
        elif not limit:
            attempt(0)
        path, size = made[best]
        path.replace(output)
    finally:
        for path, _ in made.values():
            path.unlink(missing_ok=True)
    fps, width = steps[best]
    _, height = gif_dimensions(plan, width)
    _, _, frames = read_gif_frames(output)
    return GifResult(
        path=output,
        size=size,
        width=width,
        height=height,
        fps=fps,
        frames=frames,
        lowered=best > 0,
        fits=not limit or size <= limit,
    )


def preview_plan(
    plan: EncodePlan, *, longest: float, pieces: list[Segment]
) -> tuple[EncodePlan, float]:
    """A timeline over `longest` seconds is previewed from a few pieces, which say its size."""
    if plan.effective_duration <= longest or not pieces:
        return plan, 1.0
    sampled = sum(piece.duration for piece in pieces)
    if sampled <= 0 or not math.isfinite(sampled):
        return plan, 1.0
    return replace(plan, segments=list(pieces)), plan.effective_duration / sampled
