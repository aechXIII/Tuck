"""PyInstaller one-folder spec for the Linux Tuck backend sidecar.

Produces one console executable, ``tuck-sidecar``. The Tauri AppImage owns the
desktop window; this payload intentionally includes no Python CLI, pywin32, or
Windows Explorer integration.
"""

from pathlib import Path

_root = Path(SPECPATH).parent.resolve()
_entry = _root / "tuck" / "sidecar_entry.py"
if not _entry.is_file():
    raise FileNotFoundError(f"Entry point not found: {_entry}")

_hiddenimports = [
    "tuck",
    "tuck.bridge",
    "tuck.bridge_contract",
    "tuck.bridge_serialization",
    "tuck.bridge_validation",
    "tuck.desktop_platform",
    "tuck.diagnostics",
    "tuck.encoding",
    "tuck.encoding.capabilities",
    "tuck.encoding.command",
    "tuck.encoding.filters",
    "tuck.encoding.progress",
    "tuck.encoding.runner",
    "tuck.encoding.target_size",
    "tuck.engine",
    "tuck.formatting",
    "tuck.media_server",
    "tuck.media_tools",
    "tuck.models",
    "tuck.models.encoding_policy",
    "tuck.models.progress",
    "tuck.models.transforms",
    "tuck.output_paths",
    "tuck.packaged",
    "tuck.planner",
    "tuck.planner_options",
    "tuck.probe",
    "tuck.probe_cache",
    "tuck.profile_service",
    "tuck.queue",
    "tuck.settings",
    "tuck.sidecar",
    "tuck.sidecar.__main__",
    "tuck.sidecar.handlers",
    "tuck.sidecar.lifecycle",
    "tuck.sidecar.protocol",
    "tuck.sidecar.server",
    "tuck.sidecar_entry",
    "platformdirs",
    "rich",
]

_excludes = [
    "clr",
    "pythoncom",
    "pythonnet",
    "pywin32",
    "pywintypes",
    "tkinter",
    "tuck.app",
    "tuck.cli",
    "tuck.cli_entry",
    "tuck.sendto",
    "unittest",
    "webview",
    "win32com",
    "win32ctypes",
    "pytest",
    "packaging",
    "setuptools",
    "pip",
    "PyQt5",
    "PyQt6",
]

a = Analysis(
    [str(_entry)],
    pathex=[str(_root)],
    binaries=[],
    datas=[],
    hiddenimports=_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=_excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="tuck-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="sidecar",
)
