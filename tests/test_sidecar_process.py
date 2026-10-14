from __future__ import annotations

import io
import json
import os
import queue
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO
from urllib.error import HTTPError
from urllib.request import urlopen

import av
import pytest

from tuck.media_tools import find_ffmpeg
from tuck.sidecar.protocol import Event
from tuck.sidecar.server import run_server

_ROOT = Path(__file__).parent.parent

_CONCURRENT_SIDECAR_SCRIPT = """
import sys
import threading

from tuck.sidecar.protocol import Event
from tuck.sidecar.server import run_server


class Api:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def get_queue_state(self):
        self.started.set()
        self.release.wait()
        return {"items": [], "current_id": None, "pending_ids": []}


class Lifecycle:
    def __init__(self):
        self.api = Api()

    def start(self):
        return self.api

    def ready_event(self):
        return Event("backend_ready", {"backend_version": "0.4.0", "pid": 1, "capabilities": {}})

    def shutdown(self):
        pass


class Stdout:
    def __init__(self, lifecycle):
        self.lifecycle = lifecycle

    def write(self, value):
        written = sys.stdout.write(value)
        if '\"id\":\"health-later\"' in value:
            self.lifecycle.api.release.set()
        return written

    def flush(self):
        sys.stdout.flush()


lifecycle = Lifecycle()
raise SystemExit(run_server(sys.stdin, Stdout(lifecycle), sys.stderr, lifecycle))
"""

_CRASHING_SIDECAR_SCRIPT = """
import sys

from tuck.sidecar.server import run_server


class Lifecycle:
    def start(self):
        raise RuntimeError("secret startup path")

    def shutdown(self):
        pass


raise SystemExit(run_server(sys.stdin, sys.stdout, sys.stderr, Lifecycle()))
"""


class SidecarProcess:
    def __init__(self, data_root: Path, command: list[str] | None = None) -> None:
        self.data_root = data_root
        environment = dict(os.environ)
        environment.update(
            {
                "APPDATA": str(data_root / "appdata"),
                "LOCALAPPDATA": str(data_root / "localappdata"),
                "XDG_CONFIG_HOME": str(data_root / "config"),
                "XDG_DATA_HOME": str(data_root / "data"),
                "XDG_CACHE_HOME": str(data_root / "cache"),
                "TUCK_SIDECAR_DATA_ROOT": str(data_root),
            }
        )
        self.process = subprocess.Popen(
            command or [sys.executable, "-m", "tuck.sidecar", "--protocol", "1"],
            cwd=_ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self._stdout: queue.Queue[str | None] = queue.Queue()
        self._stderr: queue.Queue[str | None] = queue.Queue()
        self._start_reader(self.process.stdout, self._stdout)
        self._start_reader(self.process.stderr, self._stderr)

    @staticmethod
    def _start_reader(stream: BinaryIO, destination: queue.Queue[str | None]) -> None:
        def read() -> None:
            for line in stream:
                destination.put(line.decode("utf-8"))
            destination.put(None)

        threading.Thread(target=read, daemon=True).start()

    def send(self, frame: dict[str, object]) -> None:
        self.send_bytes((json.dumps(frame, separators=(",", ":")) + "\n").encode("utf-8"))

    def send_bytes(self, value: bytes) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(value)
        self.process.stdin.flush()

    def receive(self, timeout: float = 5) -> dict[str, object]:
        try:
            line = self._stdout.get(timeout=timeout)
        except queue.Empty as exc:
            stderr = self.stderr_text()
            raise AssertionError(
                f"sidecar did not produce stdout within {timeout} seconds; stderr={stderr}"
            ) from exc
        if line is None:
            raise AssertionError(f"sidecar closed stdout; stderr={self.stderr_text()}")
        return json.loads(line)

    def stderr_text(self) -> str:
        lines: list[str] = []
        while True:
            try:
                line = self._stderr.get_nowait()
            except queue.Empty:
                return "".join(lines)
            if line is None:
                return "".join(lines)
            lines.append(line)

    def close(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        self.process.wait(timeout=5)


@pytest.fixture
def sidecar(tmp_path: Path) -> Iterator[SidecarProcess]:
    process = SidecarProcess(tmp_path / "tuck-data")
    try:
        yield process
    finally:
        process.close()


def _request(request_id: str, method: str, params: dict[str, object]) -> dict[str, object]:
    return {"kind": "request", "protocol": 1, "id": request_id, "method": method, "params": params}


def test_subprocess_serves_and_releases_exact_audio_tracks(
    sidecar: SidecarProcess, tmp_path: Path
) -> None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is required to generate multiple audio tracks")
    source = tmp_path / "recording.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=64x64:rate=10:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=1",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-disposition:a:0",
            "0",
            "-disposition:a:1",
            "default",
            str(source),
        ],
        capture_output=True,
        check=True,
        timeout=30,
    )
    assert sidecar.receive()["event"] == "backend_ready"
    urls = []
    for track in (0, 1):
        request_id = f"audio-{track}"
        sidecar.send(_request(request_id, "get_media_url", {"path": str(source), "track": track}))
        response = sidecar.receive(timeout=20)
        assert response["id"] == request_id
        assert response["ok"] is True, response
        result = response["result"]
        urls.append(result["url"])
        with (
            urlopen(result["url"], timeout=5) as served,
            av.open(io.BytesIO(served.read())) as audio,
        ):
            assert len(audio.streams.audio) == 1
            assert len(audio.streams.video) == 0
            assert next(audio.decode(audio=0)).samples > 0
        sidecar.send(
            _request(f"release-{track}", "release_media_token", {"token": result["token"]})
        )
        assert sidecar.receive()["ok"] is True
        with pytest.raises(HTTPError) as rejected:
            urlopen(result["url"], timeout=5)
        assert rejected.value.code == 403
    assert urls[0] != urls[1]
    sidecar.send(_request("invalid-audio", "get_media_url", {"path": str(source), "track": 2}))
    assert sidecar.receive()["ok"] is False
    sidecar.send(_request("shutdown", "shutdown", {}))
    assert sidecar.receive()["ok"] is True
    assert sidecar.process.wait(timeout=5) == 0


def test_subprocess_emits_readiness_then_health_and_orderly_shutdown(
    sidecar: SidecarProcess,
) -> None:
    ready = sidecar.receive()
    assert ready["kind"] == "event"
    assert ready["event"] == "backend_ready"
    assert ready["protocol"] == 1
    assert ready["payload"] is not None

    sidecar.send(_request("storage-1", "get_storage_paths", {}))
    storage = sidecar.receive()
    assert storage == {
        "kind": "response",
        "protocol": 1,
        "id": "storage-1",
        "ok": True,
        "result": {
            "config_dir": str(sidecar.data_root / "config"),
            "data_dir": str(sidecar.data_root / "data"),
            "cache_dir": str(sidecar.data_root / "cache"),
            "log_dir": str(sidecar.data_root / "data" / "logs"),
        },
    }

    sidecar.send(_request("health-1", "health", {}))
    assert sidecar.receive() == {
        "kind": "response",
        "protocol": 1,
        "id": "health-1",
        "ok": True,
        "result": {"status": "ok"},
    }

    sidecar.send(_request("stop-1", "shutdown", {}))
    stopped = sidecar.receive()
    assert stopped["id"] == "stop-1"
    assert stopped["ok"] is True
    assert sidecar.process.wait(timeout=5) == 0


def test_subprocess_keeps_two_request_ids_and_stdout_as_ndjson(sidecar: SidecarProcess) -> None:
    assert sidecar.receive()["event"] == "backend_ready"
    sidecar.send(_request("queue-1", "get_queue_state", {}))
    sidecar.send(_request("health-2", "health", {}))

    first = sidecar.receive()
    second = sidecar.receive()
    responses = {str(first["id"]): first, str(second["id"]): second}

    assert set(responses) == {"queue-1", "health-2"}
    assert responses["queue-1"]["result"] == {"items": [], "current_id": None, "pending_ids": []}
    assert responses["health-2"]["result"] == {"status": "ok"}


def test_subprocess_accepts_fragmented_and_coalesced_request_lines(sidecar: SidecarProcess) -> None:
    assert sidecar.receive()["event"] == "backend_ready"
    first = json.dumps(_request("fragmented-1", "health", {}), separators=(",", ":"))
    second = json.dumps(_request("coalesced-2", "health", {}), separators=(",", ":"))

    sidecar.send_bytes(first[:17].encode("utf-8"))
    sidecar.send_bytes((first[17:] + "\n" + second + "\n").encode("utf-8"))
    responses = {str(sidecar.receive()["id"]), str(sidecar.receive()["id"])}

    assert responses == {"fragmented-1", "coalesced-2"}


def test_subprocess_rejects_malformed_json_unknown_methods_and_duplicate_ids(
    sidecar: SidecarProcess,
) -> None:
    assert sidecar.receive()["event"] == "backend_ready"
    assert sidecar.process.stdin is not None
    sidecar.process.stdin.write(b"{bad json}\n")
    sidecar.process.stdin.flush()
    malformed = sidecar.receive()
    assert malformed["error"]["code"] == "INVALID_REQUEST"

    sidecar.send(_request("unknown-1", "not_allowed", {}))
    unknown = sidecar.receive()
    assert unknown["id"] == "unknown-1"
    assert unknown["error"]["code"] == "UNKNOWN_METHOD"

    sidecar.send(_request("duplicate-1", "health", {}))
    assert sidecar.receive()["id"] == "duplicate-1"
    sidecar.send(_request("duplicate-1", "health", {}))
    duplicate = sidecar.receive()
    assert duplicate["id"] == "duplicate-1"
    assert duplicate["error"]["code"] == "INVALID_REQUEST"

    sidecar.send({**_request("version-2", "health", {}), "protocol": 2})
    mismatch = sidecar.receive()
    assert mismatch["id"] == "version-2"
    assert mismatch["error"]["code"] == "PROTOCOL_MISMATCH"


def test_subprocess_accepts_large_unicode_request_id_and_logs_to_stderr(
    sidecar: SidecarProcess,
) -> None:
    assert sidecar.receive()["event"] == "backend_ready"
    request_id = "unicode-" + ("żółw-" * 20_000)
    sidecar.send(_request(request_id, "health", {}))
    response = sidecar.receive(timeout=10)

    assert response["id"] == request_id
    assert response["ok"] is True
    assert response["result"] == {"status": "ok"}
    assert sidecar.stderr_text()
    sidecar.send(_request("stop-log-1", "shutdown", {}))
    assert sidecar.receive()["ok"] is True
    assert sidecar.process.wait(timeout=5) == 0
    assert list(sidecar.data_root.rglob("tuck.log"))


def test_subprocess_finishes_cleanly_after_stdin_eof(sidecar: SidecarProcess) -> None:
    assert sidecar.receive()["event"] == "backend_ready"
    assert sidecar.process.stdin is not None

    sidecar.process.stdin.close()

    assert sidecar.process.wait(timeout=5) == 0


def test_subprocess_preserves_correlation_when_a_later_request_finishes_first(
    tmp_path: Path,
) -> None:
    sidecar = SidecarProcess(
        tmp_path / "concurrent-data",
        [sys.executable, "-c", _CONCURRENT_SIDECAR_SCRIPT],
    )
    try:
        assert sidecar.receive()["event"] == "backend_ready"
        sidecar.send(_request("slow-first", "get_queue_state", {}))
        sidecar.send(_request("health-later", "health", {}))
        assert sidecar.process.stdin is not None
        sidecar.process.stdin.close()

        first = sidecar.receive()
        second = sidecar.receive()

        assert [first["id"], second["id"]] == ["health-later", "slow-first"]
        assert sidecar.process.wait(timeout=5) == 0
    finally:
        sidecar.close()


def test_subprocess_reports_a_safe_fatal_event_before_crash(tmp_path: Path) -> None:
    sidecar = SidecarProcess(
        tmp_path / "crashing-data",
        [sys.executable, "-c", _CRASHING_SIDECAR_SCRIPT],
    )
    try:
        assert sidecar.receive() == {
            "kind": "event",
            "protocol": 1,
            "event": "backend_fatal",
            "payload": {
                "code": "INTERNAL_ERROR",
                "message": "The backend could not start.",
                "details": {},
            },
        }
        assert sidecar.process.wait(timeout=5) == 1
    finally:
        sidecar.close()


def test_server_preserves_correlation_when_a_later_request_finishes_first() -> None:
    class BlockingApi:
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release = threading.Event()

        def get_queue_state(self) -> dict[str, object]:
            self.started.set()
            assert self.release.wait(timeout=5)
            return {"items": [], "current_id": None, "pending_ids": []}

    class Lifecycle:
        def __init__(self) -> None:
            self.api = BlockingApi()
            self.stopped = False

        def start(self) -> BlockingApi:
            return self.api

        def ready_event(self) -> Event:
            return Event(
                "backend_ready", {"backend_version": "0.4.0", "pid": 1, "capabilities": {}}
            )

        def shutdown(self) -> None:
            self.stopped = True

    class RecordingStdout(io.StringIO):
        def __init__(self) -> None:
            super().__init__()
            self.health_written = threading.Event()

        def write(self, value: str) -> int:
            result = super().write(value)
            if '"id":"health-later"' in value:
                self.health_written.set()
            return result

    lifecycle = Lifecycle()
    stdout = RecordingStdout()
    stdin = io.StringIO(
        "\n".join(
            [
                json.dumps(_request("slow-first", "get_queue_state", {}), separators=(",", ":")),
                json.dumps(_request("health-later", "health", {}), separators=(",", ":")),
                "",
            ]
        )
    )
    result: list[int] = []
    worker = threading.Thread(
        target=lambda: result.append(run_server(stdin, stdout, io.StringIO(), lifecycle))
    )
    worker.start()
    assert lifecycle.api.started.wait(timeout=5)
    assert stdout.health_written.wait(timeout=5)
    lifecycle.api.release.set()
    worker.join(timeout=5)

    frames = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert result == [0]
    assert lifecycle.stopped is True
    assert [frame.get("id") for frame in frames] == [None, "health-later", "slow-first"]


def test_server_reports_a_safe_fatal_event_when_startup_crashes() -> None:
    class CrashingLifecycle:
        def start(self) -> object:
            raise RuntimeError("secret startup path")

        def shutdown(self) -> None:
            pass

    stdout = io.StringIO()

    exit_code = run_server(io.StringIO(), stdout, io.StringIO(), CrashingLifecycle())

    assert exit_code == 1
    assert json.loads(stdout.getvalue()) == {
        "kind": "event",
        "protocol": 1,
        "event": "backend_fatal",
        "payload": {
            "code": "INTERNAL_ERROR",
            "message": "The backend could not start.",
            "details": {},
        },
    }


_NOISY_SIDECAR_SCRIPT = """
import os
import subprocess
import sys

import tuck.sidecar.__main__ as entry
from tuck.sidecar.protocol import Event
from tuck.sidecar.server import run_server


def noise(where):
    print(f"stray print {where}")
    os.write(1, f"native write {where}\\n".encode())
    # stdin stays closed to children: on Windows a child that inherits the request pipe
    # blocks at startup while the reader thread waits on it
    subprocess.run(
        [sys.executable, "-c", f"print('child process {where}')"],
        stdin=subprocess.DEVNULL,
        check=True,
    )


class Api:
    def get_queue_state(self):
        noise("in a handler")
        return {"items": [], "current_id": None, "pending_ids": []}


class Lifecycle:
    def start(self):
        noise("at startup")
        return Api()

    def ready_event(self):
        return Event("backend_ready", {"backend_version": "0.4.0", "pid": 1, "capabilities": {}})

    def shutdown(self):
        pass


def run_noisy(stdin, stdout, stderr):
    return run_server(stdin, stdout, stderr, Lifecycle())


entry.run_server = run_noisy
raise SystemExit(entry.main(["--protocol", "1"]))
"""


def test_subprocess_keeps_stray_stdout_writes_out_of_the_protocol(tmp_path: Path) -> None:
    sidecar = SidecarProcess(tmp_path / "noisy-data", [sys.executable, "-c", _NOISY_SIDECAR_SCRIPT])
    try:
        # receive() parses every stdout line, so any stray text there fails the test
        assert sidecar.receive(timeout=10)["event"] == "backend_ready"
        sidecar.send(_request("queue-1", "get_queue_state", {}))
        response = sidecar.receive(timeout=10)
        assert response["id"] == "queue-1"
        assert response["ok"] is True
        sidecar.send(_request("stop-1", "shutdown", {}))
        assert sidecar.receive()["id"] == "stop-1"
        assert sidecar.process.wait(timeout=5) == 0
        assert sidecar._stdout.get(timeout=5) is None
        stderr = sidecar.stderr_text()
        for where in ("at startup", "in a handler"):
            assert f"stray print {where}" in stderr
            assert f"native write {where}" in stderr
            assert f"child process {where}" in stderr
    finally:
        sidecar.close()


class _Lifecycle:
    def __init__(self, api: object) -> None:
        self.api = api

    def start(self) -> object:
        return self.api

    def ready_event(self) -> Event:
        return Event("backend_ready", {"backend_version": "0.4.0", "pid": 1, "capabilities": {}})

    def shutdown(self) -> None:
        pass


def _lines(*frames: dict[str, object]) -> io.StringIO:
    return io.StringIO("".join(json.dumps(f, separators=(",", ":")) + "\n" for f in frames))


def test_server_answers_an_oversized_reply_with_an_error_instead_of_breaking_the_stream() -> None:
    from tuck.sidecar.protocol import MAX_FRAME_BYTES

    class HugeApi:
        def get_queue_state(self) -> dict[str, object]:
            return {"items": ["x" * MAX_FRAME_BYTES], "current_id": None, "pending_ids": []}

    stdout = io.StringIO()
    stdin = _lines(_request("huge-1", "get_queue_state", {}), _request("health-1", "health", {}))

    assert run_server(stdin, stdout, io.StringIO(), _Lifecycle(HugeApi())) == 0

    lines = stdout.getvalue().splitlines()
    assert all(len(line.encode("utf-8")) <= MAX_FRAME_BYTES for line in lines)
    responses = {frame["id"]: frame for frame in map(json.loads, lines[1:])}
    assert responses["huge-1"]["ok"] is False
    assert responses["huge-1"]["error"]["code"] == "RESPONSE_TOO_LARGE"
    assert responses["health-1"]["ok"] is True


def test_server_keeps_answering_control_requests_while_media_work_is_busy() -> None:
    from tuck.sidecar.server import MEDIA_METHODS

    class SlowMediaApi:
        def __init__(self) -> None:
            self.release = threading.Event()

        def probe_file(self, path: str) -> dict[str, object]:
            assert self.release.wait(timeout=10)
            return {"ok": True, "data": {"path": path}}

        def get_thumbnail(self, path: str) -> dict[str, object]:
            assert self.release.wait(timeout=10)
            return {"ok": True, "thumbnail": ""}

        def get_queue_state(self) -> dict[str, object]:
            return {"items": [], "current_id": None, "pending_ids": []}

    class WatchingStdout(io.StringIO):
        def __init__(self, api: SlowMediaApi) -> None:
            super().__init__()
            self.api = api

        def write(self, value: str) -> int:
            written = super().write(value)
            if '"id":"queue-1"' in value:
                self.api.release.set()
            return written

    assert {"probe_file", "get_thumbnail"} <= MEDIA_METHODS
    api = SlowMediaApi()
    stdout = WatchingStdout(api)
    # a large import: far more slow media requests than there are workers
    media = [
        _request(f"{method}-{n}", method, {"path": f"C:/clip-{n}.mp4"})
        for n in range(6)
        for method in ("probe_file", "get_thumbnail")
    ]
    stdin = _lines(*media, _request("queue-1", "get_queue_state", {}))
    result: list[int] = []
    worker = threading.Thread(
        target=lambda: result.append(run_server(stdin, stdout, io.StringIO(), _Lifecycle(api)))
    )
    worker.start()
    worker.join(timeout=15)
    api.release.set()

    assert result == [0]
    ids = [frame.get("id") for frame in map(json.loads, stdout.getvalue().splitlines())]
    # the queue answer comes before any media work finishes, since it never waits behind it
    assert ids[1] == "queue-1"
    assert sorted(ids[2:]) == sorted(str(frame["id"]) for frame in media)
