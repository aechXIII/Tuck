"""Read the packet timeline of any container: frame times, entry points and safe ends."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise
from threading import Event

import av
from av.container import InputContainer
from av.error import FFmpegError
from av.stream import Disposition, Stream
from av.video.stream import VideoStream

from .bitstream import nal_length_size, nal_units

MAX_PACKETS = 500_000
MAX_PACKET_BYTES = 32 * 1024 * 1024

# codecs whose every frame can be decoded on its own
INTRA_ONLY = {
    "mjpeg",
    "prores",
    "dnxhd",
    "ffv1",
    "huffyuv",
    "utvideo",
    "png",
    "qtrle",
    "rawvideo",
    "cfhd",
    "hap",
    "v210",
    "jpeg2000",
}
# codecs whose key frames are always clean entry points
CLEAN_KEY_FRAMES = {"av1", "vp8", "vp9"}


class TimelineError(ValueError):
    """The file cannot be cut by copying packets; `code` is a cut issue code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PacketTime:
    start: Fraction
    duration: Fraction
    skip_samples: int = 0
    discard_samples: int = 0
    keyframe: bool = False


@dataclass(frozen=True)
class StreamPackets:
    index: int
    kind: str
    codec: str
    # in demux order, with times relative to the video origin
    packets: tuple[PacketTime, ...]
    # the container's own duration for this track, when it states one
    declared_duration: Fraction | None = None


@dataclass(frozen=True)
class VideoTimeline:
    index: int
    codec: str
    # absolute presentation time of the first frame
    origin: Fraction
    # relative presentation times, in presentation order
    frames: tuple[Fraction, ...]
    end: Fraction
    # clean entry points, relative to the origin
    keyframes: tuple[Fraction, ...]
    # true when some entry points rely on the container's key flag alone
    unverified_keyframes: bool
    # ends where every earlier frame, in decode order, is already complete
    safe_ends: tuple[Fraction, ...]
    # the largest PTS minus DTS in the source, zero when the container has no DTS
    decode_delay: Fraction
    # the most common frame duration
    nominal_step: Fraction
    constant_rate: bool
    # decode timestamps step by the frame duration without gaps
    regular_decode: bool
    declared_frames: int
    # the container's own video duration, when it states one
    declared_video_duration: Fraction | None
    # how many frames the decoder holds back before showing one
    reorder_frames: int = 0


@dataclass(frozen=True)
class MediaTimeline:
    format_name: str
    video: VideoTimeline
    others: tuple[StreamPackets, ...]
    declared_duration: Fraction
    # (start, end, title), relative to the video origin
    chapters: tuple[tuple[Fraction, Fraction, str], ...] = ()


def is_clean_entry(codec: str, payload: bytes, length_size: int | None) -> bool | None:
    """Whether a key-flagged packet is a clean entry point, or None when unknown."""
    if codec == "h264":
        return any(unit[0] & 0x1F == 5 for unit in nal_units(payload, length_size))
    if codec == "hevc":
        # IDR, CRA and BLA pictures; leading pictures shown before them are dropped
        return any(16 <= (unit[0] >> 1) & 0x3F <= 21 for unit in nal_units(payload, length_size))
    if codec in CLEAN_KEY_FRAMES or codec in INTRA_ONLY:
        return True
    return None


def _check(cancel: Event) -> None:
    if cancel.is_set():
        raise TimelineError("analysis_cancelled", "Keyframe analysis was cancelled.")


def _safe_ends(
    decode_order: list[Fraction], last_end: Fraction, origin: Fraction
) -> tuple[Fraction, ...]:
    """Ends where every frame decoded so far is shown before every frame decoded later."""
    suffix_min = [Fraction(0)] * (len(decode_order) + 1)
    suffix_min[-1] = last_end
    for index in range(len(decode_order) - 1, -1, -1):
        suffix_min[index] = min(decode_order[index], suffix_min[index + 1])
    ends = []
    highest: Fraction | None = None
    for index, pts in enumerate(decode_order):
        highest = pts if highest is None else max(highest, pts)
        if highest < suffix_min[index + 1]:
            ends.append(suffix_min[index + 1] - origin)
    return tuple(ends)


def _reorder_depth(decode_order: list[Fraction], presented: list[Fraction]) -> int:
    """How many frames the decoder holds back before showing one."""
    rank = {pts: index for index, pts in enumerate(presented)}
    return max(0, max(index - rank[pts] for index, pts in enumerate(decode_order)))


def _typical_step(presented: list[Fraction]) -> tuple[Fraction, bool]:
    """The most common frame spacing, and whether every frame uses it."""
    counts: dict[Fraction, int] = {}
    for delta in (b - a for a, b in pairwise(presented)):
        counts[delta] = counts.get(delta, 0) + 1
    return max(counts, key=lambda d: (counts[d], -d)), len(counts) == 1


class _VideoScan:
    """Timing and entry-point facts gathered from video packets in file order."""

    def __init__(self, codec: str, length_size: int | None) -> None:
        self.codec = codec
        self.length_size = length_size
        self.decode_order: list[Fraction] = []
        self.decode_times: list[Fraction | None] = []
        self.durations: dict[Fraction, Fraction] = {}
        self.key_times: list[Fraction] = []
        self.unverified = False
        self.decode_delay = Fraction(0)
        self.all_intra = True

    def add(self, packet: av.Packet, pts: Fraction, duration: Fraction, base: Fraction) -> None:
        if pts in self.durations:
            raise TimelineError(
                "unsupported_codec", "The video repeats a frame timestamp and cannot be cut."
            )
        self.durations[pts] = duration
        self.decode_order.append(pts)
        dts = packet.dts * base if packet.dts is not None else None
        self.decode_times.append(dts)
        if dts is not None:
            self.decode_delay = max(self.decode_delay, pts - dts)
        self.all_intra &= packet.is_keyframe
        if packet.is_keyframe:
            # a keyframe the codec rules cannot confirm is still usable; frames shown
            # before it belong to the removed part, but the start is not verified
            self.key_times.append(pts)
            clean = is_clean_entry(self.codec, bytes(packet), self.length_size)
            self.unverified |= clean is not True

    def timeline(self, video: VideoStream) -> VideoTimeline:
        if len(self.decode_order) < 2:
            raise TimelineError("unsupported_codec", "The video is too short to cut.")
        presented = sorted(self.decode_order)
        origin = presented[0]
        if not self.key_times or min(self.key_times) != origin:
            raise TimelineError(
                "unsupported_codec", "The video does not begin at a clean entry point."
            )
        step, constant = _typical_step(presented)
        last = self.durations[presented[-1]] or step
        known_dts = [t for t in self.decode_times if t is not None]
        regular = len(known_dts) == len(self.decode_times) and all(
            b - a == step for a, b in pairwise(known_dts)
        )
        frames = tuple(t - origin for t in presented)
        return VideoTimeline(
            video.index,
            self.codec,
            origin,
            frames,
            presented[-1] + last - origin,
            frames if self.all_intra else tuple(sorted({t - origin for t in self.key_times})),
            self.unverified and not self.all_intra,
            _safe_ends(self.decode_order, presented[-1] + last, origin),
            self.decode_delay,
            step,
            constant,
            regular,
            video.frames,
            video.duration * Fraction(video.time_base)
            if video.duration is not None and video.time_base is not None
            else None,
            _reorder_depth(self.decode_order, presented),
        )


def _packet_time(packet: av.Packet, pts: Fraction, duration: Fraction) -> PacketTime:
    side = bytes(packet.get_sidedata("skip_samples")) if packet.stream.type == "audio" else b""
    return PacketTime(
        pts,
        duration,
        int.from_bytes(side[:4], "little") if len(side) >= 4 else 0,
        int.from_bytes(side[4:8], "little") if len(side) >= 8 else 0,
        packet.is_keyframe,
    )


def _declared_duration(stream: Stream) -> Fraction | None:
    if stream.duration is None or stream.time_base is None:
        return None
    return stream.duration * Fraction(stream.time_base)


def _chapters(
    container: InputContainer, origin: Fraction
) -> tuple[tuple[Fraction, Fraction, str], ...]:
    chapters = []
    for chapter in container.chapters():
        base = chapter["time_base"]
        if base is None:
            continue
        chapters.append(
            (
                Fraction(chapter["start"]) * base - origin,
                Fraction(chapter["end"]) * base - origin,
                str(chapter.get("metadata", {}).get("title", "")),
            )
        )
    return tuple(chapters)


def read_timeline(
    path: str,
    cancel: Event,
    on_frames: Callable[[tuple[Fraction, ...], Fraction], None] | None = None,
    *,
    max_packets: int = MAX_PACKETS,
    check_cancel: Callable[[Event], None] = _check,
) -> MediaTimeline:
    """Read every packet once, keeping only timing and entry-point facts."""
    try:
        with av.open(path) as container:
            videos = [
                s
                for s in container.streams.video
                if not s.disposition.value & Disposition.attached_pic.value
            ]
            if not videos:
                raise TimelineError("unsupported_stream", "This file has no video to cut.")
            video = videos[0]
            codec = video.codec_context.codec.canonical_name
            scan = _VideoScan(codec, nal_length_size(codec, video.codec_context.extradata))
            others: dict[int, list[PacketTime]] = {}
            streams: dict[int, Stream] = {}
            for count, packet in enumerate(container.demux(), 1):
                check_cancel(cancel)
                if count > max_packets or packet.size > MAX_PACKET_BYTES:
                    raise TimelineError(
                        "unsupported_stream", "This video exceeds the current cut analysis limit."
                    )
                if not packet.size:
                    continue
                if packet.is_corrupt:
                    raise TimelineError(
                        "unsupported_stream", "The video does not contain complete media packets."
                    )
                if packet.time_base is None or packet.pts is None:
                    if packet.stream.index == video.index:
                        raise TimelineError(
                            "unsupported_codec",
                            "This video's packets have no timestamps to cut by.",
                        )
                    continue
                base = Fraction(packet.time_base)
                pts = packet.pts * base
                duration = packet.duration * base if packet.duration else Fraction(0)
                if packet.stream.index != video.index:
                    others.setdefault(packet.stream.index, []).append(
                        _packet_time(packet, pts, duration)
                    )
                    streams.setdefault(packet.stream.index, packet.stream)
                    continue
                scan.add(packet, pts, duration, base)
                if len(scan.decode_order) % 256 == 0 and on_frames is not None and scan.key_times:
                    first = scan.key_times[0]
                    keys = tuple(t - first for t in scan.key_times)
                    on_frames(keys, max(scan.decode_order) - first)
            timeline = scan.timeline(video)
            origin = timeline.origin
            return MediaTimeline(
                container.format.name,
                timeline,
                tuple(
                    StreamPackets(
                        index,
                        streams[index].type,
                        streams[index].codec_context.codec.canonical_name
                        if streams[index].codec_context
                        else "unknown",
                        tuple(
                            PacketTime(
                                p.start - origin,
                                p.duration,
                                p.skip_samples,
                                p.discard_samples,
                                p.keyframe,
                            )
                            for p in packets
                        ),
                        _declared_duration(streams[index]),
                    )
                    for index, packets in sorted(others.items())
                ),
                Fraction(container.duration or 0, av.time_base),
                _chapters(container, origin),
            )
    except FFmpegError as exc:
        raise TimelineError("analysis_failed", "The video packets could not be read.") from exc
