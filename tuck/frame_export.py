from __future__ import annotations

import math
import os
import subprocess
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from time import monotonic

import av

from .bridge_contract import JsonValue
from .bridge_validation import validate_path
from .encoding.filters import build_plan_video_filters, join_video_filters
from .lut import snapshot_lut
from .media_tools import find_ffmpeg, media_tool_environment
from .models import EncodePlan, TransformGeometry, VideoTransform
from .models.lut import LutSettings
from .models.transforms import oriented_dimensions
from .output_transaction import OutputTransaction
from .planner import plan_colors
from .probe import probe
from .request_work import RequestWork


@dataclass(frozen=True)
class FrameRequest:
    source: Path
    output: Path
    time: float
    transform: VideoTransform
    lut: LutSettings


def _parse_request(raw: object) -> FrameRequest:
    if not isinstance(raw, dict) or raw.keys() - {"source", "output", "time", "transform", "lut"}:
        raise ValueError("Frame request must be an object with supported fields")
    source = raw.get("source")
    if not isinstance(source, str):
        raise ValueError("Choose a source video before saving a frame")
    source_path = Path(validate_path(source))
    output = raw.get("output")
    if not isinstance(output, str) or not output:
        raise ValueError("Choose a PNG file to save the frame")
    output_path = Path(output)
    if not output_path.is_absolute() or output_path.suffix.lower() != ".png":
        raise ValueError("The frame destination must be an absolute PNG file path")
    if output_path.resolve() == source_path:
        raise ValueError("Save the frame to a different file from the source video")
    time = raw.get("time")
    if isinstance(time, bool) or not isinstance(time, (int, float)):
        raise ValueError("Frame time must be a finite number at or after zero")
    try:
        parsed_time = float(time)
    except OverflowError:
        raise ValueError("Frame time must be a finite number at or after zero") from None
    if not math.isfinite(parsed_time) or parsed_time < 0:
        raise ValueError("Frame time must be a finite number at or after zero")
    transform = raw.get("transform", {})
    if not isinstance(transform, dict):
        raise ValueError("Frame transform must be an object")
    parsed_transform = VideoTransform.from_dict(transform)
    if parsed_transform.output is not None:
        raise ValueError("Frame export uses source resolution; remove transform output sizing")
    return FrameRequest(
        source_path,
        output_path,
        parsed_time,
        parsed_transform,
        LutSettings.from_dict(raw.get("lut", {})),
    )


def _check_work(work: RequestWork) -> None:
    if work.is_set():
        raise RuntimeError("Saving the frame was cancelled")
    if work.expired:
        raise TimeoutError("Saving the frame timed out. Try again")


def _select_frame(
    source: Path, time: float, duration: float, work: RequestWork
) -> tuple[float, float]:
    with av.open(str(source), timeout=max(0.1, work.deadline - monotonic())) as container:
        if not container.streams.video:
            raise ValueError("The source does not contain a video")
        stream = container.streams.video[0]
        base = stream.time_base
        if base is None:
            raise ValueError("The source video has no frame timestamps")
        start = stream.start_time or 0
        end = float((start + stream.duration) * base) if stream.duration else duration
        if time > end + 1e-6:
            raise ValueError("Frame time is past the end of the source video")
        # leave one tick before the playhead so a keyframe just after it cannot hide
        # the preceding displayed picture
        seek = max(start, math.floor(Fraction(str(time)) / base) - 1)
        container.seek(seek, stream=stream, backward=True, any_frame=False)
        selected: float | None = None
        for packet in container.demux(stream):
            _check_work(work)
            for frame in packet.decode():
                if frame.pts is None:
                    raise ValueError("The source video has a picture without a timestamp")
                pts = float(frame.pts * base)
                if selected is None or pts <= time + 1e-9:
                    selected = pts
                if pts > time + 1e-9:
                    return selected, float(base)
        if selected is None:
            raise ValueError("No picture could be decoded from the source video")
        return selected, float(base)


def _run_ffmpeg(command: list[str], work: RequestWork) -> None:
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            command,
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=errors,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            while process.poll() is None:
                _check_work(work)
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    continue
            _check_work(work)
            if process.returncode:
                errors.seek(max(0, errors.tell() - 8192))
                detail = errors.read(8192).decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"Could not save the frame. {detail}")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def _verify_png(path: Path) -> tuple[int, int]:
    if not path.is_file():
        raise RuntimeError("The source frame could not be saved")
    with path.open("rb") as data:
        if data.read(8) != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError("The saved frame is not a PNG image")
    with av.open(str(path), timeout=10) as container:
        for frame in container.decode(video=0):
            if frame.width > 0 and frame.height > 0:
                return frame.width, frame.height
    raise RuntimeError("The saved PNG image could not be decoded")


def export_frame(raw: object, *, work: RequestWork | None = None) -> dict[str, JsonValue]:
    current = work or RequestWork()
    _check_work(current)
    request = _parse_request(raw)
    info = probe(request.source)
    request.transform.validate_for_source(info.width, info.height)
    _check_work(current)
    pts, tick = _select_frame(request.source, request.time, info.duration, current)
    tone_map, warnings = plan_colors(info)
    plan = EncodePlan(
        source=str(request.source),
        output=str(request.output),
        source_info=info,
        transform=request.transform,
        lut=request.lut,
        lut_filter_path=snapshot_lut(request.lut, info),
        tone_map_hdr=tone_map,
    )
    # keep the original pixels through HDR conversion; seeking an RGB preview first
    # would already have clipped the source highlights
    width, height = oriented_dimensions(request.transform, info.width, info.height)
    crop = request.transform.crop
    geometry = TransformGeometry(
        crop.width if crop else info.width,
        crop.height if crop else info.height,
        width,
        height,
        None,
        width,
        height,
    )
    filters = [
        f"select=gte(t\\,{pts - tick / 2:.12f})",
        *build_plan_video_filters(plan, geometry=geometry),
    ]
    if info.sample_aspect_ratio not in {"", "0:1", "1:1", "0/1", "1/1"}:
        # PNG readers generally ignore pixel aspect, so bake the displayed shape into
        # square pixels after orientation and edits have updated the aspect ratio
        filters.extend(["scale='round(iw*max(sar,1))':'round(ih/min(sar,1))'", "setsar=1"])
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise FileNotFoundError("FFmpeg was not found. Check the media tools in Settings")
    with OutputTransaction(request.output, replace=True) as transaction:
        partial = transaction.workspace / "frame.png"
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-copyts",
            # timestamp selection below owns the discard; FFmpeg's accurate seek
            # otherwise drops valid pictures from sources with a nonzero start
            "-noaccurate_seek",
            "-seek_timestamp",
            "1",
            "-ss",
            f"{max(0.0, pts - 1.0):.12f}",
            "-i",
            str(request.source),
            "-map",
            "0:v:0",
            "-vf",
            join_video_filters(filters),
            "-frames:v",
            "1",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "png",
            "-pix_fmt",
            "rgb24",
            "-update",
            "1",
            str(partial),
        ]
        _run_ffmpeg(command, current)
        width, height = _verify_png(partial)
        _check_work(current)
        published = transaction.publish(partial)
    return {
        "ok": True,
        "path": str(published),
        "width": width,
        "height": height,
        "time": pts,
        "warnings": warnings,
    }
