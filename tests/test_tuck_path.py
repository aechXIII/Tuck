"""Behavior of the PATH transformation used by the Windows installer."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

# The script and these assertions are Windows-installer behavior. The Ubuntu CI
# runner ships pwsh, so a `which pwsh` guard is not enough to keep it off Linux.
pytestmark = pytest.mark.skipif(
    sys.platform != "win32", reason="tuck-path.ps1 is Windows-installer only"
)

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "tuck-path.ps1"


def _run_path_action(action: str, directory: str, current: str) -> tuple[int, dict[str, str]]:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        pytest.skip("PowerShell is required to test the Windows installer PATH script")
    result = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(_SCRIPT),
            "-Action",
            action,
            "-Dir",
            directory,
            "-PathValue",
            current,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, json.loads(result.stdout)


def _powershell() -> str:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        pytest.skip("PowerShell is required to test the Windows installer PATH script")
    return powershell


def _run_registry_path_action(
    action: str, directory: str, registry_subkey: str
) -> tuple[int, dict[str, str]]:
    result = subprocess.run(
        [
            _powershell(),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(_SCRIPT),
            "-Action",
            action,
            "-Dir",
            directory,
            "-RegistrySubKey",
            registry_subkey,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, json.loads(result.stdout)


def test_add_reports_change_only_when_tuck_appends_a_new_path_entry() -> None:
    code, result = _run_path_action("add", r"C:\Tuck", r"C:\Tools")

    assert code == 0
    assert result == {"status": "added", "path": r"C:\Tools;C:\Tuck"}


def test_add_initializes_an_empty_user_path() -> None:
    code, result = _run_path_action("add", r"C:\Tuck", "")

    assert code == 0
    assert result == {"status": "added", "path": r"C:\Tuck"}


def test_add_reports_existing_equivalent_entry_without_claiming_ownership() -> None:
    current = 'C:\\Tools;"c:\\tuck\\"'
    code, result = _run_path_action("add", r"C:\Tuck", current)

    assert code == 10
    assert result == {"status": "already_present", "path": current}


def test_remove_preserves_another_equivalent_path_entry() -> None:
    code, result = _run_path_action("remove", r"C:\Tuck", "C:\\Tuck;C:\\Tools;C:\\Tuck\\")

    assert code == 0
    assert result == {"status": "removed", "path": r"C:\Tuck;C:\Tools"}


def test_remove_reports_missing_entry_without_writing_path() -> None:
    code, result = _run_path_action("remove", r"C:\Tuck", r"C:\Tools")

    assert code == 10
    assert result == {"status": "not_present", "path": r"C:\Tools"}


def test_expandable_path_entry_survives_add_and_owned_remove() -> None:
    current = r"%USERPROFILE%\bin"

    code, added = _run_path_action("add", r"C:\Tuck", current)
    assert code == 0
    assert added == {"status": "added", "path": r"%USERPROFILE%\bin;C:\Tuck"}

    code, removed = _run_path_action("remove", r"C:\Tuck", added["path"])
    assert code == 0
    assert removed == {"status": "removed", "path": current}


def test_path_edit_preserves_expand_string_registry_kind() -> None:
    subkey = f"Software\\Tuck\\PathScriptTests\\{uuid.uuid4()}"
    create = (
        "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('"
        f"{subkey}'); "
        "$key.SetValue('Path', '%USERPROFILE%\\bin', "
        "[Microsoft.Win32.RegistryValueKind]::ExpandString); $key.Dispose()"
    )
    inspect = (
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('"
        f"{subkey}'); "
        "$raw = $key.GetValue('Path', '', "
        "[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); "
        "[pscustomobject]@{kind = [string]$key.GetValueKind('Path'); path = $raw} "
        "| ConvertTo-Json -Compress; $key.Dispose()"
    )
    cleanup = f"[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('{subkey}')"
    try:
        subprocess.run([_powershell(), "-NoProfile", "-Command", create], check=True)

        code, added = _run_registry_path_action("add", r"C:\Tuck", subkey)
        assert code == 0
        assert added == {"status": "added", "path": r"%USERPROFILE%\bin;C:\Tuck"}

        result = subprocess.run(
            [_powershell(), "-NoProfile", "-Command", inspect],
            capture_output=True,
            text=True,
            check=True,
        )
        assert json.loads(result.stdout) == {
            "kind": "ExpandString",
            "path": r"%USERPROFILE%\bin;C:\Tuck",
        }

        code, removed = _run_registry_path_action("remove", r"C:\Tuck", subkey)
        assert code == 0
        assert removed == {"status": "removed", "path": r"%USERPROFILE%\bin"}

        result = subprocess.run(
            [_powershell(), "-NoProfile", "-Command", inspect],
            capture_output=True,
            text=True,
            check=True,
        )
        assert json.loads(result.stdout) == {"kind": "ExpandString", "path": r"%USERPROFILE%\bin"}
    finally:
        subprocess.run([_powershell(), "-NoProfile", "-Command", cleanup], check=False)
