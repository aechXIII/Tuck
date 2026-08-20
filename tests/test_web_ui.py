from __future__ import annotations

import json
from pathlib import Path

from tuck.bridge_validation import validate_audio_paths, validate_video_paths
from tuck.web_ui import (
    _bind_drag_drop,
    _get_resource_path,
    _JsApi,
    _native_hwnd,
    _response,
    _save_window_size,
    _window_size,
)


def _web_source() -> str:
    web_dir = Path("tuck/web")
    return "\n".join(path.read_text(encoding="utf-8") for path in web_dir.iterdir())


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

    def test_audio_validation_accepts_supported_audio_only(self, tmp_path: Path) -> None:
        audio = tmp_path / "music.FLAC"
        video = tmp_path / "clip.mp4"
        audio.write_text("x")
        video.write_text("x")

        accepted, rejected = validate_audio_paths([str(audio), str(video)])

        assert accepted == [str(audio.resolve())]
        assert rejected == [str(video)]


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

    def test_audio_picker_filters_to_existing_audio_files(self, tmp_path: Path) -> None:
        audio = tmp_path / "music.mp3"
        text = tmp_path / "notes.txt"
        audio.write_text("x")
        text.write_text("x")
        api = _JsApi(_Bridge())
        api._window = _DialogWindow((str(audio), str(text)))

        assert api.pickAudioFiles() == {"ok": True, "files": [str(audio.resolve())]}

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
        assert settings["encoder_cache_days"] == 7

    def test_exposes_queue_management_methods(self) -> None:
        api = _JsApi(_Bridge())
        called: list[str] = []
        api._api.cancel_item = lambda item_id: called.append(item_id) or '{"ok": true}'
        api._api.retry_item = lambda item_id: called.append(item_id) or '{"ok": true}'
        api._api.stop_after_current = lambda: '{"ok": true}'
        api._api.move_item = lambda item_id, new_index: (
            called.append(f"{item_id}:{new_index}") or '{"ok": true}'
        )
        api._api.get_diagnostics = lambda context_json="{}": '{"ok": true, "text": "diag"}'
        api._api.copy_text = lambda text: called.append(f"copy:{len(text)}") or '{"ok": true}'
        api._api.open_logs_folder = lambda: called.append("logs") or '{"ok": true}'
        api._api.open_config_folder = lambda: called.append("config") or '{"ok": true}'

        assert api.cancelItem("first") == {"ok": True}
        assert api.retryItem("second") == {"ok": True}
        assert api.stopAfterCurrent() == {"ok": True}
        assert api.moveItem("third", 1) == {"ok": True}
        assert api.getDiagnostics("{}") == {"ok": True, "text": "diag"}
        assert api.copyText("hello") == {"ok": True}
        assert api.openLogsFolder() == {"ok": True}
        assert api.openConfigFolder() == {"ok": True}
        assert called == ["first", "second", "third:1", "copy:5", "logs", "config"]

    def test_exports_one_profile_through_the_bridge(self) -> None:
        api = _JsApi(_Bridge())
        called: list[tuple[str, str]] = []
        api._api.export_profile_to_file = lambda path, profile_id: (
            called.append((path, profile_id)) or '{"ok": true}'
        )

        assert api.exportProfileToFile("gaming.json", "gaming") == {"ok": True}
        assert called == [("gaming.json", "gaming")]

    def test_ffmpeg_picker_returns_selected_executable(self, tmp_path: Path) -> None:
        executable = tmp_path / "ffmpeg.exe"
        executable.write_text("x")
        api = _JsApi(_Bridge())
        api._window = _DialogWindow(str(executable))

        assert api.pickFfmpegFile() == {"ok": True, "path": str(executable)}
        assert api.pickFfprobeFile() == {"ok": True, "path": str(executable)}


def test_support_folder_opener_creates_and_opens_directory(tmp_path, monkeypatch) -> None:
    import subprocess

    from tuck.bridge import BridgeAPI

    opened: list[list[str]] = []
    monkeypatch.setattr(
        subprocess,
        "Popen",
        lambda args, creationflags=0: opened.append(args),
    )

    folder = tmp_path / "logs"
    response = json.loads(BridgeAPI._open_app_folder(folder))

    assert response == {"ok": True, "path": str(folder)}
    assert folder.is_dir()
    assert opened == [["explorer", str(folder)]]


def test_resource_path_locates_web_ui() -> None:
    for name in (
        "index.html",
        "styles.css",
        "settings.css",
        "player.css",
        "audio.css",
        "queue.css",
        "transform.css",
        "app.js",
        "audio.js",
        "encoding-ui.js",
        "history.js",
        "layout.js",
        "panels.js",
        "segments.js",
        "player.js",
        "queue.js",
        "settings.js",
        "settings-state.js",
        "crop.js",
        "transform.js",
    ):
        assert _get_resource_path(f"tuck/web/{name}").is_file()


def test_profile_settings_export_individual_profiles() -> None:
    source = Path("tuck/web/settings.js").read_text(encoding="utf-8")

    assert "api.exportProfileToFile(r.path, pid)" in source
    assert 'settingButton("Export", "exportProfs()")' not in source


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


def test_drop_reports_unresolvable_paths_as_rejected() -> None:
    evaluated: list[str] = []

    class Element:
        def __init__(self) -> None:
            self.handlers: dict[str, object] = {}

        def on(self, event: str, handler) -> None:
            self.handlers[event] = handler

    class Dom:
        def __init__(self) -> None:
            self.element = Element()

        def get_element(self, selector: str):
            return self.element

    class Window:
        def __init__(self) -> None:
            self.dom = Dom()

        def evaluate_js(self, script: str) -> None:
            evaluated.append(script)

    window = Window()
    _bind_drag_drop(window)

    on_drop = window.dom.element.handlers["drop"].callback
    on_drop({"dataTransfer": {"files": [{"pywebviewFullPath": None}]}})

    assert evaluated == ['window.addFiles([], ["None"])']


def test_clip_cards_use_icon_statuses_and_compact_metadata() -> None:
    html = _web_source()

    assert 'role="img"' in html
    assert "function clipStateBadge(p)" in html
    assert 'st === "failed" && c._queueError' in html
    assert '<span class="c-error">' in html
    assert '"Finished: " + esc(clip.name)' in html
    assert "appSettings.clear_completed_automatically" in html
    assert 'Failed to process "' in html
    assert "esc(errorSummary(item.error))" in html
    assert "flex-wrap: wrap" in html
    assert 'completed: ["Completed", "✓", "cst-completed"]' in html
    assert "function formatQueueStatus(item)" in html
    assert "function copyDiagnostics" in html
    assert "function beginClipReorder" in html
    assert "Open folder" in html
    assert "c-status-row" in html
    assert "clipReorder" in html
    assert "c-act link" in html
    assert "function cancelQueueItem(itemId)" in html
    assert "cancelQueueItem('" in html
    assert "function clearDone()" in html
    assert 'clips[p]._queueState === "completed"' in html
    assert ">Rescan</button>" in html
    assert "saveSystemSettings()" in html
    assert 'aria-label="Close settings"' in html
    assert 'settingButton("Save changes", "saveSystemSettings()", true, true)' in html
    assert '"Last checked: " + esc(s.last_update_check)' in html
    assert 'class="settings-readonly"' in html
    assert "Clear completed jobs automatically" in html
    assert 'onclick="clearOut()"' in html
    assert 'onclick="clearFfmpeg()"' in html
    assert 'onclick="clearFfprobe()"' in html
    assert 'st === "running" || st === "processing" || st === "pending"' in html
    assert 'id="btn-diag"' not in html


def test_queue_action_buttons_share_secondary_style() -> None:
    html = _web_source()

    assert "#btn-stop-after," in html
    assert "#btn-clear," in html
    assert "#btn-cancel" in html


def test_trim_handles_keep_the_resize_cursor_while_dragging() -> None:
    html = _web_source()

    assert ".tl-handle {" in html
    assert "cursor: ew-resize;" in html
    assert "body.tl-trim-dragging *" in html
    assert "cursor: ew-resize !important;" in html
    assert "setTrimDragCursor(true);" in html
    assert "setTrimDragCursor(false);" in html


def test_segment_editor_controls_payloads_and_accessibility_are_wired() -> None:
    html = _web_source()

    assert 'id="tl-segments"' in html
    assert 'id="timeline-row"' in html
    assert 'aria-label="Segment actions"' in html
    assert 'id="segment-menu-toggle"' not in html
    assert 'id="segment-popover"' not in html
    assert 'aria-label="Active segment start"' in html
    assert 'aria-label="Active segment end"' in html
    assert 'aria-label="Add segment"' in html
    assert 'aria-label="Remove active segment"' in html
    assert 'aria-label="Reset segments to full source"' in html
    assert "function addSegment()" in html
    assert "function removeActiveSegment()" in html
    assert "SegmentEditing.canAddSegment" in html
    assert "SegmentEditing.moveSegment" in html
    assert 'range.style.setProperty("--segment-color", segmentColor(i))' in html
    assert "body.tl-segment-dragging *" in html
    assert "cursor: grabbing !important;" in html
    assert '_tlDrag = "segment-pending"' in html
    assert "_SEGMENT_DRAG_THRESHOLD = 5" in html
    assert 'range.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight")' in html
    assert '". Click to seek; drag to move"' in html
    assert "range.title" not in html
    assert 'timeLabel.className = "tl-segment-time"' in html
    assert "formatSegmentTime(segments[i].start)" in html
    assert ".tl-segment:hover .tl-segment-time" in html
    assert "#timeline.segment-dragging .tl-segment.active .tl-segment-time" in html
    assert "#timeline.trim-dragging .tl-segment.active .tl-segment-time" in html
    assert "resetButton.disabled = !has" in html
    assert 'resetButton.classList.toggle("hid", !has)' in html
    assert "SegmentEditing.playbackTarget" in html
    assert "req.segments = SegmentEditing.segmentsForClip" in html
    assert "r.data.segment_count" in html
    assert "ctx.selected_duration" in html


def test_profile_editor_uses_shared_encoder_rules() -> None:
    html = _web_source()

    assert "function peRateControls()" in html
    assert "function nativePresets(enc)" in html
    assert html.count("function isCpuEncoder(enc)") == 1
    assert 'auto_compression: "Auto (best compression)"' in html
    assert 'auto_fast: "Auto (fastest available)"' in html
    assert "function isAutoEncoder(enc)" in html
    assert 'byId("preset-sel").value = "veryslow"' in html
    assert 'byId("pe-preset").value = "veryslow"' in html
    assert "!isAutoEncoder(id)" in html
    assert "availEncoders.length" in html
    assert "set-encoder-cache-days" in html
    assert "refreshEncoders()" in html
    assert 'enc === "libx265" || enc === "auto_compression"' in html
    assert 'twoPassEligible(task, byId("pe-enc").value)' in html
    assert '!isAutoEncoder(byId("pe-enc").value)' in html
    assert 'task === "upscale" && (rc === "cbr" || rc === "vbr")' in html
    assert '? "explicit_bitrate"' in html
    assert ': "target_size"' in html


def test_settings_uses_compact_modal_and_grouped_navigation() -> None:
    html = _web_source()

    assert 'id="settings-workspace"' in html
    assert 'class="settings-dialog"' in html
    assert 'role="dialog"' in html
    assert 'aria-modal="true"' in html
    assert ".settings-workspace {" in html
    assert "width: min(860px, calc(100vw - 24px));" in html
    assert ".settings-nav-group {" in html
    assert "flex-direction: column;" in html
    assert ".settings-nav-group + .settings-nav-group {" in html
    assert ".settings-tabs button {" in html
    assert ">Preferences</div>" in html
    assert "Output &amp; naming" in html
    assert ">Library</div>" in html
    assert ">Integrations</div>" in html
    assert ">Support</div>" in html
    assert "Windows integration" in html
    assert "System &amp; support" in html
    assert "function toggleSettings()" in html
    assert "function profileEditorHTML()" in html
    assert "Discard unsaved profile changes?" in html
    assert "function closeActiveModal()" in html


def test_queue_filename_and_sendto_copy_match_the_requested_design() -> None:
    html = _web_source()

    assert "#qfname {" in html
    assert "font-size: 11px;" in html
    assert "#btn-clear," in html
    assert "#btn-cancel" in html
    assert "font-family: var(--mono);" in html
    assert "Windows integration" in html
    assert "for more handy processing." not in html


def test_settings_file_naming_and_subsection_navigation_use_shared_layout() -> None:
    html = _web_source()

    assert ".file-naming {" in html
    assert "background: transparent;" in html
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in html
    assert ".file-naming .settings-field {" in html
    assert ".file-naming .settings-field input {" in html
    assert "background: var(--input-bg);" in html
    assert "font: 13px var(--font);" in html
    assert ".settings-actions .btn1," in html
    assert ".settings-actions .btn2" in html
    assert "min-height: 34px;" in html
    assert "function settingsTitle(title, action)" in html
    assert "Back to profiles" not in html
    assert "button.mrow {" in html
    assert "font: inherit;" in html
    assert 'settingsTitle("Add shortcut", "openSettings(\'explorer\')")' in html


def test_settings_separates_output_and_stages_all_persisted_changes() -> None:
    html = _web_source()

    assert "function outputSettingsHTML(s)" in html
    assert "function saveOutputSettings()" in html
    assert 'id="ex-up-out"' in html
    assert "function markSettingsDirty()" in html
    assert 'clear_completed_automatically: byId("set-auto-clear").checked' in html
    assert 'id="set-open-output-folder"' in html
    assert 'open_output_folder_after_queue: byId("set-open-output-folder").checked' in html
    assert "queueCompletionOutput(" in html
    assert "queueActiveItemIds" in html
    assert "appSettings.open_output_folder_after_queue" in html
    assert 'confirmToast("Discard unsaved settings?"' in html
    assert 'box.className = "mod-box confirm-dialog"' in html
    assert "Discard changes" in html
    assert "Keep editing" in html
    assert "function acceptConfirm()" in html
    assert "_confirmCbs" not in html
    assert "Advanced system settings" in html
    assert 'class="settings-topbar"' in html
    assert 'id="settings-heading"' not in html
    assert "var settingsMeta" not in html
    assert 'row.className = "settings-list-row"' in html
    assert 'class="settings-status-table"' in html
    assert "function insertNamingToken(id, token)" in html
    assert "function openSupportFolder(kind)" in html
    assert "Open logs folder" in html
    assert "Open configuration folder" in html
    assert ".settings-status-row {" in html
    assert "display: grid;" in html
    assert 'class="profile-actions-menu"' in html
    assert 'class="profile-actions-popover"' in html
    assert 'class="settings-profile-filterbar"' in html
    assert ".profile-filters {" in html
    assert "width: 100%;" in html
    assert ".profile-filters button {" in html
    assert "flex: 1 1 0;" in html
    assert 'aria-label="Filter profiles"' in html
    assert ".profile-filters button.on {" in html
    assert "color: #ddd2ff;" in html
    assert "plain: true" in html
    assert 'settingButton("Import", "importProfs()")' in html
    assert 'settingButton("+ New profile", "newProf()", true)' in html
