"""Exercise the packaged Tuck backend end to end.

    python scripts/smoke_packaged.py --staging
    python scripts/smoke_packaged.py --app-root <dir containing tuck-sidecar.exe>

Runs against the frozen sidecar and the *bundled* ffmpeg/ffprobe only. Each
scenario uses its own sidecar and a temporary settings root:

1. start + health + generate a fixture with the bundled ffmpeg + probe +
   run a real two-pass size-target compression to completion with a published
   output;
2. fresh sidecar: enqueue a slow encode, cancel it mid-run, assert no final
   output is published;
3. after shutdown, assert no tuck-sidecar.exe / ffmpeg.exe processes linger.

Bounded waits, fixed fixtures, no sleeps to paper over races. Exit code is
non-zero on any failure.
"""

from __future__ import annotations

import argparse
import json
import os
import queue as queuelib
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGING_APP = ROOT / "packaging" / "staging" / "app"


class SmokeError(RuntimeError):
    pass


class Sidecar:
    """NDJSON client with a background stdout reader and a pending-response map,
    so responses are matched to requests regardless of arrival order or rate.
    """

    def __init__(self, app_root: Path) -> None:
        self.app_root = app_root
        self.exe = app_root / "tuck-sidecar.exe"
        self.proc: subprocess.Popen[str] | None = None
        self._seq = 0
        self._pending: dict[str, queuelib.Queue] = {}
        self._lock = threading.Lock()
        self._ready: queuelib.Queue = queuelib.Queue()
        self._reader: threading.Thread | None = None

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

    def start(self, data_root: Path) -> dict:
        env = dict(os.environ, TUCK_SIDECAR_DATA_ROOT=str(data_root))
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


def _running(image: str) -> list[str]:
    out = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH", "/FI", f"IMAGENAME eq {image}"],
        capture_output=True,
        text=True,
    ).stdout
    return [row for row in out.splitlines() if image.lower() in row.lower()]


def _make_fixture(app_root: Path, dest: Path, *, duration: int = 3, size: str = "640x480") -> None:
    ffmpeg = app_root / "ffmpeg" / "ffmpeg.exe"
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


def _encode_scenario(app_root: Path, work: Path) -> None:
    fixture = work / "fixture.mp4"
    car = Sidecar(app_root)
    ready = car.start(work / "data-encode")
    print(f"  backend_ready {ready['payload'].get('backend_version')}")
    car.call("health")
    print("  health ok")
    _make_fixture(app_root, fixture)
    print(f"  fixture {fixture.stat().st_size} bytes")

    probe = car.call("probe_file", {"path": str(fixture)}, timeout=120)
    data = probe.get("data", probe)
    if int(data.get("width", 0)) != 640 or int(data.get("height", 0)) != 480:
        raise SmokeError(f"probe returned unexpected dimensions: {data}")
    print(f"  probe {data.get('width')}x{data.get('height')} {data.get('duration')}s")

    # a reachable target keeps the size-target retry loop from spinning on a
    # synthetic clip; still a real two-pass rate-controlled encode
    request = {"source": str(fixture), "preset": "ultrafast", "target_size_bytes": 2 * 1024 * 1024}
    enq = car.call("enqueue_with_options", {"request": request}, timeout=120)
    item_id = enq.get("item_id")
    if not item_id:
        raise SmokeError(f"enqueue returned no item id: {enq}")

    deadline = time.monotonic() + 240
    state = ""
    while time.monotonic() < deadline:
        state = _queue_item(car, item_id).get("state", "")
        if state in {"completed", "failed", "cancelled"}:
            break
        time.sleep(2.0)
    if state != "completed":
        raise SmokeError(f"encode did not complete (last state {state!r})")
    result_path = _queue_item(car, item_id).get("result_path")
    if not result_path or not Path(result_path).is_file():
        raise SmokeError(f"no output file was published on completion: {result_path!r}")
    print(f"  completed -> {Path(result_path).name}")
    car.shutdown()


def _cancel_scenario(app_root: Path, work: Path) -> set[str]:
    """Returns the ffmpeg PIDs seen before shutdown, for the caller's cleanup check."""
    long_src = work / "long.mp4"
    _make_fixture(app_root, long_src, duration=6, size="854x480")
    car = Sidecar(app_root)
    car.start(work / "data-cancel")

    ffmpeg_before = set(_running("ffmpeg.exe"))
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


def run(app_root: Path) -> None:
    if not (app_root / "tuck-sidecar.exe").is_file():
        raise SmokeError(f"tuck-sidecar.exe not found in {app_root}")

    work = Path(tempfile.mkdtemp(prefix="tuck-smoke-"))

    print("[1/3] encode a fixture to completion")
    _encode_scenario(app_root, work)

    print("[2/3] cancel a running encode")
    ffmpeg_before = _cancel_scenario(app_root, work)

    print("[3/3] process cleanup after shutdown")
    time.sleep(1.0)
    lingering_sidecar = _running("tuck-sidecar.exe")
    lingering_ffmpeg = set(_running("ffmpeg.exe")) - ffmpeg_before
    if lingering_sidecar:
        raise SmokeError(f"tuck-sidecar.exe still running after shutdown: {lingering_sidecar}")
    if lingering_ffmpeg:
        raise SmokeError(f"ffmpeg.exe spawned by the encode is still running: {lingering_ffmpeg}")
    print("  ok: no lingering tuck-sidecar.exe / ffmpeg.exe")
    print("\nSMOKE OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", action="store_true")
    parser.add_argument("--app-root", type=Path)
    args = parser.parse_args()

    app_root = STAGING_APP if args.staging else args.app_root
    if not app_root:
        parser.error("pass --staging or --app-root")

    try:
        run(Path(app_root))
        return 0
    except (SmokeError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"\nSMOKE FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
