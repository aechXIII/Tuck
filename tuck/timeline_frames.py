"""Bounded, cached pictures on the source timeline."""

from __future__ import annotations

import hashlib
import math
import os
import struct
import tempfile
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from time import monotonic

import av
import numpy as np
from av.codec.context import CodecContext
from av.error import FFmpegError
from av.filter import Graph
from av.video.codeccontext import VideoCodecContext
from av.video.frame import VideoFrame
from numpy.typing import NDArray

from .media_filters import UPRIGHT_FILTERS
from .request_work import RequestWork

TILE_WIDTH = 150
TILE_HEIGHT = 84
_CACHE_VERSION = 2
_CACHE_BYTES = 128 * 1024 * 1024
_MAX_SECONDS = 20.0
_MAX_PACKETS = 20000
_MAX_FRAMES = 6000


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
                if output.is_file():
                    with output.open("rb") as cached:
                        header = cached.read(24)
                    if len(header) == 24 and header[:8] == b"\x89PNG\r\n\x1a\n":
                        width, height = struct.unpack(">II", header[16:24])
                        if height == TILE_HEIGHT and width % TILE_WIDTH == 0 and 0 < width <= 4800:
                            output.touch()
                            return TimelineSprite(str(output), start, step, width // TILE_WIDTH)
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
        tiles: list[NDArray[np.uint8]] = []
        with av.open(str(source), timeout=_MAX_SECONDS) as container:
            if not container.streams.video:
                return tiles
            stream = container.streams.video[0]
            stream.codec_context.thread_count = 1
            if stream.time_base is None:
                return tiles
            origin = float((stream.start_time or 0) * stream.time_base)
            duration = (
                float(stream.duration * stream.time_base)
                if stream.duration
                else container.duration / av.time_base
                if container.duration
                else None
            )
            packets = 0
            frames = 0

            def decoded_frames() -> Iterator[VideoFrame]:
                nonlocal packets, frames
                for packet in container.demux(stream):
                    packets += 1
                    check()
                    if packets > _MAX_PACKETS:
                        raise TimeoutError("Timeline picture packet limit reached")
                    for frame in packet.decode():
                        if not isinstance(frame, VideoFrame):
                            continue
                        frames += 1
                        check()
                        if frames > _MAX_FRAMES:
                            raise TimeoutError("Timeline picture decode limit reached")
                        yield frame

            iterator: Iterator[VideoFrame] | None = None
            previous_frame: VideoFrame | None = None
            next_frame: VideoFrame | None = None
            decoder_exhausted = False
            previous_target = -math.inf
            for index in range(count):
                check()
                target = start + index * step
                if not math.isfinite(target) or (duration is not None and target >= duration):
                    break
                if iterator is None or not exact or target - previous_target > 0.5:
                    container.seek(
                        int((target + origin) / float(stream.time_base)),
                        stream=stream,
                        backward=True,
                    )
                    iterator = decoded_frames()
                    previous_frame = None
                    next_frame = None
                    decoder_exhausted = False
                chosen = previous_frame if exact else None
                if (
                    next_frame is not None
                    and next_frame.time is not None
                    and next_frame.time - origin <= target
                ):
                    chosen = next_frame
                    next_frame = None
                if next_frame is None and not decoder_exhausted:
                    for frame in iterator:
                        if exact and frame.time is not None and frame.time - origin > target:
                            # keep the next picture so VFR holds and sub-frame samples stay aligned
                            next_frame = frame
                            if chosen is None:
                                chosen = frame
                            break
                        chosen = frame
                        if not exact:
                            break
                    else:
                        decoder_exhausted = True
                if chosen is None:
                    break
                if exact and decoder_exhausted and chosen.time is not None:
                    last_time = chosen.time - origin
                    if chosen.duration > 0 and chosen.time_base is not None:
                        if target >= last_time + float(chosen.duration * chosen.time_base):
                            break
                    elif target > last_time:
                        # without a final duration, only its recorded timestamp is certain
                        break
                if chosen is previous_frame and tiles:
                    tiles.append(tiles[-1])
                else:
                    tiles.append(
                        _render_tile(chosen, mode, stream.sample_aspect_ratio or Fraction(1))
                    )
                previous_frame = chosen
                previous_target = target
        return tiles


def _render_tile(frame: VideoFrame, mode: str, aspect: Fraction) -> NDArray[np.uint8]:
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
    graph.push(frame)
    result = graph.pull()
    if not isinstance(result, VideoFrame):
        raise ValueError("Could not draw timeline picture")
    return result.to_ndarray(format="rgb24").astype(np.uint8, copy=False)
