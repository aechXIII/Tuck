"""Exact cuts: encode the frames next to each cut and copy everything in between."""

from __future__ import annotations

import functools
import struct
from bisect import bisect_left
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from threading import Event
from typing import BinaryIO

import av
from av.codec import Codec
from av.codec.context import Flags
from av.error import FFmpegError
from av.video.codeccontext import VideoCodecContext
from av.video.frame import PictureType
from av.video.stream import VideoStream

from ..models.cutting import CutAnalysis, CutPlan
from .analysis import CutAnalysisError
from .bitstream import (
    AV1_SEQUENCE_HEADER,
    HEVC_AUD,
    HEVC_PPS,
    HEVC_SPS,
    HEVC_VPS,
    AvcConfig,
    BitstreamError,
    HevcConfig,
    HevcIds,
    av1_obus,
    hevc_parameter_id,
    hevc_type,
    is_hevc_slice,
    length_prefixed,
    nal_units,
    renumber_hevc_parameter_set,
    renumber_hevc_slice,
    without_temporal_delimiters,
)
from .output_timing import decode_times, output_frame_times, to_ticks
from .timeline import MAX_PACKET_BYTES

# MP4, MOV and Matroska keep one decoder configuration that lists every parameter set
_CONTAINERS = {"mov", "matroska"}
# free HEVC IDs whose Exp-Golomb codes are exactly 8 bits longer than 0's
_HEVC_SPS_ID = 15
_HEVC_PPS_IDS = range(15, 31)
_H264_PROFILES = {
    "Constrained Baseline": "baseline",
    "Baseline": "baseline",
    "Main": "main",
    "High": "high",
    "High 10": "high10",
    "High 4:2:2": "high422",
    "High 4:4:4 Predictive": "high444",
}


@dataclass(frozen=True)
class _EdgeCodec:
    label: str
    encoders: tuple[str, ...]


_CODECS = {
    "h264": _EdgeCodec("H.264", ("libx264",)),
    "hevc": _EdgeCodec("HEVC", ("libx265",)),
    # SVT-AV1 is much faster; libaom takes the sizes and formats it rejects
    "av1": _EdgeCodec("AV1", ("libsvtav1", "libaom-av1")),
    "vp9": _EdgeCodec("VP9", ("libvpx-vp9",)),
    "vp8": _EdgeCodec("VP8", ("libvpx",)),
}


def _failed(message: str) -> CutAnalysisError:
    return CutAnalysisError("cut_failed", f"The exact cut could not be made: {message}")


def _video_properties(analysis: CutAnalysis) -> dict[str, str]:
    videos = [s for s in analysis.streams if s.index == analysis.video_index]
    return dict(videos[0].properties) if videos else {}


def _video_codec(analysis: CutAnalysis) -> str:
    videos = [s for s in analysis.streams if s.index == analysis.video_index]
    return videos[0].codec if videos else ""


@functools.cache
def encoder_supports(name: str, pixel_format: str) -> bool:
    """Whether this build's `name` encoder takes `pixel_format` pictures."""
    try:
        codec = Codec(name, "w")
    except (ValueError, FFmpegError):
        return False
    return any(f.name == pixel_format for f in codec.video_formats or ())


def _edge_encoders(analysis: CutAnalysis) -> list[str]:
    spec = _CODECS.get(_video_codec(analysis))
    pixel_format = _video_properties(analysis).get("pix_fmt", "")
    return [n for n in spec.encoders if encoder_supports(n, pixel_format)] if spec else []


def exact_media_reason(analysis: CutAnalysis) -> str:
    """Why this video cannot use Exact, or an empty string when it can."""
    if analysis.issues:
        return analysis.issues[0].message
    codec = _video_codec(analysis)
    spec = _CODECS.get(codec)
    if spec is None:
        return "Exact works with H.264, HEVC, AV1, VP9 and VP8 video."
    if analysis.format_name.split(",")[0] not in _CONTAINERS:
        return "Exact needs an MP4, MOV, MKV or WebM file."
    properties = _video_properties(analysis)
    if properties.get("field_order") not in {None, "progressive", "unknown"}:
        return "Exact needs progressive video."
    width, height = properties.get("width", ""), properties.get("height", "")
    if not width.isdigit() or not height.isdigit() or int(width) % 2 or int(height) % 2:
        return "Exact needs video with even width and height."
    if codec == "h264":
        if properties.get("profile") not in _H264_PROFILES:
            return "Exact does not support this H.264 profile."
        if not properties.get("level", "").isdigit():
            return "Exact needs the video's H.264 level."
    if not _edge_encoders(analysis):
        return f"This build cannot re-encode {spec.label} video in this colour format."
    return ""


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


# --- edge encoding ---


@dataclass(frozen=True)
class ExactEdges:
    chunks: dict[ExactRegion, Path]
    extradata: bytes
    # AV1: the source's sequence header, for a copied key frame that follows an edge
    entry_header: bytes = b""


@dataclass(frozen=True)
class _Picture:
    """What the edge encoder must match in the source video."""

    width: int
    height: int
    pixel_format: str
    colour: tuple[int, int, int, int]
    aspect: Fraction | None


def _encoder_options(name: str, properties: dict[str, str], parameter_id: int) -> dict[str, str]:
    if name == "libx264":
        level = int(properties["level"])
        return {
            "preset": "medium",
            "crf": "14",
            "bf": "0",
            "profile": _H264_PROFILES[properties["profile"]],
            "level": "1b" if level == 9 else f"{level // 10}.{level % 10}",
            # a separate parameter-set ID lets the copied and encoded pictures share one avcC
            "x264-params": f"sps-id={parameter_id}:keyint=infinite:scenecut=0:repeat-headers=0",
        }
    if name == "libx265":
        return {
            "preset": "fast",
            "crf": "14",
            "x265-params": "keyint=-1:scenecut=0:bframes=0:repeat-headers=0:info=0:log-level=error",
        }
    if name == "libsvtav1":
        # low-delay prediction never holds a frame back, so each packet shows one frame
        return {"crf": "18", "preset": "8", "svtav1-params": "pred-struct=1:keyint=-1:scd=0"}
    if name == "libaom-av1":
        return {"crf": "18", "b": "0", "cpu-used": "6", "lag-in-frames": "0", "row-mt": "1"}
    if name == "libvpx-vp9":
        return {
            "crf": "15",
            "b": "0",
            "deadline": "good",
            "cpu-used": "4",
            "lag-in-frames": "0",
            "auto-alt-ref": "0",
            "row-mt": "1",
        }
    return {
        "crf": "6",
        "b": "100M",
        "deadline": "good",
        "cpu-used": "2",
        "lag-in-frames": "0",
        "auto-alt-ref": "0",
    }


def _open_encoder(
    name: str, analysis: CutAnalysis, picture: _Picture, parameter_id: int
) -> VideoCodecContext:
    context = av.CodecContext.create(name, "w")
    if not isinstance(context, VideoCodecContext):
        raise _failed(f"the {name} encoder is not a video encoder.")
    context.width, context.height = picture.width, picture.height
    context.pix_fmt = picture.pixel_format
    step = analysis.frame_duration.seconds
    # edges are retimed from the source frames, so a nominal rate is enough for the encoder
    context.time_base = step
    context.framerate = 1 / step
    context.gop_size = 1 << 30
    (
        context.color_primaries,
        context.color_trc,
        context.colorspace,
        context.color_range,
    ) = picture.colour
    if picture.aspect:
        context.sample_aspect_ratio = picture.aspect
    if name in {"libx264", "libx265"}:
        # parameter sets go to the decoder configuration, not into the pictures
        context.flags |= Flags.global_header
    context.options = _encoder_options(name, _video_properties(analysis), parameter_id)
    try:
        context.open()
    except (FFmpegError, ValueError) as exc:
        raise _failed(f"the {name} encoder could not encode a cut edge. {exc}") from exc
    return context


def _open_edge_encoder(
    encoders: list[str], analysis: CutAnalysis, picture: _Picture, parameter_id: int
) -> tuple[VideoCodecContext, list[str]]:
    """The first encoder that starts, and the ones still worth trying for later edges."""
    for index, name in enumerate(encoders):
        try:
            return _open_encoder(name, analysis, picture, parameter_id), encoders[index:]
        except CutAnalysisError:
            if index == len(encoders) - 1:
                raise
    raise _failed("no edge encoder is available.")


def _source_frames(
    source: Path, analysis: CutAnalysis, start: Fraction, end: Fraction, cancel: Event
) -> Iterator[av.VideoFrame]:
    """Decoded source frames whose exact timestamps fall in [start, end)."""
    frames = analysis.frames
    wanted = frames[bisect_left(frames, start) : bisect_left(frames, end)]
    keys = [key.seconds for key in analysis.keyframes if key.seconds <= start]
    seek = analysis.origin.seconds + (keys[-1] if keys else Fraction(0))
    found = 0
    with av.open(str(source)) as container:
        stream = container.streams[analysis.video_index]
        if not isinstance(stream, VideoStream) or stream.time_base is None:
            raise _failed("the video has no time base.")
        stream.thread_type = "AUTO"
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
                    if found != len(wanted):
                        raise _failed("frames near a cut are missing.")
                    return
                if found == len(wanted) or moment != wanted[found]:
                    raise _failed("frames near a cut are missing or repeated.")
                found += 1
                yield frame
    if found != len(wanted):
        raise _failed("the video ended before a cut edge.")


def _edge_payload(codec: str, data: bytes, length_size: int, pps_id: int) -> bytes:
    """An encoded edge picture in the source's own bitstream format."""
    if codec == "h264":
        units = [u for u in nal_units(data, None) if u[0] & 0x1F not in (7, 8, 9)]
        return length_prefixed(units, length_size)
    if codec == "hevc":
        units = [
            renumber_hevc_slice(u, pps_id) if is_hevc_slice(u) else u
            for u in nal_units(data, None)
            if hevc_type(u) not in (HEVC_VPS, HEVC_SPS, HEVC_PPS, HEVC_AUD)
        ]
        return length_prefixed(units, length_size)
    if codec == "av1":
        return without_temporal_delimiters(data)
    return data


def _edge_parameter_sets(codec: str, extradata: bytes | None) -> tuple[bytes, ...]:
    if codec in {"h264", "hevc"} and not extradata:
        raise _failed("the edge encoder gave no parameter sets.")
    if codec == "h264":
        config = AvcConfig.from_annex_b(bytes(extradata or b""))
        return (*config.sps, *config.pps)
    if codec == "hevc":
        return tuple(
            u
            for u in nal_units(bytes(extradata or b""), None)
            if hevc_type(u) in (HEVC_VPS, HEVC_SPS, HEVC_PPS)
        )
    return ()


def _free(ids: set[int], choices: range) -> int:
    free = next((value for value in choices if value not in ids), None)
    if free is None:
        raise _failed("this video uses every parameter-set ID.")
    return free


def _write_record(out: BinaryIO, key: bool, payload: bytes) -> None:
    out.write(struct.pack(">?I", key, len(payload)))
    out.write(payload)


def _read_chunk(path: Path) -> Iterator[tuple[bool, bytes]]:
    with path.open("rb") as chunk:
        while header := chunk.read(5):
            key, size = struct.unpack(">?I", header)
            yield key, chunk.read(size)


def encode_edges(
    plan: CutPlan,
    analysis: CutAnalysis,
    workspace: Path,
    cancel: Event,
    *,
    on_frame: Callable[[], None] = lambda: None,
) -> ExactEdges:
    source = Path(plan.identity.path)
    codec = _video_codec(analysis)
    encoders = _edge_encoders(analysis)
    if not encoders:
        raise _failed(exact_media_reason(analysis) or "no edge encoder is available.")
    with av.open(str(source)) as container:
        stream = container.streams[analysis.video_index]
        if not isinstance(stream, VideoStream):
            raise _failed("the video track could not be read.")
        decoder = stream.codec_context
        original = bytes(decoder.extradata or b"")
        picture = _Picture(
            decoder.width,
            decoder.height,
            _video_properties(analysis).get("pix_fmt", ""),
            (decoder.color_primaries, decoder.color_trc, decoder.colorspace, decoder.color_range),
            decoder.sample_aspect_ratio or stream.sample_aspect_ratio,
        )
    try:
        avc = AvcConfig.parse(original) if codec == "h264" else None
        hevc = HevcConfig.parse(original) if codec == "hevc" else None
        parameter_id, ids = 0, HevcIds(0, 0, 0)
        length_size = 4
        if avc is not None:
            length_size = avc.length_size
            parameter_id = _free(avc.sps_ids() | avc.pps_ids(), range(32))
        if hevc is not None:
            length_size = hevc.length_size
            used = {kind: {hevc_parameter_id(u) for u in hevc.units(kind)} for kind in (32, 33, 34)}
            if _HEVC_SPS_ID in used[HEVC_SPS]:
                raise _failed("this video uses every parameter-set ID.")
            ids = HevcIds(
                _free(used[HEVC_VPS], range(16)),
                _HEVC_SPS_ID,
                _free(used[HEVC_PPS], _HEVC_PPS_IDS),
            )
        chunks: dict[ExactRegion, Path] = {}
        edge_sets: tuple[bytes, ...] | None = None
        frames = analysis.frames
        for number, region in enumerate(exact_regions(plan)):
            context, encoders = _open_edge_encoder(encoders, analysis, picture, parameter_id)
            sets = _edge_parameter_sets(codec, context.extradata)
            # every edge must share one configuration, since the decoder configuration lists
            # its parameter sets once
            if edge_sets is not None and sets != edge_sets:
                raise _failed("the encoded edges used different settings.")
            edge_sets = sets
            chunk = workspace / f"edge-{number}.bin"
            count = 0
            with chunk.open("wb") as out:

                def write(packets: list[av.Packet]) -> None:
                    nonlocal count
                    for packet in packets:
                        payload = _edge_payload(codec, bytes(packet), length_size, ids.pps)
                        _write_record(out, packet.is_keyframe or count == 0, payload)
                        count += 1

                for index, frame in enumerate(
                    _source_frames(source, analysis, region.start, region.end, cancel)
                ):
                    if frame.format.name != picture.pixel_format:
                        frame = frame.reformat(format=picture.pixel_format)
                    frame.pts = index
                    frame.time_base = context.time_base
                    # decoded picture types would force extra key frames in some encoders
                    frame.pict_type = PictureType.NONE
                    write(context.encode(frame))
                    on_frame()
                write(context.encode(None))
            wanted = bisect_left(frames, region.end) - bisect_left(frames, region.start)
            if count != wanted:
                raise _failed("an encoded edge has the wrong number of frames.")
            chunks[region] = chunk
        extradata = original
        if avc is not None and edge_sets:
            edge = AvcConfig.from_annex_b(b"".join(b"\x00\x00\x01" + u for u in edge_sets))
            if edge.sps_ids() != {parameter_id} or edge.pps_ids() != {parameter_id}:
                raise _failed("an encoded edge used unexpected parameter sets.")
            extradata = avc.merged(edge)
        if hevc is not None and edge_sets:
            extradata = hevc.with_units(renumber_hevc_parameter_set(u, ids) for u in edge_sets)
        entry = b""
        if codec == "av1" and len(original) > 4:
            entry = b"".join(
                obu for kind, obu in av1_obus(original[4:]) if kind == AV1_SEQUENCE_HEADER
            )
    except BitstreamError as exc:
        raise _failed(f"{exc}.") from exc
    except FFmpegError as exc:
        raise _failed(f"the edge encoder could not encode a cut edge. {exc}") from exc
    # a plan that encodes nothing keeps the source configuration byte for byte
    return ExactEdges(chunks, extradata, entry)


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
    frames = analysis.frames
    ends = (*frames[1:], analysis.duration.seconds)
    presented = output_frame_times(plan, analysis)
    decoding = decode_times(presented, analysis.reorder_frames)
    last_length = (
        to_ticks(plan.exported_duration.seconds, time_base) - to_ticks(presented[-1], time_base)
        if presented
        else 0
    )
    # pieces of the output in ticks: (start, end, encoded region or None, source-to-output)
    pieces: list[tuple[int, int, ExactRegion | None, Fraction]] = []
    elapsed = Fraction(0)
    regions = iter(sorted(edges.chunks, key=lambda r: (r.segment, r.start)))
    pending = next(regions, None)

    def piece(
        first: Fraction, last: Fraction, region: ExactRegion | None, offset: Fraction
    ) -> None:
        span = (to_ticks(first + offset, time_base), to_ticks(last + offset, time_base))
        pieces.append((*span, region, offset))

    for index, segment in enumerate(plan.segments):
        start, end = segment.resolved.start.seconds, segment.resolved.end.seconds
        if segment.start_kind == "collapsed":
            continue
        offset = elapsed - start
        cursor = start
        while pending is not None and pending.segment == index:
            if pending.start > cursor:
                piece(cursor, pending.start, None, offset)
            piece(pending.start, pending.end, pending, offset)
            cursor = pending.end
            pending = next(regions, None)
        if cursor < end:
            piece(cursor, end, None, offset)
        elapsed += end - start
    decoded = 0

    def retime(packet: av.Packet, pts: int) -> av.Packet:
        nonlocal decoded
        if decoded >= len(decoding):
            raise CutAnalysisError("plan_changed", "The video frames changed since analysis.")
        packet.time_base = base
        packet.pts = pts
        packet.dts = to_ticks(decoding[decoded], time_base)
        if decoded == len(decoding) - 1:
            # the last picture decoded lasts as long as the last frame shown; see decode_times
            packet.duration = last_length
        decoded += 1
        return packet

    def encoded(region: ExactRegion, offset: Fraction) -> Iterator[av.Packet]:
        low = bisect_left(frames, region.start)
        for number, (key, payload) in enumerate(_read_chunk(edges.chunks[region])):
            if cancel.is_set():
                raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.")
            frame = low + number
            packet = av.Packet(payload)
            packet.stream = video_stream
            packet.is_keyframe = key
            shown = to_ticks(frames[frame] + offset, time_base)
            packet.duration = to_ticks(ends[frame] + offset, time_base) - shown
            yield retime(packet, shown)

    position = 0
    after_edge = False

    def flush_encoded() -> Iterator[av.Packet]:
        nonlocal position, after_edge
        while position < len(pieces):
            _, _, region, offset = pieces[position]
            if region is None:
                return
            yield from encoded(region, offset)
            after_edge = True
            position += 1

    for packet in video_and_audio:
        if packet.stream.type != "video":
            yield packet
            continue
        if packet.pts is None or packet.time_base is None:
            raise _failed("a video packet has no timestamp.")
        moment = packet.pts
        yield from flush_encoded()
        while position < len(pieces) and moment >= pieces[position][1]:
            position += 1
            yield from flush_encoded()
        if position < len(pieces) and pieces[position][0] <= moment < pieces[position][1]:
            if after_edge and edges.entry_header:
                packet = _with_entry_header(packet, edges.entry_header)
            after_edge = False
            yield retime(packet, moment)
    while position < len(pieces):
        yield from flush_encoded()
        position += 1
    if decoded != len(decoding):
        raise _failed("the joined video has the wrong number of frames.")


def _with_entry_header(packet: av.Packet, header: bytes) -> av.Packet:
    """An AV1 key frame after an edge must bring back the source's sequence header."""
    try:
        if any(kind == AV1_SEQUENCE_HEADER for kind, _ in av1_obus(bytes(packet))):
            return packet
    except BitstreamError as exc:
        raise _failed(f"{exc}.") from exc
    copy = av.Packet(header + bytes(packet))
    copy.stream = packet.stream
    copy.time_base = packet.time_base
    copy.pts, copy.dts, copy.duration = packet.pts, packet.dts, packet.duration
    copy.is_keyframe = packet.is_keyframe
    return copy
