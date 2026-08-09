from __future__ import annotations

import contextlib
import copy
import logging
import os
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..formatting import format_size
from ..models import (
    AUDIO_OVERHEAD_FACTOR,
    ENCODER_AUTO,
    ENCODER_AUTO_COMPRESSION,
    ENCODER_AUTO_FAST,
    RC_EXPLICIT_BITRATE,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    WORKFLOW_UPSCALE,
    EncodePlan,
)
from ..models.progress import EncodeProgress, EncodeStage
from .capabilities import (
    _find_ffmpeg,
    auto_encoder_candidates,
    get_available_encoders,
    is_hardware_encoder,
    is_hardware_init_failure,
)
from .command import build_base_cmd
from .progress import ProgressTracker
from .target_size import DEFAULT_MAX_RETRIES, decide_retry

logger = logging.getLogger(__name__)

_MAX_STDERR_DIAG = 4000

ProgressCallback = Callable[[Any], None]


def _execution_plan(requested_plan: EncodePlan, encoder: str, auto: bool) -> EncodePlan:
    plan = copy.deepcopy(requested_plan)
    plan.video_encoder = encoder
    if not auto:
        return plan
    if requested_plan.video_encoder == ENCODER_AUTO_COMPRESSION and not is_hardware_encoder(
        encoder
    ):
        plan.two_pass = True
        plan.preset = "veryslow"
    if is_hardware_encoder(encoder):
        plan.two_pass = False
        if plan.rate_control_method == RCM_CRF:
            plan.rate_control_method = RCM_CQ
            plan.cq = plan.crf
    elif plan.rate_control_method == RCM_CQ:
        plan.rate_control_method = RCM_CRF
        plan.crf = plan.cq
    elif plan.rate_control_method == RCM_CQP:
        plan.rate_control_method = RCM_CRF
        plan.crf = plan.qp
    elif plan.rate_control_method == RCM_VBR:
        plan.rate_control_method = RCM_CBR
    return plan


class EncodeError(Exception):
    def __init__(self, message: str, returncode: int = -1, stderr: str = ""):
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


class EncodeCancelled(Exception):
    pass


def _emit(on_progress: ProgressCallback | None, progress: EncodeProgress | float) -> None:
    if not on_progress:
        return
    try:
        on_progress(progress)
    except TypeError:
        if isinstance(progress, EncodeProgress):
            on_progress(progress.percent)
        else:
            raise


class FFmpegEngine:
    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None
        self._cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._last_stderr: str = ""
        self._resolved_encoder: str = ""

    @property
    def last_stderr(self) -> str:
        return self._last_stderr

    @property
    def resolved_encoder(self) -> str:
        return self._resolved_encoder

    def encode(
        self,
        plan: EncodePlan,
        on_progress: ProgressCallback | None = None,
    ) -> Path:
        plan = copy.deepcopy(plan)
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            raise FileNotFoundError(
                "FFmpeg not found. Install FFmpeg and ensure ffmpeg is on PATH "
                "or set the path in settings."
            )

        requested = getattr(plan, "video_encoder", "libx264") or "libx264"
        available = get_available_encoders()
        was_auto = requested in (ENCODER_AUTO, ENCODER_AUTO_COMPRESSION, ENCODER_AUTO_FAST)
        fastest = requested != ENCODER_AUTO_COMPRESSION
        candidates = (
            auto_encoder_candidates(available=available, fastest=fastest)
            if was_auto
            else (requested,)
        )
        if not was_auto and requested not in available and available:
            raise EncodeError(
                f"Encoder '{requested}' is not available in this FFmpeg installation. "
                f"Available encoders: {sorted(available)}. "
                f"Install an FFmpeg build that includes '{requested}' or choose another encoder."
            )

        _emit(
            on_progress,
            EncodeProgress(percent=0.0, stage=EncodeStage.PREPARING, message="Preparing"),
        )

        source = Path(plan.source)
        output = Path(plan.output)

        if not source.is_file():
            raise FileNotFoundError(f"Source file not found: {source}")

        output.parent.mkdir(parents=True, exist_ok=True)

        reservation = output.with_suffix(output.suffix + ".reserved")
        try:
            fd = os.open(str(reservation), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
        except FileExistsError:
            from ..planner import _resolve_output_collision

            new_output = _resolve_output_collision(output)
            plan.output = str(new_output)
            output = new_output
            reservation = output.with_suffix(output.suffix + ".reserved")
            try:
                fd = os.open(str(reservation), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
            except FileExistsError:
                raise FileExistsError(
                    f"Cannot reserve output path: {output} is locked by another process"
                ) from None

        total_duration = plan.trim_duration
        if total_duration <= 0 and plan.source_info is not None:
            total_duration = float(plan.source_info.duration or 0)

        if self._cancel_event.is_set():
            raise EncodeCancelled("Encoding cancelled by user")

        if not plan.original_video_bitrate:
            plan.original_video_bitrate = plan.video_bitrate

        tmp_output = output.parent / f".tmp_{output.stem}_{os.getpid()}.mp4"

        try:
            result: Path | None = None
            last_hardware_error: EncodeError | None = None
            for encoder in candidates:
                attempt_plan = _execution_plan(plan, encoder, was_auto)
                self._resolved_encoder = encoder
                if was_auto:
                    logger.info("Auto encoder attempt: %s", encoder)
                try:
                    result = self._encode_with_retry(
                        ffmpeg_path,
                        attempt_plan,
                        source,
                        tmp_output,
                        total_duration,
                        on_progress,
                    )
                    break
                except EncodeError as exc:
                    if (
                        was_auto
                        and is_hardware_encoder(encoder)
                        and is_hardware_init_failure(exc.stderr, exc.returncode)
                    ):
                        last_hardware_error = exc
                        self._cleanup_output(tmp_output)
                        logger.warning(
                            "Auto encoder %s could not initialize; trying next candidate", encoder
                        )
                        continue
                    raise
            if result is None:
                if last_hardware_error is not None:
                    raise last_hardware_error
                raise EncodeError(
                    "No usable video encoders were detected in this FFmpeg installation."
                )

            if output.exists():
                from ..planner import _resolve_output_collision

                with contextlib.suppress(OSError):
                    reservation.unlink()
                output = _resolve_output_collision(output)
                reservation = output.with_suffix(output.suffix + ".reserved")
                try:
                    fd = os.open(str(reservation), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.close(fd)
                except FileExistsError:
                    raise FileExistsError(
                        f"Publication slot stolen: {output} is locked by another process"
                    ) from None
                plan.output = str(output)

            result.replace(output)

            with contextlib.suppress(OSError):
                reservation.unlink()
            _emit(
                on_progress,
                EncodeProgress(
                    percent=100.0,
                    stage=EncodeStage.COMPLETED,
                    duration=total_duration,
                    message="Completed",
                ),
            )
            return output

        except EncodeCancelled:
            self._cleanup_output(tmp_output)
            self._cleanup_output(reservation)
            _emit(
                on_progress,
                EncodeProgress(percent=0.0, stage=EncodeStage.CANCELLED, message="Cancelled"),
            )
            raise
        except Exception as exc:
            self._cleanup_output(tmp_output)
            self._cleanup_output(reservation)
            _emit(
                on_progress,
                EncodeProgress(
                    percent=0.0,
                    stage=EncodeStage.FAILED,
                    message=str(exc),
                ),
            )
            raise

    def _encode_with_retry(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
        output: Path,
        total_duration: float,
        on_progress: ProgressCallback | None,
    ) -> Path:
        is_explicit = plan.rate_control == RC_EXPLICIT_BITRATE
        is_upscale = getattr(plan, "workflow", "compression") == WORKFLOW_UPSCALE

        max_attempts = 1 if is_upscale or is_explicit else DEFAULT_MAX_RETRIES + 1
        attempt = 0

        while attempt < max_attempts:
            if attempt > 0:
                _emit(
                    on_progress,
                    EncodeProgress(
                        percent=0.0,
                        stage=EncodeStage.RETRYING,
                        duration=total_duration,
                        retry_number=attempt + 1,
                        max_retries=max_attempts,
                        message="Adjusting bitrate",
                    ),
                )

            if plan.two_pass:
                result = self._encode_two_pass(
                    ffmpeg,
                    plan,
                    source,
                    output,
                    total_duration,
                    on_progress,
                    retry_number=attempt + 1 if attempt > 0 else None,
                    max_retries=max_attempts if attempt > 0 else None,
                )
            else:
                result = self._encode_single_pass(
                    ffmpeg,
                    plan,
                    source,
                    output,
                    total_duration,
                    on_progress,
                    retry_number=attempt + 1 if attempt > 0 else None,
                    max_retries=max_attempts if attempt > 0 else None,
                )

            if not result.is_file() or result.stat().st_size == 0:
                if attempt < max_attempts - 1:
                    self._cleanup_output(output)
                    attempt += 1
                    continue
                raise EncodeError("Output file is missing or empty after encoding")

            if is_upscale:
                logger.info("Upscale encode complete: %s", format_size(result.stat().st_size))
                return result

            _emit(
                on_progress,
                EncodeProgress(
                    percent=99.0,
                    stage=EncodeStage.VERIFYING,
                    duration=total_duration,
                    retry_number=attempt + 1 if attempt > 0 else None,
                    max_retries=max_attempts if attempt > 0 else None,
                    message="Verifying target size",
                ),
            )

            actual_size = result.stat().st_size
            if is_explicit:
                if actual_size <= plan.target_size:
                    return result
                raise EncodeError(
                    f"Output size {format_size(actual_size)} exceeds hard profile "
                    f"limit {format_size(plan.target_size)}. "
                    f"The explicit bitrate produced a larger file than the profile allows."
                )

            decision = decide_retry(
                actual_size=actual_size,
                target_size=plan.target_size,
                current_video_bitrate=plan.video_bitrate,
                attempt=attempt,
                max_attempts=max_attempts,
                hardware_encoder=is_hardware_encoder(plan.video_encoder),
            )
            if decision.should_retry:
                logger.warning(
                    "Output size %s against target %s; retrying (%s)",
                    format_size(actual_size),
                    format_size(plan.target_size),
                    decision.reason,
                )
                plan.video_bitrate = decision.new_video_bitrate
                self._recalc_plan(plan)
                self._cleanup_output(output)
                attempt += 1
                continue

            if actual_size <= plan.target_size:
                logger.info(
                    "Output size %s within target %s",
                    format_size(actual_size),
                    format_size(plan.target_size),
                )
                return result
            raise EncodeError(
                f"Output size {format_size(actual_size)} exceeds "
                f"target {format_size(plan.target_size)} after {max_attempts} attempts"
            )

        raise EncodeError("Encoding failed after all retries")

    def _recalc_plan(self, plan: EncodePlan) -> None:
        effective_duration = plan.trim_duration
        if effective_duration <= 0 and plan.source_info is not None:
            effective_duration = float(plan.source_info.duration or 0)

        audio_size = (plan.audio_bitrate / 8) * effective_duration
        video_size = (plan.video_bitrate / 8) * effective_duration
        overhead = plan.target_size * AUDIO_OVERHEAD_FACTOR
        plan.estimated_size = int(video_size + audio_size + overhead)

    def reset_cancel(self) -> None:
        self._cancel_event.clear()

    def cancel(self) -> None:
        self._cancel_event.set()
        with self._lock:
            proc = self._process
            if proc and proc.poll() is None:
                if os.name == "nt":
                    self._kill_process_tree_windows(proc)
                else:
                    with contextlib.suppress(Exception):
                        proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        with contextlib.suppress(Exception):
                            proc.kill()

    @staticmethod
    def _kill_process_tree_windows(proc: subprocess.Popen) -> None:
        try:
            pid = proc.pid
            if pid:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                    timeout=10,
                )
        except Exception:
            pass

        with contextlib.suppress(Exception):
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(Exception):
                proc.kill()

    def _encode_two_pass(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
        output: Path,
        total_duration: float,
        on_progress: ProgressCallback | None,
        retry_number: int | None = None,
        max_retries: int | None = None,
    ) -> Path:
        log_file = output.with_suffix(".log")
        null_output = "NUL" if os.name == "nt" else "/dev/null"

        try:
            pass1_cmd = [
                *build_base_cmd(ffmpeg, plan, source),
                "-pass",
                "1",
                "-passlogfile",
                str(log_file),
                "-an",
                "-f",
                "null",
                null_output,
            ]

            logger.info("Pass 1: %s", " ".join(pass1_cmd))
            self._run_pass(
                pass1_cmd,
                total_duration,
                on_progress,
                pass_num=1,
                total_passes=2,
                retry_number=retry_number,
                max_retries=max_retries,
            )

            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user")

            pass2_cmd = [
                *build_base_cmd(ffmpeg, plan, source),
                "-pass",
                "2",
                "-passlogfile",
                str(log_file),
                str(output),
            ]

            logger.info("Pass 2: %s", " ".join(pass2_cmd))
            self._run_pass(
                pass2_cmd,
                total_duration,
                on_progress,
                pass_num=2,
                total_passes=2,
                retry_number=retry_number,
                max_retries=max_retries,
            )

            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user")

        finally:
            self._cleanup_pass_logs(log_file)

        return output

    def _encode_single_pass(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
        output: Path,
        total_duration: float,
        on_progress: ProgressCallback | None,
        retry_number: int | None = None,
        max_retries: int | None = None,
    ) -> Path:
        cmd = [
            *build_base_cmd(ffmpeg, plan, source),
            str(output),
        ]

        logger.info("Single pass: %s", " ".join(cmd))
        self._run_pass(
            cmd,
            total_duration,
            on_progress,
            pass_num=1,
            total_passes=1,
            retry_number=retry_number,
            max_retries=max_retries,
        )

        if self._cancel_event.is_set():
            raise EncodeCancelled("Encoding cancelled by user")

        return output

    def _build_base_cmd(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
    ) -> list[str]:
        return build_base_cmd(ffmpeg, plan, source)

    def _run_pass(
        self,
        cmd: list[str],
        total_duration: float,
        on_progress: ProgressCallback | None,
        pass_num: int,
        total_passes: int = 1,
        retry_number: int | None = None,
        max_retries: int | None = None,
    ) -> None:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        tracker = ProgressTracker(
            total_duration,
            total_passes=total_passes,
            retry_number=retry_number,
            max_retries=max_retries,
        )
        tracker.set_pass(pass_num)
        _emit(on_progress, tracker.snapshot())

        with self._lock:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=creationflags,
            )
            self._process = proc

        stderr_lines: list[str] = []
        returncode: int | None = None

        try:
            assert proc.stderr is not None
            for line in proc.stderr:
                if self._cancel_event.is_set():
                    break
                stderr_lines.append(line)
                if len(stderr_lines) > 200:
                    stderr_lines = stderr_lines[-200:]

                progress = tracker.update_from_line(line)
                if progress is not None:
                    _emit(on_progress, progress)

            proc.wait(timeout=3600 * 24)
            returncode = proc.returncode

        except subprocess.TimeoutExpired:
            self._kill_process_tree()
            proc.wait()
            returncode = proc.returncode
            raise EncodeError("Encoding timed out") from None

        finally:
            with self._lock:
                self._process = None
            self._last_stderr = "".join(stderr_lines[-_MAX_STDERR_DIAG:])

        if self._cancel_event.is_set():
            return

        if returncode is not None and returncode != 0:
            stderr_tail = self._last_stderr
            raise EncodeError(
                f"ffmpeg pass {pass_num} failed with code {returncode}",
                returncode=returncode,
                stderr=stderr_tail,
            )

    def _kill_process_tree(self) -> None:
        with self._lock:
            proc = self._process
            if proc and proc.poll() is None:
                if os.name == "nt":
                    self._kill_process_tree_windows(proc)
                else:
                    with contextlib.suppress(Exception):
                        proc.kill()

    def _cleanup_output(self, output: Path) -> None:
        try:
            if output.exists():
                output.unlink()
        except OSError:
            pass

    def _cleanup_pass_logs(self, log_base: Path) -> None:
        log_dir = log_base.parent
        log_stem = log_base.name
        for f in log_dir.glob(f"{log_stem}*"):
            with contextlib.suppress(OSError):
                f.unlink()


def is_ffmpeg_available() -> bool:
    return _find_ffmpeg() is not None


def cleanup_cache(cache_dir: Path, max_age_hours: int = 24) -> int:
    removed = 0
    if not cache_dir.exists():
        return 0
    cutoff = time.time() - max_age_hours * 3600
    for f in cache_dir.iterdir():
        if f.is_file():
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    removed += 1
            except OSError:
                pass
    return removed
