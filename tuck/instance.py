from __future__ import annotations

import ctypes
import json
import logging
import os
import re
from collections.abc import Callable, Sequence
from ctypes import wintypes
from functools import lru_cache
from pathlib import Path
from typing import cast

logger = logging.getLogger(__name__)

MUTEX_NAME = "Local\\Tuck_SingleInstance_v1"
MAP_NAME = "Local\\Tuck_SharedMemory_v1"
WM_COPYDATA = 0x004A

MAX_PAYLOAD_SIZE = 4096

_PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SENDTO_ACTIONS = frozenset({"start", "review"})
_SENDTO_PASSTHROUGH_ARGS = frozenset({"--sendto-files", "gui", "--files", "sendto", "tuck"})
_SENDTO_FLAG_FIELDS: dict[str, tuple[str, Callable[[str], object]]] = {
    "--profile-id": ("profile_id", _PROFILE_ID_RE.match),
    "--sendto-action": ("action", lambda v: v in _SENDTO_ACTIONS),
}

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


def _extract_ipc_metadata(data: dict[str, object]) -> dict[str, str] | None:
    metadata: dict[str, str] = {}
    for key in ("profile_id", "action"):
        val = data.get(key)
        if val is None:
            continue
        if not isinstance(val, str) or not val.strip():
            logger.warning("IPC payload '%s' must be a non-empty string", key)
            return None
        if key == "profile_id" and not _PROFILE_ID_RE.match(val):
            logger.warning("IPC payload 'profile_id' is not a valid profile ID")
            return None
        if key == "action" and val not in _SENDTO_ACTIONS:
            logger.warning("IPC payload 'action' must be 'start' or 'review'")
            return None
        metadata[key] = val
    return metadata


def _decode_ipc_json(payload_bytes: bytes) -> object | None:
    try:
        payload_str = payload_bytes.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("IPC payload is not valid UTF-8")
        return None

    try:
        return json.loads(payload_str)
    except json.JSONDecodeError:
        logger.warning("IPC payload is not valid JSON")
        return None


def _extract_valid_paths(items: Sequence[object]) -> list[str]:
    valid_paths: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        p = Path(item)
        if p.is_file():
            valid_paths.append(str(p.resolve()))
        else:
            logger.debug("IPC payload path not found or not a file: %s", item)
    return valid_paths


def handle_ipc_payload(
    payload_bytes: bytes,
    on_files: Callable[[list[str]], None] | None = None,
    on_metadata: Callable[[dict[str, str]], None] | None = None,
) -> bool:
    data = _decode_ipc_json(payload_bytes)
    if data is None:
        return False

    if isinstance(data, list):
        items: list[str] = data
        metadata: dict[str, str] = {}

    elif isinstance(data, dict):
        raw_files = data.get("files", [])
        if not isinstance(raw_files, list):
            logger.warning("IPC payload 'files' is not a JSON array")
            return False
        items = raw_files

        extracted = _extract_ipc_metadata(data)
        if extracted is None:
            return False
        metadata = extracted
    else:
        logger.warning("IPC payload is not a JSON array or object")
        return False

    valid_paths = _extract_valid_paths(items)
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


def _next_arg_if(args: list[str], i: int, predicate: Callable[[str], object]) -> str | None:
    if i + 1 >= len(args):
        return None
    candidate = args[i + 1]
    return candidate if predicate(candidate) else None


def _bring_to_foreground(hwnd: int) -> None:
    user32 = ctypes.windll.user32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)


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
                logger.debug("Failed to publish hwnd to shared memory", exc_info=True)

        self._subclass_window(hwnd)

    def _handle_copydata(self, hwnd: int, wparam: int, lparam: int) -> int:
        try:
            cds = ctypes.cast(lparam, ctypes.POINTER(COPYDATASTRUCT)).contents
            if cds.cbData <= 0 or cds.cbData > MAX_PAYLOAD_SIZE or not cds.lpData:
                return 0
            if not _is_local_process(hwnd, wparam):
                return 0
            data_bytes = ctypes.string_at(cds.lpData, cds.cbData)
            success = handle_ipc_payload(
                data_bytes,
                on_files=self._ipc_callback,
                on_metadata=self._ipc_metadata_callback,
            )
            return 1 if success else 0  # ACK when handled, NAK otherwise
        except Exception:
            logger.debug("Error handling WM_COPYDATA", exc_info=True)
            return 0

    def _subclass_window(self, hwnd: int) -> None:
        if os.name != "nt" or _user32 is None:
            return

        @WNDPROC
        def new_wndproc(hWnd, msg, wParam, lParam):  # noqa: N803 (Win32 API conventions)
            if msg == WM_COPYDATA:
                return self._handle_copydata(hWnd, wParam, lParam)

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

        _bring_to_foreground(hwnd)

        data_bytes = payload.encode("utf-8")
        cds = COPYDATASTRUCT()
        cds.dwData = 0
        cds.cbData = len(data_bytes)
        cds.lpData = ctypes.cast(
            ctypes.create_string_buffer(data_bytes, len(data_bytes)),
            ctypes.c_void_p,
        )

        result = ctypes.windll.user32.SendMessageW(hwnd, WM_COPYDATA, 0, ctypes.byref(cds))
        acked = result == 1
        logger.info(
            "Forwarded %d file(s) to primary window (result=%d, acked=%s)",
            len(cast(list[str], sanitized.get("files", []))),
            result,
            acked,
        )
        return acked

    def _sanitize_forward_args(self, args: list[str]) -> dict[str, object] | bool:
        files: list[str] = []
        fields: dict[str, str] = {}
        skip_next = False

        for i, arg in enumerate(args):
            if skip_next:
                skip_next = False
                continue
            handler = _SENDTO_FLAG_FIELDS.get(arg)
            if handler is not None:
                field, predicate = handler
                candidate = _next_arg_if(args, i, predicate)
                if candidate is not None:
                    fields[field] = candidate
                    skip_next = True
            elif arg in _SENDTO_PASSTHROUGH_ARGS:
                continue
            else:
                p = Path(arg)
                if p.is_file():
                    files.append(str(p.resolve()))

        if not files:
            return False

        return {"files": files, **fields}

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
                logger.debug("Failed to open shared memory mapping", exc_info=True)

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
            logger.debug("Failed to read primary hwnd from shared memory", exc_info=True)
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
                logger.debug("Failed to restore original window procedure", exc_info=True)
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


@lru_cache(maxsize=1)
def get_single_instance() -> SingleInstance:
    return SingleInstance()
