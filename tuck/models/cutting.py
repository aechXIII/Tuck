"""Cut intent, measured media boundaries, and export previews."""

from dataclasses import dataclass
from fractions import Fraction


@dataclass(frozen=True)
class MediaTime:
    ticks: int
    time_base_num: int = 1
    time_base_den: int = 1

    def __post_init__(self) -> None:
        if type(self.ticks) is not int or abs(self.ticks) >= 2**63:
            raise ValueError("Time ticks must be a signed 64-bit integer")
        if any(
            type(v) is not int or not 0 < v < 2**31
            for v in (self.time_base_num, self.time_base_den)
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


@dataclass(frozen=True)
class CutIssue:
    code: str
    message: str
    field: str | None = None


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
    exact_available: bool = False
    exact_reason: str = "Exact cutting is not available in this build."


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

    @property
    def source(self) -> str:
        return self.identity.path

    @property
    def output(self) -> str:
        return self.output_path
