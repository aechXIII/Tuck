from __future__ import annotations

import re
from pathlib import Path

from tuck.bridge import BridgeAPI
from tuck.bridge_validation import AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, validate_video_paths


class TestVideoPathExtraction:
    def test_accepts_existing_video_files(self, tmp_path) -> None:
        first = tmp_path / "first.mp4"
        second = tmp_path / "second.mkv"
        first.write_text("a")
        second.write_text("b")

        accepted, rejected = validate_video_paths([str(first), str(second)])

        assert accepted == [str(first.resolve()), str(second.resolve())]
        assert rejected == []

    def test_accepts_the_containers_lossless_cut_keeps(self, tmp_path) -> None:
        videos = [tmp_path / f"clip.{ext}" for ext in ("ts", "M2TS", "mts", "3gp", "ogv")]
        for video in videos:
            video.write_text("a")

        accepted, rejected = validate_video_paths([str(video) for video in videos])

        assert accepted == [str(video.resolve()) for video in videos]
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

        files = api.get_ipc_files()
        assert len(files) == 3
        assert "C:\\videos\\a.mp4" in files

    def test_clear_after_get(self, tmp_path, monkeypatch) -> None:
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api.add_ipc_files(["C:\\videos\\x.mp4"])
        assert api.get_ipc_files() == ["C:\\videos\\x.mp4"]
        assert api.get_ipc_files() == []

    def test_metadata_replaces_previous_value(self, tmp_path, monkeypatch) -> None:
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api.add_ipc_metadata({"profile_id": "discord-10mb", "action": "review"})

        assert api.get_ipc_metadata() == {
            "profile_id": "discord-10mb",
            "action": "review",
        }
        assert api.get_ipc_metadata() == {}


ROOT = Path(__file__).resolve().parents[1]


def _rust_extensions(name: str) -> set[str]:
    source = (ROOT / "src-tauri/src/commands/native.rs").read_text(encoding="utf-8")
    match = re.search(rf"const {name}: &\[&str\] = &\[(.*?)\];", source, re.DOTALL)
    assert match is not None, name
    return {f".{extension}" for extension in re.findall(r'"([a-z0-9]+)"', match.group(1))}


def test_file_pickers_offer_exactly_the_files_tuck_serves() -> None:
    assert _rust_extensions("VIDEO_EXTENSIONS") == VIDEO_EXTENSIONS
    assert _rust_extensions("AUDIO_EXTENSIONS") == AUDIO_EXTENSIONS


def test_drop_routing_sends_exactly_the_served_audio_files_to_the_audio_panel() -> None:
    source = (ROOT / "frontend/src/features/editor/drop-routing.ts").read_text(encoding="utf-8")
    match = re.search(r"AUDIO_DROP_EXTENSIONS = new Set\(\[(.*?)\]\)", source, re.DOTALL)
    assert match is not None
    assert set(re.findall(r'"(\.[a-z0-9]+)"', match.group(1))) == AUDIO_EXTENSIONS


def test_every_served_file_type_has_a_content_type() -> None:
    import importlib
    import mimetypes

    # the media server registers the types it serves when it is imported
    importlib.import_module("tuck.media_server")
    for extension in VIDEO_EXTENSIONS | AUDIO_EXTENSIONS:
        assert mimetypes.guess_type(f"clip{extension}")[0], extension
