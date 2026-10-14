"""Build the optional source helper required by packaged Tuck builds."""

from __future__ import annotations

import argparse
import ctypes
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tuck" / "encoding" / "native_blending.c"


def _msvc_environment() -> dict[str, str] | None:
    installer = Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)"))
    vswhere = installer / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"
    if not vswhere.is_file():
        return None
    result = subprocess.run(
        [
            str(vswhere),
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-find",
            "VC/Auxiliary/Build/vcvars64.bat",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    setups = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
    if not setups or not setups[0].is_file():
        return None
    shell = os.environ.get("COMSPEC", "cmd.exe")
    result = subprocess.run(
        f'"{shell}" /d /s /c ""{setups[0]}" >nul && set"',
        capture_output=True,
        text=True,
        check=True,
    )
    values = dict(
        line.split("=", 1)
        for line in result.stdout.splitlines()
        if "=" in line and not line.startswith("=")
    )
    # vcvars can return both the old Path and its updated PATH
    return {key.upper(): values.get(key.upper(), value) for key, value in values.items()}


def build(output: Path | None = None) -> Path:
    output = (output or ROOT / "build" / "native").resolve()
    output.mkdir(parents=True, exist_ok=True)
    windows = sys.platform == "win32"
    target = output / ("native_blending.dll" if windows else "libnative_blending.so")
    compiler = shutil.which("gcc") or shutil.which("cc")
    if compiler is None and not windows:
        compiler = shutil.which("clang")
    environment = None
    if compiler is not None:
        command = [
            compiler,
            "-shared",
            "-O3",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fno-fast-math",
            "-ffp-contract=off",
            "-fexcess-precision=standard",
        ]
        command += ["-static-libgcc"] if windows else ["-fPIC", "-fvisibility=hidden"]
        command += [str(SOURCE), "-o", str(target)]
    else:
        compiler = shutil.which("cl") if windows else None
        if compiler is None and windows:
            environment = _msvc_environment()
            if environment is not None:
                compiler = shutil.which("cl", path=environment.get("PATH"))
        if compiler is None:
            raise RuntimeError("A C compiler is required to build the native blending helper")
        command = [
            compiler,
            "/nologo",
            "/LD",
            "/O2",
            "/fp:strict",
            "/MT",
            str(SOURCE),
            f"/Fo{output / 'native_blending.obj'}",
            "/link",
            f"/OUT:{target}",
        ]
    subprocess.run(command, check=True, cwd=output, env=environment)
    library = ctypes.CDLL(str(target.resolve()))
    library.tuck_blending_abi.restype = ctypes.c_uint
    if library.tuck_blending_abi() != 1:
        raise RuntimeError("The built native blending helper has an incompatible ABI")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    print(build(arguments.output).resolve())


if __name__ == "__main__":
    main()
