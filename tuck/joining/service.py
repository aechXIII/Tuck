"""Join videos into one new file on a worker of its own, so a long join never holds up the
sidecar's requests. One join runs at a time; the page reads its progress by work ID."""

from __future__ import annotations

import logging
import os
import subprocess
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Condition, Event, Thread

from ..encoding.capabilities import auto_encoder_candidates, hardware_failure_kind
from ..encoding.failures import is_progress_line
from ..encoding.progress import parse_ffmpeg_time
from ..encoding.vaapi import choose_encode_device
from ..media_tools import find_ffmpeg, find_ffprobe, media_tool_environment
from ..models.encoding_policy import VAAPI_ENCODERS
from ..output_transaction import OutputTransaction
from .plan import (
    ENCODED_EXTENSION,
    MAX_JOIN_VIDEOS,
    JoinError,
    JoinSource,
    concat_list,
    copy_command,
    copy_mismatch,
    encode_candidates,
    encode_command,
    joined_output,
    probe_source,
    total_duration,
)

logger = logging.getLogger(__name__)

# every code a join can be refused or fail with; the desktop bridge passes only these through
JOIN_ERROR_CODES = frozenset(
    {
        "invalid_join",
        "join_busy",
        "join_failed",
        "no_video",
        "tools_missing",
        "unreadable",
    }
)

_ENCODER_NAMES = {
    "h264_nvenc": "the NVIDIA encoder",
    "h264_amf": "the AMD encoder",
    "h264_vaapi": "the graphics card's encoder",
    "libx264": "the processor",
}


@dataclass(frozen=True)
class JoinSnapshot:
    work_id: str
    # running, done, failed or cancelled
    status: str
    # checking, copying, encoding or saving while it runs
    stage: str = "checking"
    # measured share of the joining stage, or None while it can't be measured
    progress: float | None = None
    output_path: str = ""
    # whether the streams were copied as they are; None until that is decided
    lossless: bool | None = None
    # why the videos had to be re-encoded
    reason: str = ""
    encoder: str = ""
    # what the encoder that couldn't be used was replaced with, for the record
    fallback: str = ""
    code: str = ""
    message: str = ""

    def to_dict(self) -> dict[str, str | float | bool | None]:
        return {
            "work_id": self.work_id,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "output_path": self.output_path,
            "lossless": self.lossless,
            "reason": self.reason,
            "encoder": self.encoder,
            "fallback": self.fallback,
            "code": self.code,
            "message": self.message,
        }


class JoinCancelled(Exception):
    pass


@dataclass
class FFmpegRun:
    """One FFmpeg run; the cancel event stops it."""

    returncode: int
    stderr: str


Runner = Callable[[list[str], float, Event, Callable[[float | None], None]], FFmpegRun]


def run_ffmpeg(
    command: list[str], duration: float, cancel: Event, progress: Callable[[float | None], None]
) -> FFmpegRun:
    process = subprocess.Popen(
        command,
        env=media_tool_environment(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    lines: list[str] = []

    def read() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            seconds = parse_ffmpeg_time(line) if line.startswith("out_time=") else None
            if seconds is not None and duration > 0:
                progress(min(1.0, seconds / duration))
            elif not is_progress_line(line):
                lines.append(line)
                del lines[:-200]

    reader = Thread(target=read, name="tuck-join-output", daemon=True)
    reader.start()
    try:
        while process.poll() is None:
            if cancel.wait(0.1):
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise JoinCancelled
    finally:
        reader.join(timeout=5)
    return FFmpegRun(process.returncode, "".join(lines))


def _failure_message(stderr: str) -> str:
    text = stderr.lower()
    if any(m in text for m in ("no space left", "not enough space", "disk quota", "too large")):
        return (
            "The disk is full, so the joined video wasn't saved. Free up some space and try again."
        )
    if any(m in text for m in ("permission denied", "access is denied", "read-only file system")):
        return (
            "Tuck couldn't write the joined video next to the first video. "
            "Check that the folder is writable, then try again."
        )
    if any(
        m in text for m in ("invalid data found", "moov atom not found", "error while decoding")
    ):
        return (
            "Tuck couldn't read part of one of the videos. It may be damaged or incomplete. "
            "Check that each one plays in another app."
        )
    return "FFmpeg stopped while joining the videos, so nothing was saved. Try again."


@dataclass
class _Work:
    paths: list[Path]
    snapshot: JoinSnapshot
    cancel: Event


class JoinService:
    def __init__(
        self,
        *,
        runner: Runner = run_ffmpeg,
        tools: Callable[[], tuple[str | None, str | None]] = lambda: (
            find_ffmpeg(),
            find_ffprobe(),
        ),
        encoders: Callable[[], list[str]] = lambda: list(auto_encoder_candidates("h264")),
    ) -> None:
        self._runner = runner
        self._tools = tools
        self._encoders = encoders
        self._condition = Condition()
        self._history: OrderedDict[str, _Work] = OrderedDict()
        self._running: _Work | None = None
        self._threads: list[Thread] = []
        self._closed = False

    def start(self, paths: list[Path], work_id: str) -> JoinSnapshot:
        if not work_id or len(work_id) > 128:
            raise JoinError("invalid_join", "Join work ID must contain 1 to 128 characters.")
        if not 2 <= len(paths) <= MAX_JOIN_VIDEOS:
            raise JoinError(
                "invalid_join", f"Choose between 2 and {MAX_JOIN_VIDEOS} videos to join."
            )
        if len({str(path) for path in paths}) != len(paths):
            raise JoinError("invalid_join", "Each video can be joined only once.")
        with self._condition:
            if self._closed:
                raise JoinError("invalid_join", "Joining has stopped.")
            if work_id in self._history:
                raise JoinError("invalid_join", "Join work ID must be new.")
            if self._running is not None:
                raise JoinError(
                    "join_busy", "Another join is still running. Wait for it or cancel it."
                )
            work = _Work(list(paths), JoinSnapshot(work_id, "running"), Event())
            self._running = work
            self._history[work_id] = work
            while len(self._history) > 8:
                self._history.popitem(last=False)
            thread = Thread(target=self._run, args=(work,), name="tuck-join", daemon=True)
            self._threads = [t for t in self._threads if t.is_alive()] + [thread]
            thread.start()
            return work.snapshot

    def get(self, work_id: str) -> JoinSnapshot:
        with self._condition:
            work = self._history.get(work_id)
            if work is None:
                return JoinSnapshot(work_id, "missing", stage="")
            return work.snapshot

    def cancel(self, work_id: str) -> bool:
        with self._condition:
            work = self._history.get(work_id)
            if work is None or work.snapshot.status != "running":
                return False
            work.cancel.set()
            return True

    def close(self) -> None:
        with self._condition:
            self._closed = True
            for work in self._history.values():
                work.cancel.set()
            threads = list(self._threads)
        for thread in threads:
            thread.join(timeout=10)

    def _update(self, work: _Work, **changes: object) -> None:
        with self._condition:
            if work.snapshot.status == "running":
                work.snapshot = replace(work.snapshot, **changes)
            self._condition.notify_all()

    def _finish(self, work: _Work, **changes: object) -> None:
        with self._condition:
            work.snapshot = replace(work.snapshot, **changes)
            if self._running is work:
                self._running = None
            self._condition.notify_all()

    def _run(self, work: _Work) -> None:
        try:
            output = self._join(work)
        except JoinCancelled:
            self._finish(work, status="cancelled", progress=None, message="Join canceled.")
        except JoinError as exc:
            self._finish(work, status="failed", progress=None, code=exc.code, message=str(exc))
        except OSError as exc:
            logger.warning("Join failed: %s", exc)
            self._finish(
                work,
                status="failed",
                progress=None,
                code="join_failed",
                message=(
                    "Tuck couldn't save the joined video next to the first video. "
                    "Check that the folder is writable and has space, then try again."
                ),
            )
        except Exception:
            logger.exception("Join worker failed")
            self._finish(
                work,
                status="failed",
                progress=None,
                code="join_failed",
                message="The videos couldn't be joined. Try again.",
            )
        else:
            self._finish(work, status="done", stage="", progress=1.0, output_path=str(output))

    def _join(self, work: _Work) -> Path:
        ffmpeg, ffprobe = self._tools()
        if not ffmpeg or not ffprobe:
            raise JoinError(
                "tools_missing",
                "Tuck can't join videos without FFmpeg and FFprobe. "
                "Choose them in Settings > Media tools.",
            )
        sources: list[JoinSource] = []
        for path in work.paths:
            if work.cancel.is_set():
                raise JoinCancelled
            sources.append(probe_source(ffprobe, path))
        reason = copy_mismatch(sources)
        lossless = not reason
        self._update(work, lossless=lossless, reason=reason)
        extension = sources[0].path.suffix.lower() if lossless else ENCODED_EXTENSION
        duration = total_duration(sources)
        with OutputTransaction(joined_output(sources[0].path, extension)) as output:
            result = output.workspace / f"joined{extension}"
            if lossless:
                self._copy(work, ffmpeg, sources, output.workspace, result, duration)
            else:
                self._encode(work, ffmpeg, sources, result, duration)
            if work.cancel.is_set():
                raise JoinCancelled
            self._update(work, stage="saving", progress=None)
            return output.publish(result)

    def _report(self, work: _Work) -> Callable[[float | None], None]:
        def report(value: float | None) -> None:
            self._update(work, progress=value)

        return report

    def _copy(
        self,
        work: _Work,
        ffmpeg: str,
        sources: list[JoinSource],
        workspace: Path,
        result: Path,
        duration: float,
    ) -> None:
        listing = workspace / "videos.ffconcat"
        listing.write_text(concat_list([s.path for s in sources]), encoding="utf-8")
        self._update(work, stage="copying", progress=0.0 if duration > 0 else None)
        command = copy_command(ffmpeg, listing, result)
        run = self._runner(command, duration, work.cancel, self._report(work))
        if run.returncode != 0:
            logger.warning("Lossless join failed: %s", run.stderr[-2000:])
            raise JoinError("join_failed", _failure_message(run.stderr))

    def _encode(
        self,
        work: _Work,
        ffmpeg: str,
        sources: list[JoinSource],
        result: Path,
        duration: float,
    ) -> None:
        failures: list[str] = []
        for encoder in encode_candidates(self._encoders()):
            vaapi_init: list[str] | None = None
            if encoder in VAAPI_ENCODERS:
                device = choose_encode_device(ffmpeg, encoder)
                if device is None:
                    logger.info(
                        "No render device can encode with %s; trying the next encoder", encoder
                    )
                    continue
                vaapi_init = device.init_args
            failed = _ENCODER_NAMES[failures[-1]] if failures else ""
            fallback = (
                f"{failed[:1].upper()}{failed[1:]} couldn't be used, "
                f"so {_ENCODER_NAMES[encoder]} made this video."
                if failed
                else ""
            )
            self._update(
                work,
                stage="encoding",
                progress=0.0 if duration > 0 else None,
                encoder=encoder,
                fallback=fallback,
            )
            command = encode_command(ffmpeg, sources, result, encoder, vaapi_init=vaapi_init)
            run = self._runner(command, duration, work.cancel, self._report(work))
            if run.returncode == 0:
                return
            result.unlink(missing_ok=True)
            # a graphics card that can't take this job hands it to the next encoder; a
            # video FFmpeg can't read would fail the same way everywhere
            if encoder != "libx264" and hardware_failure_kind(run.stderr) is not None:
                logger.info("Join encoder %s failed, trying the next one: %s", encoder, run.stderr)
                failures.append(encoder)
                continue
            logger.warning("Join with %s failed: %s", encoder, run.stderr[-2000:])
            raise JoinError("join_failed", _failure_message(run.stderr))
        raise JoinError("join_failed", "No video encoder could join these videos.")
