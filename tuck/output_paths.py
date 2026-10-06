from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def export_directory(source: Path, output_dir: str = "", subfolder: str = "") -> Path:
    """The folder an export of ``source`` is written to; a chosen folder wins over a subfolder."""
    if output_dir:
        return Path(output_dir)
    if subfolder:
        return source.parent / subfolder
    return source.parent


def copy_file_dates(source: Path, output: Path) -> None:
    """Give a published export the source's file dates: modified and accessed everywhere, and
    created as well on Windows, where Explorer shows it.

    The export is already safe on disk, so a failure here is logged and ignored.
    """
    try:
        stat = source.stat()
        os.utime(output, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        if sys.platform == "win32":
            # st_ctime is the creation time on Windows; newer Pythons name it st_birthtime
            created = getattr(stat, "st_birthtime_ns", stat.st_ctime_ns)
            _set_creation_time(output, created)
    except OSError as exc:
        logger.warning("Could not copy the source file dates to the export: %s", exc)


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _FILE_WRITE_ATTRIBUTES = 0x0100
    _FILE_SHARE_ALL = 0x1 | 0x2 | 0x4
    _OPEN_EXISTING = 3
    # FILETIME counts 100 ns steps from 1601; Unix time starts 11644473600 s later
    _FILETIME_UNIX_OFFSET = 116_444_736_000_000_000

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    _kernel32.SetFileTime.restype = wintypes.BOOL
    _kernel32.SetFileTime.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _INVALID_HANDLE = wintypes.HANDLE(-1).value

    def _set_creation_time(path: Path, created_ns: int) -> None:
        ticks = created_ns // 100 + _FILETIME_UNIX_OFFSET
        created = wintypes.FILETIME(ticks & 0xFFFFFFFF, ticks >> 32)
        handle = _kernel32.CreateFileW(
            str(path), _FILE_WRITE_ATTRIBUTES, _FILE_SHARE_ALL, None, _OPEN_EXISTING, 0, None
        )
        if handle == _INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not _kernel32.SetFileTime(handle, ctypes.byref(created), None, None):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            _kernel32.CloseHandle(handle)


def reservation_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + ".reserved")


def path_is_taken(output: Path, *, respect_reservation: bool = True) -> bool:
    if output.exists():
        return True
    return respect_reservation and reservation_path(output).exists()


def resolve_output_collision(
    output: Path,
    *,
    respect_reservation: bool = True,
) -> Path:
    if not path_is_taken(output, respect_reservation=respect_reservation):
        return output
    base = output.parent / output.stem
    suffix = output.suffix
    for counter in range(1, 101):
        candidate = base.parent / f"{base.name}_{counter}{suffix}"
        if not path_is_taken(candidate, respect_reservation=respect_reservation):
            logger.info("Output collision resolved: %s -> %s", output, candidate)
            return candidate
    raise ValueError(f"Too many output file collisions for {output}. Clean up existing files.")
