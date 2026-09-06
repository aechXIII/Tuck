"""Packaging-aware resource resolution.

The only module that inspects ``sys.frozen`` / ``sys._MEIPASS`` / the executable
directory; everything else receives already-resolved paths from here.

* source checkout: nothing bundled, callers fall back to settings and ``PATH``.
* packaged sidecar: the Tauri shell passes ``TUCK_BUNDLED_FFMPEG`` /
  ``TUCK_BUNDLED_FFPROBE`` because only Rust knows the resource directory.
* packaged CLI: no environment set, so tools are found next to the executable.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

TOOLS_DIR_ENV = "TUCK_BUNDLED_TOOLS_DIR"
FFMPEG_ENV = "TUCK_BUNDLED_FFMPEG"
FFPROBE_ENV = "TUCK_BUNDLED_FFPROBE"

_TOOL_ENV = {"ffmpeg": FFMPEG_ENV, "ffprobe": FFPROBE_ENV}
_BUNDLED_TOOLS_SUBDIR = "ffmpeg"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def executable_dir() -> Path:
    """Directory of the running executable. Only meaningful in a frozen build."""

    return Path(sys.executable).resolve().parent


def _tool_filename(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


def _explicit_tool_path(name: str) -> Path | None:
    raw = os.environ.get(_TOOL_ENV[name])
    if not raw:
        return None
    candidate = Path(raw)
    return candidate if candidate.is_file() else None


def _bundled_tool_dirs() -> list[Path]:
    dirs: list[Path] = []
    raw_dir = os.environ.get(TOOLS_DIR_ENV)
    if raw_dir:
        dirs.append(Path(raw_dir))
    if is_frozen():
        exe_dir = executable_dir()
        dirs.append(exe_dir / _BUNDLED_TOOLS_SUBDIR)
        dirs.append(exe_dir / "resources" / _BUNDLED_TOOLS_SUBDIR)
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            dirs.append(Path(meipass) / _BUNDLED_TOOLS_SUBDIR)
    seen: set[Path] = set()
    unique: list[Path] = []
    for directory in dirs:
        resolved = directory
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def bundled_media_tool(name: str) -> Path | None:
    """Return the bundled ``ffmpeg``/``ffprobe`` path, or ``None`` when unbundled.

    An explicit ``TUCK_BUNDLED_*`` environment path is honored first; otherwise
    the executable-relative locations are searched. A configured environment
    path that does not exist is ignored rather than trusted.
    """

    if name not in _TOOL_ENV:
        raise ValueError(f"Unknown media tool: {name!r}")
    explicit = _explicit_tool_path(name)
    if explicit is not None:
        return explicit
    filename = _tool_filename(name)
    for directory in _bundled_tool_dirs():
        candidate = directory / filename
        if candidate.is_file():
            return candidate
    return None
