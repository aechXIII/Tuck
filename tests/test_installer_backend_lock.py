"""Exercise the installer lock check without touching an installed Tuck."""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows installer behavior")
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def installer(tmp_path: Path) -> Path:
    compiler = Path(os.environ["LOCALAPPDATA"]) / "tauri/NSIS/makensis.exe"
    if not compiler.is_file():
        pytest.skip("Tauri's NSIS compiler is not installed")
    output = tmp_path / "check.exe"
    source = tmp_path / "check.nsi"
    source.write_text(
        "\n".join(
            [
                "Unicode true",
                "RequestExecutionLevel user",
                "!include LogicLib.nsh",
                f'!include "{ROOT / "src-tauri/installer-hooks.nsh"}"',
                f'OutFile "{output}"',
                f'InstallDir "{tmp_path / "install"}"',
                "Section",
                "  !insertmacro TuckCheckBackendFile",
                '  FileOpen $0 "$INSTDIR\\installed.txt" w',
                '  FileWrite $0 "installed"',
                "  FileClose $0",
                "SectionEnd",
            ]
        ),
        encoding="utf-8",
    )
    result = subprocess.run([str(compiler), "/V2", str(source)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    (tmp_path / "install").mkdir()
    return output


def test_unlocked_backend_allows_installation(installer: Path) -> None:
    target = installer.parent / "install/tuck-sidecar.exe"
    target.write_bytes(b"existing backend")
    result = subprocess.run([str(installer), "/S"], timeout=30, check=False)
    assert result.returncode == 0
    assert target.with_name("installed.txt").is_file()
    assert target.read_bytes() == b"existing backend"


def test_first_install_needs_no_existing_backend(installer: Path) -> None:
    result = subprocess.run([str(installer), "/S"], timeout=30, check=False)
    assert result.returncode == 0
    assert (installer.parent / "install/installed.txt").is_file()


def test_locked_backend_stops_before_any_installation(installer: Path) -> None:
    from ctypes import wintypes

    target = installer.parent / "install/tuck-sidecar.exe"
    target.write_bytes(b"existing backend")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateFileW(str(target), 0x80000000, 1, None, 3, 0, None)
    assert handle != wintypes.HANDLE(-1).value
    try:
        result = subprocess.run([str(installer), "/S"], timeout=30, check=False)
        assert result.returncode != 0
        assert not target.with_name("installed.txt").exists()
        assert target.read_bytes() == b"existing backend"
    finally:
        kernel.CloseHandle(handle)
    result = subprocess.run([str(installer), "/S"], timeout=30, check=False)
    assert result.returncode == 0
    assert target.with_name("installed.txt").is_file()
