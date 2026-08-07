from __future__ import annotations

import contextlib
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .models import (
    _AMF_ENCODERS,
    _CPU_ENCODERS,
    _NVENC_ENCODERS,
    _VALID_VIDEO_ENCODERS,
    AUDIO_OVERHEAD_FACTOR,
    RC_EXPLICIT_BITRATE,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    WORKFLOW_UPSCALE,
    EncodePlan,
)
from .planner import _reservation_exists

logger = logging.getLogger(__name__)

_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")

_MAX_STDERR_DIAG = 4000

_MAX_RETRIES = 2

_encoder_cache: frozenset[str] | None = None
_encoder_cache_lock = threading.Lock()


def _find_ffmpeg() -> str | None:
    from .settings import get_settings_manager

    mgr = get_settings_manager()
    custom = mgr.get_setting("ffmpeg_path", "")
    if custom and Path(custom).is_file():
        return custom

    found = shutil.which("ffmpeg")
    if found:
        return found

    candidates = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
    ]
    for c in candidates:
        if Path(c).is_file():
            return c

    return None


def _detect_available_encoders(ffmpeg_path: str) -> frozenset[str]:
    try:
        result = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode != 0:
            logger.warning("ffmpeg -encoders returned non-zero; assuming no encoders available")
            return frozenset()
        available: set[str] = set()
        for line in result.stdout.splitlines():
            for enc in _VALID_VIDEO_ENCODERS:
                if enc in line:
                    available.add(enc)
        return frozenset(available)
    except Exception:
        logger.warning("Failed to detect ffmpeg encoders", exc_info=True)
        return frozenset()


def get_available_encoders() -> frozenset[str]:
    """Return cached set of available FFmpeg encoders.

    Discovers via ``ffmpeg -encoders`` on first call and caches the result.
    Returns an empty frozenset if FFmpeg is not found or discovery fails.
    """
    global _encoder_cache
    if _encoder_cache is not None:
        return _encoder_cache
    with _encoder_cache_lock:
        if _encoder_cache is not None:
            return _encoder_cache
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            _encoder_cache = frozenset()
            return _encoder_cache
        _encoder_cache = _detect_available_encoders(ffmpeg_path)
        return _encoder_cache


class EncodeError(Exception):
    def __init__(self, message: str, returncode: int = -1, stderr: str = ""):
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


class EncodeCancelled(Exception):
    pass


class FFmpegEngine:
    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None
        self._cancel_event = threading.Event()
        self._lock = threading.Lock()

    def encode(
        self,
        plan: EncodePlan,
        on_progress: Callable[[float], None] | None = None,
    ) -> Path:
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            raise FileNotFoundError(
                "ffmpeg not found. Install FFmpeg and ensure ffmpeg is on PATH "
                "or set the path in settings."
            )

        encoder = getattr(plan, "video_encoder", "libx264")
        available = get_available_encoders()
        if encoder not in available:
            raise EncodeError(
                f"Encoder '{encoder}' is not available in this FFmpeg installation. "
                f"Available encoders: {sorted(available) if available else 'none detected'}. "
                f"Install an FFmpeg build that includes '{encoder}' or choose a different encoder."
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
            from .planner import _resolve_output_collision

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

        total_duration = plan.source_info.duration if plan.source_info else 0

        self._cancel_event.clear()

        if not plan.original_video_bitrate:
            plan.original_video_bitrate = plan.video_bitrate

        tmp_output = output.parent / f".tmp_{output.stem}_{os.getpid()}.mp4"

        try:
            result = self._encode_with_retry(
                ffmpeg_path,
                plan,
                source,
                tmp_output,
                total_duration,
                on_progress,
            )

            if output.exists() or _reservation_exists(output):
                from .planner import _resolve_output_collision

                output = _resolve_output_collision(output)
                reservation.unlink(missing_ok=True)
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
            return output

        except EncodeCancelled:
            self._cleanup_output(tmp_output)
            self._cleanup_output(reservation)
            raise
        except Exception:
            self._cleanup_output(tmp_output)
            self._cleanup_output(reservation)
            raise

    def _encode_with_retry(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
        output: Path,
        total_duration: float,
        on_progress: Callable[[float], None] | None,
    ) -> Path:
        is_explicit = plan.rate_control == RC_EXPLICIT_BITRATE
        is_upscale = getattr(plan, "workflow", "compression") == WORKFLOW_UPSCALE

        max_attempts = 1 if is_upscale or is_explicit else _MAX_RETRIES + 1

        for attempt in range(max_attempts):
            if attempt > 0:
                plan.video_bitrate = int(plan.video_bitrate * 0.9)
                logger.info(
                    "Retry %d: lowering video bitrate to %d kbps",
                    attempt,
                    plan.video_bitrate // 1000,
                )
                self._recalc_plan(plan)

            if plan.two_pass:
                result = self._encode_two_pass(
                    ffmpeg,
                    plan,
                    source,
                    output,
                    total_duration,
                    on_progress,
                )
            else:
                result = self._encode_single_pass(
                    ffmpeg,
                    plan,
                    source,
                    output,
                    total_duration,
                    on_progress,
                )

            if not result.is_file() or result.stat().st_size == 0:
                if attempt < max_attempts - 1:
                    self._cleanup_output(output)
                    continue
                raise EncodeError("Output file is missing or empty after encoding")

            if is_upscale:
                logger.info("Upscale encode complete: %s", _fmt_size(result.stat().st_size))
                return result

            actual_size = result.stat().st_size
            if actual_size <= plan.target_size:
                logger.info(
                    "Output size %s within target %s",
                    _fmt_size(actual_size),
                    _fmt_size(plan.target_size),
                )
                return result

            if is_explicit:
                raise EncodeError(
                    f"Output size {_fmt_size(actual_size)} exceeds hard profile "
                    f"limit {_fmt_size(plan.target_size)}. "
                    f"The explicit bitrate produced a larger file than the profile allows."
                )

            if attempt < max_attempts - 1:
                logger.warning(
                    "Output size %s exceeds target %s; retrying",
                    _fmt_size(actual_size),
                    _fmt_size(plan.target_size),
                )
                self._cleanup_output(output)
                continue

            raise EncodeError(
                f"Output size {_fmt_size(actual_size)} exceeds "
                f"target {_fmt_size(plan.target_size)} after {max_attempts} attempts"
            )

        raise EncodeError("Encoding failed after all retries")

    def _recalc_plan(self, plan: EncodePlan) -> None:
        effective_duration = plan.source_info.duration if plan.source_info else 0

        audio_size = (plan.audio_bitrate / 8) * effective_duration
        video_size = (plan.video_bitrate / 8) * effective_duration
        overhead = plan.target_size * AUDIO_OVERHEAD_FACTOR
        plan.estimated_size = int(video_size + audio_size + overhead)

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
        on_progress: Callable[[float], None] | None,
    ) -> Path:
        log_file = output.with_suffix(".log")
        null_output = "NUL" if os.name == "nt" else "/dev/null"

        try:
            pass1_cmd = [
                *self._build_base_cmd(ffmpeg, plan, source),
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
            self._run_pass(pass1_cmd, total_duration, on_progress, pass_num=1)

            if self._cancel_event.is_set():
                raise EncodeCancelled("Encoding cancelled by user")

            pass2_cmd = [
                *self._build_base_cmd(ffmpeg, plan, source),
                "-pass",
                "2",
                "-passlogfile",
                str(log_file),
                str(output),
            ]

            logger.info("Pass 2: %s", " ".join(pass2_cmd))
            self._run_pass(pass2_cmd, total_duration, on_progress, pass_num=2)

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
        on_progress: Callable[[float], None] | None,
    ) -> Path:
        cmd = [
            *self._build_base_cmd(ffmpeg, plan, source),
            str(output),
        ]

        logger.info("Single pass: %s", " ".join(cmd))
        self._run_pass(cmd, total_duration, on_progress, pass_num=1)

        if self._cancel_event.is_set():
            raise EncodeCancelled("Encoding cancelled by user")

        return output

    def _build_base_cmd(
        self,
        ffmpeg: str,
        plan: EncodePlan,
        source: Path,
    ) -> list[str]:
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-stats"]

        cmd += ["-i", str(source)]

        vf_parts = []
        if plan.apply_scale and plan.target_width > 0 and plan.target_height > 0:
            scaler_flag = _scaler_to_ffmpeg_flag(getattr(plan, "scaler", "neighbor"))
            vf_parts.append(f"scale={plan.target_width}:{plan.target_height}:flags={scaler_flag}")
        if plan.apply_fps_filter and plan.target_fps > 0:
            vf_parts.append(f"fps={plan.target_fps}")

        if vf_parts:
            cmd += ["-vf", ",".join(vf_parts)]

        encoder = getattr(plan, "video_encoder", "libx264")
        rc_method = getattr(plan, "rate_control_method", RCM_CRF)
        qp_val = getattr(plan, "qp", 23)
        cq_val = getattr(plan, "cq", qp_val)
        crf_val = getattr(plan, "crf", 23)

        cmd += ["-c:v", encoder]

        if encoder in _CPU_ENCODERS:
            cmd += ["-preset", plan.preset]
            tune = getattr(plan, "tune", "")
            if tune:
                cmd += ["-tune", tune]
            if rc_method == RCM_CRF:
                cmd += ["-crf", str(crf_val)]
            elif rc_method == RCM_CBR:
                bitrate = plan.video_bitrate
                if bitrate <= 0:
                    bitrate = 2_000_000
                cmd += ["-b:v", str(bitrate)]
                cmd += ["-minrate", str(bitrate)]
                cmd += ["-maxrate", str(bitrate)]
                cmd += ["-bufsize", str(bitrate)]
        elif encoder in _NVENC_ENCODERS:
            cmd += ["-preset", _nvenc_preset(plan.preset)]
            if rc_method == RCM_CQ:
                bitrate = plan.video_bitrate
                cmd += ["-rc", "vbr", "-cq", str(cq_val)]
                if bitrate > 0:
                    cmd += ["-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]
            elif rc_method == RCM_CQP:
                cmd += ["-rc", "constqp", "-qp", str(qp_val)]
            elif rc_method == RCM_CBR:
                bitrate = plan.video_bitrate
                if bitrate <= 0:
                    bitrate = 2_000_000
                cmd += ["-rc", "cbr", "-b:v", str(bitrate)]
            elif rc_method == RCM_VBR:
                bitrate = plan.video_bitrate
                if bitrate <= 0:
                    bitrate = 2_000_000
                cmd += ["-rc", "vbr", "-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]
        elif encoder in _AMF_ENCODERS:
            cmd += ["-usage", "transcoding"]
            if rc_method in (RCM_CQ, RCM_CQP):
                cmd += [
                    "-rc",
                    "cqp",
                    "-qp_i",
                    str(cq_val),
                    "-qp_p",
                    str(cq_val),
                    "-qp_b",
                    str(cq_val),
                ]
            elif rc_method == RCM_CBR:
                bitrate = plan.video_bitrate
                if bitrate <= 0:
                    bitrate = 2_000_000
                cmd += ["-rc", "cbr", "-b:v", str(bitrate)]
            elif rc_method == RCM_VBR:
                bitrate = plan.video_bitrate
                if bitrate <= 0:
                    bitrate = 2_000_000
                cmd += ["-rc", "vbr", "-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]

        cmd += ["-pix_fmt", "yuv420p"]

        if getattr(plan, "copy_audio", False):
            cmd += ["-c:a", "copy"]
        elif plan.audio_bitrate > 0:
            cmd += ["-c:a", "aac", "-b:a", str(plan.audio_bitrate)]
            cmd += ["-ac", str(plan.audio_channels)]
            cmd += ["-ar", str(plan.audio_sample_rate)]
        else:
            cmd += ["-an"]

        cmd += ["-movflags", "+faststart"]

        return cmd

    def _run_pass(
        self,
        cmd: list[str],
        total_duration: float,
        on_progress: Callable[[float], None] | None,
        pass_num: int,
    ) -> None:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

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
            last_progress = 0.0
            assert proc.stderr is not None
            for line in proc.stderr:
                if self._cancel_event.is_set():
                    break
                stderr_lines.append(line)
                if len(stderr_lines) > 200:
                    stderr_lines = stderr_lines[-200:]

                m = _TIME_RE.search(line)
                if m and total_duration > 0:
                    h, mn, s = m.groups()
                    elapsed = int(h) * 3600 + int(mn) * 60 + float(s)
                    progress = min((elapsed / total_duration) * 100.0, 100.0)

                    progress = progress * 0.5 if pass_num == 1 else 50.0 + progress * 0.5
                    if progress > last_progress:
                        last_progress = progress
                        if on_progress:
                            on_progress(progress)

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

        if self._cancel_event.is_set():
            return

        if returncode is not None and returncode != 0:
            stderr_tail = "".join(stderr_lines[-_MAX_STDERR_DIAG:])
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


def _fmt_size(bytes_val: int | float) -> str:
    b = float(bytes_val)
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


_SCALER_TO_FFMPEG: dict[str, str] = {
    "bilinear": "bilinear",
    "bicubic": "bicubic",
    "lanczos": "lanczos",
    "nearest": "neighbor",
    "point": "neighbor",
}


def _scaler_to_ffmpeg_flag(scaler: str) -> str:
    return _SCALER_TO_FFMPEG.get(scaler, "neighbor")


_NVENC_PRESET_MAP: dict[str, str] = {
    "ultrafast": "p1",
    "superfast": "p2",
    "veryfast": "p3",
    "faster": "p3",
    "fast": "p4",
    "medium": "p6",
    "slow": "p6",
    "slower": "p7",
    "veryslow": "p7",
}


def _nvenc_preset(preset: str) -> str:
    return (
        preset
        if preset in {"p1", "p2", "p3", "p4", "p5", "p6", "p7"}
        else _NVENC_PRESET_MAP.get(preset, "p5")
    )
