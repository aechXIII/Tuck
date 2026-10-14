import io
import json
import threading

from tuck.sidecar.protocol import Event
from tuck.sidecar.server import run_server


def test_raw_media_urls_stay_responsive_while_audio_preview_workers_are_busy():
    class Api:
        def __init__(self):
            self.lock = threading.Lock()
            self.busy = 0
            self.all_busy = threading.Event()
            self.release = threading.Event()
            self.track_started = threading.Event()

        def get_waveform(self, path, track=0):
            with self.lock:
                self.busy += 1
                if self.busy == 4:
                    self.all_busy.set()
            assert self.release.wait(timeout=5)
            return {"ok": True, "url": path}

        def get_media_url(self, path, track=None):
            if track is not None:
                self.track_started.set()
            return {"ok": True, "url": path}

    api = Api()

    class Lifecycle:
        def start(self):
            return api

        def ready_event(self):
            return Event("backend_ready", {})

        def shutdown(self):
            pass

    raw_received = threading.Event()

    class Output(io.StringIO):
        def write(self, value):
            result = super().write(value)
            if '"id":"raw"' in value:
                raw_received.set()
            return result

    def frame(request_id, method, params):
        return (
            json.dumps(
                {
                    "kind": "request",
                    "protocol": 1,
                    "id": request_id,
                    "method": method,
                    "params": params,
                }
            )
            + "\n"
        )

    def requests():
        for index in range(4):
            yield frame(f"wave-{index}", "get_waveform", {"path": "clip.mkv"})
        assert api.all_busy.wait(timeout=3)
        yield frame("track", "get_media_url", {"path": "clip.mkv", "track": 1})
        yield frame("raw", "get_media_url", {"path": "clip.mkv"})

    output = Output()
    result = []
    worker = threading.Thread(
        target=lambda: result.append(run_server(requests(), output, io.StringIO(), Lifecycle()))
    )
    worker.start()
    try:
        assert raw_received.wait(timeout=3)
        assert not api.track_started.is_set()
    finally:
        api.release.set()
        worker.join(timeout=5)
    assert result == [0]
    assert api.track_started.is_set()
    frames = [json.loads(line) for line in output.getvalue().splitlines()]
    assert next(frame for frame in frames if frame.get("id") == "raw")["ok"] is True
