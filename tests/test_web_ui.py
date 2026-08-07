from __future__ import annotations

import json
from pathlib import Path

from tuck.bridge_validation import validate_video_paths
from tuck.web_ui import (
    _bind_drag_drop,
    _get_resource_path,
    _JsApi,
    _native_hwnd,
    _response,
    _save_window_size,
    _window_size,
)


class _Bridge:
    def probe_file(self, path: str) -> str:
        return json.dumps({"ok": True, "path": path})

    def get_settings(self) -> str:
        return "not json"

    def get_ipc_files(self) -> str:
        return "[]"

    def get_ipc_metadata(self) -> str:
        return "{}"


class _DialogWindow:
    def __init__(self, result) -> None:
        self._result = result

    def create_file_dialog(self, *args, **kwargs):
        return self._result


class TestVideoPathValidation:
    def test_accepts_videos_in_order_and_deduplicates(self, tmp_path: Path) -> None:
        first = tmp_path / "first.mp4"
        second = tmp_path / "second.MKV"
        first.write_text("x")
        second.write_text("x")

        accepted, rejected = validate_video_paths([str(first), str(second), str(first.resolve())])

        assert accepted == [str(first.resolve()), str(second.resolve())]
        assert rejected == []

    def test_rejects_invalid_entries_without_rejecting_valid_videos(self, tmp_path: Path) -> None:
        video = tmp_path / "clip.mp4"
        text = tmp_path / "notes.txt"
        video.write_text("x")
        text.write_text("x")

        accepted, rejected = validate_video_paths(
            [str(video), str(text), str(tmp_path), str(tmp_path / "missing.mkv"), None]
        )

        assert accepted == [str(video.resolve())]
        assert len(rejected) == 4


class TestJsApi:
    def test_decodes_backend_json(self) -> None:
        api = _JsApi(_Bridge())

        assert api.probeFile("clip.mp4") == {"ok": True, "path": "clip.mp4"}

    def test_turns_invalid_backend_json_into_error(self) -> None:
        api = _JsApi(_Bridge())

        assert api.getSettings() == {"ok": False, "error": "Invalid backend response"}

    def test_file_picker_filters_to_existing_videos(self, tmp_path: Path) -> None:
        video = tmp_path / "clip.mp4"
        text = tmp_path / "notes.txt"
        video.write_text("x")
        text.write_text("x")
        api = _JsApi(_Bridge())
        api._window = _DialogWindow((str(video), str(text)))

        assert api.pickFiles() == {"ok": True, "files": [str(video.resolve())]}

    def test_file_picker_cancellation_is_empty_list(self) -> None:
        api = _JsApi(_Bridge())
        api._window = _DialogWindow(None)

        assert api.pickFiles() == {"ok": True, "files": []}

    def test_settings_preserves_profile_values_used_by_the_web_ui(
        self, tmp_path, monkeypatch
    ) -> None:
        import tuck.settings as settings_mod
        from tuck.bridge import BridgeAPI

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        settings_mod._settings_manager = None

        settings = _response(BridgeAPI().get_settings())

        assert isinstance(settings, dict)
        profile = settings["profiles"][0]
        assert profile["target_size_bytes"] > 0
        assert profile["audio_bitrate"] > 0
        assert isinstance(profile["keep_audio"], bool)
        assert settings["last_task"] == "compression"
        assert settings["left_sidebar_width"] == 240
        assert isinstance(settings["ffmpeg_available"], bool)
        assert isinstance(settings["ffprobe_available"], bool)

    def test_exposes_queue_management_methods(self) -> None:
        api = _JsApi(_Bridge())
        called: list[str] = []
        api._api.cancel_item = lambda item_id: called.append(item_id) or '{"ok": true}'
        api._api.retry_item = lambda item_id: called.append(item_id) or '{"ok": true}'
        api._api.stop_after_current = lambda: '{"ok": true}'

        assert api.cancelItem("first") == {"ok": True}
        assert api.retryItem("second") == {"ok": True}
        assert api.stopAfterCurrent() == {"ok": True}
        assert called == ["first", "second"]


def test_resource_path_locates_web_ui() -> None:
    assert _get_resource_path("tuck/web/index.html").is_file()


def test_native_hwnd_requires_real_handle() -> None:
    class Window:
        native = object()

    assert _native_hwnd(Window()) is None


def test_window_size_uses_defaults_and_clamps_invalid_values() -> None:
    class Settings:
        window_width = "invalid"
        window_height = 99999

    assert _window_size(Settings()) == (1240, 4320)


def test_saves_window_size_on_close() -> None:
    class Settings:
        window_width = 0
        window_height = 0

    class Window:
        width = 1400
        height = 900

    class Manager:
        saved = False

        def save(self) -> None:
            self.saved = True

    settings = Settings()
    manager = Manager()
    _save_window_size(settings, Window(), manager)

    assert (settings.window_width, settings.window_height) == (1400, 900)
    assert manager.saved


def test_response_rejects_scalar_json() -> None:
    assert _response('"unexpected"') == {"ok": False, "error": "Invalid backend response"}


def test_drop_binding_targets_the_html_element() -> None:
    class Element:
        def __init__(self) -> None:
            self.events: list[str] = []

        def on(self, event: str, callback) -> None:
            self.events.append(event)

    class Dom:
        def __init__(self) -> None:
            self.element = Element()

        def get_element(self, selector: str):
            assert selector == "html"
            return self.element

    class Window:
        def __init__(self) -> None:
            self.dom = Dom()

    window = Window()
    _bind_drag_drop(window)

    assert window.dom.element.events == ["dragenter", "dragstart", "dragover", "drop"]


def test_clip_cards_use_icon_statuses_and_compact_metadata() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert 'role="img"' in html
    assert "label=state[0]+(st==='failed'&&c._queueError?': '+c._queueError:'')" in html
    assert '<span class="c-error">' in html
    assert "Failed to process \"'+esc(clip.name)+'\": '+esc(errorSummary(item.error))" in html
    assert "flex-wrap:wrap" in html
    assert "completed:['Completed','✓','cst-completed']" in html


def test_profile_editor_uses_shared_encoder_rules() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "function peRateControls()" in html
    assert "function nativePresets(enc)" in html
    assert "function isCpuEncoder(enc)" in html
    assert "rate_control:task==='upscale'" in html
    assert "?'explicit_bitrate':'target_size'" in html


def test_settings_uses_stable_shell_and_required_pages() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "settings-modal" in html
    assert "['general','General'],['profiles','Profiles']" in html
    assert "['explorer','Explorer integration'],['system','System']" in html
    assert "height:min(650px,calc(100vh - 24px))" in html
    assert "function profileEditorHTML()" in html
    assert "Discard unsaved profile changes?" in html
    assert "function closeActiveModal()" in html


def test_queue_filename_and_sendto_copy_match_the_requested_design() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "#qfname { color:#7a7a8c; font-size:11px; font-family:var(--mono);" in html
    assert "#btn-clear, #btn-cancel" in html
    assert "font-family:var(--mono);" in html
    assert "Explorer integration" in html
    assert "for more handy processing." not in html


def test_settings_file_naming_and_subsection_navigation_use_shared_layout() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert ".file-naming { background:var(--card-bg);" in html
    assert "grid-template-columns:repeat(2,minmax(0,1fr))" in html
    assert ".file-naming .settings-field { background:var(--input-bg);" in html
    assert ".file-naming .settings-field input { background:var(--input-bg);" in html
    assert "font:13px var(--font);" in html
    assert ".settings-actions .btn1, .settings-actions .btn2" in html
    assert "min-height:34px;" in html
    assert "function settingsTitle(title, action)" in html
    assert "Back to profiles" not in html
    assert "button.mrow { font:inherit; text-align:left; width:100%; }" in html
    assert "settingsTitle('Add shortcut',\"openSettings('explorer')\")" in html
