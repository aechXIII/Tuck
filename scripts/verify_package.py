"""Inspect and exercise a built Tuck package.

Two modes:

    python scripts/verify_package.py --staging
        Inspect packaging/staging/app/ (the exact tree Tauri bundles) and start
        the frozen sidecar + CLI from it.

    python scripts/verify_package.py --platform windows --artifact <setup.exe>
        Extract the real NSIS installer, inspect its payload, and start the
        frozen sidecar + CLI from the extracted files.

Artifact existence or config text is never accepted as proof: this script reads
the actual files and runs the actual executables. Exit code is non-zero on any
failure.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGING_APP = ROOT / "packaging" / "staging" / "app"
MANIFEST = ROOT / "packaging" / "staging" / "manifest.json"
LOCK = ROOT / "packaging" / "ffmpeg-sources.lock.json"
WEBVIEW2_LOCK = ROOT / "packaging" / "webview2-bootstrapper.lock.json"
EXPECTED_VERSION = "0.4.0"


class VerifyError(RuntimeError):
    pass


_SIDECAR_STARTUP_TIMEOUT_SECONDS = 15


def _load_manifest() -> dict:
    if not MANIFEST.is_file():
        raise VerifyError(f"Missing {MANIFEST}. Run scripts/build_sidecar.py first.")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _find_app_root(tree: Path) -> Path:
    if (tree / "tuck-sidecar.exe").is_file():
        return tree
    for candidate in tree.rglob("tuck-sidecar.exe"):
        return candidate.parent
    raise VerifyError(f"tuck-sidecar.exe not found anywhere under {tree}")


def inspect_tree(app_root: Path, manifest: dict) -> None:
    print(f"  inspecting {app_root}")
    for rel in manifest["expected_present"]:
        target = app_root / rel
        if not target.exists():
            raise VerifyError(f"expected file missing from package: {rel}")
    print(f"  ok: {len(manifest['expected_present'])} expected entries present")

    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    by_name = {m["install_as"]: m for m in lock["members"]}
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        actual = _sha256(app_root / "ffmpeg" / name)
        expected = by_name[name]["sha256"]
        if actual != expected:
            raise VerifyError(
                f"bundled {name} SHA-256 mismatch\n  expected {expected}\n  got      {actual}"
            )
    print("  ok: bundled ffmpeg/ffprobe match the lock file")

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


def start_sidecar(app_root: Path) -> None:
    exe = app_root / "tuck-sidecar.exe"
    print(f"  starting {exe.name} --protocol 1")
    with tempfile.TemporaryDirectory(prefix="tuck-sidecar-data-") as data_root:
        env = dict(os.environ)
        env["TUCK_SIDECAR_DATA_ROOT"] = data_root
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


def _extract_artifact(artifact: Path) -> Path:
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
    parser.add_argument("--platform", default="windows", choices=["windows"])
    parser.add_argument("--staging", action="store_true", help="Inspect packaging/staging/app/.")
    parser.add_argument("--artifact", type=Path, help="Path to the built NSIS installer .exe.")
    args = parser.parse_args()

    if not args.staging and not args.artifact:
        parser.error("pass --staging or --artifact")

    manifest = _load_manifest()
    cleanup: Path | None = None
    try:
        if args.staging:
            app_root = _find_app_root(STAGING_APP)
        else:
            if not args.artifact.is_file():
                raise VerifyError(f"artifact not found: {args.artifact}")
            cleanup = _extract_artifact(args.artifact)
            app_root = _find_app_root(cleanup)

        print("[1/3] inspect package contents")
        inspect_tree(app_root, manifest)
        if args.artifact:
            gui = app_root / "Tuck.exe"
            if not gui.is_file():
                raise VerifyError(
                    "the Tauri GUI executable must be named Tuck.exe and sit next to "
                    f"TuckCli.exe (Send To targeting depends on it); not found in {app_root}"
                )
            print("  ok: Tuck.exe present next to TuckCli.exe")
        print("[2/3] start frozen sidecar")
        start_sidecar(app_root)
        print("[3/3] run packaged CLI")
        run_cli_version(app_root)
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
