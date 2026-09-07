"""Exercise the packaged Tuck backend end to end.

    python scripts/smoke_packaged.py --staging
    python scripts/smoke_packaged.py --platform linux --staging
    python scripts/smoke_packaged.py --platform linux --artifact <AppImage>
    python scripts/smoke_packaged.py --app-root <dir containing tuck-sidecar.exe>

Runs against the frozen sidecar and the *bundled* ffmpeg/ffprobe only. Each
scenario uses its own sidecar and a temporary settings root:

1. start + health + generate a fixture with the bundled ffmpeg + probe +
   run a real two-pass size-target compression to completion with a published
   output;
2. fresh sidecar: enqueue a slow encode, cancel it mid-run, assert no final
   output is published;
3. after shutdown, assert no sidecar or FFmpeg processes linger.

Bounded waits, fixed fixtures, no sleeps to paper over races. Exit code is
non-zero on any failure.
"""

from __future__ import annotations

import argparse
import json
import os
import queue as queuelib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGING_APP = ROOT / "packaging" / "staging" / "app"
LINUX_STAGING_APP = ROOT / "packaging" / "staging" / "linux" / "app"


class SmokeError(RuntimeError):
    pass


class Sidecar:
    """NDJSON client with a background stdout reader and a pending-response map,
    so responses are matched to requests regardless of arrival order or rate.
    """

    def __init__(self, app_root: Path, platform_name: str) -> None:
        self.app_root = app_root
        self.platform_name = platform_name
        self.exe = app_root / ("tuck-sidecar" if platform_name == "linux" else "tuck-sidecar.exe")
        self.proc: subprocess.Popen[str] | None = None
        self._seq = 0
        self._pending: dict[str, queuelib.Queue] = {}
        self._lock = threading.Lock()
        self._ready: queuelib.Queue = queuelib.Queue()
        self._reader: threading.Thread | None = None
        # A full stderr pipe blocks the sidecar mid-encode, so it must be drained.
        # Keep the tail for diagnostics when a scenario fails.
        self._stderr_tail: deque[str] = deque(maxlen=200)
        self._stderr_reader: threading.Thread | None = None

    def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if frame.get("kind") == "event":
                self._ready.put(frame)
            elif frame.get("kind") == "response":
                with self._lock:
                    box = self._pending.pop(frame.get("id", ""), None)
                if box is not None:
                    box.put(frame)

    def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for line in self.proc.stderr:
            self._stderr_tail.append(line.rstrip())

    def stderr_tail(self, lines: int = 40) -> str:
        return "\n".join(list(self._stderr_tail)[-lines:])

    def start(self, data_root: Path) -> dict:
        env = dict(os.environ, TUCK_SIDECAR_DATA_ROOT=str(data_root))
        if self.platform_name == "linux":
            env["TUCK_DESKTOP_PLATFORM"] = "linux"
        self.proc = subprocess.Popen(
            [str(self.exe), "--protocol", "1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(self.app_root),
            env=env,
        )
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_reader.start()
        try:
            frame = self._ready.get(timeout=15)
        except queuelib.Empty:
            raise SmokeError("sidecar never reported backend_ready") from None
        if frame.get("event") != "backend_ready":
            raise SmokeError(f"unexpected first frame: {frame!r}")
        return frame

    def call(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        assert self.proc and self.proc.stdin
        self._seq += 1
        request_id = f"smoke-{self._seq}"
        box: queuelib.Queue = queuelib.Queue(maxsize=1)
        with self._lock:
            self._pending[request_id] = box
        self.proc.stdin.write(
            json.dumps(
                {
                    "kind": "request",
                    "protocol": 1,
                    "id": request_id,
                    "method": method,
                    "params": params or {},
                }
            )
            + "\n"
        )
        self.proc.stdin.flush()
        try:
            frame = box.get(timeout=timeout)
        except queuelib.Empty:
            raise SmokeError(f"{method} timed out after {timeout}s") from None
        if not frame.get("ok"):
            raise SmokeError(f"{method} failed: {frame.get('error')}")
        return frame.get("result", {})

    def shutdown(self) -> None:
        if not self.proc:
            return
        try:
            if self.proc.poll() is None and self.proc.stdin:
                self.proc.stdin.write(
                    '{"kind":"request","protocol":1,"id":"smoke-shutdown",'
                    '"method":"shutdown","params":{}}\n'
                )
                self.proc.stdin.flush()
            self.proc.wait(timeout=15)
        except (subprocess.SubprocessError, OSError):
            pass
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait(timeout=5)


def _running(image: str, platform_name: str) -> list[str]:
    if platform_name == "linux":
        result = subprocess.run(
            ["ps", "-eo", "pid=,comm="], capture_output=True, text=True, check=True
        )
        return [row for row in result.stdout.splitlines() if row.split()[-1:] == [image]]
    out = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH", "/FI", f"IMAGENAME eq {image}"],
        capture_output=True,
        text=True,
    ).stdout
    return [row for row in out.splitlines() if image.lower() in row.lower()]


def _make_fixture(
    app_root: Path,
    platform_name: str,
    dest: Path,
    *,
    duration: int = 3,
    size: str = "640x480",
) -> None:
    ffmpeg = app_root / "ffmpeg" / ("ffmpeg" if platform_name == "linux" else "ffmpeg.exe")
    # a high-entropy source (mandelbrot + grain) so compressed size scales with
    # bitrate; a flat testsrc compresses to a fixed tiny size and can stall the
    # size-target rate-control loop
    graph = f"mandelbrot=size={size}:rate=24,noise=alls=24:allf=t+u,format=yuv420p"
    subprocess.run(
        [str(ffmpeg), "-y", "-f", "lavfi", "-i", graph, "-t", str(duration), str(dest)],
        check=True,
        capture_output=True,
    )
    if not dest.is_file() or dest.stat().st_size == 0:
        raise SmokeError("bundled ffmpeg did not produce the fixture")


def _queue_item(car: Sidecar, item_id: str) -> dict:
    items = car.call("get_queue_state").get("items", [])
    return next((i for i in items if i.get("id") == item_id), {})


def _encode_scenario(app_root: Path, platform_name: str, work: Path) -> None:
    fixture = work / "fixture.mp4"
    car = Sidecar(app_root, platform_name)
    ready = car.start(work / "data-encode")
    print(f"  backend_ready {ready['payload'].get('backend_version')}")
    car.call("health")
    print("  health ok")
    # 6 s of 720p high-entropy video carries well over 2 MB of information, so the
    # size-target rate control is bitrate-constrained (its normal case). A tiny
    # clip whose natural size sits far below the target makes the planner keep
    # raising the bitrate across its bounded retries, which is slow on a CI runner.
    _make_fixture(app_root, platform_name, fixture, duration=6, size="1280x720")
    print(f"  fixture {fixture.stat().st_size} bytes")

    probe = car.call("probe_file", {"path": str(fixture)}, timeout=120)
    data = probe.get("data", probe)
    if int(data.get("width", 0)) != 1280 or int(data.get("height", 0)) != 720:
        raise SmokeError(f"probe returned unexpected dimensions: {data}")
    print(f"  probe {data.get('width')}x{data.get('height')} {data.get('duration')}s")

    request = {"source": str(fixture), "preset": "ultrafast", "target_size_bytes": 2 * 1024 * 1024}
    enq = car.call("enqueue_with_options", {"request": request}, timeout=120)
    item_id = enq.get("item_id")
    if not item_id:
        raise SmokeError(f"enqueue returned no item id: {enq}")

    deadline = time.monotonic() + 600
    state = ""
    while time.monotonic() < deadline:
        state = _queue_item(car, item_id).get("state", "")
        if state in {"completed", "failed", "cancelled"}:
            break
        time.sleep(2.0)
    if state != "completed":
        tail = car.stderr_tail()
        raise SmokeError(
            f"encode did not complete (last state {state!r})"
            + (f"\n--- sidecar stderr tail ---\n{tail}" if tail else "")
        )
    result_path = _queue_item(car, item_id).get("result_path")
    if not result_path or not Path(result_path).is_file():
        raise SmokeError(f"no output file was published on completion: {result_path!r}")
    print(f"  completed -> {Path(result_path).name}")
    car.shutdown()


def _cancel_scenario(app_root: Path, platform_name: str, work: Path) -> set[str]:
    """Returns the ffmpeg PIDs seen before shutdown, for the caller's cleanup check."""
    long_src = work / "long.mp4"
    _make_fixture(app_root, platform_name, long_src, duration=6, size="854x480")
    car = Sidecar(app_root, platform_name)
    car.start(work / "data-cancel")

    ffmpeg_name = "ffmpeg" if platform_name == "linux" else "ffmpeg.exe"
    ffmpeg_before = set(_running(ffmpeg_name, platform_name))
    request = {"source": str(long_src)}  # default veryslow preset -> slow enough to catch
    enq = car.call("enqueue_with_options", {"request": request}, timeout=120)
    item_id = enq.get("item_id")

    for _ in range(120):
        if _queue_item(car, item_id).get("state") == "running":
            break
        time.sleep(1.0)
    else:
        raise SmokeError("encode never started running")
    car.call("cancel_item", {"item_id": item_id})

    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if _queue_item(car, item_id).get("state") in {"cancelled", "failed"}:
            break
        time.sleep(1.0)
    cancelled = _queue_item(car, item_id)
    if cancelled.get("state") not in {"cancelled", "failed"}:
        raise SmokeError(f"encode did not cancel (state {cancelled.get('state')!r})")
    published = cancelled.get("result_path")
    if published and Path(published).is_file():
        raise SmokeError(f"cancelled encode published a final output: {published}")
    print("  ok: cancelled with no published output")
    car.shutdown()
    return ffmpeg_before


def run(app_root: Path, platform_name: str) -> None:
    sidecar_name = "tuck-sidecar" if platform_name == "linux" else "tuck-sidecar.exe"
    if not (app_root / sidecar_name).is_file():
        raise SmokeError(f"{sidecar_name} not found in {app_root}")

    work = Path(tempfile.mkdtemp(prefix="tuck-smoke-"))

    print("[1/3] encode a fixture to completion")
    _encode_scenario(app_root, platform_name, work)

    print("[2/3] cancel a running encode")
    ffmpeg_before = _cancel_scenario(app_root, platform_name, work)

    print("[3/3] process cleanup after shutdown")
    time.sleep(1.0)
    lingering_sidecar = _running(sidecar_name, platform_name)
    ffmpeg_name = "ffmpeg" if platform_name == "linux" else "ffmpeg.exe"
    lingering_ffmpeg = set(_running(ffmpeg_name, platform_name)) - ffmpeg_before
    if lingering_sidecar:
        raise SmokeError(f"{sidecar_name} still running after shutdown: {lingering_sidecar}")
    if lingering_ffmpeg:
        raise SmokeError(
            f"{ffmpeg_name} spawned by the encode is still running: {lingering_ffmpeg}"
        )
    print(f"  ok: no lingering {sidecar_name} / {ffmpeg_name}")
    print("\nSMOKE OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", default="windows", choices=["windows", "linux"])
    parser.add_argument("--staging", action="store_true")
    parser.add_argument("--app-root", type=Path)
    parser.add_argument("--artifact", type=Path)
    args = parser.parse_args()

    if sum(bool(value) for value in (args.staging, args.app_root, args.artifact)) != 1:
        parser.error("pass exactly one of --staging, --app-root, or --artifact")

    cleanup: Path | None = None
    if args.staging:
        app_root = LINUX_STAGING_APP if args.platform == "linux" else STAGING_APP
    elif args.app_root:
        app_root = args.app_root
    else:
        if args.platform != "linux":
            parser.error("--artifact is only supported for Linux AppImages")
        assert args.artifact is not None
        artifact = args.artifact.resolve()
        if not artifact.is_file():
            parser.error(f"artifact not found: {artifact}")
        cleanup = Path(tempfile.mkdtemp(prefix="tuck-smoke-appimage-"))
        result = subprocess.run(
            [str(artifact), "--appimage-extract"],
            cwd=cleanup,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            cleanup.rmdir()
            parser.error(f"could not extract {artifact}: {result.stdout}\n{result.stderr}")
        extracted = cleanup / "squashfs-root"
        if not extracted.is_dir():
            shutil.rmtree(cleanup, ignore_errors=True)
            parser.error("AppImage extraction did not produce squashfs-root")
        sidecar = next(extracted.rglob("tuck-sidecar"), None)
        if sidecar is None:
            shutil.rmtree(cleanup, ignore_errors=True)
            parser.error("AppImage does not contain tuck-sidecar")
        app_root = sidecar.parent

    try:
        run(Path(app_root), args.platform)
        return 0
    except (SmokeError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"\nSMOKE FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        if cleanup is not None:
            shutil.rmtree(cleanup, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
