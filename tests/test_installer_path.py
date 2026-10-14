"""Run the real NSIS PATH hooks against isolated per-user registry keys."""

import os
import shutil
import subprocess
import sys
import uuid
from contextlib import suppress
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows installer hooks")
ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.parametrize(
    "scenario",
    [
        "fresh",
        "legacy",
        "unowned",
        "existing-bin",
        "expanded-root",
        "expanded-bin",
        "owned-bin",
        "legacy-missing",
        "duplicates",
        "failure",
    ],
)
def test_installer_migrates_and_removes_only_owned_path_entries(tmp_path, monkeypatch, scenario):
    import winreg

    compiler = Path(os.environ["LOCALAPPDATA"]) / "tauri/NSIS/makensis.exe"
    if not compiler.is_file():
        pytest.skip("Tauri's NSIS compiler is not installed")
    registry = "Software\\TuckInstallerTests\\" + uuid.uuid4().hex
    marker = registry + "\\Markers"
    environment = registry + "\\Environment"
    app = tmp_path / "Program Files" / "Tuck"
    app.mkdir(parents=True)
    monkeypatch.setenv("TUCK_INSTALLER_TEST_ROOT", str(app))
    retained_root = "%TUCK_INSTALLER_TEST_ROOT%" if scenario.startswith("expanded-") else str(app)
    retained_bin = (
        r"%TUCK_INSTALLER_TEST_ROOT%\bin" if scenario == "expanded-bin" else str(app / "bin")
    )
    unowned_bin = scenario in ("existing-bin", "expanded-bin")
    (app / "tuck.cmd").write_text("old wrapper", encoding="ascii")
    shutil.copy2(ROOT / "scripts/tuck-path.ps1", app / "tuck-path.ps1")
    if scenario == "failure":
        (app / "tuck-path.ps1").write_text("exit 99", encoding="ascii")
    prefix = r"%USERPROFILE%\bin"
    legacy_owned = scenario in ("legacy", "legacy-missing", "duplicates", "failure")
    bin_owned = scenario == "owned-bin"
    initial = [prefix]
    if scenario not in ("fresh", "legacy-missing"):
        initial.append(retained_root)
    if unowned_bin or bin_owned:
        initial.append(retained_bin)
    if scenario == "duplicates":
        initial.append(str(app))

    def compile_hook(name, body):
        executable = tmp_path / f"{name}.exe"
        source = tmp_path / f"{name}.nsi"
        source.write_text(
            "Unicode true\nRequestExecutionLevel user\nSilentInstall silent\n"
            "!include LogicLib.nsh\n"
            f'!include "{ROOT / "src-tauri/installer-hooks.nsh"}"\n'
            f'OutFile "{executable}"\nSection\nStrCpy $INSTDIR "{app}"\n'
            f"{body}\nSectionEnd\n",
            encoding="utf-8",
        )
        result = subprocess.run([str(compiler), "/V2", str(source)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        return executable

    def read_path():
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, environment) as key:
            value, kind = winreg.QueryValueEx(key, "Path")
            assert kind == winreg.REG_EXPAND_SZ
            return value.split(";")

    def owns(name):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, marker) as key:
                return winreg.QueryValueEx(key, name)[0] == 1
        except FileNotFoundError:
            return False

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, environment) as key:
            winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, ";".join(initial))
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, marker) as key:
            if legacy_owned:
                winreg.SetValueEx(key, "AddedToPath", 0, winreg.REG_DWORD, 1)
            if bin_owned:
                winreg.SetValueEx(key, "AddedBinToPath", 0, winreg.REG_DWORD, 1)
        install = compile_hook(
            "install", f'!insertmacro TuckAddCommandPath "{marker}" "{environment}"'
        )
        for _ in range(2):
            subprocess.run([str(install), "/S"], check=True, timeout=30)
            if scenario == "failure":
                assert read_path() == initial
                assert owns("AddedToPath")
                assert not owns("AddedBinToPath")
                assert (app / "tuck.cmd").is_file()
                continue
            expected = [prefix, retained_bin]
            if scenario in (
                "unowned",
                "existing-bin",
                "owned-bin",
                "duplicates",
                "expanded-root",
                "expanded-bin",
            ):
                expected.append(retained_root)
            assert read_path() == expected
            assert not owns("AddedToPath")
            assert owns("AddedBinToPath") == (not unowned_bin)
            assert not (app / "tuck.cmd").exists()
        if scenario == "failure":
            return
        uninstall = compile_hook(
            "uninstall",
            (
                f'!insertmacro TuckRemoveOwnedPath "{marker}" "AddedBinToPath" '
                f'"$INSTDIR\\bin" "{environment}"\n'
                f'!insertmacro TuckRemoveOwnedPath "{marker}" "AddedToPath" '
                f'"$INSTDIR" "{environment}"'
            ),
        )
        for _ in range(2):
            subprocess.run([str(uninstall), "/S"], check=True, timeout=30)
            expected = [prefix]
            if unowned_bin:
                expected.append(retained_bin)
            if scenario in (
                "unowned",
                "existing-bin",
                "owned-bin",
                "duplicates",
                "expanded-root",
                "expanded-bin",
            ):
                expected.append(retained_root)
            assert read_path() == expected
            assert not owns("AddedBinToPath")
            assert not owns("AddedToPath")
    finally:
        for key in (marker, environment, registry):
            with suppress(FileNotFoundError):
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
