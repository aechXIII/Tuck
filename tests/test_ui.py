from __future__ import annotations

import re
from pathlib import Path

WEB_DIR = Path("tuck/web")


def _asset(name: str) -> str:
    return (WEB_DIR / name).read_text(encoding="utf-8")


def _web_source() -> str:
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(WEB_DIR.iterdir())
        if path.suffix in {".css", ".html", ".js"}
    )


def test_web_ui_is_packaged_source_asset() -> None:
    html = _asset("index.html")
    app_js = _asset("app.js")

    assets = re.findall(r'<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"', html)
    assert assets
    for asset in assets:
        assert (WEB_DIR / asset).is_file()
    assert "window.pywebview.api" in app_js
    assert "pywebviewready" in app_js


def test_web_ui_uses_python_managed_drop_paths() -> None:
    html = _web_source()

    assert "postMessageWithAdditionalObjects" not in html
    assert "chrome.webview" not in html


def test_web_ui_forwards_start_metadata_and_releases_old_media_tokens() -> None:
    html = _web_source()

    assert "metadata.files = files" in html
    assert "releaseMediaToken(clips[selPath].mediaToken)" in html
    assert "api.closeWindow()" in html


def test_application_shortcuts_use_the_central_command_dispatcher() -> None:
    html = _asset("index.html")
    shortcuts_js = _asset("shortcuts.js")
    app_js = _asset("app.js")
    audio_js = _asset("audio.js")
    history_js = _asset("history.js")
    timeline_js = _asset("timeline.js")

    assert 'root.addEventListener("keydown", dispatchCommand)' in shortcuts_js
    assert 'TuckShortcuts.registerAction("file.add-videos"' in app_js
    assert 'TuckShortcuts.registerAction("settings.open", function () {' in app_js
    assert "toggleSettings();" in app_js
    assert "execute: function () {\n    togglePlay();\n  }," in app_js
    assert 'TuckShortcuts.registerAction("playback.step-backward"' in app_js
    assert 'TuckShortcuts.registerAction("playback.step-forward"' in app_js
    assert "seekPreview(0);" in app_js
    assert "seekPreview(videoDuration());" in app_js
    assert "return !!libraryClipTarget(event);" in app_js
    assert 'TuckShortcuts.registerAction("timeline.split"' in audio_js
    assert 'TuckShortcuts.registerAction("edit.delete-selection"' in audio_js
    assert 'root.TuckShortcuts.registerAction("timeline.zoom-in"' in timeline_js
    assert 'root.TuckShortcuts.registerAction("timeline.zoom-out"' in timeline_js
    assert 'root.TuckShortcuts.registerAction("timeline.fit"' in timeline_js
    assert 'TuckShortcuts.registerAction("edit.undo"' in history_js
    assert 'aria-keyshortcuts="Space"' in html
    assert 'aria-keyshortcuts="? Control+/"' in html
    assert 'aria-keyshortcuts="ArrowLeft"' in html
    assert 'aria-keyshortcuts="Control+0"' in html
    assert 'window.addEventListener("keydown", function (e)' not in app_js
    assert 'root.document.addEventListener("keydown", function (event)' not in audio_js
    assert 'document.addEventListener("keydown", function (event)' not in history_js


def test_web_ui_starts_if_python_calls_init_after_bridge_injection() -> None:
    html = _web_source()

    assert "if (window.pywebview && window.pywebview.api)" in html
    assert "var p = paths[i];" in html


def test_web_ui_contains_visual_crop_overlay_and_request_state() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")
    encoding_js = _asset("encoding-ui.js")
    crop_js = _asset("crop.js")
    transform_js = _asset("transform.js")
    styles = _asset("transform.css")

    assert 'id="crop-selection"' in html
    assert "event.target.dataset.handle" in transform_js
    assert html.count('class="crop-handle" data-handle=') == 8
    assert '.crop-handle[data-handle="nw"] {' in styles
    assert '.crop-handle[data-handle="se"] {' in styles
    assert 'aria-label="Segment actions"' in html
    assert 'id="btn-segments-reset"' in html
    assert 'id="segment-menu"' not in html
    assert "cropTransformForRequest(c)" in encoding_js
    assert "new ResizeObserver(paintCropOverlay)" in transform_js
    assert "api.createPlan" not in crop_js
    assert "api.createPlan" not in transform_js


def test_web_ui_contains_complete_transform_controls() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")
    transform_js = _asset("transform.js")
    video_panel = html.split('id="insp-edit"', 1)[1].split('id="insp-audio"', 1)[0]
    export_panel = html.split('id="insp-export"', 1)[1].split('id="right-foot"', 1)[0]
    for value in ("free", "16:9", "9:16", "1:1", "4:3"):
        assert f'data-aspect="{value}"' in html
    for sizing in ("fit", "fill", "stretch"):
        assert f'data-sizing="{sizing}"' in video_panel
        assert f'data-sizing="{sizing}"' not in export_panel
    assert video_panel.index("Flip") < video_panel.index('data-sizing="fit"')
    assert 'id="transform-fields"' in html
    assert 'id="video-inspector-empty"' in video_panel
    assert 'id="video-inspector-content"' in video_panel
    assert "Video" in html.split('id="insp-tabs"', 1)[1].split('id="right-scroll"', 1)[0]
    assert 'aria-label="Video transform controls"' in html
    assert 'class="transform-controls seq-toolbar"' in html
    assert 'role="toolbar"' in html
    assert 'id="media-viewport"' in html
    assert html.index('id="transform-fields"') < html.index('id="timeline"')
    assert 'data-rotation="90"' in html
    assert 'data-rotation="270"' in html
    assert 'id="flip-horizontal"' in html
    assert 'id="flip-vertical"' in html
    assert html.count('data-tip="') >= 8
    assert 'data-sizing="fit"' in html and 'title="Keep the entire' not in html
    assert 'sizing_mode: clip.sizingMode || "fit"' in transform_js
    assert "flip_horizontal: !!clip.flipHorizontal" in transform_js
    assert "plannedGeometry.oriented_width" in transform_js
    assert "paintTransformPreview(clip, size)" in transform_js
    assert "cropEditorGeometry(clip, size)" in transform_js
    assert "sourceHandleForDisplay(displayHandle, origin, editor)" in transform_js
    assert 'tooltip.id = "transform-tooltip"' in transform_js
    assert "tooltipTarget !== target || !target.isConnected" in transform_js
    assert "if (tooltipPointerActive) return;" in transform_js
    assert "tooltipPointerActive = true;" in transform_js
    assert "targetRect.width <= 0 || targetRect.height <= 0" in transform_js
    assert 'button.setAttribute("aria-pressed", String(active))' in transform_js


def test_editor_shell_uses_adaptive_accessible_panels() -> None:
    styles = _asset("styles.css")
    audio_styles = _asset("audio.css")
    app_js = _asset("app.js")
    encoding_js = _asset("encoding-ui.js")
    panels_js = _asset("panels.js")
    timeline_js = _asset("timeline.js")
    queue_js = _asset("queue.js")
    html = _asset("index.html")
    topbar = html.split('<div id="tb">', 1)[1].split('<div id="main">', 1)[0]

    assert "--library-width: 232px;" in styles
    assert "--inspector-width: 316px;" in styles
    assert "--inspector-wide-width: 344px;" in styles
    assert "--inspector-overlay-width: clamp(336px, 38vw, 380px);" in styles
    assert "resize: horizontal" not in styles
    assert "new ResizeObserver(function (entries)" not in app_js
    assert 'byId("left").style.width' not in encoding_js
    assert 'id="panel-toggle-library"' in html
    assert 'aria-controls="left"' in html
    assert 'id="panel-toggle-library"' in topbar and 'aria-label="Library"' in topbar
    assert 'id="panel-toggle-inspector"' in html
    assert 'aria-controls="right"' in html
    assert 'id="panel-toggle-inspector"' in topbar and 'aria-label="Inspector"' in topbar
    assert "<title>Tuck</title>" in html
    assert 'id="tb-logo"' not in topbar
    assert topbar.index('id="panel-toggle-library"') < topbar.index('id="btn-undo"')
    assert topbar.index('id="btn-undo"') < topbar.index('id="btn-redo"')
    assert topbar.index('id="btn-redo"') < topbar.index('id="settings-toggle"')
    assert topbar.index('id="settings-toggle"') < topbar.index('id="panel-toggle-inspector"')
    assert 'id="workspace-backdrop"' in html
    assert 'id="library-panel-close"' in html
    assert 'id="inspector-panel-close"' in html
    assert "function toggleWorkspacePanel(panel)" in panels_js
    assert "function closeWorkspacePanels(restoreFocus)" in panels_js
    assert "function syncWorkspaceForViewport()" in panels_js
    assert "function trapWorkspaceDrawerFocus(event)" in panels_js
    assert 'byId("center").inert = drawerOpen;' in panels_js
    assert 'byId("audio-editor").inert = drawerOpen;' in panels_js
    assert "workspace-drawer-open" in styles
    assert "@media (max-width: 1179px)" in styles
    assert "@media (max-width: 719px)" in styles
    assert "overflow-x: hidden;" in audio_styles
    assert "#sequence-frame.is-zoomed" in audio_styles
    assert 'id="timeline-resizer"' in html
    assert 'role="separator"' in html
    assert 'aria-valuemin="170"' in html
    assert 'aria-valuemax="300"' in html
    assert 'aria-valuenow="190"' in html
    assert 'id="btn-timeline-height-fit"' in html
    assert 'aria-label="Fit timeline height to tracks"' in html
    assert 'id="seq-playhead-time"' in html
    assert "function handleTimelineResizeKey(event)" in timeline_js
    assert "resetTimelineHeight: resetTimelineHeight" in timeline_js
    assert "function formatTimelineTime(seconds)" in timeline_js
    assert 'byId("seq-playhead-time")' in timeline_js
    assert "saveSettings({ timeline_height: timelineHeightSetting })" in timeline_js
    assert 'frame.classList.toggle("is-zoomed", zoomed);' in timeline_js
    assert 'frame.style.removeProperty("--tl-width");' in timeline_js
    assert '<div id="qbar" class="hid">' in html
    assert 'byId("qbar").classList.toggle("hid", items.length === 0)' in queue_js


def test_library_panel_has_a_single_actionable_hierarchy() -> None:
    html = _asset("index.html")
    styles = _asset("styles.css")
    library = html.split('id="left"', 1)[1].split('id="center"', 1)[0]

    assert "\n            Video\n" in library
    assert "\n            Audio\n" in library
    assert ">Add videos</button" in library
    assert ">Add audio</button" in library
    assert "Media library</h3>" not in library
    assert "body.workspace-overlay .panel-heading" in styles
    assert "border-bottom: 2px solid var(--accent-light);" in styles
    assert "#audio-lib-list:empty" in styles


def test_audio_controls_use_consistent_nle_track_vocabulary() -> None:
    html = _asset("index.html")
    panels_js = _asset("panels.js")
    timeline_styles = _asset("timeline.css")

    assert '<span class="seq-track-code" aria-hidden="true">V1</span>' in html
    assert '<span class="seq-track-code" aria-hidden="true">A1</span>' in html
    assert 'class="seq-track-mute"' in html
    assert 'class="timeline-tool-group"' in html
    assert 'id="audio-master-toggle"' in html
    assert 'role="switch"' in html
    assert '<svg class="ti-icon"' not in html
    assert "mixer-track-code" in panels_js
    assert 'class="mixer-mute"' in panels_js
    assert 'type="checkbox" class="mixer-mute"' not in panels_js
    assert "#video-track #timeline.seq-lane" in timeline_styles


def test_waveforms_are_amplified_inside_compact_audio_clips() -> None:
    audio_js = _asset("audio.js")
    audio_styles = _asset("audio.css")

    assert '"% 160%;background-position:"' in audio_js
    assert audio_js.count('"% 160%') == 2
    assert "opacity: 0.9;" in audio_styles


def test_workspace_commands_have_clear_hierarchy() -> None:
    html = _asset("index.html")
    audio_styles = _asset("audio.css")
    panels_js = _asset("panels.js")
    timeline_js = _asset("timeline.js")
    toolbar = html.split('id="timeline-row"', 1)[1].split('id="sequence-frame"', 1)[0]

    assert 'aria-label="View controls"' in html
    assert 'class="timeline-switch"' in html
    assert 'class="timeline-fit-chevron"' in html
    assert 'aria-label="Segment actions"' in html
    assert 'aria-label="Audio actions"' in html
    assert 'aria-keyshortcuts="S"' in html
    assert '<span class="timeline-tool-label" aria-hidden="true">Segments</span>' in html
    assert 'class="dock-text-btn timeline-primary-btn"' in toolbar
    assert '<span class="timeline-command-label">New segment</span>' in toolbar
    assert '<span class="timeline-command-label">Split</span>' in toolbar
    assert toolbar.index('aria-label="Segment actions"') < toolbar.index(
        'aria-label="Audio actions"'
    )
    assert toolbar.index('aria-label="Audio actions"') < toolbar.index('id="tl-time"')
    assert toolbar.index('id="tl-time"') < toolbar.index('aria-label="View controls"')
    assert "@media (max-width: 719px)" in audio_styles
    assert "#tl-zoom-slider" in audio_styles
    assert '<span class="audio-master-title">Output audio</span>' in html
    assert "<span>Include in export</span>" in html
    assert "Video and audio tracks will appear here." in timeline_js
    assert "mixer-row-actions" in panels_js
    assert "Remove track" in panels_js


def test_removing_the_last_video_clears_timeline_state() -> None:
    app_js = _asset("app.js")
    remove_clip = app_js.split("function removeClip(p) {", 1)[1].split(
        "function removeAllClips() {", 1
    )[0]
    remove_all = app_js.split("function doRemoveAllClips() {", 1)[1].split(
        "async function probeClip(p) {", 1
    )[0]

    for removal_path in (remove_clip, remove_all):
        assert "AudioTimeline.selectVideo(null)" in removal_path
        assert "syncTimelineUI();" in removal_path
        assert "syncTransformControls();" in removal_path


def test_settings_dialog_manages_keyboard_focus() -> None:
    html = _asset("index.html")
    settings_js = _asset("settings.js")

    assert 'id="settings-close"' in html
    assert "var settingsReturnFocus" in settings_js
    assert "function trapSettingsFocus(event)" in settings_js
    assert 'document.addEventListener("keydown", trapSettingsFocus)' in settings_js
    assert "settingsReturnFocus.focus();" in settings_js


def test_settings_save_state_is_wired_into_the_ui() -> None:
    html = _asset("index.html")
    settings_js = _asset("settings.js")

    assert '<details class="profile-options">' in html
    assert 'src="settings-state.js"' in html
    assert 'data-settings-save="true"' in settings_js
    assert "function captureSettingsSnapshot()" in settings_js
    persist_settings = settings_js.split("async function persistSettings", 1)[1].split(
        "async function saveSettings", 1
    )[0]
    assert persist_settings.index("await loadSettings();") < persist_settings.index(
        'indicator.textContent = "Saved";'
    )


def test_thumbnail_is_created_only_when_a_valid_source_exists() -> None:
    html = _asset("index.html")
    app_js = _asset("app.js")
    transform_js = _asset("transform.js")

    assert '<img id="thumb"' not in html
    assert 'id="media-viewport"' in html
    assert "function showThumbnail(source)" in app_js
    assert "function removeThumbnail()" in app_js
    assert ".filter(Boolean)" in transform_js


def test_preview_responses_are_bound_to_the_source_and_request_snapshot() -> None:
    encoding_js = _asset("encoding-ui.js")
    transform_js = _asset("transform.js")

    assert "var path = selPath;" in encoding_js
    assert "req._request_id = requestId;" in encoding_js
    assert "clips[path] === clip" in encoding_js
    assert "clip._previewRequestId === requestId" in encoding_js
    assert "r._request_id === requestId" in encoding_js
    assert 'document.getElementById("res-mode")' not in transform_js


def test_web_ui_allows_manual_target_size_entry() -> None:
    html = _web_source()

    assert 'id="sz-badge"' in html
    assert 'type="number"' in html
    assert 'min="2"' in html
    assert "#sz-badge {" in html
    assert "color: #c4b5fd;" in html
    assert "function onBadgeSize(v)" in html
    assert 'byId("sz-slider").max = Math.max(500, size)' in html
    assert "if (!size || size < 2)" in html


def test_web_ui_checks_for_updates_on_startup_when_enabled() -> None:
    html = _web_source()

    assert "if (appSettings.check_updates !== false) checkUpdates(true);" in html
    assert "async function checkUpdates(silent)" in html
    assert 'if (!silent) toast("Running latest version.", "ok");' in html


def test_web_ui_shows_release_notes_in_an_update_modal() -> None:
    html = _web_source()

    assert "function showUpdateModal(update)" in html
    assert 'id="update-notes"' in html
    assert "function renderUpdateNotes(notes)" in html
    assert 'document.createElement(block.type === "heading" ? "h4" : "p")' in html
    assert "item.textContent = block.text" in html
    assert "renderUpdateNotes(update.notes);" in html
    assert "showUpdateModal(r);" in html


def test_update_download_starts_the_installer_without_a_second_prompt() -> None:
    html = _web_source()

    assert "Download &amp; install" in html
    assert "async function downloadAndInstallUpdate()" in html
    assert "var installed = await api.installUpdate();" in html
    assert "await api.closeWindow();" in html
    assert "Update downloaded. Install now?" not in html


def test_installer_exposes_tuck_command_on_path() -> None:
    installer = Path("scripts/installer.iss").read_text(encoding="utf-8")
    wrapper = Path("scripts/tuck.cmd").read_text(encoding="utf-8")

    assert "ChangesEnvironment=yes" in installer
    assert "procedure AddTuckToPath;" in installer
    assert "procedure RemoveTuckFromPath;" in installer
    assert 'Source: "tuck.cmd"; DestDir: "{app}"' in installer
    assert '"%~dp0TuckCli.exe" %*' in wrapper
    assert "CloseApplications=yes" in installer
    assert "CloseApplicationsFilter=Tuck.exe,TuckCli.exe" in installer
