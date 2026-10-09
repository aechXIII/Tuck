from __future__ import annotations

import contextlib
import errno
import logging
import os
import re
import secrets
import shutil
import sys
import threading
from pathlib import Path
from stat import FILE_ATTRIBUTE_REPARSE_POINT

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


RESERVATION_SUFFIX = ".reserved"
WORKSPACE_PREFIX = ".tuck-"
# every container Tuck writes; a reservation for any other name is never Tuck's
OUTPUT_EXTENSIONS = frozenset(
    {".mp4", ".m4v", ".mov", ".3gp", ".mkv", ".webm"}
    | {".ts", ".m2ts", ".mts", ".avi", ".flv", ".ogv"}
)
# scratch folders, their locks, and locks still being created; older versions named
# their folders the same way through tempfile, so their leftovers match too
_WORKSPACE_NAME = re.compile(r"\.tuck-[a-z0-9_]{8}")
_WORKSPACE_LOCK_NAME = re.compile(r"\.tuck-[a-z0-9_]{8}\.lock")
_PENDING_NAME = re.compile(r"\.tuck-[a-z0-9_]{8}\.pending")


def reservation_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + RESERVATION_SUFFIX)


# link() errors on filesystems without hard links: FAT32, exFAT, and many FUSE and SMB mounts
_NO_HARD_LINK_ERRORS = frozenset({errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS})


def hard_links_unsupported(exc: OSError) -> bool:
    return exc.errno in _NO_HARD_LINK_ERRORS


def new_workspace_id() -> str:
    return secrets.token_hex(4)


def workspace_lock_path(workspace: Path) -> Path:
    return workspace.with_name(workspace.name + ".lock")


class HeldFile:
    """An empty marker file kept open for as long as its owner is working.

    A crash can't remove markers, so other Tuck processes tell a live one from a
    leftover by whether it is still held: on Windows the open handle refuses deletion,
    elsewhere the file carries a lock that ends with the process.
    """

    def __init__(self, path: Path, descriptor: int) -> None:
        self.path = path
        self._descriptor: int | None = descriptor

    def release(self) -> None:
        """Remove the marker; a failure is only logged, since an unheld marker is swept later."""
        descriptor, self._descriptor = self._descriptor, None
        if descriptor is None:
            return
        try:
            if os.name == "nt":
                # the open handle refuses deletion, so it is closed first; if another export
                # takes the name in between, its own handle makes this unlink fail harmlessly
                os.close(descriptor)
                self.path.unlink(missing_ok=True)
            else:
                # unlinking while still locked can't remove a newer marker with the same name
                try:
                    self.path.unlink(missing_ok=True)
                finally:
                    os.close(descriptor)
        except OSError as exc:
            logger.warning("Could not remove %s: %s", self.path.name, exc)


if sys.platform != "win32":
    import fcntl

    def hold_new_file(path: Path) -> HeldFile:
        """Create ``path`` as a held marker; FileExistsError when the name is already taken."""
        # the lock is taken under a temporary name and the file is then linked into place,
        # so a sweep in another process never sees the marker unlocked
        for _ in range(100):
            pending = path.parent / f"{WORKSPACE_PREFIX}{new_workspace_id()}.pending"
            try:
                descriptor = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            except FileExistsError:
                continue
            linked = False
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.link(pending, path)
                linked = True
            except (FileNotFoundError, BlockingIOError):
                # a sweep in another process removed the pending name or is removing it
                # right now; take a new one
                continue
            except OSError as exc:
                if not hard_links_unsupported(exc):
                    raise
                return _hold_in_place(path)
            finally:
                if not linked:
                    os.close(descriptor)
                with contextlib.suppress(OSError):
                    pending.unlink()
            return HeldFile(path, descriptor)
        raise FileExistsError(f"Could not create {path.name}. Try another output folder.")

    def _hold_in_place(path: Path) -> HeldFile:
        # without hard links the marker has to be created under its real name and locked a
        # moment later. A sweep in another process that opens it in that gap sees it unheld
        # and may remove it, so the lock only counts once the name still leads to this
        # file. The gap is microseconds and needs another Tuck process sweeping the same
        # folder at that instant; the worst case is a FileExistsError that moves the export
        # on to another name, never two exports sharing one
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        owned = False
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            held = os.fstat(descriptor)
            current = os.stat(path, follow_symlinks=False)
            owned = (held.st_dev, held.st_ino) == (current.st_dev, current.st_ino)
        except (BlockingIOError, FileNotFoundError):
            # a sweep got to it in the gap
            pass
        finally:
            if not owned:
                os.close(descriptor)
        if not owned:
            raise FileExistsError(f"Could not create {path.name}. Try another output folder.")
        return HeldFile(path, descriptor)

    def remove_if_unheld(path: Path) -> bool:
        """Remove a marker nobody holds any more; False while its owner is still working."""
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        except FileNotFoundError:
            return True
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            # another sweep may have removed it and a new owner taken the name since it
            # was opened; only this exact file may go
            held = os.fstat(descriptor)
            try:
                current = os.stat(path, follow_symlinks=False)
            except FileNotFoundError:
                return True
            if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
                return False
            path.unlink()
            return True
        finally:
            os.close(descriptor)

else:

    def hold_new_file(path: Path) -> HeldFile:
        """Create ``path`` as a held marker; FileExistsError when the name is already taken."""
        # os.open shares read and write but not delete, and that refusal is the hold
        return HeldFile(path, os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))

    def remove_if_unheld(path: Path) -> bool:
        """Remove a marker nobody holds any more; False while its owner is still working."""
        try:
            path.unlink()
        except FileNotFoundError:
            return True
        except PermissionError:
            # a sharing violation: the owner still has it open
            return False
        return True


def _is_plain_empty_file(entry: os.DirEntry[str]) -> bool:
    return entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_size == 0


def _is_plain_directory(entry: os.DirEntry[str]) -> bool:
    if not entry.is_dir(follow_symlinks=False):
        return False
    # a junction is not a symlink to Python, but it must never be followed either
    attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
    return not attributes & FILE_ATTRIBUTE_REPARSE_POINT


def _is_tuck_reservation(entry: os.DirEntry[str]) -> bool:
    name = entry.name
    if not name.endswith(RESERVATION_SUFFIX):
        return False
    output = Path(name[: -len(RESERVATION_SUFFIX)])
    return (
        bool(output.stem)
        and output.suffix.lower() in OUTPUT_EXTENSIONS
        and _is_plain_empty_file(entry)
    )


def _sweep_entry(folder: Path, entry: os.DirEntry[str]) -> None:
    path = folder / entry.name
    if _is_tuck_reservation(entry) or (
        _PENDING_NAME.fullmatch(entry.name) and _is_plain_empty_file(entry)
    ):
        if remove_if_unheld(path):
            logger.info("Removed %s left behind by an earlier export", entry.name)
        return
    if _WORKSPACE_LOCK_NAME.fullmatch(entry.name) and _is_plain_empty_file(entry):
        # a lock without its folder: the owner crashed between the two removals
        if not path.with_name(entry.name[: -len(".lock")]).exists() and remove_if_unheld(path):
            logger.info("Removed %s left behind by an earlier export", entry.name)
        return
    # the lock is created before the folder and removed after it, so a folder whose lock
    # is gone or unheld belongs to nobody
    if (
        _WORKSPACE_NAME.fullmatch(entry.name)
        and _is_plain_directory(entry)
        and remove_if_unheld(workspace_lock_path(path))
    ):
        shutil.rmtree(path)
        logger.info("Removed %s left behind by an earlier export", entry.name)


def sweep_stale_outputs(folder: Path) -> None:
    """Remove reservations and scratch folders an interrupted export left in ``folder``.

    Only Tuck's own empty markers and scratch folders are considered, and anything
    another export still holds is left alone, so this is safe while other Tuck
    processes export into the same folder. Problems are logged, never raised.
    """
    try:
        with os.scandir(folder) as listing:
            entries = list(listing)
    except OSError:
        # a missing, offline, or unreadable folder has nothing Tuck can clean up
        return
    for entry in entries:
        try:
            _sweep_entry(folder, entry)
        except FileNotFoundError:
            # its owner finished, or another sweep or this one already removed it
            continue
        except OSError as exc:
            logger.warning("Could not remove %s left by an earlier export: %s", entry.name, exc)


def sweep_stale_outputs_later(folder: Path) -> threading.Thread:
    """Sweep ``folder`` without holding up startup; a slow or offline drive can take a while."""
    worker = threading.Thread(
        target=sweep_stale_outputs, args=(folder,), name="tuck-output-sweep", daemon=True
    )
    worker.start()
    return worker


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
