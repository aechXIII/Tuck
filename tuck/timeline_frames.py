"""Bounded, cached pictures on the source timeline."""

from __future__ import annotations

import hashlib
import math
import os
import struct
import tempfile
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING

from .media_filters import UPRIGHT_FILTERS
from .media_libraries import load_media_libraries
from .probe import first_video_frame
from .request_work import RequestWork

# imported inside functions after load_media_libraries(), so the backend starts without them
if TYPE_CHECKING:
    import numpy as np
    from av.container import InputContainer
    from av.filter import Graph
    from av.video.frame import VideoFrame
    from av.video.stream import VideoStream
    from numpy.typing import NDArray

TILE_WIDTH = 150
TILE_HEIGHT = 84
_CACHE_VERSION = 2
_CACHE_BYTES = 128 * 1024 * 1024
_MAX_SECONDS = 20.0
_MAX_PACKETS = 20000
_MAX_FRAMES = 6000
# a request's pictures are decoded on up to this many threads; the timeline keeps two requests
# going at once, so between them they use about all the cores
_DECODE_THREADS = max(1, min(8, (os.cpu_count() or 1) // 2))
# each decoder has its own file handle. A keyframe picture is one decoded frame, so more than
# four of them only add opening and setup; exact pictures give their spare threads to frames
_DECODERS = min(4, _DECODE_THREADS)
# exact pictures this close are decoded on from the one before instead of seeking again
_DECODE_ON_SECONDS = 0.5


@dataclass(frozen=True)
class TimelineSprite:
    path: str
    start: float
    step: float
    count: int


def validate_timeline_request(
    start: object, step: object, count: object, mode: object, exact: object
) -> None:
    for name, value in (("start", start), ("step", step)):
        if isinstance(value, bool) or not isinstance(value, (float, int)):
            raise ValueError(f"{name} must be a finite number")
        try:
            valid = math.isfinite(value) and (value >= 0 if name == "start" else value > 0)
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError(f"{name} is outside the timeline range")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 32:
        raise ValueError("count must be a whole number from 1 to 32")
    if mode not in ("center", "whole"):
        raise ValueError("mode must be center or whole")
    if not isinstance(exact, bool):
        raise ValueError("exact must be a boolean")


class TimelineFrames:
    def __init__(self) -> None:
        # striped locks serialize identical requests without accumulating a lock per chunk
        self._locks = [threading.Lock() for _ in range(32)]
        self._workers = threading.BoundedSemaphore(2)
        self._cache_lock = threading.Lock()

    def generate(
        self,
        source: Path,
        cache: Path,
        start: float,
        step: float,
        count: int,
        mode: str,
        exact: bool,
        work: RequestWork | None = None,
    ) -> TimelineSprite | None:
        validate_timeline_request(start, step, count, mode, exact)
        source = source.resolve()
        if not source.is_file():
            return None
        stat = source.stat()
        key = hashlib.sha256(
            f"{_CACHE_VERSION}:{source}:{stat.st_size}:{stat.st_mtime_ns}:"
            f"{start:.17g}:{step:.17g}:{count}:{mode}:{exact}".encode()
        ).hexdigest()
        output = cache / f"timeline_{key}.png"
        # a saved strip needs no decoding, so it doesn't wait for PyAV to load
        with self._cache_lock:
            saved = self._saved_sprite(output, start, step)
        if saved is not None:
            return saved
        load_media_libraries()
        import numpy as np
        from av.codec.context import CodecContext
        from av.error import FFmpegError
        from av.video.codeccontext import VideoCodecContext
        from av.video.frame import VideoFrame

        deadline = min(monotonic() + _MAX_SECONDS, work.deadline if work else math.inf)

        def check() -> None:
            if monotonic() >= deadline or (work is not None and work.is_set()):
                raise TimeoutError("Timeline pictures took too long to read")

        lock = self._locks[int(key[:2], 16) % len(self._locks)]
        if not lock.acquire(timeout=max(0, deadline - monotonic())):
            raise TimeoutError("Timeline pictures took too long to read")
        try:
            check()
            with self._cache_lock:
                saved = self._saved_sprite(output, start, step)
                if saved is not None:
                    return saved
            if not self._workers.acquire(timeout=max(0, deadline - monotonic())):
                raise TimeoutError("Timeline pictures took too long to read")
            try:
                tiles = self._decode(source, start, step, count, mode, exact, check)
                if not tiles:
                    return None
                check()
                sprite = VideoFrame.from_ndarray(np.concatenate(tiles, axis=1), format="rgb24")
                encoder = CodecContext.create("png", "w")
                if not isinstance(encoder, VideoCodecContext):
                    return None
                encoder.width = sprite.width
                encoder.height = sprite.height
                encoder.pix_fmt = "rgb24"
                encoder.time_base = Fraction(1, 1)
                data = b"".join(bytes(p) for p in [*encoder.encode(sprite), *encoder.encode(None)])
                if not data:
                    return None
                with tempfile.TemporaryDirectory(prefix=".timeline-", dir=cache) as temp:
                    partial = Path(temp) / output.name
                    partial.write_bytes(data)
                    check()
                    with self._cache_lock:
                        os.replace(partial, output)
                        self._trim_cache(cache, output)
                return TimelineSprite(str(output), start, step, len(tiles))
            except TimeoutError:
                raise
            except (FFmpegError, OSError, ValueError):
                return None
            finally:
                self._workers.release()
        finally:
            lock.release()

    @staticmethod
    def _saved_sprite(output: Path, start: float, step: float) -> TimelineSprite | None:
        if not output.is_file():
            return None
        with output.open("rb") as cached:
            header = cached.read(24)
        if len(header) == 24 and header[:8] == b"\x89PNG\r\n\x1a\n":
            width, height = struct.unpack(">II", header[16:24])
            if height == TILE_HEIGHT and width % TILE_WIDTH == 0 and 0 < width <= 4800:
                output.touch()
                return TimelineSprite(str(output), start, step, width // TILE_WIDTH)
        return None

    @staticmethod
    def _trim_cache(cache: Path, current: Path) -> None:
        entries = sorted(
            ((p.stat().st_mtime_ns, p.stat().st_size, p) for p in cache.glob("timeline_*.png")),
            reverse=True,
        )
        size = 0
        for index, (_, length, path) in enumerate(entries):
            size += length
            if (size > _CACHE_BYTES or index >= 512) and path != current:
                path.unlink(missing_ok=True)

    @staticmethod
    def _decode(
        source: Path,
        start: float,
        step: float,
        count: int,
        mode: str,
        exact: bool,
        check: Callable[[], None],
    ) -> list[NDArray[np.uint8]]:
        load_media_libraries()
        import av

        with av.open(str(source), timeout=_MAX_SECONDS) as container:
            if not container.streams.video:
                return []
            stream = container.streams.video[0]
            if stream.time_base is None:
                return []
            duration = (
                float(stream.duration * stream.time_base)
                if stream.duration
                else container.duration / av.time_base
                if container.duration
                else None
            )
        targets: list[float] = []
        for index in range(count):
            target = start + index * step
            if not math.isfinite(target) or (duration is not None and target >= duration):
                break
            targets.append(target)
        if not targets:
            return []
        limits = _RequestLimits(check)
        if exact and step <= _DECODE_ON_SECONDS:
            # one run decoded on from a single seek, so its decoder gets the threads instead
            return _decode_targets(source, targets, mode, exact, _DECODE_THREADS, limits)[0]
        size = math.ceil(len(targets) / _DECODERS)
        groups = [targets[first : first + size] for first in range(0, len(targets), size)]
        # an exact picture far from the one before decodes a run of frames from its own keyframe,
        # so it gets frame threads as well
        threads = _DECODE_THREADS // len(groups) if exact else 1
        if len(groups) == 1:
            return _decode_targets(source, targets, mode, exact, threads, limits)[0]

        def decode(group: list[float]) -> tuple[list[NDArray[np.uint8]], bool]:
            try:
                return _decode_targets(source, group, mode, exact, threads, limits)
            except BaseException:
                limits.failed.set()
                raise

        with ThreadPoolExecutor(len(groups), thread_name_prefix="tuck-timeline") as pool:
            futures = [pool.submit(decode, group) for group in groups]
        tiles: list[NDArray[np.uint8]] = []
        for future in futures:
            error = future.exception()
            if isinstance(error, _OtherThreadFailed):
                error = next(
                    (
                        found
                        for found in (later.exception() for later in futures)
                        if found is not None and not isinstance(found, _OtherThreadFailed)
                    ),
                    error,
                )
            if error is not None:
                raise error
            group_tiles, complete = future.result()
            tiles.extend(group_tiles)
            # one pass through the pictures in order would have stopped here too
            if not complete:
                break
        return tiles


class _OtherThreadFailed(Exception):
    """Stops a thread once another thread working on the same request has failed."""


class _RequestLimits:
    """The time, packet and frame limits of one request, shared by the threads decoding it."""

    def __init__(self, check: Callable[[], None]) -> None:
        self._check = check
        self._lock = threading.Lock()
        self._packets = 0
        self._frames = 0
        self.failed = threading.Event()

    def check(self) -> None:
        if self.failed.is_set():
            raise _OtherThreadFailed
        self._check()

    def count_packet(self) -> None:
        with self._lock:
            self._packets += 1
            over = self._packets > _MAX_PACKETS
        self.check()
        if over:
            raise TimeoutError("Timeline picture packet limit reached")

    def count_frame(self) -> None:
        with self._lock:
            self._frames += 1
            over = self._frames > _MAX_FRAMES
        self.check()
        if over:
            raise TimeoutError("Timeline picture decode limit reached")


def _decode_targets(
    source: Path,
    targets: list[float],
    mode: str,
    exact: bool,
    threads: int,
    limits: _RequestLimits,
) -> tuple[list[NDArray[np.uint8]], bool]:
    """Draws the pictures at these times with one file handle and decoder.

    The flag is False when the video ran out before the last of them.
    """
    load_media_libraries()
    import av
    from av.video.frame import VideoFrame

    tiles: list[NDArray[np.uint8]] = []
    with av.open(str(source), timeout=_MAX_SECONDS) as container:
        stream = container.streams.video[0]
        stream.codec_context.thread_count = threads
        if threads > 1:
            stream.codec_context.thread_type = "FRAME"
        if stream.time_base is None:
            return tiles, False
        origin = float((stream.start_time or 0) * stream.time_base)
        drawer = _TileDrawer(mode, stream.sample_aspect_ratio or Fraction(1))

        def decoded_frames() -> Iterator[VideoFrame]:
            for packet in container.demux(stream):
                limits.count_packet()
                for frame in packet.decode():
                    if not isinstance(frame, VideoFrame):
                        continue
                    limits.count_frame()
                    yield frame

        iterator: Iterator[VideoFrame] | None = None
        previous_frame: VideoFrame | None = None
        next_frame: VideoFrame | None = None
        decoder_exhausted = False
        previous_target = -math.inf
        for target in targets:
            limits.check()
            if not exact:
                picture = _keyframe_picture(container, stream, target + origin, limits)
                if picture is None:
                    return tiles, False
                tiles.append(drawer.draw(picture))
                continue
            if iterator is None or target - previous_target > _DECODE_ON_SECONDS:
                container.seek(
                    int((target + origin) / float(stream.time_base)),
                    stream=stream,
                    backward=True,
                )
                iterator = decoded_frames()
                previous_frame = None
                next_frame = None
                decoder_exhausted = False
            chosen = previous_frame
            if (
                next_frame is not None
                and next_frame.time is not None
                and next_frame.time - origin <= target
            ):
                chosen = next_frame
                next_frame = None
            if next_frame is None and not decoder_exhausted:
                for frame in iterator:
                    if frame.time is not None and frame.time - origin > target:
                        # keep the next picture so VFR holds and sub-frame samples stay aligned
                        next_frame = frame
                        if chosen is None:
                            chosen = frame
                        break
                    chosen = frame
                else:
                    decoder_exhausted = True
            if chosen is None:
                return tiles, False
            if decoder_exhausted and chosen.time is not None:
                last_time = chosen.time - origin
                if chosen.duration > 0 and chosen.time_base is not None:
                    if target >= last_time + float(chosen.duration * chosen.time_base):
                        return tiles, False
                elif target > last_time:
                    # without a final duration, only its recorded timestamp is certain
                    return tiles, False
            if chosen is previous_frame and tiles:
                tiles.append(tiles[-1])
            else:
                tiles.append(drawer.draw(chosen))
            previous_frame = chosen
            previous_target = target
    return tiles, True


def _keyframe_picture(
    container: InputContainer, stream: VideoStream, at: float, limits: _RequestLimits
) -> VideoFrame | None:
    """The first picture from the keyframe at or before this time, in the stream's own clock."""
    if stream.time_base is None:
        return None
    container.seek(int(at / float(stream.time_base)), stream=stream, backward=True)
    # no cap of its own: the request's packet limit raises before it is reached
    picture = first_video_frame(container, stream, _MAX_PACKETS + 1, limits.count_packet)
    if picture is not None:
        limits.count_frame()
    return picture


class _TileDrawer:
    """Draws timeline pictures through one filter graph for as long as the frames keep their shape.

    Building the graph takes about ten times as long as running a picture through it.
    """

    def __init__(self, mode: str, aspect: Fraction) -> None:
        self._mode = mode
        self._aspect = aspect
        self._shape: tuple[object, ...] | None = None
        self._graph: Graph | None = None

    def draw(self, frame: VideoFrame) -> NDArray[np.uint8]:
        load_media_libraries()
        import numpy as np
        from av.video.frame import VideoFrame

        shape = (frame.width, frame.height, frame.format.name, frame.rotation, frame.time_base)
        if self._graph is None or shape != self._shape:
            self._graph = _tile_graph(frame, self._mode, self._aspect)
            self._shape = shape
        self._graph.push(frame)
        result = self._graph.pull()
        if not isinstance(result, VideoFrame):
            raise ValueError("Could not draw timeline picture")
        return result.to_ndarray(format="rgb24").astype(np.uint8, copy=False)


def _tile_graph(frame: VideoFrame, mode: str, aspect: Fraction) -> Graph:
    load_media_libraries()
    from av.filter import Graph

    graph = Graph()
    nodes = [
        graph.add_buffer(
            width=frame.width,
            height=frame.height,
            format=frame.format,
            time_base=frame.time_base or Fraction(1),
        )
    ]
    # normalize anamorphic pixels before turning the displayed picture upright
    nodes.append(graph.add("scale", f"{max(2, round(frame.width * aspect / 2) * 2)}:ih"))
    nodes.append(graph.add("setsar", "1"))
    for name, args in UPRIGHT_FILTERS.get(round(frame.rotation) % 360, ()):
        nodes.append(graph.add(name, args))
    if mode == "center":
        nodes.append(graph.add("crop", "iw*0.6:ih*0.6"))
    nodes.append(graph.add("scale", "150:84:force_original_aspect_ratio=decrease"))
    nodes.append(graph.add("pad", "150:84:(ow-iw)/2:(oh-ih)/2:color=black"))
    nodes.append(
        graph.add(
            "colorlevels", "rimin=0.015:gimin=0.015:bimin=0.015:rimax=0.985:gimax=0.985:bimax=0.985"
        )
    )
    nodes.append(graph.add("hue", "s=1.08"))
    nodes.append(graph.add("unsharp", "5:5:0.35"))
    nodes.append(graph.add("format", "rgb24"))
    nodes.append(graph.add("buffersink"))
    graph.link_nodes(*nodes).configure()
    return graph
