from __future__ import annotations

import ctypes
import json
import logging
import os
from collections.abc import Callable
from ctypes import wintypes
from pathlib import Path
from typing import cast

logger = logging.getLogger(__name__)

MUTEX_NAME = "Local\\Tuck_SingleInstance_v1"
MAP_NAME = "Local\\Tuck_SharedMemory_v1"
WM_COPYDATA = 0x004A

MAX_PAYLOAD_SIZE = 4096

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(
    LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)

_user32 = ctypes.windll.user32 if os.name == "nt" else None
if _user32 is not None:
    _user32.CallWindowProcW.argtypes = [
        ctypes.c_void_p,  # WNDPROC lpPrevWndFunc
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    _user32.CallWindowProcW.restype = LRESULT

    _user32.SetWindowLongPtrW.argtypes = [
        wintypes.HWND,
        ctypes.c_int,
        ctypes.c_void_p,  # LONG_PTR
    ]
    _user32.SetWindowLongPtrW.restype = ctypes.c_void_p


class COPYDATASTRUCT(ctypes.Structure):
    _fields_ = [
        ("dwData", ctypes.c_ulong),
        ("cbData", ctypes.c_uint),
        ("lpData", ctypes.c_void_p),
    ]


def handle_ipc_payload(
    payload_bytes: bytes,
    on_files: Callable[[list[str]], None] | None = None,
    on_metadata: Callable[[dict[str, str]], None] | None = None,
) -> bool:
    try:
        payload_str = payload_bytes.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("IPC payload is not valid UTF-8")
        return False

    try:
        data = json.loads(payload_str)
    except json.JSONDecodeError:
        logger.warning("IPC payload is not valid JSON")
        return False

    metadata: dict[str, str] = {}

    if isinstance(data, list):
        items: list[str] = data

    elif isinstance(data, dict):
        raw_files = data.get("files", [])
        if not isinstance(raw_files, list):
            logger.warning("IPC payload 'files' is not a JSON array")
            return False
        items = raw_files

        for key in ("profile_id", "action"):
            val = data.get(key)
            if val is not None:
                if not isinstance(val, str) or not val.strip():
                    logger.warning("IPC payload '%s' must be a non-empty string", key)
                    return False

                if key == "profile_id":
                    import re

                    if not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", val):
                        logger.warning("IPC payload 'profile_id' is not a valid profile ID")
                        return False

                if key == "action" and val not in ("start", "review"):
                    logger.warning("IPC payload 'action' must be 'start' or 'review'")
                    return False
                metadata[key] = val
    else:
        logger.warning("IPC payload is not a JSON array or object")
        return False

    valid_paths: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        p = Path(item)
        if p.is_file():
            valid_paths.append(str(p.resolve()))
        else:
            logger.debug("IPC payload path not found or not a file: %s", item)

    if not valid_paths:
        logger.debug("IPC payload contained no valid file paths")
        return False

    if on_files is not None:
        on_files(valid_paths)

    if on_metadata is not None and metadata:
        on_metadata(metadata)

    logger.info(
        "IPC received %d valid file paths%s",
        len(valid_paths),
        f" with metadata {metadata!r}" if metadata else "",
    )
    return True


class SingleInstance:
    def __init__(self) -> None:
        self._handle: int | None = None
        self._hwnd: int | None = None
        self._map_handle: int | None = None
        self._original_wndproc: int | None = None
        self._wndproc_callback: object | None = None
        self._ipc_callback: Callable[[list[str]], None] | None = None
        self._ipc_metadata_callback: Callable[[dict[str, str]], None] | None = None

    def acquire(self) -> bool:

        if os.name != "nt":
            return True

        kernel32 = ctypes.windll.kernel32
        CreateMutexW = kernel32.CreateMutexW  # noqa: N806
        CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        CreateMutexW.restype = wintypes.HANDLE

        GetLastError = kernel32.GetLastError  # noqa: N806
        GetLastError.restype = wintypes.DWORD

        ERROR_ALREADY_EXISTS = 183  # noqa: N806

        handle = CreateMutexW(None, True, MUTEX_NAME)
        self._handle = handle

        if GetLastError() == ERROR_ALREADY_EXISTS:
            logger.info("Another instance is already running")
            if handle:
                kernel32.CloseHandle(handle)
            self._handle = None
            return False

        self._create_shared_memory()
        return True

    def _create_shared_memory(self) -> None:

        try:
            kernel32 = ctypes.windll.kernel32
            size = ctypes.sizeof(wintypes.HWND)
            self._map_handle = kernel32.CreateFileMappingW(
                wintypes.HANDLE(-1),  # INVALID_HANDLE_VALUE
                None,
                0x04,  # PAGE_READWRITE
                0,
                size,
                MAP_NAME,
            )
        except Exception:
            self._map_handle = None

    def register_window(
        self,
        hwnd: int,
        ipc_callback: Callable[[list[str]], None] | None = None,
        ipc_metadata_callback: Callable[[dict[str, str]], None] | None = None,
    ) -> None:

        self._hwnd = hwnd
        self._ipc_callback = ipc_callback
        self._ipc_metadata_callback = ipc_metadata_callback

        if self._map_handle:
            try:
                kernel32 = ctypes.windll.kernel32
                ptr = kernel32.MapViewOfFile(
                    self._map_handle,
                    0x0002,  # FILE_MAP_WRITE
                    0,
                    0,
                    ctypes.sizeof(wintypes.HWND),
                )
                if ptr:
                    ctypes.memmove(
                        ptr, ctypes.byref(wintypes.HWND(hwnd)), ctypes.sizeof(wintypes.HWND)
                    )
                    kernel32.UnmapViewOfFile(ptr)
            except Exception:
                pass

        self._subclass_window(hwnd)

    def _subclass_window(self, hwnd: int) -> None:
        if os.name != "nt" or _user32 is None:
            return

        @WNDPROC
        def new_wndproc(hWnd, msg, wParam, lParam):  # noqa: N803 (Win32 API conventions)
            if msg == WM_COPYDATA:
                try:
                    cds = ctypes.cast(lParam, ctypes.POINTER(COPYDATASTRUCT)).contents
                    if cds.cbData > 0 and cds.cbData <= MAX_PAYLOAD_SIZE and cds.lpData:
                        data_bytes = ctypes.string_at(cds.lpData, cds.cbData)

                        if _is_local_process(hWnd, wParam):
                            success = handle_ipc_payload(
                                data_bytes,
                                on_files=self._ipc_callback,
                                on_metadata=self._ipc_metadata_callback,
                            )
                            if success:
                                return 1  # ACK: processed successfully
                except Exception:
                    logger.debug("Error handling WM_COPYDATA", exc_info=True)
                return 0  # NAK: not processed

            return _user32.CallWindowProcW(self._original_wndproc, hWnd, msg, wParam, lParam)

        self._wndproc_callback = new_wndproc

        GWLP_WNDPROC = -4  # noqa: N806 (Windows API constant)
        new_proc_ptr = ctypes.cast(new_wndproc, ctypes.c_void_p).value
        prev = _user32.SetWindowLongPtrW(wintypes.HWND(hwnd), GWLP_WNDPROC, new_proc_ptr)
        self._original_wndproc = prev
        if self._original_wndproc:
            logger.info("Window subclassed for IPC (hwnd=%d)", hwnd)
        else:
            logger.warning("Failed to subclass window for IPC")

    def forward_to_primary(self, args: list[str]) -> bool:

        if os.name != "nt":
            return False

        if not args:
            return False

        sanitized = self._sanitize_forward_args(args)
        if isinstance(sanitized, bool):
            return False

        payload = json.dumps(sanitized)
        if len(payload) > MAX_PAYLOAD_SIZE:
            logger.warning("Forward payload too large: %d bytes", len(payload))
            return False

        hwnd = self._get_primary_hwnd()
        if not hwnd:
            logger.warning("Cannot find primary window for forwarding")
            return False

        user32 = ctypes.windll.user32
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)

        data_bytes = payload.encode("utf-8")
        cds = COPYDATASTRUCT()
        cds.dwData = 0
        cds.cbData = len(data_bytes)
        cds.lpData = ctypes.cast(
            ctypes.create_string_buffer(data_bytes, len(data_bytes)),
            ctypes.c_void_p,
        )

        result = user32.SendMessageW(hwnd, WM_COPYDATA, 0, ctypes.byref(cds))
        acked = result == 1
        logger.info(
            "Forwarded %d file(s) to primary window (result=%d, acked=%s)",
            len(cast(list[str], sanitized.get("files", []))),
            result,
            acked,
        )
        return acked

    def _sanitize_forward_args(self, args: list[str]) -> dict[str, object] | bool:
        result: dict[str, object] = {"files": []}
        files: list[str] = []
        profile_id: str | None = None
        action: str | None = None
        skip_next = False

        _valid_actions = frozenset({"start", "review"})

        for i, arg in enumerate(args):
            if skip_next:
                skip_next = False
                continue
            if arg == "--profile-id":
                if i + 1 < len(args):
                    candidate = args[i + 1]

                    import re

                    if re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", candidate):
                        profile_id = candidate
                        skip_next = True
            elif arg == "--sendto-action":
                if i + 1 < len(args):
                    candidate = args[i + 1]
                    if candidate in _valid_actions:
                        action = candidate
                        skip_next = True
            elif arg in ("--sendto-files", "gui", "--files", "sendto", "tuck"):
                continue
            else:
                p = Path(arg)
                if p.is_file():
                    files.append(str(p.resolve()))

        if not files:
            return False

        result["files"] = files
        if profile_id:
            result["profile_id"] = profile_id
        if action:
            result["action"] = action

        return result

    def _get_primary_hwnd(self) -> int | None:

        if not self._map_handle:
            try:
                kernel32 = ctypes.windll.kernel32
                self._map_handle = kernel32.OpenFileMappingW(
                    0x0004,  # FILE_MAP_READ
                    False,
                    MAP_NAME,
                )
            except Exception:
                pass

        if not self._map_handle:
            return None

        try:
            kernel32 = ctypes.windll.kernel32
            ptr = kernel32.MapViewOfFile(
                self._map_handle,
                0x0004,  # FILE_MAP_READ
                0,
                0,
                ctypes.sizeof(wintypes.HWND),
            )
            if ptr:
                hwnd = wintypes.HWND()
                ctypes.memmove(ctypes.byref(hwnd), ptr, ctypes.sizeof(wintypes.HWND))
                kernel32.UnmapViewOfFile(ptr)
                return hwnd.value if hwnd.value else None
        except Exception:
            pass
        return None

    def release(self) -> None:

        if self._hwnd and self._original_wndproc and os.name == "nt" and _user32 is not None:
            try:
                GWLP_WNDPROC = -4  # noqa: N806 (Windows API constant)
                _user32.SetWindowLongPtrW(
                    wintypes.HWND(self._hwnd),
                    GWLP_WNDPROC,
                    self._original_wndproc,
                )
            except Exception:
                pass
            self._original_wndproc = None
            self._wndproc_callback = None

        if self._handle and os.name == "nt":
            ctypes.windll.kernel32.CloseHandle(self._handle)
            self._handle = None
        if self._map_handle and os.name == "nt":
            ctypes.windll.kernel32.CloseHandle(self._map_handle)
            self._map_handle = None


# wParam=0 is accepted because the sender HWND is not always available
def _is_local_process(hwnd: int, wparam: int) -> bool:

    if not wparam:
        return True

    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        sender_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(wintypes.HWND(wparam), ctypes.byref(sender_pid))

        if sender_pid.value == 0:
            return False

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000  # noqa: N806 (Windows API constant)
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, sender_pid)
        if hproc:
            kernel32.CloseHandle(hproc)
            return True
        return False
    except Exception:
        return False


_single_instance: SingleInstance | None = None


def get_single_instance() -> SingleInstance:
    global _single_instance
    if _single_instance is None:
        _single_instance = SingleInstance()
    return _single_instance
