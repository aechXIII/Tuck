"""Start an extracted Linux AppImage under a desktop display and check cleanup.

The shell owns the sidecar process group, so stopping the GUI must also stop the
sidecar and any FFmpeg descendant it started. This is a launch smoke, not a
replacement for the manual desktop workflow gate.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


class GuiSmokeError(RuntimeError):
    pass


def _sidecar_processes(sidecar: Path) -> set[int]:
    result = subprocess.run(["ps", "-eo", "pid="], capture_output=True, text=True, check=True)
    processes: set[int] = set()
    for row in result.stdout.splitlines():
        pid = int(row.strip())
        try:
            if sidecar.samefile(Path("/proc") / str(pid) / "exe"):
                processes.add(pid)
        except OSError:
            continue
    return processes


def _tuck_window_is_visible() -> bool:
    result = subprocess.run(
        ["xwininfo", "-root", "-tree"], capture_output=True, text=True, check=True
    )
    return '"Tuck"' in result.stdout


def run(artifact: Path) -> None:
    artifact = artifact.resolve()
    if sys.platform != "linux":
        raise GuiSmokeError("The AppImage GUI smoke must run on Linux.")
    if not artifact.is_file():
        raise GuiSmokeError(f"AppImage not found: {artifact}")
    if not os.environ.get("DISPLAY"):
        raise GuiSmokeError(
            "DISPLAY is unavailable. Run this through xvfb-run or a desktop session."
        )

    with tempfile.TemporaryDirectory(prefix="tuck-appimage-gui-") as work:
        workdir = Path(work)
        result = subprocess.run(
            [str(artifact), "--appimage-extract"], cwd=workdir, capture_output=True, text=True
        )
        if result.returncode != 0:
            raise GuiSmokeError(f"Could not extract {artifact}: {result.stdout}\n{result.stderr}")
        app_root = workdir / "squashfs-root"
        app_run = app_root / "AppRun"
        sidecar = next(app_root.rglob("tuck-sidecar"), None)
        if not app_run.is_file() or sidecar is None:
            raise GuiSmokeError("The AppImage does not contain AppRun and tuck-sidecar.")
        data_root = workdir / "data"
        environment = dict(
            os.environ,
            TUCK_SIDECAR_DATA_ROOT=str(data_root),
            TUCK_DESKTOP_PLATFORM="linux",
        )
        process = subprocess.Popen(
            [str(app_run)],
            cwd=app_root,
            env=environment,
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        launched: set[int] = set()
        ready = False
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    output, errors = process.communicate()
                    raise GuiSmokeError(
                        "The AppImage GUI exited during launch "
                        f"({process.returncode}):\n{output}{errors}"
                    )
                launched = _sidecar_processes(sidecar)
                if launched and _tuck_window_is_visible():
                    ready = True
                    break
                time.sleep(0.2)
            if not ready:
                raise GuiSmokeError("The AppImage did not show the Tuck window within 20 seconds.")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)

        deadline = time.monotonic() + 10
        remaining = launched
        while remaining and time.monotonic() < deadline:
            time.sleep(0.2)
            current = _sidecar_processes(sidecar)
            remaining = launched & current
        if remaining:
            raise GuiSmokeError(f"The AppImage left sidecar processes running: {sorted(remaining)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.artifact)
    except (GuiSmokeError, OSError, subprocess.SubprocessError) as error:
        print(f"GUI SMOKE FAILED: {error}", file=sys.stderr)
        return 1
    print("GUI SMOKE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
