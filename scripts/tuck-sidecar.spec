"""PyInstaller one-folder spec for the Tuck backend sidecar and Windows CLI.

Produces two console executables that share one ``_internal`` payload:

* ``tuck-sidecar.exe`` - NDJSON backend supervised by the Tauri shell.
* ``TuckCli.exe``      - public Windows CLI and Explorer "Send To" handler.

Each executable has its own single-entry ``Analysis``; ``MERGE`` deduplicates
their shared dependencies into one ``_internal`` folder. No GUI shell is bundled
(Tauri owns the migrated window), so ``webview`` / ``pythonnet`` / ``clr`` are
excluded. Runtime dependencies come from the hash-pinned
``packaging/sidecar-constraints.txt``; ffmpeg/ffprobe are staged separately by
``scripts/build_sidecar.py``.
"""

from pathlib import Path

_root = Path(SPECPATH).parent.resolve()

for _entry in ("tuck/sidecar_entry.py", "tuck/cli_entry.py"):
    if not (_root / _entry).is_file():
        raise FileNotFoundError(
            f"Entry point not found: {_root / _entry}\n"
            "Run pyinstaller from the repository root: pyinstaller scripts/tuck-sidecar.spec"
        )

_icon_path = _root / "assets" / "Tuck.ico"
_icon = str(_icon_path) if _icon_path.is_file() else None


# pywin32 runtime binaries: PyInstaller can miss them in frozen builds, and the
# CLI needs them for Explorer "Send To" shortcut management
_pywin32_binaries = []
try:
    import pythoncom
    import pywin32_system32
    import pywintypes
    import win32com

    for _dll in Path(pywin32_system32.__path__[0]).glob("*.dll"):
        _pywin32_binaries.append((str(_dll), "."))
    for _dll in Path(pythoncom.__file__).parent.glob("pythoncom*.dll"):
        _pywin32_binaries.append((str(_dll), "."))
    _pywintypes_file = Path(pywintypes.__file__)
    if _pywintypes_file.suffix in (".pyd", ".dll"):
        _pywin32_binaries.append((str(_pywintypes_file), "."))
    _ = win32com  # imported to validate the install
except ImportError:
    print("WARNING: pywin32 not found; Send To shortcut management will be unavailable.")

_hiddenimports = [
    "tuck",
    "tuck.app",
    "tuck.bridge",
    "tuck.bridge_contract",
    "tuck.bridge_serialization",
    "tuck.bridge_validation",
    "tuck.cli",
    "tuck.cli_entry",
    "tuck.diagnostics",
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
    "tuck.sendto",
    "tuck.settings",
    "tuck.sidecar",
    "tuck.sidecar.__main__",
    "tuck.sidecar.handlers",
    "tuck.sidecar.lifecycle",
    "tuck.sidecar.protocol",
    "tuck.sidecar.server",
    "tuck.sidecar_entry",
    "tuck.encoding",
    "tuck.encoding.capabilities",
    "tuck.encoding.command",
    "tuck.encoding.filters",
    "tuck.encoding.progress",
    "tuck.encoding.runner",
    "tuck.encoding.target_size",
    "platformdirs",
    "packaging",
    "rich",
    "win32com",
    "win32com.client",
    "pythoncom",
    "pywintypes",
    "pywin32_system32",
]

_excludes = [
    "clr",
    "pythonnet",
    "webview",
    "tkinter",
    "unittest",
    "pytest",
    "setuptools",
    "pip",
    "PyQt5",
    "PyQt6",
]


def _analysis(entry: str, datas):
    return Analysis(
        [str(_root / "tuck" / entry)],
        pathex=[str(_root)],
        binaries=list(_pywin32_binaries),
        datas=datas,
        hiddenimports=_hiddenimports,
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=_excludes,
        noarchive=False,
        optimize=0,
    )


a_sidecar = _analysis("sidecar_entry.py", [])
a_cli = _analysis(
    "cli_entry.py",
    [
        (str(_root / "LICENSE"), "."),
        (str(_root / "packaging" / "THIRD_PARTY_NOTICES.md"), "."),
    ],
)

MERGE((a_sidecar, "tuck-sidecar", "tuck-sidecar"), (a_cli, "TuckCli", "TuckCli"))

pyz_sidecar = PYZ(a_sidecar.pure)
pyz_cli = PYZ(a_cli.pure)


def _exe(pyz, analysis, name):
    return EXE(
        pyz,
        analysis.scripts,
        [],
        exclude_binaries=True,
        name=name,
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


exe_sidecar = _exe(pyz_sidecar, a_sidecar, "tuck-sidecar")
exe_cli = _exe(pyz_cli, a_cli, "TuckCli")

coll = COLLECT(
    exe_sidecar,
    a_sidecar.binaries,
    a_sidecar.zipfiles,
    a_sidecar.datas,
    exe_cli,
    a_cli.binaries,
    a_cli.zipfiles,
    a_cli.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="sidecar",
)
