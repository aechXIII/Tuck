from __future__ import annotations

import re
from pathlib import Path

FRONTEND_DIR = Path("frontend")
INDEX_PATH = FRONTEND_DIR / "index.html"
WEB_DIR = FRONTEND_DIR / "public" / "legacy"
SOURCE_DIR = FRONTEND_DIR / "src"
STYLES_DIR = SOURCE_DIR / "styles"

MIGRATED_MODULES = {
    "app.js": (
        "features/editor/runtime.ts",
        "features/editor/toast.ts",
        "features/editor/updates.ts",
        "features/library/library.ts",
        "features/preview/preview-controller.ts",
    ),
    "audio.js": ("features/audio/audio-timeline.ts",),
    "clip-card.js": ("features/library/clip-card.ts",),
    "clip-details.js": ("features/library/clip-details.ts",),
    "crop.js": ("features/transform/crop-geometry.ts",),
    "history.js": ("features/history/history.ts",),
    "inspector-ui.js": ("features/panels/inspector-ui.ts",),
    "encoding-ui.js": (
        "features/export/encoding-controls.ts",
        "features/export/encoder-options.ts",
        "features/export/encoder-select.ts",
        "features/export/plan-request.ts",
    ),
    "panels.js": ("features/panels/panels.ts",),
    "queue.js": ("features/queue/queue.ts", "features/queue/queue-view.ts"),
    "settings.js": ("features/settings/settings.ts",),
    "player.js": ("features/player/player.ts",),
    "segments.js": ("features/timeline/segments.ts",),
    "shortcuts.js": ("features/shortcuts/shortcuts.ts",),
    "timeline.js": ("features/timeline/timeline-core.ts", "features/timeline/timeline.ts"),
    "transform.js": ("features/transform/transform.ts",),
}


def _asset(name: str) -> str:
    if name == "index.html":
        return INDEX_PATH.read_text(encoding="utf-8")
    migrated = MIGRATED_MODULES.get(name)
    if migrated:
        return "\n".join((SOURCE_DIR / path).read_text(encoding="utf-8") for path in migrated)
    if name.endswith(".css"):
        return (STYLES_DIR / name).read_text(encoding="utf-8")
    return (WEB_DIR / name).read_text(encoding="utf-8")


def _web_source() -> str:
    legacy = (
        path.read_text(encoding="utf-8")
        for path in sorted(STYLES_DIR.iterdir())
        if path.suffix == ".css"
    )
    modules = (path.read_text(encoding="utf-8") for path in SOURCE_DIR.rglob("*.ts"))
    return "\n".join((INDEX_PATH.read_text(encoding="utf-8"), *legacy, *modules))


def test_web_ui_is_packaged_source_asset() -> None:
    html = _asset("index.html")
    app_js = _asset("app.js")

    assets = re.findall(r'<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"', html)
    assert assets
    for asset in assets:
        path = (
            WEB_DIR / asset.removeprefix("/legacy/")
            if asset.startswith("/legacy/")
            else FRONTEND_DIR / asset
        )
        assert path.is_file()
    assert "window.pywebview" not in app_js
    main_ts = (FRONTEND_DIR / "src" / "main.ts").read_text(encoding="utf-8")
    assert "window.attachBackendClient = attachDesktopBackend" in main_ts
    assert "pywebviewready" in (FRONTEND_DIR / "src" / "backend" / "pywebview.ts").read_text(
        encoding="utf-8"
    )


def test_workspace_surface_styles_load_in_owner_order() -> None:
    html = _asset("index.html")
    main_ts = (SOURCE_DIR / "main.ts").read_text(encoding="utf-8")

    # CSS is imported by TypeScript modules and bundled by Vite, not linked in HTML
    assert '<script type="module" src="./src/main.ts"></script>' in html
    assert "./styles/index.ts" in main_ts
    for name in ("styles.css", "library.css", "inspector.css", "export.css"):
        assert (STYLES_DIR / name).is_file()


def test_topbar_settings_control_has_visible_and_accessible_label() -> None:
    html = _asset("index.html")
    settings = re.search(r'<button\b[^>]*id="settings-toggle"[^>]*>.*?</button>', html, re.DOTALL)

    assert settings is not None
    assert 'aria-label="Settings"' in settings.group(0)
    assert "<span>Settings</span>" in settings.group(0)


def test_web_ui_uses_python_managed_drop_paths() -> None:
    html = _web_source()

    assert "postMessageWithAdditionalObjects" not in html
    assert "chrome.webview" not in html


def test_web_ui_forwards_start_metadata_and_releases_old_media_tokens() -> None:
    html = _web_source()

    assert "launch.files" in html
    assert "getBackendClient().releaseMediaToken(clip.mediaToken)" in html
    assert "getBackendClient().closeWindow()" in html


def test_application_shortcuts_use_the_central_command_dispatcher() -> None:
    html = _asset("index.html")
    shortcuts_js = _asset("shortcuts.js")
    app_js = _asset("app.js")
    audio_js = _asset("audio.js")
    history_js = _asset("history.js")
    timeline_js = _asset("timeline.js")

    assert "function dispatch" in shortcuts_js
    for command in (
        "file.add-videos",
        "settings.open",
        "playback.toggle",
        "playback.step-backward",
        "playback.step-forward",
    ):
        assert f'"{command}"' in app_js
    assert 'registerAction("timeline.split"' in audio_js
    assert 'registerAction("edit.delete-selection"' in audio_js
    for command in ("timeline.zoom-in", "timeline.zoom-out", "timeline.fit"):
        assert f'registerAction("{command}"' in timeline_js
    assert 'registerAction("edit.undo"' in history_js
    assert 'aria-keyshortcuts="Space"' in html
    assert 'aria-keyshortcuts="? Control+/"' in html
    assert 'aria-keyshortcuts="ArrowLeft"' in html
    assert 'aria-keyshortcuts="Control+0"' in html
    assert 'addEventListener("keydown"' not in app_js
    assert 'document.addEventListener("keydown"' not in audio_js
    assert 'document.addEventListener("keydown"' not in history_js


def test_web_ui_starts_if_python_calls_init_after_bridge_injection() -> None:
    _app_js = _asset("app.js")
    main_ts = (FRONTEND_DIR / "src" / "main.ts").read_text(encoding="utf-8")

    assert "function attachDesktopBackend" in main_ts
    assert "window.initApp = (data: unknown)" in main_ts
    assert "window.attachBackendClient = attachDesktopBackend" in main_ts
    assert "if (window.tuckBackendClient)" in main_ts
    assert "waitForDesktopBackend" in main_ts


def test_web_ui_contains_visual_crop_overlay_and_request_state() -> None:
    html = INDEX_PATH.read_text(encoding="utf-8")
    encoding_js = _asset("encoding-ui.js")
    crop_js = _asset("crop.js")
    transform_js = _asset("transform.js")
    styles = _asset("transform.css")

    assert 'id="crop-selection"' in html
    assert "target?.dataset?.handle" in transform_js
    assert html.count('class="crop-handle" data-handle=') == 8
    assert '.crop-handle[data-handle="nw"] {' in styles
    assert '.crop-handle[data-handle="se"] {' in styles
    assert 'aria-label="Segment actions"' in html
    assert 'id="btn-segments-reset"' in html
    assert 'id="segment-menu"' not in html
    assert "cropTransformForRequest" in encoding_js
    assert "new ResizeObserver(paintCropOverlay)" in transform_js
    assert "api.createPlan" not in crop_js
    assert "api.createPlan" not in transform_js


def test_web_ui_contains_complete_transform_controls() -> None:
    html = INDEX_PATH.read_text(encoding="utf-8")
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
    assert "Transform" in html.split('id="insp-tabs"', 1)[1].split('id="right-scroll"', 1)[0]
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
    assert 'button.setAttribute("aria-pressed", String(pressed))' in transform_js


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
    assert "function toggleWorkspacePanel(panel: WorkspacePanelName)" in panels_js
    assert "function closeWorkspacePanels(restoreFocus?: boolean)" in panels_js
    assert "function syncWorkspaceForViewport()" in panels_js
    assert "function trapWorkspaceDrawerFocus(event: KeyboardEvent)" in panels_js
    assert "if (center) center.inert = drawerOpen;" in panels_js
    assert "if (audioEditor) audioEditor.inert = drawerOpen;" in panels_js
    assert "workspace-drawer-open" in styles
    assert "@media (max-width: 1179px)" in styles
    assert "@media (max-width: 719px)" in styles
    assert "overflow-x: hidden;" in audio_styles
    assert "#sequence-frame.is-zoomed" in audio_styles
    assert "body.library-panel-open .timeline-empty" in audio_styles
    assert "left: var(--library-width);" in audio_styles
    assert "body.inspector-panel-open .timeline-empty" in audio_styles
    assert "right: var(--inspector-width);" in audio_styles
    assert "right: var(--inspector-wide-width);" in audio_styles
    assert 'id="timeline-resizer"' in html
    assert 'role="separator"' in html
    assert 'aria-valuemin="170"' in html
    assert 'aria-valuemax="300"' in html
    assert 'aria-valuenow="190"' in html
    assert 'id="btn-timeline-height-fit"' in html
    assert 'aria-label="Fit timeline height to tracks"' in html
    assert 'id="seq-playhead-time"' in html
    assert "function handleTimelineResizeKey(event: KeyboardEvent)" in timeline_js
    assert "resetTimelineHeight: resetTimelineHeight" in timeline_js
    assert "function formatTimelineTime(seconds: number)" in timeline_js
    assert 'byId("seq-playhead-time")' in timeline_js
    assert (
        "getBackendClient().saveSettings({ timeline_height: timelineHeightSetting })" in timeline_js
    )
    assert 'frame.classList.toggle("is-zoomed", zoomed);' in timeline_js
    assert 'frame.style.removeProperty("--tl-width");' in timeline_js
    assert '<div id="qbar" class="hid">' in html
    assert 'toggleHidden("qbar", !queueView.barVisible)' in queue_js
    assert 'byId(id)?.classList.toggle("hid", hidden)' in queue_js
    assert "barVisible: items.length > 0" in queue_js


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
    assert "#audio-lib-list:empty" in styles


def test_audio_controls_use_consistent_nle_track_vocabulary() -> None:
    html = _asset("index.html")
    panels_js = _asset("panels.js")
    timeline_styles = _asset("timeline.css")

    for header_id, label in (("video-track-head", "Video"), ("source-audio-head", "Source audio")):
        header = re.search(rf'<div\b[^>]*id="{header_id}"[^>]*>.*?</div>', html, re.DOTALL)
        assert header is not None
        assert f">{label}</span>" in header.group(0)
        assert 'class="seq-track-icon" aria-hidden="true"' in header.group(0)
    mute = re.search(r'<button\b[^>]*id="source-audio-label"[^>]*>', html)
    assert mute is not None
    assert 'type="button"' in mute.group(0)
    assert 'aria-label="Mute source audio"' in mute.group(0)
    assert 'aria-pressed="false"' in mute.group(0)
    assert "disabled" in mute.group(0)
    assert 'class="timeline-tool-group"' in html
    assert 'id="audio-master-toggle"' in html
    assert 'role="switch"' in html
    assert '<svg class="ti-icon"' not in html
    assert "mixer-track-code" in panels_js
    assert 'mute.className = "mixer-mute"' in panels_js
    assert 'type="checkbox" class="mixer-mute"' not in panels_js
    assert "#video-track #timeline.seq-lane" in timeline_styles


def test_workspace_commands_have_clear_hierarchy() -> None:
    html = _asset("index.html")
    audio_styles = _asset("audio.css")
    panels_js = _asset("panels.js")
    toolbar = html.split('id="timeline-row"', 1)[1].split('id="sequence-frame"', 1)[0]

    assert 'aria-label="View controls"' in html
    assert 'class="timeline-switch"' in html
    assert 'class="timeline-fit-chevron"' in html
    assert 'aria-label="Segment actions"' in html
    assert 'aria-label="Audio actions"' in html
    assert 'aria-keyshortcuts="S"' in html
    assert '<span class="timeline-tool-label" aria-hidden="true">Segments</span>' in html
    assert 'class="dock-text-btn timeline-primary-btn"' in toolbar
    assert '<span class="timeline-command-label">Add segment</span>' in toolbar
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
    assert "mixer-row-actions" in panels_js


def test_removing_the_last_video_clears_timeline_state() -> None:
    app_js = _asset("app.js")
    assert "function removeClip(path: string): void" in app_js
    assert "function doRemoveAllClips(): void" in app_js
    assert "host.audio?.selectVideo?.(null);" in app_js
    assert "host.syncTimelineUI?.();" in app_js
    assert "host.syncTransformControls?.();" in app_js


def test_settings_dialog_manages_keyboard_focus() -> None:
    html = _asset("index.html")
    settings_js = _asset("settings.js")

    assert 'id="settings-close"' in html
    assert "let settingsReturnFocus" in settings_js
    assert "function trapSettingsFocus(event: KeyboardEvent)" in settings_js
    assert 'document.addEventListener("keydown", trapSettingsFocus)' in settings_js
    assert "settingsReturnFocus.focus();" in settings_js


def test_settings_save_state_is_wired_into_the_ui() -> None:
    html = _asset("index.html")
    settings_js = _asset("settings.js")

    assert '<details class="profile-options">' in html
    # Settings state is owned by the module, not a legacy window global.
    assert "settingsDirty = settingsAreDirty(snapshot, settingsPageState())" in settings_js
    assert 'data-settings-save="true"' in settings_js
    assert "function captureSettingsSnapshot()" in settings_js
    persist_settings = settings_js.split("async function persistSettings", 1)[1].split(
        "async function saveGeneralSettings", 1
    )[0]
    assert persist_settings.index("await deps.reloadEditorSettings();") < persist_settings.index(
        'indicator.textContent = "Saved";'
    )


def test_profile_management_is_visible_without_opening_an_overflow_menu() -> None:
    html = _asset("index.html")
    profile_card = html.split('id="profile-card"', 1)[1].split('id="sz-grp"', 1)[0]
    profile_header = profile_card.split('class="profile-select-row"', 1)[0]
    profile_options = profile_card.split('<details class="profile-options">', 1)[1]

    assert 'data-action-click="settings-open-profiles"' in profile_header
    assert 'aria-label="Manage profiles"' in profile_header
    assert 'data-action-click="encoding-save-profile"' in profile_header
    assert 'data-action-click="settings-open-profiles"' not in profile_options


def test_thumbnail_is_created_only_when_a_valid_source_exists() -> None:
    html = _asset("index.html")
    app_js = _asset("app.js")
    _transform_js = _asset("transform.js")

    assert '<img id="thumb"' not in html
    assert 'id="media-viewport"' in html
    assert "function showThumbnail(source: string)" in app_js
    assert "function removeThumbnail(): void" in app_js


def test_preview_responses_are_bound_to_the_source_and_request_snapshot() -> None:
    encoding_js = _asset("encoding-ui.js")
    transform_js = _asset("transform.js")

    assert "const path = session.selPath;" in encoding_js
    assert "clip._previewRequestId = requestId;" in encoding_js
    assert "const req = buildRequest(path as string, requestId);" in encoding_js
    assert "session.clips[path as string] === clip" in encoding_js
    assert "clip._previewRequestId === requestId" in encoding_js
    assert "r._request_id === requestId" in encoding_js
    assert 'document.getElementById("res-mode")' not in transform_js


def test_web_ui_allows_manual_target_size_entry() -> None:
    html = _web_source()

    assert 'id="sz-badge"' in html
    assert 'type="number"' in html
    assert 'min="2"' in html
    assert "#sz-badge {" in html
    assert "color: var(--text) !important;" in html
    assert "function onBadgeSize(value: string)" in html
    assert 'input("sz-slider").max = String(Math.max(500, size))' in html
    assert "if (!size || size < 2)" in html


def test_web_ui_checks_for_updates_on_startup_when_enabled() -> None:
    html = _web_source()

    assert "session.appSettings.check_updates !== false" in html
    assert "shouldShowUpdater(await fetchPlatformCapabilities())" in html
    assert "void checkUpdates(true);" in html
    assert "export async function checkUpdates(silent: boolean)" in html
    assert 'if (!silent) toast("Running latest version.", "ok");' in html


def test_web_ui_shows_release_notes_in_an_update_modal() -> None:
    html = _web_source()

    assert "export function showUpdateModal(update" in html
    assert 'id="update-notes"' in html
    assert "export function renderUpdateNotes(notes: unknown)" in html
    assert 'document.createElement(block.type === "heading" ? "h4" : "p")' in html
    assert "element.textContent = block.text" in html
    assert "renderUpdateNotes(update.notes);" in html
    assert "showUpdateModal(r);" in html


def test_update_download_starts_the_installer_without_a_second_prompt() -> None:
    html = _web_source()

    assert "Download &amp; install" in html
    assert "async function downloadAndInstallUpdate()" in html
    assert "const installed = await legacyBackendResult(api.installUpdate());" in html
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
