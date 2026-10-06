from __future__ import annotations

import contextlib
import logging
import shutil
import subprocess
import sys
from collections.abc import Generator
from typing import Protocol

logger = logging.getLogger(__name__)

REASON = "Exporting videos in Tuck"


if sys.platform == "win32":

    class _WindowsPowerRequest:
        """A power request handle; unlike SetThreadExecutionState it isn't tied to one thread."""

        def __init__(self) -> None:
            import ctypes
            from ctypes import wintypes

            class _ReasonContext(ctypes.Structure):
                _fields_ = [
                    ("Version", wintypes.ULONG),
                    ("Flags", wintypes.DWORD),
                    ("SimpleReasonString", wintypes.LPWSTR),
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.PowerCreateRequest.restype = wintypes.HANDLE
            kernel32.PowerCreateRequest.argtypes = [ctypes.POINTER(_ReasonContext)]
            kernel32.PowerSetRequest.argtypes = [wintypes.HANDLE, ctypes.c_int]
            kernel32.PowerSetRequest.restype = wintypes.BOOL
            kernel32.PowerClearRequest.argtypes = [wintypes.HANDLE, ctypes.c_int]
            kernel32.PowerClearRequest.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            self._kernel32 = kernel32
            # POWER_REQUEST_CONTEXT_VERSION 0 with a simple reason string
            context = _ReasonContext(0, 0x1, REASON)
            handle = kernel32.PowerCreateRequest(ctypes.byref(context))
            if not handle or handle == wintypes.HANDLE(-1).value:
                raise OSError(ctypes.get_last_error(), "PowerCreateRequest failed")
            self._handle = handle
            # PowerRequestSystemRequired: the PC stays awake, the screen may still turn off
            if not kernel32.PowerSetRequest(handle, 1):
                error = ctypes.get_last_error()
                kernel32.CloseHandle(handle)
                raise OSError(error, "PowerSetRequest failed")

        def release(self) -> None:
            self._kernel32.PowerClearRequest(self._handle, 1)
            self._kernel32.CloseHandle(self._handle)


class _LinuxInhibitor:
    """Holds a systemd-logind sleep lock for as long as a helper process lives."""

    def __init__(self, systemd_inhibit: str) -> None:
        # the helper waits on a pipe from Tuck rather than sleeping forever, so the lock also
        # ends if Tuck exits without releasing it
        self._process = subprocess.Popen(
            [
                systemd_inhibit,
                "--what=sleep:idle",
                "--who=Tuck",
                f"--why={REASON}",
                "--mode=block",
                "cat",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def release(self) -> None:
        if self._process.stdin is not None:
            with contextlib.suppress(OSError):
                self._process.stdin.close()
        try:
            self._process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()


class _Lock(Protocol):
    def release(self) -> None: ...


@contextlib.contextmanager
def keep_awake(enabled: bool = True) -> Generator[None]:
    """Keep the computer from sleeping while the body runs.

    Sleep is only held off, never forced; where the platform can't do this the
    export still runs and the reason is logged.
    """
    if not enabled:
        yield
        return
    lock: _Lock | None = None
    try:
        if sys.platform == "win32":
            lock = _WindowsPowerRequest()
        else:
            helper = shutil.which("systemd-inhibit")
            if helper is None:
                logger.info("systemd-inhibit was not found; the computer may sleep during exports")
            else:
                lock = _LinuxInhibitor(helper)
    except OSError as exc:
        logger.warning("Could not keep the computer awake during exports: %s", exc)
    try:
        yield
    finally:
        if lock is not None:
            try:
                lock.release()
            except OSError as exc:
                logger.warning("Could not release the keep-awake request: %s", exc)
