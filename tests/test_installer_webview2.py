"""Run the WebView2 setup flow against isolated test registry keys."""

import os
import subprocess
import sys
import uuid
from contextlib import suppress
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows installer behavior")
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "machine,user,after,exit_code,expected_run,expected_success",
    [
        ("130.0.1.0", "", "", 23, False, True),
        ("", "130.0.1.0", "", 23, False, True),
        ("0.0.0.0", "130.0.1.0", "", 23, False, True),
        ("", "", "130.0.1.0", 0, True, True),
        ("0.0.0.0", "", "130.0.1.0", 3010, True, True),
        ("", "", "130.0.1.0", 23, True, True),
        ("", "", "", 0, True, False),
        ("", "", "", 23, True, False),
    ],
)
def test_runtime_detection_and_installation(
    tmp_path: Path,
    machine: str,
    user: str,
    after: str,
    exit_code: int,
    expected_run: bool,
    expected_success: bool,
) -> None:
    import winreg

    compiler = Path(os.environ["LOCALAPPDATA"]) / "tauri/NSIS/makensis.exe"
    if not compiler.is_file():
        pytest.skip("Tauri's NSIS compiler is not installed")
    registry = "Software\\TuckInstallerTests\\" + uuid.uuid4().hex

    def compile_installer(name: str, section: str) -> Path:
        output = tmp_path / f"{name}.exe"
        source = tmp_path / f"{name}.nsi"
        source.write_text(
            "Unicode true\nRequestExecutionLevel user\n"
            "SilentInstall silent\n!include LogicLib.nsh\n"
            f'!include "{ROOT / "src-tauri/installer-hooks.nsh"}"\n'
            f'OutFile "{output}"\nSection\n{section}\nSectionEnd\n',
            encoding="utf-8",
        )
        result = subprocess.run([str(compiler), "/V2", str(source)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        return output

    bootstrapper = compile_installer(
        "bootstrapper",
        (
            f'FileOpen $0 "{tmp_path / "ran.txt"}" w\nFileClose $0\n'
            f'SetRegView 32\nWriteRegStr HKCU "{registry}\\user" "pv" "{after}"\n'
            f"SetErrorLevel {exit_code}"
        ),
    )
    setup = compile_installer(
        "setup",
        (
            f"SetRegView 32\n"
            f'WriteRegStr HKCU "{registry}\\machine" "pv" "{machine}"\n'
            f'WriteRegStr HKCU "{registry}\\user" "pv" "{user}"\n'
            f"SetRegView 64\n"
            f'!insertmacro TuckEnsureWebView2 HKCU "{registry}\\machine" '
            f'HKCU "{registry}\\user" "{bootstrapper}"\n'
            f'FileOpen $0 "{tmp_path / "completed.txt"}" w\nFileClose $0'
        ),
    )
    try:
        result = subprocess.run([str(setup), "/S"], timeout=30, check=False)
        assert (tmp_path / "ran.txt").exists() == expected_run
        assert (tmp_path / "completed.txt").exists() == expected_success
        assert (result.returncode == 0) == expected_success
    finally:
        for key in (registry + "\\machine", registry + "\\user", registry):
            with suppress(FileNotFoundError):
                winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, key, winreg.KEY_WOW64_32KEY)
