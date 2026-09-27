from __future__ import annotations

import hashlib
import time
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from threading import Event

import av
from av import logging as av_logging
from av.container import InputContainer
from av.error import FFmpegError

from ..media_tools import find_ffprobe
from ..models.cutting import CutAnalysis, CutPlan
from .analysis import CutAnalysisError, read_inventory
from .exact import ExactEdges, verify_exact_frames
from .packets import check_cut_cancel, prepare_cut, selected_packets, validate_cut_source
from .timeline import MAX_PACKET_BYTES, MAX_PACKETS

MAX_BOUNDARY_FRAMES = 24_000
MAX_BOUNDARY_SECONDS = 120
MAX_FRAME_PIXELS = 33_554_432


@dataclass(frozen=True)
class CutVerification:
    video_packets: int
    audio_packets: int
    boundary_frames: int


def _failed(message: str) -> CutAnalysisError:
    return CutAnalysisError("verification_failed", f"The cut could not be verified: {message}")


# tags the muxer writes for the new file; they describe the output, not the source
GENERATED_TAGS = {
    "encoder",
    "major_brand",
    "minor_version",
    "compatible_brands",
    "creation_time",
    "duration",
    "number_of_frames",
    "number_of_bytes",
    "bps",
}


# AVI always names the muxer that wrote the file here
_GENERATED_BY_FORMAT = {"avi": {"software"}}


def is_generated_tag(key: str, format_name: str = "") -> bool:
    lower = key.lower()
    return (
        lower in GENERATED_TAGS
        or lower in _GENERATED_BY_FORMAT.get(format_name, set())
        or lower.startswith("_statistics")
    )


def plan_frame_tolerance(plan: CutPlan, analysis: CutAnalysis) -> Fraction:
    """Containers without stored frame durations may count the last frame as zero long."""
    if analysis.format_name.split(",")[0] in {"mov", "mp4"}:
        return Fraction(0)
    return analysis.frame_duration.seconds


def kept_indices(plan: CutPlan, analysis: CutAnalysis) -> list[int]:
    """Source stream indices in the order they are written to the output."""
    kept = {analysis.video_index} | {t.index for t in plan.tracks if t.keep}
    return [s.index for s in analysis.streams if s.index in kept]


def _verify_streams(
    plan: CutPlan,
    output: Path,
    cancel: Event,
    analysis: CutAnalysis,
    ffprobe: str,
    video_extradata: bytes | None = None,
) -> None:
    actual, _ = read_inventory(output, cancel, ffprobe, limits=False)
    order = kept_indices(plan, analysis)
    by_index = {s.index: s for s in analysis.streams}
    expected = [by_index[i] for i in order]
    if len(actual) != len(expected):
        raise _failed("the output streams do not match the source.")
    properties = (
        "profile",
        "codec_tag_string",
        "width",
        "height",
        "pix_fmt",
        "level",
        "color_range",
        "color_space",
        "color_transfer",
        "color_primaries",
        "chroma_location",
        "sample_aspect_ratio",
        "field_order",
        "sample_rate",
        "channels",
        "channel_layout",
        "time_base",
    )
    for source, target in zip(expected, actual, strict=True):
        source_properties, target_properties = dict(source.properties), dict(target.properties)
        if (
            source.kind != target.kind
            or source.codec != target.codec
            or source.dispositions != target.dispositions
            or any(
                source_properties.get(key) != target_properties.get(key)
                for key in properties
                # MP4 stores audio in its sample-rate time base; the packet check below
                # still compares every audio timestamp exactly
                if not (key == "time_base" and source.kind == "audio")
            )
            or any(
                dict(target.metadata).get(key) != value
                for key, value in source.metadata
                if not is_generated_tag(key)
            )
        ):
            raise _failed("the output stream properties or metadata changed.")
    with av.open(plan.identity.path) as incoming, av.open(str(output)) as outgoing:
        selected = [incoming.streams[i] for i in order]
        for source, target in zip(selected, outgoing.streams, strict=True):
            wanted = source.codec_context.extradata if source.codec_context else None
            if source.index == analysis.video_index and video_extradata is not None:
                wanted = video_extradata
            found = target.codec_context.extradata if target.codec_context else None
            if (wanted or b"") != (found or b""):
                raise _failed("the codec configuration changed.")
        if any(
            outgoing.metadata.get(key) != value
            for key, value in incoming.metadata.items()
            if not is_generated_tag(key, plan.container)
        ):
            raise _failed("the output metadata changed.")
        video = outgoing.streams.video[0]
        exported = plan.exported_duration.seconds
        if video.time_base is None:
            raise _failed("the video has no time base.")
        base = Fraction(video.time_base)
        if video.duration is not None:
            stored = video.duration * base
        else:
            # Matroska and MPEG-TS state no per-track duration; measure the video itself
            stored = max(
                (
                    (p.pts + (p.duration or 0)) * base
                    for p in outgoing.demux(video)
                    if p.size and p.pts is not None
                ),
                default=Fraction(0),
            )
            stored -= (video.start_time or 0) * base
        # the stored duration is exact unless the container rounds its timestamps
        if abs(stored - exported) >= max(base, plan_frame_tolerance(plan, analysis)):
            raise _failed("the video duration changed.")


def _packet_identity(packet: av.Packet, base: Fraction) -> tuple:
    """Timing in `base` ticks plus content, so a rounded container time base still matches."""
    if (
        packet.pts is None
        or packet.time_base is None
        or packet.is_corrupt
        or packet.size > MAX_PACKET_BYTES
    ):
        raise _failed("a packet has invalid timing or data.")
    own = Fraction(packet.time_base)

    def ticks(value: int | None) -> int | None:
        return None if value is None else _round(value * own / base)

    # a video frame's stored duration comes from the container (MP4 derives it from decode
    # times), so frames are identified by time and content; other tracks keep their durations
    return (
        ticks(packet.pts),
        None if packet.stream.type == "video" else ticks(packet.duration or None),
        packet.is_keyframe,
        bytes(packet.get_sidedata("skip_samples")),
        hashlib.sha256(bytes(packet)).digest(),
    )


def _round(value: Fraction) -> int:
    return int(value + (Fraction(1, 2) if value >= 0 else Fraction(-1, 2)))


def _verify_packets(
    plan: CutPlan,
    output: Path,
    analysis: CutAnalysis,
    cancel: Event,
    edges: ExactEdges | None = None,
) -> tuple[dict[str, int], Fraction]:
    """Every output packet is the planned packet, in order, stream by stream.

    Returns packet counts per kind and the constant start delay the muxer added.
    """
    order = kept_indices(plan, analysis)
    expected: dict[int, list[tuple]] = {i: [] for i in order}
    counts: dict[str, int] = {}
    with av.open(plan.identity.path) as source, av.open(str(output)) as target:
        # Matroska and WebM store presentation times only; the demuxer guesses decode times
        stored_dts = target.format.name.split(",")[0] not in {"matroska", "ogg"}
        bases = {}
        for number, index in enumerate(order):
            base = target.streams[number].time_base
            if base is None:
                raise _failed("an output stream has no time base.")
            bases[index] = Fraction(base)
        planned = (
            _chain_exact(source, plan, analysis, edges, cancel)
            if edges is not None
            else selected_packets(source, plan, analysis, cancel)
        )
        for count, packet in enumerate(planned, 1):
            check_cut_cancel(cancel)
            if count > MAX_PACKETS:
                raise _failed("the output exceeds the packet limit.")
            index = packet.stream.index
            expected[index].append(_packet_identity(packet, bases[index]))
        found: dict[int, list[tuple]] = {i: [] for i in order}
        previous: dict[int, int] = {}
        for packet in target.demux():
            check_cut_cancel(cancel)
            if not packet.size:
                continue
            index = order[packet.stream.index]
            identity = _packet_identity(packet, bases[index])
            if stored_dts and packet.dts is not None and packet.stream.type == "video":
                if packet.stream.index in previous and packet.dts <= previous[packet.stream.index]:
                    raise _failed("the video packets are out of order.")
                previous[packet.stream.index] = packet.dts
            found[index].append(identity)
    # some muxers (MPEG-TS) move every timestamp by one constant start delay; that is
    # allowed only when all tracks move together, so sync is still checked
    shifts = set()
    for index in order:
        if expected[index] and found[index]:
            shifts.add((found[index][0][0] - expected[index][0][0]) * bases[index])
    if len(shifts) > 1 and max(shifts) - min(shifts) > max(bases.values()):
        raise _failed("the tracks moved apart in time.")
    shift = min(shifts, default=Fraction(0))
    for index in order:
        moved = _round(shift / bases[index])
        expected[index] = [
            (pts + moved if pts is not None else None, *rest) for pts, *rest in expected[index]
        ]
    for index in order:
        kind = source_kind(analysis, index)
        if expected[index] != found[index]:
            if len(expected[index]) != len(found[index]):
                raise _failed(f"the number of {kind} packets changed.")
            raise _failed(f"a {kind} packet or its timing changed.")
        counts[kind] = counts.get(kind, 0) + len(found[index])
    return counts, shift


def source_kind(analysis: CutAnalysis, index: int) -> str:
    return next((s.kind for s in analysis.streams if s.index == index), "media")


def _chain_exact(
    source: InputContainer,
    plan: CutPlan,
    analysis: CutAnalysis,
    edges: ExactEdges,
    cancel: Event,
):
    from .exact import exact_packets

    return exact_packets(
        selected_packets(source, plan, analysis, cancel),
        plan,
        analysis,
        edges,
        next(v for v in source.streams.video if v.index == analysis.video_index),
        cancel,
    )


@dataclass
class _DecodeBudget:
    remaining: int
    deadline: float

    def spend(self, cancel: Event, packet: av.Packet) -> None:
        check_cut_cancel(cancel)
        self.remaining -= 1
        if self.remaining < 0 or time.monotonic() > self.deadline or packet.size > MAX_PACKET_BYTES:
            raise _failed("checking the cut edges exceeded the decoding limit. Try fewer cuts.")


def _decode_edge(
    path: Path,
    seek: Fraction,
    start: Fraction,
    end: Fraction,
    cancel: Event,
    budget: _DecodeBudget,
    slack: Fraction = Fraction(0),
) -> list[tuple[Fraction, bytes]]:
    """Decode the frames shown in [start, end) and hash them.

    Seeking can land before a keyframe in files without an index (MPEG-TS), and pictures
    before the window may lack references; only problems inside the window count.
    """
    # seeking without an index can land past the window; step further back until it fits
    for back in (0, 2, 10, 60, None):
        position = Fraction(0) if back is None else max(Fraction(0), seek - back)
        frames, late = _decode_window(path, position, start, end, cancel, budget, slack)
        if not late:
            return frames
    raise _failed("a cut edge could not be found in the output.")


def _picture_digest(frame: av.VideoFrame) -> bytes:
    """Hash the picture itself; plane buffers also hold row padding that can differ."""
    try:
        pixels = frame.to_ndarray()
    except (ValueError, NotImplementedError):
        # formats PyAV cannot export directly, such as 10-bit YUV, are converted exactly
        pixels = frame.reformat(format="rgb48le").to_ndarray()
    return hashlib.sha256(pixels.tobytes()).digest()


def _decode_window(
    path: Path,
    seek: Fraction,
    start: Fraction,
    end: Fraction,
    cancel: Event,
    budget: _DecodeBudget,
    slack: Fraction,
) -> tuple[list[tuple[Fraction, bytes]], bool]:
    """Frames in [start, end), and whether decoding began after `start`."""
    frames = []
    first_seen: Fraction | None = None
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        if (
            stream.time_base is None
            or stream.codec_context.width * stream.codec_context.height > MAX_FRAME_PIXELS
        ):
            raise _failed("this video exceeds the boundary decoding limit.")
        stream.codec_context.thread_count = 1
        if seek > 0:
            container.seek(int(seek / stream.time_base), stream=stream, backward=True)
        with av_logging.Capture() as logs:
            complete = False
            started = False
            window_logs = None
            for packet in container.demux(stream):
                budget.spend(cancel, packet)
                started |= packet.is_keyframe
                if not started:
                    continue
                try:
                    decoded = packet.decode()
                except FFmpegError:
                    if frames:
                        raise
                    continue
                for frame in decoded:
                    if not isinstance(frame, av.VideoFrame) or frame.pts is None:
                        continue
                    if frame.time_base is None:
                        raise _failed("a cut edge could not be decoded.")
                    moment = frame.pts * Fraction(frame.time_base)
                    if first_seen is None:
                        first_seen = moment
                        # a frame within the rounding slack is the window's own first frame
                        if moment > start + slack:
                            return [], True
                    if moment >= end:
                        complete = True
                        break
                    if moment >= start:
                        if frame.is_corrupt:
                            raise _failed("a cut edge could not be decoded.")
                        if window_logs is None:
                            window_logs = len(logs)
                        frames.append((moment - start, _picture_digest(frame)))
                if window_logs is not None and any(
                    level <= av_logging.WARNING for level, _, _ in logs[window_logs:]
                ):
                    raise _failed("the decoder reported a damaged cut edge.")
                if complete:
                    break
    return frames, first_seen is None


def _verify_audio_edges(plan: CutPlan, output: Path, cancel: Event, budget: _DecodeBudget) -> None:
    for segment in plan.segments:
        if segment.audio_output is None:
            continue
        with av.open(str(output)) as container:
            if not container.streams.audio:
                raise _failed("the audio is missing.")
            stream = container.streams.audio[0]
            stream.codec_context.options = {"err_detect": "explode"}
            rate = stream.codec_context.sample_rate
            quantum = Fraction(stream.codec_context.frame_size or 1024, rate)
            base = stream.time_base
            if base is None:
                raise _failed("the audio has no time base.")
            for start in (
                segment.audio_output.start.seconds,
                max(
                    segment.audio_output.start.seconds,
                    segment.audio_output.end.seconds - 3 * quantum,
                ),
            ):
                container.seek(int(start / base), stream=stream, backward=True)
                end = min(start + 3 * quantum, segment.audio_output.end.seconds)
                found = False
                with av_logging.Capture() as logs:
                    complete = False
                    for packet in container.demux(stream):
                        budget.spend(cancel, packet)
                        for frame in packet.decode():
                            if (
                                not isinstance(frame, av.AudioFrame)
                                or frame.pts is None
                                or frame.time_base is None
                                or frame.is_corrupt
                            ):
                                raise _failed("an audio cut edge could not be decoded.")
                            moment = frame.pts * Fraction(frame.time_base)
                            if moment >= end:
                                complete = True
                                break
                            found |= moment + Fraction(frame.samples, frame.sample_rate) > start
                        if any(level <= av_logging.WARNING for level, _, _ in logs):
                            raise _failed("the decoder reported a damaged audio cut edge.")
                        if complete:
                            break
                if not found:
                    raise _failed("an audio cut edge contains no samples.")


def _verify_boundaries(
    plan: CutPlan, output: Path, analysis: CutAnalysis, cancel: Event, shift: Fraction
) -> int:
    keys = [key.seconds for key in analysis.keyframes]
    frames = list(analysis.frames)
    budget = _DecodeBudget(MAX_BOUNDARY_FRAMES, time.monotonic() + MAX_BOUNDARY_SECONDS)
    elapsed = Fraction(0)
    checked = 0
    with av.open(str(output)) as container:
        output_base = container.streams.video[0].time_base
    # a container that rounds timestamps can move a frame by less than one of its ticks
    tolerance = Fraction(output_base) if output_base is not None else Fraction(0)
    for segment in plan.segments:
        if segment.start_kind == "collapsed":
            continue
        start, end = segment.resolved.start.seconds, segment.resolved.end.seconds
        low, high = bisect_left(frames, start), bisect_left(frames, end)
        head = frames[low : min(high, low + 3)]
        tail = frames[max(low, high - 3) : high]
        windows = [(start, head[0], head[-1])]
        if tail and tail[0] > head[-1]:
            key = keys[bisect_right(keys, tail[0]) - 1]
            windows.append((max(start, key), tail[0], tail[-1]))
        for seek, first, last in windows:
            wanted = bisect_right(frames, last) - bisect_left(frames, first)
            original = _decode_edge(
                Path(plan.identity.path),
                analysis.origin.seconds + seek,
                analysis.origin.seconds + first,
                analysis.origin.seconds + last + tolerance / 2,
                cancel,
                budget,
            )
            copied = _decode_edge(
                output,
                shift + elapsed + seek - start,
                shift + elapsed + first - start - tolerance / 2,
                shift + elapsed + last - start + tolerance / 2,
                cancel,
                budget,
                tolerance,
            )
            if (
                len(original) != wanted
                or len(copied) != wanted
                or [digest for _, digest in copied] != [digest for _, digest in original]
            ):
                raise _failed("frames at a cut edge are missing, repeated or different.")
            checked += len(copied)
        elapsed += end - start
    _verify_audio_edges(plan, output, cancel, budget)
    return checked


def verify_cut_output(
    plan: CutPlan,
    output: Path,
    cancel: Event,
    *,
    analysis: CutAnalysis | None = None,
    ffprobe: str | None = None,
    edges: ExactEdges | None = None,
) -> CutVerification:
    check_cut_cancel(cancel)
    binary = ffprobe or find_ffprobe()
    if not binary:
        raise _failed("FFprobe is not available.")
    analysis = analysis or prepare_cut(plan, cancel, binary)
    validate_cut_source(plan, cancel)
    try:
        if (plan.precision == "exact") != (edges is not None):
            raise _failed("the exact cut edges are missing.")
        _verify_streams(plan, output, cancel, analysis, binary, edges.extradata if edges else None)
        counts, shift = _verify_packets(plan, output, analysis, cancel, edges)
        video, audio = counts.get("video", 0), counts.get("audio", 0)
        if edges is not None:
            frames = verify_exact_frames(plan, output, analysis, cancel)
            _verify_audio_edges(
                plan,
                output,
                cancel,
                _DecodeBudget(MAX_BOUNDARY_FRAMES, time.monotonic() + MAX_BOUNDARY_SECONDS),
            )
        else:
            frames = _verify_boundaries(plan, output, analysis, cancel, shift)
    except FFmpegError as exc:
        raise _failed(f"the media could not be read ({exc}).") from exc
    validate_cut_source(plan, cancel)
    return CutVerification(video, audio, frames)
