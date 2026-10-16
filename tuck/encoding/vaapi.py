from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path

from ..desktop_platform import is_linux_desktop
from ..media_tools import media_tool_environment
from ..models.encoding_policy import VAAPI_ENCODERS

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class VaapiEncodeDevice:
    device: str

    def __post_init__(self) -> None:
        # FFmpeg device strings also accept driver options; only discovered render nodes belong here
        if re.fullmatch(r"/dev/dri/renderD[0-9]+", self.device) is None:
            raise ValueError("VAAPI encoding requires a DRM render device")

    @property
    def init_args(self) -> list[str]:
        return [
            "-init_hw_device",
            f"vaapi=tuck_encode:{self.device}",
            "-filter_hw_device",
            "tuck_encode",
        ]


def render_devices() -> tuple[VaapiEncodeDevice, ...]:
    try:
        return tuple(
            VaapiEncodeDevice(str(path))
            for path in sorted(Path("/dev/dri").glob("renderD*"))
            if path.is_char_device() and re.fullmatch(r"renderD[0-9]+", path.name)
        )
    except OSError:
        return ()


def environment_fingerprint(ffmpeg: str) -> str:
    paths = {Path(ffmpeg)}
    for device in render_devices():
        path = Path(device.device)
        paths.add(path)
        paths.add(Path("/sys/class/drm") / path.name / "device/driver")
    driver_dirs = {
        Path("/usr/lib/dri"),
        Path("/usr/lib64/dri"),
        Path("/usr/lib/x86_64-linux-gnu/dri"),
        *(Path(part) for part in os.environ.get("LIBVA_DRIVERS_PATH", "").split(":") if part),
    }
    for directory in driver_dirs:
        try:
            paths.update(directory.glob("*_drv_video.so"))
        except OSError:
            continue
    files: list[tuple[str, int, int, int, int, int]] = []
    for path in sorted(paths):
        try:
            stat = path.stat()
            files.append(
                (
                    str(path.resolve()),
                    stat.st_mtime_ns,
                    stat.st_size,
                    stat.st_mode,
                    stat.st_ino,
                    stat.st_dev,
                )
            )
        except OSError:
            files.append((str(path), 0, 0, 0, 0, 0))
    identity = (
        files,
        os.environ.get("LIBVA_DRIVER_NAME", ""),
        os.environ.get("LIBVA_DRIVERS_PATH", ""),
        media_tool_environment().get("LD_LIBRARY_PATH"),
    )
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()


_probe_cache: dict[tuple[str, str], VaapiEncodeDevice | None] = {}
_probe_lock = threading.Lock()


def clear_probe_cache() -> None:
    with _probe_lock:
        _probe_cache.clear()


def _device_encodes(ffmpeg: str, encoder: str, device: VaapiEncodeDevice) -> bool:
    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                *device.init_args,
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=1280x720:d=0.1",
                "-vf",
                "format=nv12,hwupload",
                "-frames:v",
                "1",
                "-an",
                "-c:v",
                encoder,
                "-rc_mode",
                "CQP",
                "-qp",
                "23",
                "-f",
                "null",
                "-",
            ],
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.SubprocessError):
        logger.info("VAAPI encoder %s could not probe %s", encoder, device.device, exc_info=True)
        return False
    if result.returncode:
        logger.info(
            "VAAPI encoder %s is unavailable on %s: %s",
            encoder,
            device.device,
            result.stderr.strip(),
        )
    return result.returncode == 0


def choose_encode_device(ffmpeg: str, encoder: str) -> VaapiEncodeDevice | None:
    if not is_linux_desktop() or encoder not in VAAPI_ENCODERS:
        return None
    key = (environment_fingerprint(ffmpeg), encoder)
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
        device = next(
            (device for device in render_devices() if _device_encodes(ffmpeg, encoder, device)),
            None,
        )
        _probe_cache[key] = device
        return device
