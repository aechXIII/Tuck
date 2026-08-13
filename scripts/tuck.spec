"""PyInstaller one-folder spec for Tuck."""

import os
import sys
from pathlib import Path

# PyInstaller sets SPECPATH to this file's directory
# Its parent is the repository root
_root = Path(SPECPATH).parent.resolve()

# The main module must be present
_main_entry = _root / "tuck" / "__main__.py"
if not _main_entry.is_file():
    raise FileNotFoundError(
        f"Entry point not found: {_main_entry}\n"
        f"Ensure you are running pyinstaller from the repository root: pyinstaller scripts/tuck.spec"
    )

_icon_path = _root / "assets" / "Tuck.ico"
_icon = str(_icon_path) if _icon_path.is_file() else None


# Collect pywin32 runtime binaries
# PyInstaller can miss them in frozen builds
_pywin32_binaries = []
_pywin32_datas = []
try:
    import pywin32_system32
    import pythoncom
    import pywintypes
    import win32com

    _pywin32_system32_dir = Path(pywin32_system32.__path__[0])
    _pythoncom_dir = Path(
        pythoncom.__path__[0]
        if hasattr(pythoncom, "__path__")
        else os.path.dirname(pythoncom.__file__)
    )
    _win32com_dir = Path(win32com.__path__[0])
    _pywintypes_file = Path(pywintypes.__file__)

    # Collect DLLs from pywin32_system32
    for _dll in _pywin32_system32_dir.glob("*.dll"):
        _pywin32_binaries.append((str(_dll), "."))

    # Collect pythoncom loader
    for _dll in _pythoncom_dir.glob("*.dll"):
        _pywin32_binaries.append((str(_dll), "."))

    # pywintypes .pyd
    if _pywintypes_file.suffix in (".pyd", ".dll"):
        _pywin32_binaries.append((str(_pywintypes_file), "."))

    # win32com package data
    _pywin32_datas = []
except ImportError:
    # pywin32 is unavailable; Send To shortcuts will not work in this build
    print(
        "WARNING: pywin32 not found in build environment. "
        "Shortcut creation in frozen builds will not be available."
    )
    _pywin32_binaries = []
    _pywin32_datas = []


a = Analysis(
    [str(_root / "tuck" / "__main__.py")],
    pathex=[str(_root)],
    binaries=_pywin32_binaries,
    datas=[
        (str(_root / "assets" / "Tuck.ico"), "assets"),
        (str(_root / "LICENSE"), "."),
        (str(_root / "tuck" / "web"), "tuck/web"),
    ]
    + _pywin32_datas,
    hiddenimports=[
        "tuck",
        "tuck.app",
        "tuck.bridge",
        "tuck.cli",
        "tuck.engine",
        "tuck.instance",
        "tuck.models",
        "tuck.planner",
        "tuck.probe",
        "tuck.probe_cache",
        "tuck.queue",
        "tuck.sendto",
        "tuck.settings",
        "tuck.updater",
        "tuck.media_server",
        "tuck.web_ui",
        "tuck.bridge_validation",
        "tuck.bridge_serialization",
        "tuck.diagnostics",
        "tuck.formatting",
        "tuck.encoding",
        "tuck.encoding.capabilities",
        "tuck.encoding.command",
        "tuck.encoding.filters",
        "tuck.encoding.progress",
        "tuck.encoding.runner",
        "tuck.encoding.target_size",
        "tuck.models.progress",
        "tuck.models.transforms",
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "platformdirs",
        "packaging",
        "win32com",
        "win32com.client",
        "pythoncom",
        "pywintypes",
        "pywin32_system32",
        "json",
        "logging",
        "clr",
        "pythonnet",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "unittest",
        "pytest",
        "setuptools",
        "pip",
        "PyQt5",
        "PyQt6",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Tuck",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_icon,
)

exe_cli = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TuckCli",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_icon,
)

coll = COLLECT(
    exe,
    exe_cli,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Tuck",
)
