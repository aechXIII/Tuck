"""Exact cuts: encode the frames next to each cut and copy everything in between."""

from __future__ import annotations

import os
import subprocess
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from threading import Event

import av
import numpy as np
from av.container import InputContainer
from av.video.stream import VideoStream

from ..models.cutting import CutAnalysis, CutPlan
from .analysis import MAX_PACKET_BYTES, CutAnalysisError

EDGE_CRF = "14"
# a correctly placed edge frame differs from its source only by encoding noise
MAX_EDGE_DIFFERENCE = 12.0
MAX_EXACT_DECODE_SECONDS = 600.0
# comparisons use small grey pictures, so long edges stay cheap to hold in memory
_CHECK_WIDTH = 256
_PROFILES = {
    "Constrained Baseline": "baseline",
    "Baseline": "baseline",
    "Main": "main",
    "High": "high",
}


def _failed(message: str) -> CutAnalysisError:
    return CutAnalysisError("cut_failed", f"The exact cut could not be made: {message}")


def _video_properties(analysis: CutAnalysis) -> dict[str, str]:
    videos = [s for s in analysis.streams if s.kind == "video"]
    return dict(videos[0].properties) if videos else {}


def exact_media_reason(analysis: CutAnalysis) -> str:
    """Why this video cannot use Exact, or an empty string when it can."""
    if analysis.issues:
        return analysis.issues[0].message
    properties = _video_properties(analysis)
    if properties.get("profile") not in _PROFILES:
        return "Exact needs H.264 Baseline, Main or High video."
    width, height = properties.get("width", ""), properties.get("height", "")
    if not width.isdigit() or not height.isdigit() or int(width) % 2 or int(height) % 2:
        return "Exact needs video with even width and height."
    if not properties.get("level", "").isdigit():
        return "Exact needs the video's H.264 level."
    return ""


def exact_encoder_available() -> bool:
    from ..encoding.capabilities import get_available_encoders

    try:
        return "libx264" in get_available_encoders()
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


@dataclass(frozen=True)
class ExactRegion:
    """Source frames [start, end), relative to the video origin, that must be encoded."""

    segment: int
    start: Fraction
    end: Fraction


def exact_regions(plan: CutPlan) -> list[ExactRegion]:
    regions = []
    if plan.precision != "exact":
        return regions
    for index, segment in enumerate(plan.segments):
        start, end = segment.resolved.start.seconds, segment.resolved.end.seconds
        if segment.start_kind == "collapsed" or end <= start:
            continue
        if segment.copied is None:
            regions.append(ExactRegion(index, start, end))
            continue
        if segment.copied.start.seconds > start:
            regions.append(ExactRegion(index, start, segment.copied.start.seconds))
        if segment.copied.end.seconds < end:
            regions.append(ExactRegion(index, segment.copied.end.seconds, end))
    return regions


# --- H.264 decoder configuration (avcC) ---


def _unescape(nal: bytes) -> bytes:
    return nal.replace(b"\x00\x00\x03", b"\x00\x00")


def _read_ue(data: bytes, bit: int) -> tuple[int, int]:
    zeros = 0
    while not (data[bit // 8] >> (7 - bit % 8)) & 1:
        zeros += 1
        bit += 1
        if zeros > 31:
            raise ValueError("invalid Exp-Golomb value")
    value = 0
    for _ in range(zeros + 1):
        value = (value << 1) | ((data[bit // 8] >> (7 - bit % 8)) & 1)
        bit += 1
    return value - 1, bit


@dataclass(frozen=True)
class DecoderConfig:
    header: bytes  # profile, compatibility and level
    length_size: int
    sps: tuple[bytes, ...]
    pps: tuple[bytes, ...]
    extension: bytes

    @classmethod
    def parse(cls, data: bytes | None) -> DecoderConfig:
        try:
            if not data or data[0] != 1:
                raise ValueError
            position = 6
            sps = []
            for _ in range(data[5] & 31):
                size = int.from_bytes(data[position : position + 2], "big")
                sps.append(data[position + 2 : position + 2 + size])
                position += 2 + size
            pps = []
            count = data[position]
            position += 1
            for _ in range(count):
                size = int.from_bytes(data[position : position + 2], "big")
                pps.append(data[position + 2 : position + 2 + size])
                position += 2 + size
            if position > len(data) or any(not nal for nal in (*sps, *pps)):
                raise ValueError
        except (IndexError, ValueError) as exc:
            raise _failed("the video's decoder configuration could not be read.") from exc
        return cls(
            bytes(data[1:4]), (data[4] & 3) + 1, tuple(sps), tuple(pps), bytes(data[position:])
        )

    def sps_ids(self) -> set[int]:
        return {_read_ue(_unescape(nal[:8]), 32)[0] for nal in self.sps}

    def pps_ids(self) -> set[int]:
        return {_read_ue(_unescape(nal[:6]), 8)[0] for nal in self.pps}

    def merged(self, other: DecoderConfig) -> bytes:
        """This configuration followed by `other`'s parameter sets, under this header."""
        sps, pps = (*self.sps, *other.sps), (*self.pps, *other.pps)
        if len(sps) > 31 or len(pps) > 255:
            raise _failed("the video has too many parameter sets.")
        out = bytearray([1, *self.header, 0xFC | (self.length_size - 1), 0xE0 | len(sps)])
        for nal in sps:
            out += len(nal).to_bytes(2, "big") + nal
        out.append(len(pps))
        for nal in pps:
            out += len(nal).to_bytes(2, "big") + nal
        return bytes(out + self.extension)


# --- edge encoding ---


@dataclass(frozen=True)
class ExactEdges:
    chunks: dict[ExactRegion, Path]
    extradata: bytes
    # the source's decode delay: its keyframes' PTS minus DTS
    lead: Fraction


def _encoder_arguments(analysis: CutAnalysis, ffmpeg: str, sps_id: int, output: Path) -> list[str]:
    properties = _video_properties(analysis)
    level = int(properties["level"])
    rate = 1 / analysis.frame_duration.seconds
    arguments = [
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        "-s",
        f"{properties['width']}x{properties['height']}",
        "-framerate",
        f"{rate.numerator}/{rate.denominator}",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        EDGE_CRF,
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        _PROFILES[properties["profile"]],
        "-level:v",
        "1b" if level == 9 else f"{level // 10}.{level % 10}",
        # a separate parameter-set ID lets the copied and encoded pictures share one avcC
        "-x264-params",
        f"sps-id={sps_id}:keyint=infinite:scenecut=0:repeat-headers=0",
    ]
    for option, key in (
        ("-color_primaries", "color_primaries"),
        ("-color_trc", "color_transfer"),
        ("-colorspace", "color_space"),
        ("-color_range", "color_range"),
    ):
        value = properties.get(key)
        if value and value != "unknown":
            arguments += [option, value]
    aspect = properties.get("sample_aspect_ratio", "")
    if aspect and aspect not in {"1:1", "0:1", "N/A"}:
        arguments += ["-vf", f"setsar={aspect.replace(':', '/')}"]
    return [*arguments, "-f", "mp4", str(output)]


def _source_frames(
    source: Path, analysis: CutAnalysis, start: Fraction, end: Fraction, cancel: Event
) -> Iterator[av.VideoFrame]:
    """Decoded source frames whose exact timestamps fall in [start, end)."""
    keys = [key.seconds for key in analysis.keyframes if key.seconds <= start]
    seek = analysis.origin.seconds + (keys[-1] if keys else Fraction(0))
    step = analysis.frame_duration.seconds
    expected = start
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        if stream.time_base is None:
            raise _failed("the video has no time base.")
        stream.codec_context.thread_count = 1
        container.seek(int(seek / stream.time_base), stream=stream, backward=True)
        for packet in container.demux(stream):
            if cancel.is_set():
                raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.")
            if packet.size > MAX_PACKET_BYTES:
                raise _failed("a video packet is too large.")
            for frame in packet.decode():
                if (
                    not isinstance(frame, av.VideoFrame)
                    or frame.pts is None
                    or frame.time_base is None
                ):
                    continue
                moment = frame.pts * Fraction(frame.time_base) - analysis.origin.seconds
                if moment < start:
                    continue
                if moment >= end:
                    if expected != end:
                        raise _failed("frames near a cut are missing.")
                    return
                if moment != expected:
                    raise _failed("frames near a cut are missing or repeated.")
                expected += step
                yield frame
    if expected != end:
        raise _failed("the video ended before a cut edge.")


def _encode_region(
    source: Path,
    analysis: CutAnalysis,
    region: ExactRegion,
    output: Path,
    ffmpeg: str,
    sps_id: int,
    cancel: Event,
    on_frame: Callable[[], None],
) -> None:
    log = output.with_suffix(".log")
    with log.open("wb") as errors:
        process = subprocess.Popen(
            _encoder_arguments(analysis, ffmpeg, sps_id, output),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=errors,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        stdin = process.stdin
        assert stdin is not None
        try:
            for frame in _source_frames(source, analysis, region.start, region.end, cancel):
                stdin.write(frame.reformat(format="yuv420p").to_ndarray().tobytes())
                on_frame()
            stdin.close()
            code = process.wait(timeout=120)
        except BrokenPipeError:
            code = process.wait(timeout=30)
        except BaseException:
            process.kill()
            process.wait()
            raise
    if code != 0:
        detail = log.read_text(encoding="utf-8", errors="replace").strip()[-400:]
        raise _failed(f"FFmpeg could not encode a cut edge. {detail}".strip())


def encode_edges(
    plan: CutPlan,
    analysis: CutAnalysis,
    workspace: Path,
    cancel: Event,
    *,
    ffmpeg: str,
    on_frame: Callable[[], None] = lambda: None,
) -> ExactEdges:
    source = Path(plan.identity.path)
    with av.open(str(source)) as container:
        original = container.streams.video[0].codec_context.extradata
        first = next((p for p in container.demux(video=0) if p.size), None)
        if first is None or first.pts is None or first.dts is None or first.time_base is None:
            raise _failed("the video has no timed packets.")
        lead = (first.pts - first.dts) * Fraction(first.time_base)
    config = DecoderConfig.parse(original)
    if config.length_size != 4:
        raise _failed("this video's NAL length size is not supported.")
    used = config.sps_ids() | config.pps_ids()
    sps_id = next((i for i in range(32) if i not in used), None)
    if sps_id is None:
        raise _failed("this video uses every parameter-set ID.")
    chunks: dict[ExactRegion, Path] = {}
    edge_config: DecoderConfig | None = None
    for number, region in enumerate(exact_regions(plan)):
        chunk = workspace / f"edge-{number}.mp4"
        _encode_region(source, analysis, region, chunk, ffmpeg, sps_id, cancel, on_frame)
        with av.open(str(chunk)) as container:
            current = DecoderConfig.parse(container.streams.video[0].codec_context.extradata)
            count = sum(1 for packet in container.demux(video=0) if packet.size)
        wanted = (region.end - region.start) / analysis.frame_duration.seconds
        if count != wanted:
            raise _failed("an encoded edge has the wrong number of frames.")
        if (
            current.length_size != 4
            or current.sps_ids() != {sps_id}
            or current.pps_ids() != {sps_id}
        ):
            raise _failed("an encoded edge used unexpected parameter sets.")
        # every edge must share one configuration, since the avcC lists it once
        if edge_config is not None and (current.sps, current.pps) != (
            edge_config.sps,
            edge_config.pps,
        ):
            raise _failed("the encoded edges used different settings.")
        edge_config = current
        chunks[region] = chunk
    # a plan that encodes nothing keeps the source configuration byte for byte
    extradata = config.merged(edge_config) if edge_config else bytes(original or b"")
    return ExactEdges(chunks, extradata, lead)


# --- joining ---


def exact_packets(
    video_and_audio: Iterator[av.Packet],
    plan: CutPlan,
    analysis: CutAnalysis,
    edges: ExactEdges,
    video_stream: VideoStream,
    cancel: Event,
) -> Iterator[av.Packet]:
    """Replace the source frames of each encoded region with its encoded packets.

    `video_and_audio` are the planned source packets already moved onto the output timeline.
    Every video packet gets one rebuilt decode timeline, so encoded and copied pictures
    interleave with increasing DTS and PTS never before DTS.
    """
    base = video_stream.time_base
    if base is None:
        raise _failed("the video has no time base.")
    time_base = Fraction(base)
    step = analysis.frame_duration.seconds
    # regular source DTS means no copied picture is decoded more than one keyframe delay
    # before it is shown; encoded edges have no reordering at all
    lead = edges.lead
    pieces: list[tuple[Fraction, Fraction, ExactRegion | None]] = []
    elapsed = Fraction(0)
    regions = iter(sorted(edges.chunks, key=lambda r: (r.segment, r.start)))
    pending = next(regions, None)
    for index, segment in enumerate(plan.segments):
        start, end = segment.resolved.start.seconds, segment.resolved.end.seconds
        if segment.start_kind == "collapsed":
            continue
        cursor = start
        while pending is not None and pending.segment == index:
            if pending.start > cursor:
                pieces.append((elapsed + cursor - start, elapsed + pending.start - start, None))
            pieces.append((elapsed + pending.start - start, elapsed + pending.end - start, pending))
            cursor = pending.end
            pending = next(regions, None)
        if cursor < end:
            pieces.append((elapsed + cursor - start, elapsed + end - start, None))
        elapsed += end - start
    decoded = 0

    def retime(packet: av.Packet, presentation: Fraction) -> av.Packet:
        nonlocal decoded
        ticks = [value / time_base for value in (presentation, decoded * step - lead, step)]
        if any(value.denominator != 1 for value in ticks):
            raise _failed("the cut timestamps cannot be written exactly.")
        packet.time_base = base
        packet.pts, packet.dts, packet.duration = (int(value) for value in ticks)
        decoded += 1
        return packet

    def encoded(region: ExactRegion, start: Fraction) -> Iterator[av.Packet]:
        with av.open(str(edges.chunks[region])) as container:
            for number, packet in enumerate(p for p in container.demux(video=0) if p.size):
                if cancel.is_set():
                    raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.")
                yield retime(packet, start + number * step)

    position = 0

    def flush_encoded() -> Iterator[av.Packet]:
        nonlocal position
        while position < len(pieces) and pieces[position][2] is not None:
            first, _, region = pieces[position]
            assert region is not None
            yield from encoded(region, first)
            position += 1

    for packet in video_and_audio:
        if packet.stream.type != "video":
            yield packet
            continue
        if packet.pts is None or packet.time_base is None:
            raise _failed("a video packet has no timestamp.")
        moment = packet.pts * Fraction(packet.time_base)
        yield from flush_encoded()
        while position < len(pieces) and moment >= pieces[position][1]:
            position += 1
            yield from flush_encoded()
        if position < len(pieces) and pieces[position][0] <= moment < pieces[position][1]:
            yield retime(packet, moment)
    while position < len(pieces):
        yield from flush_encoded()
        position += 1
    if decoded * step != plan.exported_duration.seconds:
        raise _failed("the joined video has the wrong number of frames.")


# --- checking ---


def _frames(
    path: Path, origin: Fraction, start: Fraction, end: Fraction, deadline: float, cancel: Event
) -> Iterator[tuple[Fraction, np.ndarray]]:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        if stream.time_base is None:
            raise _failed("a video has no time base.")
        stream.codec_context.options = {"err_detect": "explode"}
        container.seek(int((origin + start) / stream.time_base), stream=stream, backward=True)
        for packet in container.demux(stream):
            if cancel.is_set():
                raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.")
            if time.monotonic() > deadline:
                raise CutAnalysisError(
                    "verification_failed", "The cut could not be verified: checking took too long."
                )
            for frame in packet.decode():
                if (
                    not isinstance(frame, av.VideoFrame)
                    or frame.pts is None
                    or frame.time_base is None
                ):
                    raise CutAnalysisError(
                        "verification_failed", "The cut could not be verified: a frame is damaged."
                    )
                moment = frame.pts * Fraction(frame.time_base) - origin
                if moment >= end:
                    return
                if moment >= start:
                    width = min(_CHECK_WIDTH, frame.width)
                    height = max(2, round(frame.height * width / frame.width))
                    small = frame.reformat(width=width, height=height, format="gray")
                    yield moment, small.to_ndarray().astype(np.int16)


def verify_exact_frames(
    plan: CutPlan, output: Path, analysis: CutAnalysis, edges: ExactEdges, cancel: Event
) -> int:
    """Decode each cut edge and check every frame is the intended source picture.

    Copied frames must be identical. Encoded frames must match their own source frame more
    closely than either neighbour, which catches a shifted, missing or repeated frame.
    """
    step = analysis.frame_duration.seconds
    edge_width = 3 * step
    source = Path(plan.identity.path)
    deadline = time.monotonic() + MAX_EXACT_DECODE_SECONDS
    checked = 0
    elapsed = Fraction(0)
    for segment in plan.segments:
        if segment.start_kind == "collapsed":
            continue
        start, end = segment.resolved.start.seconds, segment.resolved.end.seconds
        copied = segment.copied
        head_end = min(end, (copied.start.seconds if copied else end) + edge_width)
        tail_start = max(start, (copied.end.seconds if copied else start) - edge_width)
        windows = (
            [(start, head_end)]
            if head_end >= tail_start
            else [(start, head_end), (tail_start, end)]
        )
        for first, last in windows:
            wanted = list(
                _frames(
                    source,
                    analysis.origin.seconds,
                    max(Fraction(0), first - step),
                    last + step,
                    deadline,
                    cancel,
                )
            )
            found = list(
                _frames(
                    output,
                    Fraction(0),
                    elapsed + first - start,
                    elapsed + last - start,
                    deadline,
                    cancel,
                )
            )
            count = (last - first) / step
            if len(found) != count:
                raise CutAnalysisError(
                    "verification_failed",
                    "The cut could not be verified: frames at a cut edge are missing or repeated.",
                )
            lookup = dict(wanted)
            for moment, image in found:
                source_moment = moment - elapsed + start
                reference = lookup.get(source_moment)
                if reference is None:
                    raise CutAnalysisError(
                        "verification_failed", "The cut could not be verified: a frame moved."
                    )
                is_copied = (
                    copied is not None
                    and copied.start.seconds <= source_moment < copied.end.seconds
                )
                if is_copied:
                    if not np.array_equal(image, reference):
                        raise CutAnalysisError(
                            "verification_failed",
                            "The cut could not be verified: a copied frame changed.",
                        )
                else:
                    difference = float(np.abs(image - reference).mean())
                    neighbours = [
                        float(np.abs(image - lookup[source_moment + delta]).mean())
                        for delta in (-step, step)
                        if source_moment + delta in lookup
                    ]
                    if difference > MAX_EDGE_DIFFERENCE or any(n < difference for n in neighbours):
                        raise CutAnalysisError(
                            "verification_failed",
                            "The cut could not be verified: an encoded frame is out of place.",
                        )
                checked += 1
        elapsed += end - start
    return checked


def packets_for_verification(
    incoming: InputContainer,
    plan: CutPlan,
    analysis: CutAnalysis,
    edges: ExactEdges,
    cancel: Event,
) -> Iterator[av.Packet]:
    from .packets import selected_packets

    return exact_packets(
        selected_packets(incoming, plan, analysis, cancel, kind="video"),
        plan,
        analysis,
        edges,
        incoming.streams.video[0],
        cancel,
    )
