from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ..desktop_platform import is_linux_desktop
from ..media_tools import find_ffmpeg, media_tool_environment
from ..models import (
    ENCODER_AUTO,
    ENCODER_AUTO_COMPRESSION,
    ENCODER_AUTO_FAST,
)
from ..models.encoding_policy import (
    AMF_ENCODERS,
    CPU_ENCODERS,
    NVENC_ENCODERS,
    VAAPI_ENCODERS,
    VALID_VIDEO_ENCODERS,
    validate_encoder_supported_on_desktop,
)
from .vaapi import choose_encode_device, clear_probe_cache, environment_fingerprint

logger = logging.getLogger(__name__)

_encoder_cache: frozenset[str] | None = None
_encoder_cache_fingerprint: str | None = None
_encoder_cache_lock = threading.Lock()
_ENCODER_CACHE_FILE = "encoders.json"

# these name a missing or unusable GPU, driver, or runtime
_HW_DEVICE_MARKERS = (
    "no nvenc capable devices found",
    "cannot load nvcuda",
    "cannot load libcuda",
    "cannot load libnvidia-encode",
    "cannot load nvencodeapi",
    "openencode session create failed",
    "openencodesessionex failed",
    "nvenc api version",
    "no capable devices found",
    "no cuda-capable device",
    "device creation failed",
    "failed to initialise amf",
    "amf context create",
    # the AMD runtime DLL is missing when there's no AMD GPU or driver
    "dll amfrt",
    "cannot create cuda",
    "cuda_error",
    "driver does not support",
    "not supported by the device",
    "no device available",
    "failed to initialise vaapi connection",
    "no va display found",
    "failed to create a vaapi device",
    "failed to upload frame",
)
# FFmpeg prints these for any encoder that refuses to open, including one that rejects an
# option or a frame size, so on their own they don't prove the GPU is missing
_HW_OPEN_MARKERS = (
    "failed to open codec",
    "error while opening encoder",
    "could not open encoder",
    "no usable encoding profile found",
    "failed to create encode pipeline",
    "rate control mode is not supported",
)
_OPTION_ERROR_MARKERS = (
    "unable to parse option value",
    "error setting option",
    "option not found",
    "undefined constant or missing",
    "error applying encoder options",
)

HW_FAILURE_DEVICE = "device"
HW_FAILURE_SETTINGS = "settings"

# a filter row is its flags, its name, then its input and output kinds such as "V->V"
_FILTER_ROW_RE = re.compile(r"^\s*[T.][S.][C.]\s+(\S+)\s+\S*->\S*")
_filter_cache: dict[str, frozenset[str]] = {}
_filter_cache_lock = threading.Lock()
# zscale converts PQ and HLG to linear light; tonemap then fits the highlights into SDR
TONE_MAP_FILTERS = frozenset({"zscale", "tonemap"})


@dataclass(frozen=True)
class EncoderCapabilities:
    available: frozenset[str]
    has_nvidia: bool
    has_amd: bool
    has_cpu: bool
    has_vaapi: bool = False

    def to_dict(self) -> dict:
        return {
            "available": sorted(self.available),
            "has_nvidia": self.has_nvidia,
            "has_amd": self.has_amd,
            "has_cpu": self.has_cpu,
            "has_vaapi": self.has_vaapi,
            "supports_auto": self.has_cpu or self.has_nvidia or self.has_amd or self.has_vaapi,
        }


def _detect_available_encoders(ffmpeg_path: str) -> frozenset[str]:
    try:
        result = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode != 0:
            logger.warning("ffmpeg -encoders returned non-zero; assuming no encoders available")
            return frozenset()
        available: set[str] = set()
        for line in result.stdout.splitlines():
            for enc in VALID_VIDEO_ENCODERS:
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
            # ffmpeg reads keys from a piped stdin, and the sidecar's holds request frames
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
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
    if is_linux_desktop():
        return frozenset(
            compiled & CPU_ENCODERS
            | {
                encoder
                for encoder in compiled & NVENC_ENCODERS
                if _hardware_encoder_works(ffmpeg_path, encoder)
            }
            | {
                encoder
                for encoder in compiled & VAAPI_ENCODERS
                if choose_encode_device(ffmpeg_path, encoder) is not None
            }
        )
    usable = set(compiled - (NVENC_ENCODERS | AMF_ENCODERS | VAAPI_ENCODERS))
    usable.update(
        encoder
        for encoder in compiled & (NVENC_ENCODERS | AMF_ENCODERS)
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
            isinstance(encoder, str) and encoder in VALID_VIDEO_ENCODERS for encoder in encoders
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


def _linux_encoder_fingerprint(ffmpeg: str) -> str:
    environment = media_tool_environment()
    version_paths = (Path("/sys/module/nvidia/version"), Path("/proc/driver/nvidia/version"))
    paths = {Path("/etc/ld.so.cache"), Path("/dev/dxg"), *version_paths}
    library_dirs = {
        Path("/usr/lib"),
        Path("/usr/lib64"),
        Path("/usr/lib/x86_64-linux-gnu"),
        Path("/lib/x86_64-linux-gnu"),
        Path("/usr/lib/nvidia/current"),
        Path("/usr/lib/x86_64-linux-gnu/nvidia/current"),
        Path("/usr/lib/wsl/lib"),
        *(Path(part) for part in environment.get("LD_LIBRARY_PATH", "").split(os.pathsep) if part),
    }
    for directory, pattern in (
        (Path("/dev"), "nvidia*"),
        (Path("/dev/nvidia-caps"), "nvidia-cap*"),
    ):
        try:
            paths.update(directory.glob(pattern))
        except OSError:
            continue
    for root in (Path("/usr/lib"), Path("/usr/lib/x86_64-linux-gnu")):
        try:
            library_dirs.update(root.glob("nvidia*"))
        except OSError:
            continue
    for directory in library_dirs:
        try:
            paths.update(directory.glob("libcuda.so*"))
            paths.update(directory.glob("libnvidia-encode.so*"))
        except OSError:
            continue
    files: list[tuple[str, int, int, int, int, int, int]] = []
    for path in sorted(paths):
        try:
            stat = path.stat()
            files.append(
                (
                    str(path.resolve()),
                    stat.st_mtime_ns,
                    stat.st_ctime_ns,
                    stat.st_size,
                    stat.st_mode,
                    stat.st_ino,
                    stat.st_dev,
                )
            )
        except OSError:
            files.append((str(path), 0, 0, 0, 0, 0, 0))
    versions: list[str] = []
    for path in version_paths:
        try:
            # proc and sysfs versions can change without a useful file timestamp
            versions.append(path.read_text(encoding="utf-8").strip())
        except OSError:
            versions.append("")
    identity = (
        environment_fingerprint(ffmpeg),
        files,
        versions,
        tuple(
            environment.get(name)
            for name in (
                "LD_LIBRARY_PATH",
                "CUDA_VISIBLE_DEVICES",
                "CUDA_DEVICE_ORDER",
                "NVIDIA_VISIBLE_DEVICES",
            )
        ),
    )
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()


def get_available_encoders(*, refresh: bool = False) -> frozenset[str]:
    global _encoder_cache, _encoder_cache_fingerprint
    linux = is_linux_desktop()
    ffmpeg_path = find_ffmpeg() if linux else None
    fingerprint = _linux_encoder_fingerprint(ffmpeg_path) if ffmpeg_path else None
    if _encoder_cache is not None and not refresh and fingerprint == _encoder_cache_fingerprint:
        return _desktop_supported_encoders(_encoder_cache)
    with _encoder_cache_lock:
        if _encoder_cache is not None and not refresh and fingerprint == _encoder_cache_fingerprint:
            return _desktop_supported_encoders(_encoder_cache)
        ffmpeg_path = ffmpeg_path or find_ffmpeg()
        _encoder_cache_fingerprint = fingerprint
        if refresh:
            clear_probe_cache()
        if not ffmpeg_path:
            _encoder_cache = frozenset()
            return _encoder_cache
        from ..settings import get_settings_manager

        cache_days = int(get_settings_manager().get_setting("encoder_cache_days", 7) or 0)
        # a saved encoder list cannot prove the current render node and driver can encode
        cached = None if refresh or linux else _load_cached_encoders(ffmpeg_path, cache_days)
        if cached is not None:
            _encoder_cache = _desktop_supported_encoders(cached)
            return _encoder_cache
        _encoder_cache = _desktop_supported_encoders(_detect_usable_encoders(ffmpeg_path))
        if cache_days > 0:
            _save_cached_encoders(ffmpeg_path, _encoder_cache)
        return _encoder_cache


def clear_encoder_cache(*, delete_disk: bool = False) -> None:
    global _encoder_cache, _encoder_cache_fingerprint
    with _encoder_cache_lock:
        _encoder_cache = None
        _encoder_cache_fingerprint = None
        clear_probe_cache()
        if delete_disk:
            try:
                _encoder_cache_path().unlink(missing_ok=True)
            except OSError:
                logger.debug("Could not remove encoder cache", exc_info=True)


def get_encoder_capabilities(
    available: frozenset[str] | None = None,
) -> EncoderCapabilities:
    encs = _desktop_supported_encoders(
        available if available is not None else get_available_encoders()
    )
    return EncoderCapabilities(
        available=encs,
        has_nvidia=bool(encs & NVENC_ENCODERS),
        has_amd=bool(encs & AMF_ENCODERS),
        has_cpu=bool(encs & CPU_ENCODERS),
        has_vaapi=bool(encs & VAAPI_ENCODERS),
    )


def auto_encoder_candidates(
    preferred_codec: str = "h264",
    available: frozenset[str] | None = None,
    *,
    fastest: bool = True,
) -> tuple[str, ...]:
    detected = available if available is not None else get_available_encoders()
    encs = _desktop_supported_encoders(detected)
    hevc = preferred_codec.lower() in ("hevc", "h265", "x265")
    if fastest:
        order = (
            (
                "hevc_nvenc",
                "hevc_amf",
                "hevc_vaapi",
                "libx265",
                "h264_nvenc",
                "h264_amf",
                "h264_vaapi",
                "libx264",
            )
            if hevc
            else (
                "h264_nvenc",
                "h264_amf",
                "h264_vaapi",
                "libx264",
                "hevc_nvenc",
                "hevc_amf",
                "hevc_vaapi",
                "libx265",
            )
        )
    else:
        order = (
            (
                "libx265",
                "libx264",
                "hevc_nvenc",
                "hevc_amf",
                "hevc_vaapi",
                "h264_nvenc",
                "h264_amf",
                "h264_vaapi",
            )
            if hevc
            else (
                "libx264",
                "libx265",
                "h264_nvenc",
                "h264_amf",
                "h264_vaapi",
                "hevc_nvenc",
                "hevc_amf",
                "hevc_vaapi",
            )
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
    validate_encoder_supported_on_desktop(requested)
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
    return encoder in NVENC_ENCODERS | AMF_ENCODERS | VAAPI_ENCODERS


def _desktop_supported_encoders(encoders: frozenset[str]) -> frozenset[str]:
    return (
        frozenset(encoders & (CPU_ENCODERS | NVENC_ENCODERS | VAAPI_ENCODERS))
        if is_linux_desktop()
        else frozenset(encoders - VAAPI_ENCODERS)
    )


def hardware_failure_kind(stderr: str) -> str | None:
    """Why a hardware encoder failed to start, or None when the failure was something else.

    HW_FAILURE_DEVICE means the GPU, driver, or runtime isn't usable. HW_FAILURE_SETTINGS means
    the encoder refused the options or picture it was given, which a working GPU can also do.
    """
    text = (stderr or "").lower()
    if not text:
        return None
    if any(marker in text for marker in _HW_DEVICE_MARKERS):
        return HW_FAILURE_DEVICE
    if any(marker in text for marker in _OPTION_ERROR_MARKERS + _HW_OPEN_MARKERS):
        return HW_FAILURE_SETTINGS
    return None


def parse_filter_names(listing: str) -> frozenset[str]:
    """Filter names from `ffmpeg -filters`, without its legend."""
    return frozenset(
        match.group(1) for line in listing.splitlines() if (match := _FILTER_ROW_RE.match(line))
    )


def get_available_filters() -> frozenset[str]:
    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        return frozenset()
    with _filter_cache_lock:
        cached = _filter_cache.get(ffmpeg_path)
        if cached is not None:
            return cached
        try:
            result = subprocess.run(
                [ffmpeg_path, "-hide_banner", "-filters"],
                env=media_tool_environment(),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except (OSError, subprocess.SubprocessError):
            logger.warning("Could not list FFmpeg filters", exc_info=True)
            return frozenset()
        filters = parse_filter_names(result.stdout) if result.returncode == 0 else frozenset()
        if result.returncode != 0:
            logger.warning("ffmpeg -filters returned %s; assuming no filters", result.returncode)
        _filter_cache[ffmpeg_path] = filters
        return filters


def can_tone_map_hdr() -> bool:
    return TONE_MAP_FILTERS.issubset(get_available_filters())
