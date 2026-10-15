import subprocess
from urllib.request import urlopen

import pytest

from tuck.bridge import BridgeAPI
from tuck.media_server import MediaServer
from tuck.media_tools import find_ffmpeg
from tuck.request_work import RequestWork
from tuck.sidecar.handlers import dispatch
from tuck.sidecar.protocol import Request


@pytest.fixture
def api(tmp_path, monkeypatch):
    import tuck.settings as settings

    for name in ("_config_dir", "_data_dir", "_cache_dir"):
        monkeypatch.setattr(settings, name, lambda: tmp_path)
    monkeypatch.setattr("tuck.bridge.get_media_server", MediaServer)
    return BridgeAPI()


@pytest.mark.parametrize(
    "field,value",
    [
        ("path", 1),
        ("path", "missing.mp4"),
        ("start", -1),
        ("start", float("nan")),
        ("step", float("inf")),
        ("step", True),
        ("count", 33),
        ("count", 1.5),
        ("mode", []),
        ("exact", 1),
    ],
)
def test_bridge_validates_untrusted_timeline_fields(api, tmp_path, field, value):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"bad")
    assert hasattr(api, "get_timeline_frames"), "timeline bridge is missing"
    params = {
        "path": str(source),
        "start": 0,
        "step": 1,
        "count": 16,
        "mode": "center",
        "exact": False,
    }
    params[field] = value
    assert api.get_timeline_frames(**params)["ok"] is False


def test_sidecar_accepts_timeline_requests_and_rejects_extra_fields(api, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"bad")
    params = {
        "path": str(source),
        "start": 0,
        "step": 1,
        "count": 16,
        "mode": "center",
        "exact": False,
    }
    result = dispatch(api, Request("timeline", "get_timeline_frames", params))
    assert result.error.code != "UNKNOWN_METHOD"
    for field, value in [("extra", 1), ("exact", "false"), ("mode", "other"), ("start", True)]:
        invalid = dispatch(
            api, Request("timeline", "get_timeline_frames", {**params, field: value})
        )
        assert invalid.error.code == "INVALID_REQUEST"


def test_bridge_returns_token_served_geometry_and_releases_the_result(api, tmp_path):
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is required for timeline bridge fixture")
    source = tmp_path / "clip.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=10:duration=1",
            "-c:v",
            "libx264",
            "-y",
            str(source),
        ],
        check=True,
    )
    api._media_server.start()
    try:
        result = api.get_timeline_frames(str(source), 0.5, 0.25, 16, "center", False)
        assert result["ok"] is True
        assert {
            key: result[key]
            for key in ("start", "step", "count", "columns", "tile_width", "tile_height")
        } == {
            "start": 0.5,
            "step": 0.25,
            "count": 2,
            "columns": 2,
            "tile_width": 150,
            "tile_height": 84,
        }
        with urlopen(result["url"], timeout=3) as response:
            assert response.read(8) == b"\x89PNG\r\n\x1a\n"
        api.release_media_token(result["token"])
        assert result["token"] not in api._media_server._tokens
    finally:
        api._media_server.stop()


def test_cancelled_timeline_request_uses_the_protocol_timeout_error(api, tmp_path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    work = RequestWork()
    work.set()
    response = dispatch(
        api,
        Request(
            "timeline",
            "get_timeline_frames",
            {
                "path": str(source),
                "start": 0,
                "step": 1,
                "count": 16,
                "mode": "whole",
                "exact": False,
            },
        ),
        work,
    )
    assert response.error.code == "BACKEND_TIMEOUT"
