import wave

import pytest

from tuck.bridge import BridgeAPI
from tuck.media_tools import find_ffprobe
from tuck.probe import FILE_MISSING_MESSAGE, NO_VIDEO_MESSAGE, UNREADABLE_MESSAGE


class TestBridgePathValidation:
    def test_storage_paths_are_reported_by_the_python_settings_owner(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        config = tmp_path / "config"
        data = tmp_path / "data"
        cache = tmp_path / "cache"
        monkeypatch.setattr(settings_mod, "_config_dir", lambda: config)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: data)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: cache)

        result = BridgeAPI().get_storage_paths()

        assert result == {
            "ok": True,
            "config_dir": str(config),
            "data_dir": str(data),
            "cache_dir": str(cache),
            "log_dir": str(data / "logs"),
        }

    def test_validate_path_accepts_real_file(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        f = tmp_path / "real.mp4"
        f.write_text("dummy")

        api = BridgeAPI()
        result = api._validate_path(str(f))
        assert result == str(f.resolve())

    def test_validate_path_rejects_empty(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        with pytest.raises(ValueError, match="empty or not a string"):
            api._validate_path("")

    def test_validate_path_rejects_none(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        with pytest.raises(ValueError, match="empty or not a string"):
            api._validate_path(None)  # type: ignore[arg-type]

    def test_validate_path_rejects_nonexistent(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        with pytest.raises(FileNotFoundError, match="File not found"):
            api._validate_path(str(tmp_path / "nonexistent.mp4"))

    def test_validate_path_rejects_directory(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        with pytest.raises(FileNotFoundError, match="File not found"):
            api._validate_path(str(tmp_path))

    def test_probe_file_rejects_invalid_path(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        resp = api.probe_file(str(tmp_path / "no_such_file.mp4"))
        assert not resp["ok"]
        assert "error" in resp

    def test_probe_file_rejects_empty_path(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        resp = api.probe_file("")
        assert not resp["ok"]
        assert "error" in resp


class TestBridgeDragDropSafety:
    def test_enqueue_with_options_rejects_invalid_source(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = {"source": str(tmp_path / "ghost.mp4"), "profile_id": "discord-10mb"}
        resp = api.enqueue_with_options(payload)
        assert not resp["ok"]
        assert "error" in resp

    def test_enqueue_batch_rejects_all_invalid(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = [
            {"source": str(tmp_path / "a.mp4"), "profile_id": "discord-10mb"},
            {"source": str(tmp_path / "b.mp4"), "profile_id": "discord-10mb"},
        ]

        resp = api.enqueue_batch(payload)
        assert not resp["ok"]
        assert "No files could be enqueued" in resp["error"]

    def test_create_plan_rejects_nonexistent_source(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = {"source": str(tmp_path / "ghost.mp4"), "profile_id": "discord-10mb"}
        resp = api.create_plan(payload)
        assert not resp["ok"]
        assert "error" in resp


class TestUnreadableFilesInPlainWords:
    @pytest.fixture
    def api(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path / "config")
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path / "data")
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path / "cache")
        if not find_ffprobe():
            pytest.skip("ffprobe is needed to read the files")
        return BridgeAPI()

    def test_a_damaged_file_says_it_cant_be_read(self, api, tmp_path):
        source = tmp_path / "broken.mp4"
        source.write_bytes(b"not a video at all" * 64)

        assert api.probe_file(str(source)) == {"ok": False, "error": UNREADABLE_MESSAGE}

    def test_a_file_without_video_says_so(self, api, tmp_path):
        source = tmp_path / "voice.wav"
        with wave.open(str(source), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\0\0" * 8000)

        assert api.probe_file(str(source)) == {"ok": False, "error": NO_VIDEO_MESSAGE}

    def test_a_missing_file_says_it_moved(self, api, tmp_path):
        result = api.probe_file(str(tmp_path / "gone.mp4"))

        assert result == {"ok": False, "error": FILE_MISSING_MESSAGE, "code": "invalid_path"}
