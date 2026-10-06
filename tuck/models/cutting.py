"""Cut intent, measured media boundaries, and export previews."""

import math
from dataclasses import dataclass, field
from fractions import Fraction
from functools import cached_property


@dataclass(frozen=True)
class MediaTime:
    ticks: int
    time_base_num: int = 1
    time_base_den: int = 1

    def __post_init__(self) -> None:
        if type(self.ticks) is not int or abs(self.ticks) >= 2**63:
            raise ValueError("Time ticks must be a signed 64-bit integer")
        # checked without a loop: an analysis builds hundreds of thousands of these
        num, den = self.time_base_num, self.time_base_den
        if (
            type(num) is not int
            or type(den) is not int
            or not 0 < num < 2**31
            or not 0 < den < 2**31
        ):
            raise ValueError("Time base must contain positive 32-bit integers")

    @property
    def seconds(self) -> Fraction:
        return Fraction(self.ticks * self.time_base_num, self.time_base_den)

    @classmethod
    def from_seconds(cls, seconds: Fraction) -> "MediaTime":
        return cls(seconds.numerator, 1, seconds.denominator)

    def to_dict(self) -> dict[str, str | int]:
        return {
            "ticks": str(self.ticks),
            "time_base_num": self.time_base_num,
            "time_base_den": self.time_base_den,
        }

    @classmethod
    def from_dict(cls, raw: object) -> "MediaTime":
        if not isinstance(raw, dict) or set(raw) != {"ticks", "time_base_num", "time_base_den"}:
            raise ValueError("Expected time ticks and time base")
        ticks, num, den = raw["ticks"], raw["time_base_num"], raw["time_base_den"]
        if (
            not isinstance(ticks, str)
            or len(ticks) > 20
            or not ticks.removeprefix("-").isascii()
            or not ticks.removeprefix("-").isdigit()
        ):
            raise ValueError("Time ticks must be a decimal string")
        if type(num) is not int or type(den) is not int:
            raise ValueError("Time base must contain integers")
        return cls(int(ticks), num, den)


@dataclass(frozen=True)
class SourceIdentity:
    path: str
    size: int
    mtime_ns: int
    signature: str


# every code a cut request can fail with; the desktop bridge passes only these through
CUT_ERROR_CODES = frozenset(
    {
        "analysis_cancelled",
        "analysis_failed",
        "analysis_required",
        "cut_cancelled",
        "cut_failed",
        "cut_timed_out",
        "exact_unavailable",
        "incompatible_edit",
        "invalid_cut_request",
        "invalid_output",
        "invalid_range",
        "plan_changed",
        "segment_collapsed",
        "source_changed",
        "unsupported_codec",
        "unsupported_cut",
        "unsupported_stream",
        "verification_failed",
    }
)


@dataclass(frozen=True)
class CutIssue:
    code: str
    message: str
    field: str | None = None
    # a short heading for notices that show the message below it
    title: str = ""


@dataclass(frozen=True)
class StreamDescriptor:
    index: int
    kind: str
    codec: str
    properties: tuple[tuple[str, str], ...]
    metadata: tuple[tuple[str, str], ...]
    dispositions: tuple[str, ...]


@dataclass(frozen=True)
class PacketTiming:
    start: MediaTime
    duration: MediaTime
    skip_samples: int = 0
    discard_samples: int = 0


@dataclass(frozen=True)
class WholeTimes:
    """Packet starts, ends and durations as whole numbers over one shared denominator."""

    denominator: int
    starts: tuple[int, ...]
    ends: tuple[int, ...]
    durations: tuple[int, ...]


@dataclass(frozen=True)
class TrackPackets:
    """Packet timings of a track other than the main video, relative to the video origin."""

    index: int
    kind: str
    codec: str
    packets: tuple[PacketTiming, ...]

    @cached_property
    def whole_times(self) -> WholeTimes:
        # planning and copying walk every packet of an hour of audio on each change, and
        # whole numbers keep that fast; worked out once per analysis
        denominator = math.lcm(
            1, *{t.time_base_den for p in self.packets for t in (p.start, p.duration)}
        )
        starts = tuple(
            p.start.ticks * p.start.time_base_num * (denominator // p.start.time_base_den)
            for p in self.packets
        )
        durations = tuple(
            p.duration.ticks * p.duration.time_base_num * (denominator // p.duration.time_base_den)
            for p in self.packets
        )
        return WholeTimes(
            denominator,
            starts,
            tuple(start + duration for start, duration in zip(starts, durations, strict=True)),
            durations,
        )


@dataclass(frozen=True)
class Chapter:
    start: MediaTime
    end: MediaTime
    title: str


@dataclass(frozen=True)
class CutAnalysis:
    identity: SourceIdentity
    streams: tuple[StreamDescriptor, ...]
    origin: MediaTime
    frame_duration: MediaTime
    duration: MediaTime
    keyframes: tuple[MediaTime, ...]
    safe_ends: tuple[MediaTime, ...]
    audio_packets: tuple[PacketTiming, ...]
    max_pts_dts_lag: MediaTime
    issues: tuple[CutIssue, ...]
    version: str
    # every video frame's presentation time in seconds, relative to the origin
    frames: tuple[Fraction, ...] = ()
    tracks: tuple[TrackPackets, ...] = ()
    chapters: tuple[Chapter, ...] = ()
    format_name: str = "mp4"
    video_index: int = 0
    # how many frames the decoder holds back before showing one
    reorder_frames: int = 0
    # facts that could not be confirmed; the cut still works and says so
    unverified: tuple[CutIssue, ...] = ()
    # keyframes a copy may start the output at, but never join after other pictures
    open_keyframes: tuple[MediaTime, ...] = ()


@dataclass(frozen=True)
class AnalysisProgress:
    progress: float | None
    coverage_end: MediaTime
    keyframes: tuple[MediaTime, ...] = ()


@dataclass(frozen=True)
class CutRange:
    start: MediaTime
    end: MediaTime


@dataclass(frozen=True)
class CutRequest:
    source: str
    segments: tuple[CutRange, ...]
    precision: str
    include_audio: bool
    edits: tuple[str, ...]
    without_edits: bool
    output_dir: str
    output_name: str


@dataclass(frozen=True)
class CutSegment:
    requested: CutRange
    resolved: CutRange
    start_kind: str
    end_frames_moved: int
    audio_source: CutRange | None = None
    audio_output: CutRange | None = None
    audio_packet_count: int = 0
    # Exact plans only: the part copied between the encoded edges, or None when the whole
    # segment is encoded. Keyframe plans copy all of `resolved`.
    copied: CutRange | None = None


@dataclass(frozen=True)
class TrackSegment:
    """What one kept segment takes from a non-video track."""

    # source packets from `first` up to (not including) `stop`, in demux order
    first: int
    stop: int
    # where the first chosen packet starts in the output
    output_start: MediaTime
    # subtitle packets are clipped to the segment instead of copied whole
    clip: bool = False


@dataclass(frozen=True)
class TrackPlan:
    index: int
    kind: str
    codec: str
    keep: bool
    reason: str = ""
    segments: tuple[TrackSegment, ...] = ()


@dataclass(frozen=True)
class CutPlan:
    identity: SourceIdentity
    segments: tuple[CutSegment, ...]
    precision: str
    include_audio: bool
    output_path: str
    exported_duration: MediaTime
    estimated_bytes: int
    issues: tuple[CutIssue, ...]
    exact_available: bool
    exact_reason: str
    fingerprint: str
    container: str = "mp4"
    request: CutRequest | None = None
    tracks: tuple[TrackPlan, ...] = ()
    chapters: tuple[Chapter, ...] = ()
    # checks that cannot be made for this video; shown as "Not checked"
    unverified: tuple[CutIssue, ...] = ()
    # the analysis the plan was made from; reused at export while the file's bytes still match
    analysis: CutAnalysis | None = field(default=None, compare=False, repr=False)
    # a setting applied when the cut is saved; it doesn't change what is cut
    keep_file_dates: bool = field(default=False, compare=False)
    replace_existing: bool = field(default=False, compare=False)

    @property
    def source(self) -> str:
        return self.identity.path

    @property
    def output(self) -> str:
        return self.output_path
