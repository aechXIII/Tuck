from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from .desktop_platform import is_linux_desktop
from .packaged import bundled_media_tool, is_frozen
from .settings import get_settings_manager

_WINDOWS_LOCATIONS = {
    "ffmpeg": (
        Path(r"C:\ffmpeg\bin\ffmpeg.exe"),
        Path(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"),
        Path(r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe"),
    ),
    "ffprobe": (
        Path(r"C:\ffmpeg\bin\ffprobe.exe"),
        Path(r"C:\Program Files\ffmpeg\bin\ffprobe.exe"),
        Path(r"C:\Program Files (x86)\ffmpeg\bin\ffprobe.exe"),
    ),
}


def media_tool_environment() -> dict[str, str]:
    environment = dict(os.environ)
    if sys.platform == "linux" and is_frozen():
        # host graphics drivers must not load PyInstaller's bundled Python libraries
        original = environment.get("LD_LIBRARY_PATH_ORIG")
        if original is None:
            environment.pop("LD_LIBRARY_PATH", None)
        else:
            environment["LD_LIBRARY_PATH"] = original
    return environment


def _find_tool(name: str, setting_name: str) -> str | None:
    configured = get_settings_manager().get_setting(setting_name, "")
    if configured:
        configured_path = Path(str(configured))
        if configured_path.is_file():
            return str(configured_path)

    # installed builds use the verified bundle unless the user deliberately
    # selected another valid executable in Settings
    bundled = bundled_media_tool(name)
    if bundled is not None:
        return str(bundled)

    found = shutil.which(name)
    if found:
        return found

    if not is_linux_desktop():
        for candidate in _WINDOWS_LOCATIONS[name]:
            if candidate.is_file():
                return str(candidate)
    return None


def find_ffmpeg() -> str | None:
    return _find_tool("ffmpeg", "ffmpeg_path")


def find_ffprobe() -> str | None:
    return _find_tool("ffprobe", "ffprobe_path")
