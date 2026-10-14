from dataclasses import replace

import pytest

from tuck.bridge import BridgeAPI
from tuck.media_server import MediaServer
from tuck.models import VideoInfo


@pytest.fixture
def audio_preview_api(tmp_path, monkeypatch):
    import tuck.settings as settings_mod

    monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
    monkeypatch.setattr("tuck.bridge.get_media_server", MediaServer)
    api = BridgeAPI()
    source = tmp_path / "two tracks.mkv"
    source.write_bytes(b"video")
    info = VideoInfo(str(source), 1.0, 320, 240, 25.0, "h264", has_audio=True)
    monkeypatch.setattr(api, "_probe_once", lambda _path: replace(info, audio_stream_count=2))
    return api, source


def test_media_url_serves_the_requested_audio_track(audio_preview_api, tmp_path, monkeypatch):
    api, source = audio_preview_api
    preview = tmp_path / "track.m4a"
    preview.write_bytes(b"audio")
    asked = []
    monkeypatch.setattr(
        api._media_server,
        "generate_audio_preview",
        lambda path, *, track: asked.append((path, track)) or str(preview),
        raising=False,
    )
    response = api.get_media_url(str(source), track=1)
    assert response["ok"] is True
    assert asked == [(str(source.resolve()), 1)]
    assert api._media_server._tokens[response["token"]] == str(preview)


@pytest.mark.parametrize("track", [-1, True, "1", 1.5, 2])
def test_media_url_rejects_invalid_or_missing_audio_track(audio_preview_api, track):
    api, source = audio_preview_api
    response = api.get_media_url(str(source), track=track)
    assert response["ok"] is False


def test_audio_preview_failure_never_falls_back_to_default_track(audio_preview_api, monkeypatch):
    api, source = audio_preview_api
    monkeypatch.setattr(
        api._media_server, "generate_audio_preview", lambda *_args, **_kw: None, raising=False
    )
    response = api.get_media_url(str(source), track=0)
    assert response["ok"] is False
    assert "audio track 1" in response["error"]
