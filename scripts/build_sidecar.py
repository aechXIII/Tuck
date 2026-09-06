"""Deterministic builder for the Tuck sidecar, CLI, and bundled media tools.

Run from the repository root on the native target platform:

    python scripts/build_sidecar.py

Steps, in order, each failing the build on any mismatch:

1. Verify ``packaging/ffmpeg-sources.lock.json`` and download **only** the
   archive it names. Every SHA-256 (archive + extracted members) is checked.
2. Stage ``ffmpeg.exe`` / ``ffprobe.exe`` and their notices.
3. Create an isolated build environment from the hash-pinned
   ``packaging/sidecar-constraints.txt`` plus ``packaging/build-requirements.txt``.
4. Run PyInstaller with ``scripts/tuck-sidecar.spec`` -> ``dist/sidecar/``.
5. Assemble ``packaging/staging/app/`` (sidecar + CLI + ffmpeg + notices +
   ``tuck.cmd`` + ``LICENSE``) - the exact tree Tauri bundles as resources.
6. Write ``packaging/staging/manifest.json`` for ``scripts/verify_package.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "packaging" / "ffmpeg-sources.lock.json"
CONSTRAINTS = ROOT / "packaging" / "sidecar-constraints.txt"
BUILD_REQUIREMENTS = ROOT / "packaging" / "build-requirements.txt"
SPEC = ROOT / "scripts" / "tuck-sidecar.spec"
TUCK_CMD = ROOT / "scripts" / "tuck.cmd"
TUCK_PATH_PS1 = ROOT / "scripts" / "tuck-path.ps1"
LICENSE = ROOT / "LICENSE"
WEBVIEW2_LOCK = ROOT / "packaging" / "webview2-bootstrapper.lock.json"
WEBVIEW2_BOOTSTRAPPER = ROOT / "scripts" / "MicrosoftEdgeWebView2Setup.exe"

CACHE_DIR = ROOT / "build" / "toolcache"
BUILD_VENV = ROOT / "build" / "sidecar-venv"
STAGING = ROOT / "packaging" / "staging"
STAGING_APP = STAGING / "app"
STAGING_FFMPEG = STAGING / "ffmpeg"


class BuildError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildError(message)


def load_lock() -> dict:
    _require(LOCK_PATH.is_file(), f"Missing FFmpeg lock file: {LOCK_PATH}")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    _require(lock.get("lockfile_version") == 1, "Unsupported ffmpeg lock file version")
    flags = lock["license"]["configure_flags"]
    _require("--enable-gpl" in flags, "FFmpeg lock is not a GPL build")
    _require(
        "--enable-nonfree" not in flags, "FFmpeg lock is --enable-nonfree; not redistributable"
    )
    return lock


def ensure_archive(lock: dict) -> Path:
    archive = lock["archive"]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / archive["filename"]
    if target.is_file() and _sha256(target) == archive["sha256"]:
        print(f"  cached  {target.name}")
        return target
    if target.exists():
        target.unlink()
    print(f"  fetch   {archive['url']}")
    with urlopen(archive["url"]) as response, target.open("wb") as out:
        shutil.copyfileobj(response, out)
    actual = _sha256(target)
    _require(
        actual == archive["sha256"],
        f"Archive SHA-256 mismatch for {target.name}\n"
        f"  expected {archive['sha256']}\n  got      {actual}",
    )
    actual_size = target.stat().st_size
    _require(
        actual_size == archive["size_bytes"],
        f"Archive size mismatch: expected {archive['size_bytes']}, got {actual_size}",
    )
    print(f"  ok      {target.name} ({actual_size} bytes)")
    return target


def stage_ffmpeg(lock: dict, archive_path: Path) -> list[dict]:
    if STAGING_FFMPEG.exists():
        shutil.rmtree(STAGING_FFMPEG)
    STAGING_FFMPEG.mkdir(parents=True)
    staged: list[dict] = []
    with zipfile.ZipFile(archive_path) as zf:
        names = set(zf.namelist())
        for member in lock["members"]:
            arc = member["archive_path"]
            _require(arc in names, f"Lock member not present in archive: {arc}")
            data = zf.read(arc)
            actual = hashlib.sha256(data).hexdigest()
            _require(
                actual == member["sha256"],
                f"Member SHA-256 mismatch for {arc}\n"
                f"  expected {member['sha256']}\n  got      {actual}",
            )
            _require(
                len(data) == member["size_bytes"],
                f"Member size mismatch for {arc}: expected {member['size_bytes']}, got {len(data)}",
            )
            out = STAGING_FFMPEG / member["install_as"]
            out.write_bytes(data)
            staged.append(
                {
                    "file": f"ffmpeg/{member['install_as']}",
                    "sha256": actual,
                    "size_bytes": len(data),
                }
            )
            print(f"  stage   ffmpeg/{member['install_as']}")
    installed = {item["file"].split("/")[-1] for item in staged}
    _require({"ffmpeg.exe", "ffprobe.exe"} <= installed, "ffmpeg.exe / ffprobe.exe not staged")
    return staged


def _venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def create_build_env(base_python: str) -> Path:
    resolved = Path(base_python)
    if resolved.exists():
        base_python = str(resolved.resolve())
    elif base_python not in {sys.executable, "python", "python3"} and "/" in base_python:
        raise BuildError(f"--python interpreter not found: {base_python}")
    _require(CONSTRAINTS.is_file(), f"Missing {CONSTRAINTS}")
    _require(BUILD_REQUIREMENTS.is_file(), f"Missing {BUILD_REQUIREMENTS}")
    if BUILD_VENV.exists():
        shutil.rmtree(BUILD_VENV)
    print(f"  venv    {BUILD_VENV}")
    subprocess.run([base_python, "-m", "venv", str(BUILD_VENV)], check=True)
    py = _venv_python(BUILD_VENV)
    subprocess.run([str(py), "-m", "pip", "install", "--upgrade", "--quiet", "pip"], check=True)
    subprocess.run(
        [str(py), "-m", "pip", "install", "--quiet", "--require-hashes", "-r", str(CONSTRAINTS)],
        check=True,
    )
    subprocess.run(
        [str(py), "-m", "pip", "install", "--quiet", "-r", str(BUILD_REQUIREMENTS)], check=True
    )
    subprocess.run(
        [
            str(py),
            "-m",
            "pip",
            "install",
            "--quiet",
            "--no-deps",
            "--no-build-isolation",
            str(ROOT),
        ],
        check=True,
    )
    return py


def run_pyinstaller(py: Path) -> Path:
    dist = ROOT / "dist" / "sidecar"
    work = ROOT / "build" / "sidecar-pyinstaller"
    for path in (dist, work):
        if path.exists():
            shutil.rmtree(path)
    print("  pyinstaller ...")
    subprocess.run(
        [
            str(py),
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(ROOT / "dist"),
            "--workpath",
            str(work),
            str(SPEC),
        ],
        check=True,
        cwd=ROOT,
    )
    _require((dist / "tuck-sidecar.exe").is_file(), "PyInstaller did not produce tuck-sidecar.exe")
    _require((dist / "TuckCli.exe").is_file(), "PyInstaller did not produce TuckCli.exe")
    return dist


def assemble_app(dist: Path, staged_ffmpeg: list[dict]) -> dict:
    if STAGING_APP.exists():
        shutil.rmtree(STAGING_APP)
    STAGING_APP.mkdir(parents=True)
    for item in sorted(dist.iterdir()):
        dest = STAGING_APP / item.name
        if item.is_dir():
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)
    # media tools were staged and hash-checked earlier by stage_ffmpeg()
    _require(STAGING_FFMPEG.is_dir(), "ffmpeg staging directory missing; run stage_ffmpeg first")
    shutil.copytree(STAGING_FFMPEG, STAGING_APP / "ffmpeg")
    for entry in staged_ffmpeg:
        name = entry["file"].split("/")[-1]
        if not (STAGING_APP / "ffmpeg" / name).is_file():
            raise BuildError(f"ffmpeg staging lost: {name}")
    for required in (TUCK_CMD, TUCK_PATH_PS1):
        _require(required.is_file(), f"Missing {required}")
    shutil.copy2(TUCK_CMD, STAGING_APP / "tuck.cmd")
    shutil.copy2(TUCK_PATH_PS1, STAGING_APP / "tuck-path.ps1")
    shutil.copy2(LICENSE, STAGING_APP / "LICENSE")
    webview2 = json.loads(WEBVIEW2_LOCK.read_text(encoding="utf-8"))
    _require(WEBVIEW2_BOOTSTRAPPER.is_file(), f"Missing {WEBVIEW2_BOOTSTRAPPER}")
    _require(
        WEBVIEW2_BOOTSTRAPPER.stat().st_size == webview2["size_bytes"],
        "WebView2 bootstrapper size does not match its lock file",
    )
    _require(
        _sha256(WEBVIEW2_BOOTSTRAPPER) == webview2["sha256"],
        "WebView2 bootstrapper SHA-256 does not match its lock file",
    )
    shutil.copy2(WEBVIEW2_BOOTSTRAPPER, STAGING_APP / webview2["filename"])
    shutil.copy2(
        ROOT / "packaging" / "THIRD_PARTY_NOTICES.md", STAGING_APP / "THIRD_PARTY_NOTICES.md"
    )

    manifest = {
        "sidecar_executable": "tuck-sidecar.exe",
        "cli_executable": "TuckCli.exe",
        "ffmpeg": staged_ffmpeg,
        "expected_present": [
            "tuck-sidecar.exe",
            "TuckCli.exe",
            "_internal",
            "ffmpeg/ffmpeg.exe",
            "ffmpeg/ffprobe.exe",
            "ffmpeg/FFmpeg-LICENSE.txt",
            "tuck.cmd",
            "tuck-path.ps1",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
            webview2["filename"],
        ],
        "denied_substrings": [
            "webview/",
            "pythonnet",
            "pywebview",
            "clr.pyd",
            ".pyc",
            "__pycache__",
            "pytest",
            "site-packages",
            ".venv",
            "frontend/src",
            ".map",
        ],
    }
    (STAGING / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Base interpreter used to create the isolated build venv.",
    )
    parser.add_argument(
        "--skip-pyinstaller",
        action="store_true",
        help="Only fetch/verify/stage the media tools (no frozen build).",
    )
    parser.add_argument(
        "--assemble-only",
        action="store_true",
        help="Reuse an existing dist/sidecar build; only stage tools and assemble.",
    )
    parser.add_argument(
        "--reuse-env",
        action="store_true",
        help="Reuse an existing build/sidecar-venv instead of recreating it.",
    )
    args = parser.parse_args()

    try:
        print("[1/5] verify ffmpeg lock")
        lock = load_lock()
        print("[2/5] fetch + stage media tools")
        archive = ensure_archive(lock)
        staged = stage_ffmpeg(lock, archive)
        if args.skip_pyinstaller:
            print("done (media tools only)")
            return 0
        dist = ROOT / "dist" / "sidecar"
        if args.assemble_only:
            _require(
                (dist / "tuck-sidecar.exe").is_file(),
                "no existing dist/sidecar build to reuse",
            )
            print("[3/5] reuse dist/sidecar")
            print("[4/5] skipped")
        elif args.reuse_env and (_venv_python(BUILD_VENV)).is_file():
            print("[3/5] reuse build/sidecar-venv")
            py = _venv_python(BUILD_VENV)
            subprocess.run(
                [
                    str(py),
                    "-m",
                    "pip",
                    "install",
                    "--quiet",
                    "--no-deps",
                    "--force-reinstall",
                    "--no-build-isolation",
                    str(ROOT),
                ],
                check=True,
            )
            print("[4/5] PyInstaller")
            dist = run_pyinstaller(py)
        else:
            print("[3/5] isolated build environment")
            py = create_build_env(args.python)
            print("[4/5] PyInstaller")
            dist = run_pyinstaller(py)
        print("[5/5] assemble staging tree")
        assemble_app(dist, staged)
        print(f"\nOK  staging tree at {STAGING_APP}")
        return 0
    except (BuildError, subprocess.CalledProcessError) as exc:
        print(f"\nBUILD FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
