from __future__ import annotations

import math
import threading
from collections.abc import Callable
from contextlib import closing, suppress
from fractions import Fraction
from typing import BinaryIO

import av
from av.video.stream import VideoStream

from ..models import ENCODER_AUTO_COMPRESSION, EncodePlan
from ..models.encoding_policy import QUALITY_RC_METHODS, WORKFLOW_UPSCALE
from .frame_blending import blended_frames


def can_stream_blend(plan: EncodePlan) -> bool:
    return bool(
        plan.frame_blending.enabled
        and plan.workflow == WORKFLOW_UPSCALE
        and plan.rate_control_method in QUALITY_RC_METHODS
        and not plan.two_pass
        # this Auto choice can switch its software candidate to two passes
        and plan.video_encoder != ENCODER_AUTO_COMPRESSION
        and plan.source_info is not None
        and math.isfinite(plan.target_fps)
        and plan.target_fps > 0
    )


class _StreamStopped(Exception):
    pass


class _FrameSink:
    def __init__(
        self, pipe: BinaryIO, check_running: Callable[[], None], consumer_closed: threading.Event
    ) -> None:
        self._pipe = pipe
        self._check_running = check_running
        self._consumer_closed = consumer_closed

    def write(self, data: bytes) -> int:
        view = memoryview(data)
        offset = 0
        while offset < len(view):
            try:
                self._check_running()
            except _StreamStopped:
                # shutdown may flush the muxer after its consumer has already exited
                return len(view)
            try:
                written = self._pipe.write(view[offset:])
            except BrokenPipeError:
                self._consumer_closed.set()
                return len(view)
            if written is None or written <= 0:
                self._consumer_closed.set()
                return len(view)
            offset += written
        return offset


class FrameStream:
    def __init__(
        self, plan: EncodePlan, check_cancel: Callable[[], None], abort: Callable[[], None]
    ) -> None:
        self._plan = plan
        self._check_cancel = check_cancel
        self._abort = abort
        self._stopped = threading.Event()
        self._consumer_closed = threading.Event()
        self._thread: threading.Thread | None = None
        self.error: Exception | None = None

    def _check_running(self) -> None:
        if self._stopped.is_set() or self._consumer_closed.is_set():
            raise _StreamStopped
        self._check_cancel()

    def start(self, pipe: BinaryIO) -> None:
        if self._thread is not None:
            raise RuntimeError("The blended frame stream has already started")
        self._thread = threading.Thread(target=self._write, args=(pipe,), name="blend-stream")
        self._thread.start()

    def _write(self, pipe: BinaryIO) -> None:
        try:
            info = self._plan.source_info
            assert info is not None
            rate = Fraction(self._plan.target_fps).limit_denominator(100_000)
            # the generator bounds its decode and blending queues; pipe writes apply backpressure
            with closing(blended_frames(self._plan, self._check_running)) as frames:
                sink = _FrameSink(pipe, self._check_running, self._consumer_closed)
                with av.open(sink, "w", format="nut", options={"write_index": "0"}) as output:
                    stream = output.add_stream("rawvideo", rate=rate)
                    if not isinstance(stream, VideoStream):
                        raise RuntimeError("Raw video encoding is unavailable")
                    stream.width, stream.height = info.width, info.height
                    # keep RGB buffers packed and preserve the fractional output clock
                    stream.pix_fmt = "rgb24"
                    stream.time_base = 1 / rate
                    stream.codec_context.thread_count = 1
                    try:
                        for index, pixels in enumerate(frames):
                            self._check_running()
                            frame = av.VideoFrame.from_numpy_buffer(pixels, format="rgb24")
                            frame.pts, frame.time_base = index, 1 / rate
                            for packet in stream.encode(frame):
                                output.mux(packet)
                        for packet in stream.encode():
                            output.mux(packet)
                    except _StreamStopped:
                        raise
                    except Exception as exc:
                        # retain the source error before mux shutdown can replace it
                        self.error = exc
                        self._abort()
                        raise
        except _StreamStopped:
            pass
        except Exception as exc:
            if self.error is None:
                self.error = exc
                self._abort()
        finally:
            with suppress(OSError, ValueError):
                pipe.close()

    def stop(self) -> None:
        self._stopped.set()

    def join(self) -> None:
        if self._thread is not None:
            self._thread.join()
