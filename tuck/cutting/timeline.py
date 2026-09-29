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


def _safe_ends(decode_order: list[int], last_end: int, origin: int) -> list[int]:
    """Ends where every frame decoded so far is shown before every frame decoded later."""
    suffix_min = [0] * (len(decode_order) + 1)
    suffix_min[-1] = last_end
    for index in range(len(decode_order) - 1, -1, -1):
        suffix_min[index] = min(decode_order[index], suffix_min[index + 1])
    ends = []
    highest: int | None = None
    for index, pts in enumerate(decode_order):
        highest = pts if highest is None else max(highest, pts)
        if highest < suffix_min[index + 1]:
            ends.append(suffix_min[index + 1] - origin)
    return ends


def _reorder_depth(decode_order: list[int], presented: list[int]) -> int:
    """How many frames the decoder holds back before showing one."""
    rank = {pts: index for index, pts in enumerate(presented)}
    return max(0, max(index - rank[pts] for index, pts in enumerate(decode_order)))


def _typical_step(presented: list[int]) -> tuple[int, bool]:
    """The most common frame spacing, and whether every frame uses it."""
    counts: dict[int, int] = {}
    for delta in (b - a for a, b in pairwise(presented)):
        counts[delta] = counts.get(delta, 0) + 1
    return max(counts, key=lambda d: (counts[d], -d)), len(counts) == 1


class _VideoScan:
    """Timing and entry-point facts gathered from video packets in file order.

    Times stay in ticks of the video's time base until the end: fraction math on every frame
    of a long video costs seconds.
    """

    def __init__(self, codec: str, length_size: int | None) -> None:
        self.codec = codec
        self.length_size = length_size
        self.base: Fraction | None = None
        self.decode_order: list[int] = []
        self.decode_times: list[int | None] = []
        self.durations: dict[int, int] = {}
        self.key_times: list[int] = []
        self.unverified = False
        self.decode_delay = 0
        self.all_intra = True

    def add(self, packet: av.Packet, pts: int, duration: int, base: Fraction) -> None:
        if pts in self.durations:
            raise TimelineError(
                "unsupported_codec", "The video repeats a frame timestamp and cannot be cut."
            )
        self.base = base
        self.durations[pts] = duration
        self.decode_order.append(pts)
        dts = packet.dts
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
        base = self.base
        if base is None or len(self.decode_order) < 2:
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
        frames = tuple((t - origin) * base for t in presented)
        return VideoTimeline(
            video.index,
            self.codec,
            origin * base,
            frames,
            (presented[-1] + last - origin) * base,
            frames
            if self.all_intra
            else tuple((t - origin) * base for t in sorted(set(self.key_times))),
            self.unverified and not self.all_intra,
            tuple(
                end * base for end in _safe_ends(self.decode_order, presented[-1] + last, origin)
            ),
            self.decode_delay * base,
            step * base,
            constant,
            regular,
            video.frames,
            video.duration * Fraction(video.time_base)
            if video.duration is not None and video.time_base is not None
            else None,
            _reorder_depth(self.decode_order, presented),
        )


class _KeyframeReport:
    """Report the keyframes found so far every 256 frames.

    Each report only does work for the keyframes found since the last one, so a long video
    is not walked again from the start for every report.
    """

    def __init__(
        self, on_frames: Callable[[tuple[Fraction, ...], Fraction], None], base: Fraction
    ) -> None:
        self._on_frames = on_frames
        self._base = base
        self._first: int | None = None
        self._latest: int | None = None
        # relative to the first keyframe, which later keyframes never change
        self._keys: list[Fraction] = []
        self._frames = 0

    def add(self, pts: int, keyframe: bool) -> None:
        if self._latest is None or pts > self._latest:
            self._latest = pts
        if keyframe:
            if self._first is None:
                self._first = pts
            self._keys.append((pts - self._first) * self._base)
        self._frames += 1
        if self._frames % 256 == 0:
            self.send()

    def send(self) -> None:
        if self._first is not None and self._latest is not None:
            self._on_frames(tuple(self._keys), (self._latest - self._first) * self._base)


# in ticks of the stream's time base: start, duration, skipped and discarded samples, key flag
_RawPacket = tuple[int, int, int, int, bool]


def _raw_packet(packet: av.Packet, pts: int) -> _RawPacket:
    side = bytes(packet.get_sidedata("skip_samples")) if packet.stream.type == "audio" else b""
    return (
        pts,
        packet.duration or 0,
        int.from_bytes(side[:4], "little") if len(side) >= 4 else 0,
        int.from_bytes(side[4:8], "little") if len(side) >= 8 else 0,
        packet.is_keyframe,
    )


def _relative_packets(
    packets: list[_RawPacket], base: Fraction, origin: Fraction
) -> tuple[PacketTime, ...]:
    # ticks * base - origin over one denominator, so each start is a single fraction
    scale = base.numerator * origin.denominator
    shift = origin.numerator * base.denominator
    denominator = base.denominator * origin.denominator
    return tuple(
        PacketTime(
            Fraction(pts * scale - shift, denominator),
            Fraction(duration * base.numerator, base.denominator),
            skip,
            discard,
            keyframe,
        )
        for pts, duration, skip, discard, keyframe in packets
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


def _main_video(container: InputContainer) -> VideoStream | None:
    # cover art is stored as a one-frame video stream
    return next(
        (
            s
            for s in container.streams.video
            if not s.disposition.value & Disposition.attached_pic.value
        ),
        None,
    )


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
            video = _main_video(container)
            if video is None:
                raise TimelineError("unsupported_stream", "This file has no video to cut.")
            codec = video.codec_context.codec.canonical_name
            scan = _VideoScan(codec, nal_length_size(codec, video.codec_context.extradata))
            others: dict[int, list[_RawPacket]] = {}
            streams: dict[int, tuple[Stream, Fraction]] = {}
            # every packet of a stream carries that stream's time base, so it is read once
            bases: dict[int, Fraction | None] = {}
            report: _KeyframeReport | None = None
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
                index = packet.stream.index
                if index not in bases:
                    time_base = packet.time_base
                    bases[index] = Fraction(time_base) if time_base is not None else None
                base = bases[index]
                pts = packet.pts
                if base is None or pts is None:
                    if index == video.index:
                        raise TimelineError(
                            "unsupported_codec",
                            "This video's packets have no timestamps to cut by.",
                        )
                    continue
                if index != video.index:
                    others.setdefault(index, []).append(_raw_packet(packet, pts))
                    streams.setdefault(index, (packet.stream, base))
                    continue
                scan.add(packet, pts, packet.duration or 0, base)
                if on_frames is not None:
                    report = report or _KeyframeReport(on_frames, base)
                    report.add(pts, packet.is_keyframe)
            timeline = scan.timeline(video)
            origin = timeline.origin
            tracks = []
            for index, packets in sorted(others.items()):
                stream, base = streams[index]
                tracks.append(
                    StreamPackets(
                        index,
                        stream.type,
                        stream.codec_context.codec.canonical_name
                        if stream.codec_context
                        else "unknown",
                        _relative_packets(packets, base, origin),
                        _declared_duration(stream),
                    )
                )
            return MediaTimeline(
                container.format.name,
                timeline,
                tuple(tracks),
                Fraction(container.duration or 0, av.time_base),
                _chapters(container, origin),
            )
    except FFmpegError as exc:
        raise TimelineError("analysis_failed", "The video packets could not be read.") from exc


def sweep_keyframes(
    path: str,
    stopped: Callable[[], bool],
    on_frames: Callable[[tuple[Fraction, ...], Fraction], None],
) -> None:
    """Report keyframe times from the container's keyframe flags, for display only.

    This runs beside the checked analysis, so the timeline fills in sooner.
    Times use the same base as read_timeline's progress. Nothing here is trusted to plan a cut.
    """
    with av.open(path) as container:
        video = _main_video(container)
        if video is None:
            return
        # MP4 and MOV list every keyframe in the index read when the file opens
        if "mov" in container.format.name.split(","):
            walked = _walk_keyframes(container, video, stopped)
            if walked is not None:
                keys, end = walked
                on_frames(tuple(k - keys[0] for k in keys), max(end, keys[-1]) - keys[0])
                return
    # the index could not be followed, so read every packet instead
    if stopped():
        return
    with av.open(path) as container:
        video = _main_video(container)
        if video is None or video.time_base is None:
            return
        report = _KeyframeReport(on_frames, Fraction(video.time_base))
        for packet in container.demux(video):
            if stopped():
                return
            if packet.pts is None or not packet.size:
                continue
            report.add(packet.pts, packet.is_keyframe)
        report.send()


def _walk_keyframes(
    container: InputContainer, video: VideoStream, stopped: Callable[[], bool]
) -> tuple[list[Fraction], Fraction] | None:
    """Jump from each keyframe to the next through the container's index.

    This reads one packet per keyframe instead of the whole file. Returns the keyframes and
    where the video ends, or None when a jump does not land where it should.
    """
    if video.time_base is None:
        return None
    base = Fraction(video.time_base)
    keys: list[Fraction] = []
    target: int | None = None
    while not stopped():
        if target is not None:
            try:
                # without backward, this lands on the first keyframe at or after the target
                container.seek(target, backward=False, stream=video)
            except FFmpegError:
                # there is nothing to land on after the last keyframe
                break
        packet = next((p for p in container.demux(video) if p.size), None)
        if packet is None:
            break
        if packet.pts is None or not packet.is_keyframe:
            return None
        pts = packet.pts * base
        if keys and pts <= keys[-1]:
            return None
        keys.append(pts)
        target = packet.pts + 1
    else:
        return None
    if not keys:
        return None
    if video.duration is not None and video.start_time is not None:
        return keys, (video.start_time + video.duration) * base
    return keys, Fraction(container.duration or 0, av.time_base)
