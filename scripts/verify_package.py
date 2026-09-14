"""Inspect and exercise a built Tuck package.

Two modes:

    python scripts/verify_package.py --staging
        Inspect the Windows staging tree (the exact tree Tauri bundles), then
        start the frozen sidecar and CLI from it.

    python scripts/verify_package.py --platform linux --staging
        Inspect packaging/staging/linux/app/ and start its frozen sidecar.

    python scripts/verify_package.py --platform windows --artifact <setup.exe>
        Extract the real NSIS installer, inspect its payload, and start the
        frozen sidecar + CLI from the extracted files.

    python scripts/verify_package.py --platform linux --artifact <AppImage>
        Extract the real AppImage, inspect its bundled resource tree, and start
        the frozen sidecar from it.

Artifact existence or config text is never accepted as proof: this script reads
the actual files and runs the actual executables. Exit code is non-zero on any
failure.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_windows_spec = importlib.util.spec_from_file_location(
    "windows_ffmpeg", ROOT / "scripts/windows_ffmpeg.py"
)
assert _windows_spec is not None and _windows_spec.loader is not None
windows_ffmpeg = importlib.util.module_from_spec(_windows_spec)
_windows_spec.loader.exec_module(windows_ffmpeg)
STAGING_APP = ROOT / "packaging" / "staging" / "app"
MANIFEST = ROOT / "packaging" / "staging" / "manifest.json"
LOCK = ROOT / "packaging" / "ffmpeg-sources.lock.json"
WEBVIEW2_LOCK = ROOT / "packaging" / "webview2-bootstrapper.lock.json"
EXPECTED_VERSION = "0.5.0"


class VerifyError(RuntimeError):
    pass


_SIDECAR_STARTUP_TIMEOUT_SECONDS = 15


def _platform_paths(platform_name: str) -> tuple[Path, Path, Path]:
    if platform_name == "linux":
        staging = ROOT / "packaging" / "staging" / "linux"
        return (
            staging / "app",
            staging / "manifest.json",
            ROOT / "packaging" / "ffmpeg-linux-sources.lock.json",
        )
    return STAGING_APP, MANIFEST, LOCK


def _load_manifest(manifest_path: Path) -> dict:
    if not manifest_path.is_file():
        raise VerifyError(f"Missing {manifest_path}. Run the platform sidecar builder first.")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _find_app_root(tree: Path, sidecar_name: str = "tuck-sidecar.exe") -> Path:
    if (tree / sidecar_name).is_file():
        return tree
    for candidate in tree.rglob(sidecar_name):
        return candidate.parent
    raise VerifyError(f"{sidecar_name} not found anywhere under {tree}")


def _require_provenance(condition: bool, message: str) -> None:
    if not condition:
        raise VerifyError(message)


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _validate_linux_lock(lock: dict) -> None:
    _require_provenance(
        lock.get("lockfile_version") == 2, "Linux FFmpeg lock version is unsupported"
    )
    _require_provenance(
        lock.get("platform") == "linux" and lock.get("architecture") == "x86_64",
        "Linux FFmpeg lock targets the wrong platform",
    )
    build_platform = lock.get("build_platform")
    _require_provenance(
        isinstance(build_platform, dict)
        and build_platform.get("distribution") == "Ubuntu"
        and build_platform.get("version") == "22.04"
        and build_platform.get("native_only") is True
        and build_platform.get("libc_linkage") == "dynamic",
        "Linux FFmpeg lock does not require a native Ubuntu 22.04 dynamic-libc build",
    )
    recipe = lock.get("recipe")
    _require_provenance(
        isinstance(recipe, dict)
        and recipe.get("path") == "packaging/build-ffmpeg-linux.sh"
        and _valid_sha256(recipe.get("sha256"))
        and isinstance(recipe.get("size_bytes"), int)
        and recipe["size_bytes"] > 0,
        "Linux FFmpeg lock recipe provenance is incomplete",
    )
    sources = lock.get("sources")
    _require_provenance(
        isinstance(sources, list) and len(sources) == 3, "Linux FFmpeg lock sources are incomplete"
    )
    names: set[str] = set()
    filenames: set[str] = set()
    for source in sources:
        _require_provenance(isinstance(source, dict), "Linux FFmpeg source record is invalid")
        name = source.get("name")
        filename = source.get("filename")
        license_info = source.get("license")
        _require_provenance(
            isinstance(name, str)
            and name not in names
            and isinstance(source.get("version"), str)
            and bool(source["version"])
            and isinstance(filename, str)
            and filename == Path(filename).name
            and filename not in filenames
            and isinstance(source.get("url"), str)
            and source["url"].startswith("https://")
            and isinstance(source.get("size_bytes"), int)
            and source["size_bytes"] > 0
            and _valid_sha256(source.get("sha256"))
            and isinstance(source.get("archive_root"), str)
            and source["archive_root"] == Path(source["archive_root"]).name
            and bool(source["archive_root"])
            and isinstance(license_info, dict)
            and license_info.get("spdx") == "GPL-2.0-or-later"
            and isinstance(license_info.get("text_path"), str)
            and bool(license_info["text_path"]),
            "Linux FFmpeg source provenance is incomplete",
        )
        if name == "x265":
            revision = source.get("revision")
            _require_provenance(
                isinstance(revision, str)
                and re.fullmatch(r"[0-9a-f]{40}", revision) is not None
                and revision in source["url"],
                "x265 source must use an immutable revision URL",
            )
        names.add(name)
        filenames.add(filename)
    _require_provenance(names == {"ffmpeg", "x264", "x265"}, "Linux FFmpeg sources are incomplete")
    output = lock.get("output")
    license_info = output.get("license") if isinstance(output, dict) else None
    _require_provenance(
        isinstance(output, dict)
        and isinstance(license_info, dict)
        and license_info.get("spdx") == "GPL-2.0-or-later"
        and isinstance(license_info.get("configure_flags_required"), list)
        and isinstance(license_info.get("configure_flags_forbidden"), list)
        and output.get("executables") == ["ffmpeg", "ffprobe"]
        and isinstance(output.get("required_encoders"), list)
        and bool(output["required_encoders"])
        and isinstance(output.get("required_filters"), list)
        and bool(output["required_filters"])
        and output.get("runtime_dependency") == "libc.so.6",
        "Linux FFmpeg output provenance is incomplete",
    )
    _require_provenance(
        output.get("forbidden_runtime_dependencies") == ["libx264", "libx265"],
        "Linux FFmpeg output must require static x264 and x265 linkage",
    )


def _validate_linux_source_archive(app_root: Path, manifest: dict, lock: dict) -> None:
    provenance = manifest.get("ffmpeg_provenance")
    _require_provenance(isinstance(provenance, dict), "Linux package has no FFmpeg provenance")
    _require_provenance(
        provenance.get("lock_file") == "packaging/ffmpeg-linux-sources.lock.json"
        and provenance.get("lock_sha256") == _sha256(ROOT / str(provenance["lock_file"])),
        "Linux package FFmpeg lock provenance does not match the checked-in lock",
    )
    recipe = provenance.get("recipe")
    _require_provenance(
        recipe == lock["recipe"], "Linux package FFmpeg recipe provenance does not match the lock"
    )
    source_archive = provenance.get("source_archive")
    _require_provenance(
        isinstance(source_archive, dict), "Linux package has no FFmpeg source archive provenance"
    )
    source_file = source_archive.get("file")
    _require_provenance(
        isinstance(source_file, str)
        and source_file == "ffmpeg/source/ffmpeg-source.tar.xz"
        and _valid_sha256(source_archive.get("sha256"))
        and isinstance(source_archive.get("size_bytes"), int),
        "Linux package source archive provenance is incomplete",
    )
    archive_path = app_root / source_file
    _require_provenance(
        archive_path.is_file(), f"source archive missing from package: {source_file}"
    )
    _require_provenance(
        _sha256(archive_path) == source_archive["sha256"]
        and archive_path.stat().st_size == source_archive["size_bytes"],
        "packaged FFmpeg source archive does not match its manifest hash",
    )
    expected_members = {
        "ffmpeg-source/manifest.json",
        "ffmpeg-source/build-ffmpeg-linux.sh",
        *[f"ffmpeg-source/sources/{source['filename']}" for source in lock["sources"]],
    }
    with tarfile.open(archive_path, "r:xz") as archive:
        members = {member.name: member for member in archive.getmembers() if member.isfile()}
        _require_provenance(
            set(members) == expected_members, "FFmpeg source archive members are incomplete"
        )
        source_manifest = archive.extractfile(members["ffmpeg-source/manifest.json"])
        _require_provenance(source_manifest is not None, "FFmpeg source manifest could not be read")
        bundled_manifest = json.loads(source_manifest.read().decode("utf-8"))
        _require_provenance(
            bundled_manifest
            == {
                "lock_sha256": _sha256(ROOT / "packaging" / "ffmpeg-linux-sources.lock.json"),
                "recipe": lock["recipe"],
                "sources": lock["sources"],
            },
            "FFmpeg source archive manifest does not match the source lock",
        )
        for source in lock["sources"]:
            member = members[f"ffmpeg-source/sources/{source['filename']}"]
            extracted = archive.extractfile(member)
            _require_provenance(
                extracted is not None, f"FFmpeg source could not be read: {source['filename']}"
            )
            contents = extracted.read()
            _require_provenance(
                len(contents) == source["size_bytes"]
                and hashlib.sha256(contents).hexdigest() == source["sha256"],
                f"FFmpeg source archive hash mismatch: {source['filename']}",
            )
        recipe_contents = archive.extractfile(members["ffmpeg-source/build-ffmpeg-linux.sh"])
        _require_provenance(recipe_contents is not None, "FFmpeg source recipe could not be read")
        recipe_bytes = recipe_contents.read()
        _require_provenance(
            len(recipe_bytes) == lock["recipe"]["size_bytes"]
            and hashlib.sha256(recipe_bytes).hexdigest() == lock["recipe"]["sha256"],
            "FFmpeg source recipe does not match the lock",
        )


def _validate_linux_ffmpeg_runtime(app_root: Path, lock: dict) -> None:
    ffmpeg = app_root / "ffmpeg" / "ffmpeg"
    buildconf = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-buildconf"], capture_output=True, text=True, check=True
    )
    output = buildconf.stdout + buildconf.stderr
    configure_flags = {line.strip() for line in output.splitlines()}
    for flag in lock["output"]["license"]["configure_flags_required"]:
        _require_provenance(
            flag in configure_flags, f"packaged FFmpeg build configuration is missing {flag}"
        )
    for flag in lock["output"]["license"]["configure_flags_forbidden"]:
        _require_provenance(
            flag not in configure_flags,
            f"packaged FFmpeg build configuration must not contain {flag}",
        )
    for command, names, kind in (
        ("-encoders", lock["output"]["required_encoders"], "encoder"),
        ("-filters", lock["output"]["required_filters"], "filter"),
    ):
        result = subprocess.run(
            [str(ffmpeg), "-hide_banner", command], capture_output=True, text=True, check=True
        )
        table = result.stdout + result.stderr
        for name in names:
            _require_provenance(f" {name}" in table, f"packaged FFmpeg is missing {kind} {name}")
    ldd = subprocess.run(["ldd", str(ffmpeg)], capture_output=True, text=True, check=True)
    _require_provenance(
        lock["output"]["runtime_dependency"] in ldd.stdout,
        "packaged FFmpeg is fully static or does not dynamically link libc.so.6",
    )
    for forbidden in lock["output"]["forbidden_runtime_dependencies"]:
        _require_provenance(
            forbidden not in ldd.stdout,
            f"packaged FFmpeg dynamically links {forbidden} instead of its static library",
        )


def inspect_tree(app_root: Path, manifest: dict, lock_path: Path) -> None:
    print(f"  inspecting {app_root}")
    for rel in manifest["expected_present"]:
        target = app_root / rel
        if not target.exists():
            raise VerifyError(f"expected file missing from package: {rel}")
    print(f"  ok: {len(manifest['expected_present'])} expected entries present")

    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if manifest.get("platform") == "linux":
        _validate_linux_lock(lock)
        by_name = {
            entry["file"].removeprefix("ffmpeg/"): entry for entry in manifest.get("ffmpeg", [])
        }
        tool_names = ("ffmpeg", "ffprobe")
    else:
        try:
            windows_manifest = windows_ffmpeg.verify_tools(
                app_root / "ffmpeg",
                windows_ffmpeg.BUILD / windows_ffmpeg.SOURCE_BUNDLE,
            )
        except windows_ffmpeg.BuildError as exc:
            raise VerifyError(str(exc)) from exc
        by_name = windows_manifest["files"]
        tool_names = ("ffmpeg.exe", "ffprobe.exe")
    for name in tool_names:
        if name not in by_name:
            raise VerifyError(f"missing staged output hash for {name}")
        actual = _sha256(app_root / "ffmpeg" / name)
        expected = by_name[name]["sha256"]
        if actual != expected:
            raise VerifyError(
                f"bundled {name} SHA-256 mismatch\n  expected {expected}\n  got      {actual}"
            )
        if manifest.get("platform") == "linux":
            expected_size = by_name[name].get("size_bytes")
            if (app_root / "ffmpeg" / name).stat().st_size != expected_size:
                raise VerifyError(f"bundled {name} size does not match the staging manifest")
    if manifest.get("platform") == "linux":
        print("  ok: bundled ffmpeg/ffprobe match their recorded output hashes")
    else:
        print("  ok: Windows tools, corresponding sources, and runtime capabilities verified")

    if manifest.get("platform") == "linux":
        _validate_linux_source_archive(app_root, manifest, lock)
        _validate_linux_ffmpeg_runtime(app_root, lock)
        bundled_wayland_client = app_root.parent / "libwayland-client.so.0"
        if bundled_wayland_client.exists():
            raise VerifyError(
                "Linux AppImages must use the host libwayland-client to avoid "
                "Wayland/EGL ABI conflicts"
            )
        print("  ok: source archive, GPL build configuration, codecs, filters, and libc linkage")

    if manifest.get("platform") != "linux":
        webview2 = json.loads(WEBVIEW2_LOCK.read_text(encoding="utf-8"))
        bootstrapper = app_root / webview2["filename"]
        if not bootstrapper.is_file():
            raise VerifyError(f"WebView2 bootstrapper missing from package: {webview2['filename']}")
        actual_bootstrapper = _sha256(bootstrapper)
        if actual_bootstrapper != webview2["sha256"]:
            raise VerifyError(
                "WebView2 bootstrapper SHA-256 mismatch\n"
                f"  expected {webview2['sha256']}\n  got      {actual_bootstrapper}"
            )
        if bootstrapper.stat().st_size != webview2["size_bytes"]:
            raise VerifyError("WebView2 bootstrapper size does not match its lock file")
        print("  ok: WebView2 bootstrapper matches the pinned build input")

    denied = [d.lower() for d in manifest["denied_substrings"]]
    offenders: list[str] = []
    scanned = 0
    for path in app_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(app_root).as_posix().lower()
        # NSIS extraction exposes internal directories prefixed with `$`;
        # they are installer scaffolding rather than installed payload
        if rel.startswith("$"):
            continue
        scanned += 1
        # _internal/*.pyc is normal PyInstaller archive content; only flag loose caches
        if rel.startswith("_internal/") and rel.endswith(".pyc"):
            continue
        for token in denied:
            if token in rel:
                offenders.append(f"{rel}  (matched '{token}')")
    if offenders:
        raise VerifyError("denied content found in package:\n    " + "\n    ".join(offenders))
    print(f"  ok: no denied content ({scanned} payload entries scanned)")


def start_sidecar(
    app_root: Path, sidecar_name: str = "tuck-sidecar.exe", platform_name: str = "windows"
) -> None:
    exe = app_root / sidecar_name
    print(f"  starting {exe.name} --protocol 1")
    with tempfile.TemporaryDirectory(prefix="tuck-sidecar-data-") as data_root:
        env = dict(os.environ)
        env["TUCK_SIDECAR_DATA_ROOT"] = data_root
        if platform_name == "linux":
            env["TUCK_DESKTOP_PLATFORM"] = "linux"
        proc = subprocess.Popen(
            [str(exe), "--protocol", "1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(app_root),
            env=env,
        )
        try:
            first = _read_startup_frame(proc, _SIDECAR_STARTUP_TIMEOUT_SECONDS)
            frame = json.loads(first)
            if frame.get("kind") != "event" or frame.get("event") != "backend_ready":
                raise VerifyError(f"first sidecar frame was not backend_ready: {first!r}")
            if frame.get("protocol") != 1:
                raise VerifyError(f"sidecar reported wrong protocol: {first!r}")
            print(f"  ok: backend_ready (version {frame['payload'].get('backend_version')})")

            assert proc.stdin is not None
            proc.stdin.write(
                json.dumps(
                    {
                        "kind": "request",
                        "protocol": 1,
                        "id": "v1",
                        "method": "shutdown",
                        "params": {},
                    }
                )
                + "\n"
            )
            proc.stdin.flush()
            proc.wait(timeout=15)
            if proc.returncode != 0:
                raise VerifyError(f"sidecar did not exit cleanly (code {proc.returncode})")
            print("  ok: orderly shutdown")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def _read_startup_frame(proc: subprocess.Popen[str], timeout: float) -> str:
    if proc.stdout is None:
        raise VerifyError("sidecar stdout was not available")

    lines: queue.Queue[str | None] = queue.Queue()

    def read_stdout() -> None:
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    reader = threading.Thread(target=read_stdout, name="tuck-verify-stdout", daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise VerifyError(f"sidecar did not report readiness within {timeout:g} seconds")
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty as exc:
            raise VerifyError(
                f"sidecar did not report readiness within {timeout:g} seconds"
            ) from exc
        if line is None:
            raise VerifyError("sidecar closed protocol output before reporting readiness")
        if line.strip():
            return line.strip()


def run_cli_version(app_root: Path) -> None:
    exe = app_root / "TuckCli.exe"
    print(f"  running {exe.name} --version")
    result = subprocess.run(
        [str(exe), "--version"], capture_output=True, text=True, cwd=str(app_root), timeout=60
    )
    if result.returncode != 0:
        raise VerifyError(
            f"TuckCli.exe --version exited {result.returncode}: {result.stderr.strip()}"
        )
    if EXPECTED_VERSION not in result.stdout:
        raise VerifyError(f"TuckCli.exe --version output unexpected: {result.stdout.strip()!r}")
    print(f"  ok: {result.stdout.strip()}")


def _extract_artifact(artifact: Path, platform_name: str) -> Path:
    artifact = artifact.resolve()
    if platform_name == "linux":
        workdir = Path(tempfile.mkdtemp(prefix="tuck-verify-"))
        print(f"  extracting {artifact.name} -> {workdir}")
        result = subprocess.run(
            [str(artifact), "--appimage-extract"], cwd=workdir, capture_output=True, text=True
        )
        if result.returncode != 0:
            raise VerifyError(f"could not extract {artifact}: {result.stdout}\n{result.stderr}")
        extracted = workdir / "squashfs-root"
        if not extracted.is_dir():
            raise VerifyError(f"AppImage extraction did not produce {extracted}")
        return workdir
    seven_zip = shutil.which("7z") or shutil.which("7za")
    if not seven_zip:
        raise VerifyError("7z is required to inspect an NSIS artifact but was not found on PATH")
    workdir = Path(tempfile.mkdtemp(prefix="tuck-verify-"))
    print(f"  extracting {artifact.name} -> {workdir}")
    result = subprocess.run(
        [seven_zip, "x", "-y", f"-o{workdir}", str(artifact)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise VerifyError(f"could not extract {artifact}: {result.stdout}\n{result.stderr}")
    return workdir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default="windows", choices=["windows", "linux"])
    parser.add_argument("--staging", action="store_true", help="Inspect the platform staging tree.")
    parser.add_argument("--artifact", type=Path, help="Path to the built installer or AppImage.")
    args = parser.parse_args()

    if not args.staging and not args.artifact:
        parser.error("pass --staging or --artifact")

    staging_app, manifest_path, lock_path = _platform_paths(args.platform)
    manifest = _load_manifest(manifest_path)
    sidecar_name = str(manifest["sidecar_executable"])
    cleanup: Path | None = None
    try:
        if args.staging:
            app_root = _find_app_root(staging_app, sidecar_name)
        else:
            if not args.artifact.is_file():
                raise VerifyError(f"artifact not found: {args.artifact}")
            cleanup = _extract_artifact(args.artifact, args.platform)
            app_root = _find_app_root(cleanup, sidecar_name)

        print("[1/3] inspect package contents")
        inspect_tree(app_root, manifest, lock_path)
        if args.artifact and args.platform == "windows":
            gui = app_root / "Tuck.exe"
            if not gui.is_file():
                raise VerifyError(
                    "the Tauri GUI executable must be named Tuck.exe and sit next to "
                    f"TuckCli.exe (Send To targeting depends on it); not found in {app_root}"
                )
            print("  ok: Tuck.exe present next to TuckCli.exe")
        print("[2/3] start frozen sidecar")
        start_sidecar(app_root, sidecar_name, args.platform)
        if args.platform == "windows":
            print("[3/3] run packaged CLI")
            run_cli_version(app_root)
        else:
            print("[3/3] no Linux CLI is packaged")
        print("\nPACKAGE OK")
        return 0
    except (VerifyError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print(f"\nVERIFY FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        if cleanup and cleanup.exists():
            shutil.rmtree(cleanup, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
