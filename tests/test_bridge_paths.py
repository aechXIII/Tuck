import json

import pytest

from tuck.bridge import BridgeAPI


class TestBridgePathValidation:
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
        resp = json.loads(api.probe_file(str(tmp_path / "no_such_file.mp4")))
        assert not resp["ok"]
        assert "error" in resp

    def test_probe_file_rejects_empty_path(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        resp = json.loads(api.probe_file(""))
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

        payload = json.dumps({"source": str(tmp_path / "ghost.mp4"), "profile_id": "discord-10mb"})
        resp = json.loads(api.enqueue_with_options(payload))
        assert not resp["ok"]
        assert "error" in resp

    def test_enqueue_batch_rejects_all_invalid(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = json.dumps(
            [
                {"source": str(tmp_path / "a.mp4"), "profile_id": "discord-10mb"},
                {"source": str(tmp_path / "b.mp4"), "profile_id": "discord-10mb"},
            ]
        )
        resp = json.loads(api.enqueue_batch(payload))
        assert not resp["ok"]
        assert "No files could be enqueued" in resp["error"]

    def test_create_plan_rejects_nonexistent_source(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = json.dumps({"source": str(tmp_path / "ghost.mp4"), "profile_id": "discord-10mb"})
        resp = json.loads(api.create_plan(payload))
        assert not resp["ok"]
        assert "error" in resp
