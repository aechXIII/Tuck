"""How big a Quality export will be.

A quality level has no size until the encoder has seen the picture, so the estimate encodes a few
short pieces of the export with its own settings and scales them to its length. Each piece is
its own FFmpeg run, seeking to its own start (one run of several pieces decodes everything before
the last one), and the runs go at the same time: that halves the wait on a GPU and takes a
quarter off x264, while x265 and the slow x264 presets already fill the CPU alone.

x264's `veryslow`, which Auto (best compression) uses, is the one setting where that is still slow
(14-20 s on a laptop), so its pieces are encoded at `medium` and scaled by how much smaller
`veryslow` makes the same video.
"""

from __future__ import annotations

import dataclasses
import shutil
import tempfile
import threading
from collections.abc import Callable
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path

from .encoding.capabilities import auto_encoder_choices
from .encoding.runner import EncodeCancelled, FFmpegEngine
from .models import ENCODER_AUTO_COMPRESSION, EncodePlan, Segment

# three pieces of a second each came within 4% of the whole encode on most 1440p60 and 1080p60
# recordings (8% at worst) with x264, x265 and VA-API, in 0.8 to 1.8 s on the GPU and 2.9 to
# 10.5 s on a laptop CPU. More or longer pieces weren't more accurate, and half-second pieces
# were up to 29% over: each piece starts on a keyframe, which is most of a short piece of a
# calm video
PIECE_COUNT = 3
PIECE_SECONDS = 1.0
# veryslow's whole encodes were 0.83 to 0.91 of medium's at the same CRF on six clips, at nearly
# the same SSIM; estimating from medium pieces this way was 5% off on average and 11% at worst
# (veryslow's own pieces: 3.5% and 6%) in about a fifth of the time
VERYSLOW_OF_MEDIUM = 0.87


def stand_in(plan: EncodePlan) -> tuple[EncodePlan, float]:
    """The plan the pieces are encoded with, and what scales their video to the export's."""
    if plan.video_encoder == ENCODER_AUTO_COMPRESSION:
        # Auto runs its software choice at veryslow; a GPU choice stays as it is
        slow_x264 = auto_encoder_choices()[ENCODER_AUTO_COMPRESSION] == "libx264"
    else:
        slow_x264 = plan.video_encoder == "libx264" and plan.preset == "veryslow"
    if not slow_x264:
        return plan, 1.0
    return dataclasses.replace(plan, video_encoder="libx264", preset="medium"), VERYSLOW_OF_MEDIUM


@dataclass(frozen=True)
class SizeEstimate:
    size_bytes: int
    video_bytes: int
    audio_bytes: int
    # the seconds of video that were encoded; the whole export when it is this short
    sampled_seconds: float
    encoder: str


def sample_pieces(
    segments: list[Segment], count: int = PIECE_COUNT, length: float = PIECE_SECONDS
) -> list[Segment]:
    """Pieces spread evenly over the export, each inside one of its segments.

    A short export is encoded whole, so its estimate is its size.
    """
    total = sum(segment.duration for segment in segments)
    if total <= 0:
        return []
    if total <= count * length * 2 and len(segments) <= count:
        return [Segment(segment.start, segment.end) for segment in segments]
    pieces: list[Segment] = []
    for index in range(count):
        middle = total * (index + 0.5) / count
        for segment in segments:
            if middle > segment.duration:
                middle -= segment.duration
                continue
            if segment.duration <= length:
                pieces.append(Segment(segment.start, segment.end))
                break
            start = segment.start + middle - length / 2
            start = min(max(start, segment.start), segment.end - length)
            pieces.append(Segment(start, start + length))
            break
    return pieces


def estimate_size(
    plan: EncodePlan,
    encode: Callable[[EncodePlan], Path],
    workdir: Path,
    *,
    resolved_encoder: Callable[[], str] = lambda: "",
    stop: Callable[[], None] = lambda: None,
) -> SizeEstimate:
    """Encodes the pieces at the same time; `encode` is called from several threads."""
    duration = plan.effective_duration
    pieces_plan, scale = stand_in(plan)
    segments = plan.effective_segments
    pieces = sample_pieces(segments)
    if not pieces or duration <= 0:
        raise ValueError("The export has no video to estimate.")
    whole = len(pieces) == len(segments) and all(
        piece.start == segment.start and piece.end == segment.end
        for piece, segment in zip(pieces, segments, strict=False)
    )

    def sample(index: int, piece: Segment) -> EncodePlan:
        # video only: the audio is counted from its bitrate, which the encoder keeps to
        return dataclasses.replace(
            pieces_plan,
            segments=[piece],
            trim_start=0.0,
            trim_end=0.0,
            output=str(workdir / f"piece-{index}.mp4"),
            audio_enabled=False,
            audio_bitrate=0,
            audio_tracks=[],
            source_audio_tracks=None,
            source_audio_segments=None,
            mix_audio_tracks=False,
            even_out_loudness=False,
            copy_audio=False,
            keep_file_dates=False,
            replace_existing=True,
        )

    with ThreadPoolExecutor(len(pieces), thread_name_prefix="tuck-estimate") as pool:
        runs = [pool.submit(encode, sample(i, piece)) for i, piece in enumerate(pieces)]
        done, _ = wait(runs, return_when=FIRST_EXCEPTION)
        for run in done:
            error = run.exception()
            if error is not None:
                # the other pieces are no use now; stop them rather than wait for them
                stop()
                raise error
        encoded = sum(run.result().stat().st_size for run in runs)
    sampled = sum(piece.duration for piece in pieces)
    video = round((encoded if whole else encoded / sampled * duration) * scale)
    audio = round(plan.total_audio_bitrate / 8 * duration)
    return SizeEstimate(
        size_bytes=video + audio,
        video_bytes=video,
        audio_bytes=audio,
        sampled_seconds=sampled,
        encoder=resolved_encoder(),
    )


class SizeEstimator:
    """Runs one estimate at a time: a new one, or cancel(), stops the one before it."""

    def __init__(
        self,
        cache_dir: Callable[[], Path],
        engine_factory: Callable[[], FFmpegEngine] = FFmpegEngine,
    ) -> None:
        self._cache_dir = cache_dir
        self._engine_factory = engine_factory
        self._lock = threading.Lock()
        # one engine per piece, since an engine runs one FFmpeg at a time
        self._engines: list[FFmpegEngine] = []
        self._generation = 0

    def estimate(self, plan: EncodePlan) -> SizeEstimate:
        with self._lock:
            older, self._engines = self._engines, []
            self._generation += 1
            generation = self._generation
        for engine in older:
            engine.cancel()
        mine: list[FFmpegEngine] = []
        stopped = threading.Event()
        root = self._cache_dir() / "estimates"
        root.mkdir(parents=True, exist_ok=True)
        workdir = Path(tempfile.mkdtemp(prefix="estimate-", dir=root))

        def encode(sample: EncodePlan) -> Path:
            engine = self._engine_factory()
            with self._lock:
                # a newer estimate, a cancel or a failed piece may have come before this one
                if self._generation != generation or stopped.is_set():
                    raise EncodeCancelled("A newer estimate started")
                self._engines.append(engine)
                mine.append(engine)
            return engine.encode(sample)

        def stop() -> None:
            with self._lock:
                stopped.set()
                engines = list(mine)
            for engine in engines:
                engine.cancel()

        def resolved() -> str:
            return next((engine.resolved_encoder for engine in mine if engine.resolved_encoder), "")

        try:
            return estimate_size(plan, encode, workdir, resolved_encoder=resolved, stop=stop)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            with self._lock:
                self._engines = [engine for engine in self._engines if engine not in mine]

    def cancel(self) -> bool:
        with self._lock:
            self._generation += 1
            engines, self._engines = self._engines, []
        for engine in engines:
            engine.cancel()
        return bool(engines)
