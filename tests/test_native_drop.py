from __future__ import annotations

import json

from tuck.bridge import BridgeAPI
from tuck.bridge_validation import validate_video_paths


class TestVideoPathExtraction:
    def test_accepts_existing_video_files(self, tmp_path) -> None:
        first = tmp_path / "first.mp4"
        second = tmp_path / "second.mkv"
        first.write_text("a")
        second.write_text("b")

        accepted, rejected = validate_video_paths([str(first), str(second)])

        assert accepted == [str(first.resolve()), str(second.resolve())]
        assert rejected == []

    def test_rejects_non_video_missing_files_and_directories(self, tmp_path) -> None:
        video = tmp_path / "clip.mp4"
        text = tmp_path / "notes.txt"
        video.write_text("a")
        text.write_text("b")

        accepted, rejected = validate_video_paths(
            [str(video), str(text), str(tmp_path), str(tmp_path / "ghost.mkv")]
        )

        assert accepted == [str(video.resolve())]
        assert len(rejected) == 3

    def test_deduplicates_equivalent_paths(self, tmp_path) -> None:
        video = tmp_path / "clip.mp4"
        video.write_text("a")

        accepted, rejected = validate_video_paths([str(video), str(video.resolve())])

        assert accepted == [str(video.resolve())]
        assert rejected == []


class TestAddIpcFiles:
    def test_adds_paths_and_deduplicates(self, tmp_path, monkeypatch) -> None:
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api.add_ipc_files(["C:\\videos\\a.mp4", "C:\\videos\\b.mkv"])
        api.add_ipc_files(["C:\\videos\\a.mp4", "C:\\videos\\c.avi"])

        files = json.loads(api.get_ipc_files())
        assert len(files) == 3
        assert "C:\\videos\\a.mp4" in files

    def test_clear_after_get(self, tmp_path, monkeypatch) -> None:
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api.add_ipc_files(["C:\\videos\\x.mp4"])
        assert json.loads(api.get_ipc_files()) == ["C:\\videos\\x.mp4"]
        assert json.loads(api.get_ipc_files()) == []

    def test_metadata_replaces_previous_value(self, tmp_path, monkeypatch) -> None:
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api.add_ipc_metadata({"profile_id": "discord-10mb", "action": "review"})

        assert json.loads(api.get_ipc_metadata()) == {
            "profile_id": "discord-10mb",
            "action": "review",
        }
        assert json.loads(api.get_ipc_metadata()) == {}
