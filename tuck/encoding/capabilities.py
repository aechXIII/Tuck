from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ..models import (
    _AMF_ENCODERS,
    _CPU_ENCODERS,
    _NVENC_ENCODERS,
    _VALID_VIDEO_ENCODERS,
    ENCODER_AUTO,
    ENCODER_AUTO_COMPRESSION,
    ENCODER_AUTO_FAST,
)

logger = logging.getLogger(__name__)

_encoder_cache: frozenset[str] | None = None
_encoder_cache_lock = threading.Lock()
_ENCODER_CACHE_FILE = "encoders.json"

_HW_INIT_MARKERS = (
    "no nvenc capable devices found",
    "cannot load nvcuda",
    "cannot load nvencodeapi",
    "openencode session create failed",
    "nvenc api version",
    "no capable devices found",
    "device creation failed",
    "failed to initialise amf",
    "amf context create",
    "failed to open codec",
    "error while opening encoder",
    "cannot create cuda",
    "cuda_error",
    "driver does not support",
    "not supported by the device",
    "no device available",
    "could not open encoder",
)


@dataclass(frozen=True)
class EncoderCapabilities:
    available: frozenset[str]
    has_nvidia: bool
    has_amd: bool
    has_cpu: bool

    def to_dict(self) -> dict:
        return {
            "available": sorted(self.available),
            "has_nvidia": self.has_nvidia,
            "has_amd": self.has_amd,
            "has_cpu": self.has_cpu,
            "supports_auto": self.has_cpu or self.has_nvidia or self.has_amd,
        }


def _find_ffmpeg() -> str | None:
    from ..settings import get_settings_manager

    mgr = get_settings_manager()
    custom = mgr.get_setting("ffmpeg_path", "")
    if custom and os.path.isfile(str(custom)):
        return str(custom)

    import shutil

    found = shutil.which("ffmpeg")
    if found:
        return found

    candidates = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
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


def _hardware_encoder_works(ffmpeg_path: str, encoder: str) -> bool:
    null_output = "NUL" if os.name == "nt" else "/dev/null"
    try:
        result = subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=1280x720:d=0.1",
                "-frames:v",
                "1",
                "-an",
                "-c:v",
                encoder,
                "-f",
                "null",
                null_output,
            ],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode == 0:
            return True
        logger.info("Hardware encoder %s is unavailable: %s", encoder, result.stderr.strip())
    except Exception:
        logger.info("Hardware encoder %s could not be initialized", encoder, exc_info=True)
    return False


def _detect_usable_encoders(ffmpeg_path: str) -> frozenset[str]:
    compiled = _detect_available_encoders(ffmpeg_path)
    usable = set(compiled - (_NVENC_ENCODERS | _AMF_ENCODERS))
    usable.update(
        encoder
        for encoder in compiled & (_NVENC_ENCODERS | _AMF_ENCODERS)
        if _hardware_encoder_works(ffmpeg_path, encoder)
    )
    return frozenset(usable)


def _encoder_cache_path() -> Path:
    from ..settings import get_settings_manager

    return get_settings_manager().cache_dir / _ENCODER_CACHE_FILE


def _load_cached_encoders(ffmpeg_path: str, max_age_days: int) -> frozenset[str] | None:
    if max_age_days <= 0:
        return None
    try:
        data = json.loads(_encoder_cache_path().read_text(encoding="utf-8"))
        if data.get("ffmpeg_path") != os.path.abspath(ffmpeg_path):
            return None
        if time.time() - float(data["created_at"]) > max_age_days * 86_400:
            return None
        encoders = data["encoders"]
        if not isinstance(encoders, list) or not all(
            isinstance(encoder, str) and encoder in _VALID_VIDEO_ENCODERS for encoder in encoders
        ):
            return None
        return frozenset(encoders)
    except (OSError, TypeError, ValueError, json.JSONDecodeError, KeyError):
        return None


def _save_cached_encoders(ffmpeg_path: str, encoders: frozenset[str]) -> None:
    try:
        cache_path = _encoder_cache_path()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(
                {
                    "ffmpeg_path": os.path.abspath(ffmpeg_path),
                    "created_at": time.time(),
                    "encoders": sorted(encoders),
                }
            ),
            encoding="utf-8",
        )
    except OSError:
        logger.debug("Could not save encoder cache", exc_info=True)


def get_available_encoders(*, refresh: bool = False) -> frozenset[str]:
    global _encoder_cache
    if _encoder_cache is not None and not refresh:
        return _encoder_cache
    with _encoder_cache_lock:
        if _encoder_cache is not None and not refresh:
            return _encoder_cache
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            _encoder_cache = frozenset()
            return _encoder_cache
        from ..settings import get_settings_manager

        cache_days = int(get_settings_manager().get_setting("encoder_cache_days", 7) or 0)
        cached = None if refresh else _load_cached_encoders(ffmpeg_path, cache_days)
        if cached is not None:
            _encoder_cache = cached
            return _encoder_cache
        _encoder_cache = _detect_usable_encoders(ffmpeg_path)
        if cache_days > 0:
            _save_cached_encoders(ffmpeg_path, _encoder_cache)
        return _encoder_cache


def clear_encoder_cache(*, delete_disk: bool = False) -> None:
    global _encoder_cache
    with _encoder_cache_lock:
        _encoder_cache = None
        if delete_disk:
            try:
                _encoder_cache_path().unlink(missing_ok=True)
            except OSError:
                logger.debug("Could not remove encoder cache", exc_info=True)


def get_encoder_capabilities(
    available: frozenset[str] | None = None,
) -> EncoderCapabilities:
    encs = available if available is not None else get_available_encoders()
    return EncoderCapabilities(
        available=encs,
        has_nvidia=bool(encs & _NVENC_ENCODERS),
        has_amd=bool(encs & _AMF_ENCODERS),
        has_cpu=bool(encs & _CPU_ENCODERS),
    )


def auto_encoder_candidates(
    preferred_codec: str = "h264",
    available: frozenset[str] | None = None,
    *,
    fastest: bool = True,
) -> tuple[str, ...]:
    encs = available if available is not None else get_available_encoders()
    hevc = preferred_codec.lower() in ("hevc", "h265", "x265")
    if fastest:
        order = (
            ("hevc_nvenc", "hevc_amf", "libx265", "h264_nvenc", "h264_amf", "libx264")
            if hevc
            else ("h264_nvenc", "h264_amf", "libx264", "hevc_nvenc", "hevc_amf", "libx265")
        )
    else:
        order = (
            ("libx265", "libx264", "hevc_nvenc", "hevc_amf", "h264_nvenc", "h264_amf")
            if hevc
            else ("libx264", "libx265", "h264_nvenc", "h264_amf", "hevc_nvenc", "hevc_amf")
        )
    candidates = tuple(encoder for encoder in order if encoder in encs)
    return candidates or ("libx264",)


def select_auto_encoder(
    preferred_codec: str = "h264",
    available: frozenset[str] | None = None,
) -> str:
    return auto_encoder_candidates(preferred_codec, available)[0]


def resolve_encoder(
    requested: str,
    available: frozenset[str] | None = None,
) -> tuple[str, bool]:
    encs = available if available is not None else get_available_encoders()
    if not requested or requested in (ENCODER_AUTO, ENCODER_AUTO_FAST, ENCODER_AUTO_COMPRESSION):
        return (
            auto_encoder_candidates(available=encs, fastest=requested != ENCODER_AUTO_COMPRESSION)[
                0
            ],
            True,
        )
    return requested, False


def is_hardware_encoder(encoder: str) -> bool:
    return encoder in _NVENC_ENCODERS or encoder in _AMF_ENCODERS


def is_hardware_init_failure(stderr: str, returncode: int = -1) -> bool:
    _ = returncode
    text = (stderr or "").lower()
    if not text:
        return False
    return any(marker in text for marker in _HW_INIT_MARKERS)


def cpu_fallback_encoder(encoder: str) -> str:
    if encoder in ("hevc_nvenc", "hevc_amf", "libx265"):
        return "libx265"
    return "libx264"
