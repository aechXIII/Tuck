from __future__ import annotations

import contextlib
import copy
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from io import TextIOWrapper
from pathlib import Path
from typing import Any

import av
from av.error import FFmpegError

from ..cutting.analysis import CutAnalysisError
from ..cutting.runner import CutRunner
from ..formatting import format_size
from ..media_tools import find_ffmpeg
from ..models import (
    AUDIO_OVERHEAD_FACTOR,
    ENCODER_AUTO,
    ENCODER_AUTO_COMPRESSION,
    ENCODER_AUTO_FAST,
    RC_EXPLICIT_BITRATE,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    WORKFLOW_UPSCALE,
    EncodePlan,
)
from ..models.cutting import CutPlan
from ..models.encoding_policy import NVENC_ENCODERS, validate_encoder_supported_on_desktop
from ..models.progress import EncodeProgress, EncodeStage
from ..output_paths import copy_file_dates
from ..output_transaction import OutputTransaction
from .capabilities import (
    HW_FAILURE_SETTINGS,
    auto_encoder_candidates,
    get_available_encoders,
    hardware_failure_kind,
    is_hardware_encoder,
)
from .command import build_base_cmd, can_cuda_decode_blend
from .failures import describe_ffmpeg_failure, is_cuda_decode_failure, is_progress_line

# load native array libraries before sidecar workers block on Windows stdio
from .frame_blending import TmixBlend, prepare_blended_video, tmix_blend
from .frame_stream import FrameStream, can_stream_blend
from .progress import ProgressTracker
from .target_size import (
    DEFAULT_MAX_RETRIES,
    UNDERSHOOT_RATIO,
    decide_retry,
    is_content_limited,
    left_bitrate_unused,
)

logger = logging.getLogger(__name__)

# characters of FFmpeg output kept for Diagnostics
_MAX_STDERR_DIAG = 4000
_MAX_STDERR_LINES = 200

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
    return plan


_ENCODER_FAMILY_NAMES = {
    "h264_nvenc": "NVIDIA",
    "hevc_nvenc": "NVIDIA",
    "h264_amf": "AMD",
    "hevc_amf": "AMD",
}


def _encoder_description(encoder: str) -> str:
    family = _ENCODER_FAMILY_NAMES.get(encoder)
    return f"the {family} encoder" if family else "software encoding"


def describe_encoder_fallback(used: str, failures: list[tuple[str, str]]) -> str:
    """Plain words for why Auto ended up on a different encoder than its first choice."""
    if not failures:
        return ""
    families: list[str] = []
    for encoder, _kind in failures:
        family = _ENCODER_FAMILY_NAMES.get(encoder, encoder)
        if family not in families:
            families.append(family)
    if len(families) == 1:
        subject = f"the {families[0]} encoder"
    else:
        subject = f"the {', '.join(families[:-1])} and {families[-1]} encoders"
    settings_only = all(kind == HW_FAILURE_SETTINGS for _encoder, kind in failures)
    reason = "didn't accept these settings" if settings_only else "couldn't start"
    return f"Used {_encoder_description(used)} because {subject} {reason}"


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
        self._encoder_fallback: str = ""
        self._prepared_video: Path | None = None
        self._tmix: TmixBlend | None = None
        self._cuda_decode = False
        self._stream_plan: EncodePlan | None = None
        self._cut_runner = CutRunner()
        self._low_priority = False

    @property
    def last_stderr(self) -> str:
        return self._last_stderr

    def set_low_priority(self, enabled: bool) -> None:
        """Run the next FFmpeg processes below normal priority, so other apps stay smooth."""
        self._low_priority = enabled

    @property
    def resolved_encoder(self) -> str:
        """The encoder the last export ran with, after Auto picked one."""
        return self._resolved_encoder

    @property
    def encoder_fallback(self) -> str:
        """Why the last Auto export moved past its first encoder, or "" when it didn't."""
        return self._encoder_fallback

    def _select_encoder_candidates(self, plan: EncodePlan) -> tuple[bool, tuple[str, ...]]:
        requested = plan.video_encoder or "libx264"
        validate_encoder_supported_on_desktop(requested)
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
        return was_auto, candidates

    def _validate_sources(self, plan: EncodePlan, source: Path) -> None:
        if not source.is_file():
            raise FileNotFoundError(f"Source file not found: {source}")
        for track in plan.audio_tracks:
            for clip in track.clips:
                audio_source = Path(clip.source)
                if not audio_source.is_file():
                    raise FileNotFoundError(f"Audio source file not found: {audio_source}")

    def _run_candidates(
        self,
        candidates: tuple[str, ...],
        was_auto: bool,
        plan: EncodePlan,
        ffmpeg_path: str,
        source: Path,
        tmp_output: Path,
        total_duration: float,
        on_progress: ProgressCallback | None,
    ) -> Path:
        result: Path | None = None
        last_hardware_error: EncodeError | None = None
        failures: list[tuple[str, str]] = []
        for encoder in candidates:
            attempt_plan = _execution_plan(plan, encoder, was_auto)
            self._resolved_encoder = encoder
            self._encoder_fallback = describe_encoder_fallback(encoder, failures)
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
                kind = hardware_failure_kind(exc.stderr) if was_auto else None
                if kind is not None and is_hardware_encoder(encoder):
                    last_hardware_error = exc
                    failures.append((encoder, kind))
                    self._cleanup_output(tmp_output)
                    # a settings refusal usually means Tuck asked for something this GPU
                    # can't do, so keep FFmpeg's reason in the log as well as the fallback
                    logger.warning(
                        "Auto encoder %s could not start (%s); trying next candidate: %s",
                        encoder,
                        kind,
                        (exc.stderr.strip().splitlines() or [""])[-1],
                    )
                    continue
                raise
        if result is None:
            if last_hardware_error is not None:
                raise last_hardware_error
            raise EncodeError("No usable video encoders were detected in this FFmpeg installation.")
        return result

    def encode(
        self,
        plan: EncodePlan | CutPlan,
        on_progress: ProgressCallback | None = None,
    ) -> Path:
        self._resolved_encoder = ""
        self._encoder_fallback = ""
        self._cuda_decode = False
        self._stream_plan = None
        if isinstance(plan, CutPlan):
            self._last_stderr = ""
            try:
                return self._cut_runner.run(plan, on_progress)
            except CutAnalysisError as exc:
                if exc.code in {"cut_cancelled", "analysis_cancelled"}:
                    raise EncodeCancelled("Cutting cancelled by user") from exc
                raise
        plan = copy.deepcopy(plan)
        ffmpeg_path = find_ffmpeg()
        if not ffmpeg_path:
            raise FileNotFoundError(
                "FFmpeg not found. Install FFmpeg and ensure ffmpeg is on PATH "
                "or set the path in settings."
            )

        was_auto, candidates = self._select_encoder_candidates(plan)

        _emit(
            on_progress,
            EncodeProgress(percent=0.0, stage=EncodeStage.PREPARING, message="Preparing"),
        )

        source = Path(plan.source)
        output = Path(plan.output)
        self._validate_sources(plan, source)

        total_duration = plan.effective_duration
        if total_duration <= 0 and plan.source_info is not None:
            total_duration = float(plan.source_info.duration or 0)

        if not plan.original_video_bitrate:
            plan.original_video_bitrate = plan.video_bitrate

        try:
            with OutputTransaction(output, replace=plan.replace_existing) as transaction:
                plan.output = str(transaction.output)
                tmp_output = transaction.workspace / "result.mp4"
                if self._cancel_event.is_set():
                    raise EncodeCancelled("Encoding cancelled by user")
                # FFmpeg blends simple cases itself; the rest are blended frame by frame first
                self._tmix = tmix_blend(plan) if plan.frame_blending.enabled else None
                self._cuda_decode = can_cuda_decode_blend(plan, self._tmix) and bool(
                    get_available_encoders() & NVENC_ENCODERS
                )
                if self._tmix is None and can_stream_blend(plan):
                    self._stream_plan = plan
                elif plan.frame_blending.enabled and self._tmix is None:
                    # the export workspace removes the blended video with everything else
                    self._prepared_video = transaction.workspace / "video.nut"

                    def check_cancel() -> None:
                        if self._cancel_event.is_set():
                            raise EncodeCancelled("Encoding cancelled by user")

                    def blend_progress(fraction: float, fps: float | None = None) -> None:
                        _emit(
                            on_progress,
                            EncodeProgress(
                                percent=0.0,
                                stage=EncodeStage.PREPARING,
                                current_time=fraction * total_duration,
                                duration=total_duration,
                                fps=fps,
                                message=f"Blending frames ({int(fraction * 100)}%)",
                            ),
                        )

                    blend_progress(0.0)
                    prepare_blended_video(plan, self._prepared_video, check_cancel, blend_progress)
                result = self._run_candidates(
                    candidates,
                    was_auto,
                    plan,
                    ffmpeg_path,
                    source,
                    tmp_output,
                    total_duration,
                    on_progress,
                )

                if self._cancel_event.is_set():
                    raise EncodeCancelled("Encoding cancelled by user")
                # a move to another drive can take a while, so it is named instead of sitting at 99%
                _emit(
                    on_progress,
                    EncodeProgress(
                        percent=99.0,
                        stage=EncodeStage.SAVING,
                        duration=total_duration,
                        indeterminate=True,
                    ),
                )
                output = transaction.publish(result)
                plan.output = str(output)
                if plan.keep_file_dates:
                    copy_file_dates(source, output)

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
            _emit(on_progress, EncodeProgress(stage=EncodeStage.CANCELLED, message="Canceled"))
            raise
        except Exception as exc:
            _emit(on_progress, EncodeProgress(stage=EncodeStage.FAILED, message=str(exc)))
            raise
        finally:
            self._prepared_video = None
            self._tmix = None
            self._cuda_decode = False
            self._stream_plan = None

    def _run_one_attempt(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
        output: Path,
        total_duration: float,
        on_progress: ProgressCallback | None,
        attempt: int,
        max_attempts: int,
    ) -> Path:
        retry_number = attempt + 1 if attempt > 0 else None
        max_retries = max_attempts if attempt > 0 else None
        encode = self._encode_two_pass if plan.two_pass else self._encode_single_pass
        try:
            return encode(
                ffmpeg,
                plan,
                source,
                output,
                total_duration,
                on_progress,
                retry_number=retry_number,
                max_retries=max_retries,
            )
        except EncodeError as exc:
            if not self._cuda_decode or not is_cuda_decode_failure(exc.stderr):
                raise
            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user") from exc
            self._cuda_decode = False
            logger.warning("CUDA decoding failed; retrying with software decoding: %s", exc.stderr)
            self._cleanup_output(output)
            _emit(
                on_progress,
                EncodeProgress(
                    percent=0.0,
                    stage=EncodeStage.PREPARING,
                    message="Retrying with software decoding",
                ),
            )
            # restart both passes so their statistics use the same decoded pictures
            return self._run_one_attempt(
                ffmpeg, plan, source, output, total_duration, on_progress, attempt, max_attempts
            )

    def _apply_retry_decision(
        self, plan: EncodePlan, actual_size: int, attempt: int, max_attempts: int
    ) -> bool:
        decision = decide_retry(
            actual_size=actual_size,
            target_size=plan.target_size,
            current_video_bitrate=plan.video_bitrate,
            attempt=attempt,
            max_attempts=max_attempts,
            hardware_encoder=is_hardware_encoder(plan.video_encoder),
        )
        if not decision.should_retry:
            return False
        logger.warning(
            "Output size %s against target %s; retrying (%s)",
            format_size(actual_size),
            format_size(plan.target_size),
            decision.reason,
        )
        plan.video_bitrate = decision.new_video_bitrate
        self._recalc_plan(plan)
        return True

    @staticmethod
    def _emit_retry_progress(
        on_progress: ProgressCallback | None, total_duration: float, attempt: int, max_attempts: int
    ) -> None:
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

    @staticmethod
    def _emit_verifying_progress(
        on_progress: ProgressCallback | None, total_duration: float, attempt: int, max_attempts: int
    ) -> None:
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

    @staticmethod
    def _finalize_explicit(result: Path, plan: EncodePlan, actual_size: int) -> Path:
        if actual_size <= plan.target_size:
            return result
        raise EncodeError(
            f"Output size {format_size(actual_size)} exceeds hard profile "
            f"limit {format_size(plan.target_size)}. "
            f"The explicit bitrate produced a larger file than the profile allows."
        )

    @staticmethod
    def _finalize_within_target(
        result: Path, plan: EncodePlan, actual_size: int, max_attempts: int
    ) -> Path:
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
        is_upscale = plan.workflow == WORKFLOW_UPSCALE

        max_attempts = 1 if is_upscale or is_explicit else DEFAULT_MAX_RETRIES + 1
        attempt = 0
        previous_size: int | None = None
        attempt_outputs: list[Path] = []
        best_result: Path | None = None
        best_size = 0
        best_bitrate = plan.video_bitrate
        best_estimated_size = plan.estimated_size

        def accept(result: Path) -> Path:
            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user")
            if best_result is not None:
                result = best_result
                plan.video_bitrate = best_bitrate
                plan.estimated_size = best_estimated_size
            result.replace(output)
            return output

        try:
            while attempt < max_attempts:
                if self._cancel_event.is_set():
                    raise EncodeCancelled("Encoding cancelled by user")
                if attempt > 0:
                    self._emit_retry_progress(on_progress, total_duration, attempt, max_attempts)

                # each attempt gets its own file so refinement cannot destroy a usable export
                try:
                    fd, attempt_name = tempfile.mkstemp(
                        prefix="attempt-", suffix=".mp4", dir=output.parent
                    )
                except OSError as exc:
                    if best_result is None:
                        raise
                    logger.warning(
                        "Keeping the under-target export; cannot start refinement: %s", exc
                    )
                    return accept(best_result)
                os.close(fd)
                attempt_output = Path(attempt_name)
                attempt_outputs.append(attempt_output)
                # FFmpeg refuses an existing output, including the empty reservation
                attempt_output.unlink()
                try:
                    result = self._run_one_attempt(
                        ffmpeg,
                        plan,
                        source,
                        attempt_output,
                        total_duration,
                        on_progress,
                        attempt,
                        max_attempts,
                    )
                except OSError as exc:
                    if self._cancel_event.is_set():
                        raise EncodeCancelled("Encoding cancelled by user") from exc
                    if best_result is None:
                        raise
                    logger.warning(
                        "Keeping the under-target export after refinement failed: %s", exc
                    )
                    return accept(best_result)
                if self._cancel_event.is_set():
                    raise EncodeCancelled("Encoding cancelled by user")

                if not result.is_file() or result.stat().st_size == 0:
                    self._cleanup_output(attempt_output)
                    if attempt >= max_attempts - 1:
                        raise EncodeError("Output file is missing or empty after encoding")
                    attempt += 1
                    continue

                if is_upscale:
                    logger.info("Upscale encode complete: %s", format_size(result.stat().st_size))
                    return accept(result)

                self._emit_verifying_progress(on_progress, total_duration, attempt, max_attempts)
                actual_size = result.stat().st_size

                if is_explicit:
                    return accept(self._finalize_explicit(result, plan, actual_size))

                # size ranks how closely an output fills the budget, not its image quality
                if actual_size <= plan.target_size and actual_size > best_size:
                    if best_result is not None:
                        self._cleanup_output(best_result)
                    best_result = result
                    best_size = actual_size
                    best_bitrate = plan.video_bitrate
                    best_estimated_size = plan.estimated_size

                # more bitrate cannot help when the preceding refinement barely grew the file
                if previous_size is not None and is_content_limited(
                    previous_size, actual_size, plan.target_size
                ):
                    logger.info(
                        "Output size %s is content-limited "
                        "(grew %.1f%% on more bitrate); accepting",
                        format_size(actual_size),
                        (actual_size / max(previous_size, 1) - 1.0) * 100.0,
                    )
                    return accept(result)

                # unused bitrate shows the same limit before spending another full encode
                if actual_size < plan.target_size * UNDERSHOOT_RATIO and self._left_bitrate_unused(
                    result, plan
                ):
                    logger.info(
                        "Output size %s is content-limited (video bitrate left unused); accepting",
                        format_size(actual_size),
                    )
                    return accept(result)

                previous_size = actual_size
                if self._apply_retry_decision(plan, actual_size, attempt, max_attempts):
                    if result != best_result:
                        self._cleanup_output(result)
                    attempt += 1
                    continue

                return accept(self._finalize_within_target(result, plan, actual_size, max_attempts))

            raise EncodeError("Encoding failed after all retries")
        except EncodeError as exc:
            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user") from exc
            if best_result is None:
                raise
            logger.warning("Keeping the under-target export after refinement failed: %s", exc)
            return accept(best_result)
        finally:
            for attempt_output in attempt_outputs:
                self._cleanup_output(attempt_output)

    @staticmethod
    def _left_bitrate_unused(result: Path, plan: EncodePlan) -> bool:
        try:
            with av.open(str(result)) as container:
                if not container.streams.video or not container.duration:
                    return False
                # the output's own length, so a source that misstates its length still retries
                duration = container.duration / av.time_base
                video_bytes = sum(p.size for p in container.demux(container.streams.video[0]))
        except (FFmpegError, OSError):
            # an output that cannot be measured keeps the usual retry
            return False
        return left_bitrate_unused(video_bytes, duration, plan.video_bitrate)

    def _recalc_plan(self, plan: EncodePlan) -> None:
        effective_duration = plan.effective_duration
        if effective_duration <= 0 and plan.source_info is not None:
            effective_duration = float(plan.source_info.duration or 0)

        audio_size = (plan.total_audio_bitrate / 8) * effective_duration
        video_size = (plan.video_bitrate / 8) * effective_duration
        overhead = plan.target_size * AUDIO_OVERHEAD_FACTOR
        plan.estimated_size = int(video_size + audio_size + overhead)

    def reset_cancel(self) -> None:
        self._cancel_event.clear()
        self._cut_runner.reset_cancel()

    def cancel(self) -> None:
        self._cancel_event.set()
        self._cut_runner.cancel()
        with self._lock:
            proc = self._process
            if proc and proc.poll() is None:
                if os.name == "nt":
                    self._kill_process_tree_windows(proc)
                else:
                    self._terminate_posix(proc)

    @staticmethod
    def _terminate_posix(proc: subprocess.Popen, timeout: float = 3) -> None:
        with contextlib.suppress(Exception):
            proc.terminate()
        try:
            proc.wait(timeout=timeout)
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
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                    timeout=10,
                )
        except Exception:
            logger.debug("taskkill failed while killing process tree", exc_info=True)

        FFmpegEngine._terminate_posix(proc, timeout=5)

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
                *build_base_cmd(
                    ffmpeg,
                    plan,
                    source,
                    include_audio=False,
                    prepared_video=self._prepared_video,
                    blend=self._tmix,
                    cuda_decode=self._cuda_decode,
                ),
                "-pass",
                "1",
                "-passlogfile",
                str(log_file),
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
                *build_base_cmd(
                    ffmpeg,
                    plan,
                    source,
                    prepared_video=self._prepared_video,
                    blend=self._tmix,
                    cuda_decode=self._cuda_decode,
                ),
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
            *build_base_cmd(
                ffmpeg,
                plan,
                source,
                prepared_video=self._prepared_video,
                blend=self._tmix,
                cuda_decode=self._cuda_decode,
                streamed_video=self._stream_plan is not None,
            ),
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

    def _consume_stderr(
        self,
        proc: subprocess.Popen,
        tracker: ProgressTracker,
        on_progress: ProgressCallback | None,
        stderr_lines: list[str],
    ) -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            if self._cancel_event.is_set():
                break
            progress = tracker.update_from_line(line)
            if progress is not None:
                _emit(on_progress, progress)
            # progress records would push the lines that explain a failure out of the tail
            if is_progress_line(line):
                continue
            stderr_lines.append(line)
            if len(stderr_lines) > _MAX_STDERR_LINES:
                del stderr_lines[:-_MAX_STDERR_LINES]

    def _spawn_ffmpeg(
        self, cmd: list[str], creationflags: int, *, stream_video: bool = False
    ) -> subprocess.Popen:
        if self._low_priority and sys.platform == "win32":
            creationflags |= subprocess.BELOW_NORMAL_PRIORITY_CLASS
        with self._lock:
            # cancel() takes this lock before killing the current process, so checking here
            # means a cancel between runs is never followed by a fresh FFmpeg
            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user")
            proc = subprocess.Popen(
                cmd,
                # a private pipe carries frames; FFmpeg never inherits the sidecar request pipe
                stdin=subprocess.PIPE if stream_video else subprocess.DEVNULL,
                # progress and diagnostics come from stderr; ffmpeg's stdout is
                # unused, and an unread stdout pipe deadlocks a verbose encode
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                # FFmpeg writes UTF-8 whatever the Windows code page is, and file names
                # in its messages can hold any character
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
            self._process = proc
        if self._low_priority and sys.platform != "win32":
            try:
                os.setpriority(os.PRIO_PROCESS, proc.pid, 10)
            except OSError as exc:
                logger.warning("Could not lower the export priority: %s", exc)
        return proc

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
            # this FFmpeg run blends the frames itself, so its fps is the blending rate
            report_fps=self._tmix is not None or self._stream_plan is not None,
        )
        tracker.set_pass(pass_num)
        _emit(on_progress, tracker.snapshot())

        proc = (
            self._spawn_ffmpeg(cmd, creationflags, stream_video=True)
            if self._stream_plan is not None
            else self._spawn_ffmpeg(cmd, creationflags)
        )

        stderr_lines: list[str] = []
        returncode: int | None = None
        stream: FrameStream | None = None

        try:
            if self._stream_plan is not None:
                assert isinstance(proc.stdin, TextIOWrapper)

                def check_cancel() -> None:
                    if self._cancel_event.is_set():
                        raise EncodeCancelled("Encoding cancelled by user")

                stream = FrameStream(self._stream_plan, check_cancel, self._kill_process_tree)
                stream.start(proc.stdin.buffer)
            self._consume_stderr(proc, tracker, on_progress, stderr_lines)
            proc.wait(timeout=3600 * 24)
            returncode = proc.returncode

        except subprocess.TimeoutExpired:
            self._kill_process_tree()
            proc.wait()
            returncode = proc.returncode
            raise EncodeError(
                "The export took longer than a day and was stopped. "
                "Try a faster speed setting or a shorter selection."
            ) from None

        finally:
            # reading stops early on cancel or a failed progress callback, and an FFmpeg
            # left running would block the wait forever and keep the output open
            if proc.poll() is None:
                self._kill_process_tree()
                proc.wait()
            if stream is not None:
                stream.stop()
                stream.join()
            if self._stream_plan is not None and proc.stdin is not None:
                proc.stdin.close()
            if proc.stderr is not None:
                proc.stderr.close()
            with self._lock:
                self._process = None
            self._last_stderr = "".join(stderr_lines)[-_MAX_STDERR_DIAG:]

        if self._cancel_event.is_set():
            raise EncodeCancelled("Encoding cancelled by user")

        if stream is not None and stream.error is not None:
            raise stream.error

        if returncode is not None and returncode != 0:
            full_tail = "".join(stderr_lines)
            logger.warning("FFmpeg pass %s failed with code %s", pass_num, returncode)
            raise EncodeError(
                describe_ffmpeg_failure(full_tail, returncode),
                returncode=returncode,
                stderr=full_tail,
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
            logger.debug("Could not remove output file: %s", output, exc_info=True)

    def _cleanup_pass_logs(self, log_base: Path) -> None:
        log_dir = log_base.parent
        log_stem = log_base.name
        for f in log_dir.glob(f"{log_stem}*"):
            with contextlib.suppress(OSError):
                f.unlink()


def is_ffmpeg_available() -> bool:
    return find_ffmpeg() is not None


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
                logger.debug("Could not remove cache file: %s", f, exc_info=True)
    return removed
