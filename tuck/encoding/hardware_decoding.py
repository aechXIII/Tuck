from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..desktop_platform import is_linux_desktop
from ..media_tools import media_tool_environment
from ..models.encoding_policy import NVENC_ENCODERS

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HardwareDecode:
    backend: Literal["cuda", "d3d11va", "vaapi"]
    device: str = ""

    @property
    def init_args(self) -> list[str]:
        return [
            "-init_hw_device",
            f"{self.backend}=tuck_decode" + (f":{self.device}" if self.device else ""),
        ]

    @property
    def device_args(self) -> list[str]:
        return [*self.init_args, "-hwaccel_device", "tuck_decode"]

    @property
    def input_args(self) -> list[str]:
        return [
            *self.device_args,
            "-xerror",
            "-c:v",
            "av1",
            "-hwaccel",
            self.backend,
            "-hwaccel_output_format",
            "d3d11" if self.backend == "d3d11va" else self.backend,
        ]


def device_available(ffmpeg_path: str, decoder: HardwareDecode) -> bool:
    """Probe device initialization; unsupported AV1 profiles still retry on the CPU."""
    try:
        result = subprocess.run(
            [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                *decoder.init_args,
                "-f",
                "lavfi",
                "-i",
                "color=s=16x16:d=0.01",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ],
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode != 0:
            logger.info(
                "%s decoding device unavailable: %s", decoder.backend, result.stderr[-2000:]
            )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        logger.info("%s decoding device could not be initialized", decoder.backend, exc_info=True)
        return False


def render_devices() -> list[str]:
    def is_amd(path: Path) -> bool:
        try:
            vendor = (Path("/sys/class/drm") / path.name / "device/vendor").read_text().strip()
        except OSError:
            return False
        return vendor == "0x1002"

    try:
        # keep other adapters on their existing path until their export speed is verified
        devices = [
            path
            for path in Path("/dev/dri").glob("renderD*")
            if path.is_char_device() and is_amd(path)
        ]
        return [str(path) for path in sorted(devices)]
    except OSError:
        return []


def choose_hardware_decode(ffmpeg_path: str, available: frozenset[str]) -> HardwareDecode | None:
    if is_linux_desktop():
        cuda = HardwareDecode("cuda")
        if device_available(ffmpeg_path, cuda):
            return cuda
        for device in render_devices():
            vaapi = HardwareDecode("vaapi", device)
            if device_available(ffmpeg_path, vaapi):
                return vaapi
    else:
        if available & NVENC_ENCODERS:
            return HardwareDecode("cuda")
        # use AMD on hybrid laptops even when their display is attached to an Intel adapter
        d3d11 = HardwareDecode("d3d11va", ",vendor_id=0x1002")
        if device_available(ffmpeg_path, d3d11):
            return d3d11
    return None
